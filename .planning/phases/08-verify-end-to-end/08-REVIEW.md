---
phase: 08-verify-end-to-end
reviewed: 2026-06-27T00:00:00Z
depth: standard
files_reviewed: 1
files_reviewed_list:
  - src/__tests__/batch-e2e.test.ts
findings:
  critical: 0
  warning: 1
  info: 3
  total: 4
status: issues_found
---

# Phase 08: Code Review Report

**Reviewed:** 2026-06-27T00:00:00Z
**Depth:** standard
**Files Reviewed:** 1
**Status:** issues_found

## Summary

Reviewed `src/__tests__/batch-e2e.test.ts`, a Phase-08 end-to-end verification test that drives the real `createMcpServer` `code_assist_batch` handler through a committed 3-task mixed batch (timeout / validation-fail / ok) plus a `describe.skip` opt-in 45s real-wait race.

I traced every assertion against the real implementation (`src/index.ts` `runBatch`/`runTask`/`callModel`/`deriveErrorType` and `src/batch.ts` `executeBatch`/`withTimeout`/`mapWithConcurrency`). The committed test's assertions are individually sound — the totals, statuses, error-type classification, order-preservation, `failedIds`, summary, and the `AI.run` call-count guard all match real behavior, and the `latency_ms === 20` / `error_type` assertions are deterministic (derived from the configured timeout string, not measured wall-clock). The documented SDK-internals access (`_registeredTools[...].handler`) and the `as unknown as Env` cast for `BATCH_TASK_TIMEOUT_MS` are accepted codebase patterns and are not flagged.

The findings below concern hidden ordering coupling in the AI mock sequencing (the one substantive risk), and minor coverage/clarity gaps. No correctness or security defects found.

## Warnings

### WR-01: AI mock relies on undocumented concurrency-pool dispatch order

**File:** `src/__tests__/batch-e2e.test.ts:41-47, 113`
**Issue:** The mock uses ordered `mockImplementationOnce` — the *first* `AI.run` call gets the 100ms-hang implementation (intended for task 0), the *second* gets the instant implementation (intended for task 2). This is correct only if the concurrency pool always invokes `AI.run` for task 0 before task 2. That ordering is not guaranteed by any contract; it is an emergent property of `mapWithConcurrency` (`src/batch.ts:78-95`) spawning workers in index order, each sharing the identical async prelude (`runTask` → `runAIWithMetrics` → `resolveModel` awaits `OAUTH_KV.get` → `callModel`). Task 1 (transformCode) short-circuits synchronously in `spec.validate()` before any await, so it never reaches the pool's AI dispatch — but tasks 0 and 2 race through identical microtask chains. If `resolveModel`'s await sequence, the pool's worker-spawn order, or KV mock latency ever changes, the two `mockImplementationOnce` implementations would swap: task 0 would resolve instantly (becoming `ok`) and task 2 would hang (becoming `timeout`), inverting every index-keyed status assertion (lines 88-90, 94, 99, 102) while still yielding `succeeded:1 / failed:2`. The misattribution would be silent — the totals still pass, so the test could go green while asserting the wrong tasks failed.

The comment block (lines 27-35) documents the *intended* order but the test does not *enforce* it; nothing pins which physical task consumed the hanging mock.

**Fix:** Make the mock dispatch on task identity rather than call order, so it is robust to pool scheduling. Branch on the user prompt (quickTask `buildPrompt` returns the raw `instruction`, so the hang vs. instant inputs are distinguishable):
```typescript
AI: {
  run: vi.fn(async (_model, opts: any) => {
    const userMsg = opts.messages.find((m: any) => m.role === "user")?.content ?? "";
    if (userMsg === "hang") {
      return new Promise((r) => setTimeout(() => r({ response: "late" }), 100));
    }
    return { response: "generated output" };
  }),
} as unknown as Ai,
```
This guarantees the hang attaches to the timeout task regardless of dispatch order, and the call-count guard (line 113) still holds.

## Info

### IN-01: Skipped opt-in test never asserts the second task's outcome

**File:** `src/__tests__/batch-e2e.test.ts:154, 161-168`
**Issue:** The `describe.skip` opt-in block submits two tasks (`hang-task` at index 0, `ok-task` at index 1) but only asserts on `results[0]`. Because the hanging mock (`run: vi.fn(() => new Promise(() => {}))`, line 142) never resolves for *any* call, the `ok-task` also hangs and hits the 45s `withTimeout`, so it too settles as `status:error` — yet nothing verifies index 1 settled at all. A regression that dropped or stalled the second pool slot would not be caught here. The `ok-task` name is also misleading: it cannot succeed under this mock.

**Fix:** Either drop the unused second task, or add `expect(sc.results).toHaveLength(2)` is already present (line 161) but assert index 1 settled too: `expect(sc.results[1].status).toBe("error");`. Rename `ok-task` to something like `second-hang-task` to reflect that it cannot succeed under the infinite-hang mock.

### IN-02: Orphaned 100ms timer outlives the assertion phase

**File:** `src/__tests__/batch-e2e.test.ts:44`
**Issue:** The timeout task's mock schedules a real `setTimeout(..., 100)` that resolves ~80ms after `withTimeout(20ms)` has already rejected. The late resolution is harmless by design — `withTimeout`'s two-handler `.then(resolve, reject)` form (`src/batch.ts:109-112`) ensures the orphan hits an already-settled promise with no double-settle and no unhandled rejection — and it stays well within the 5000ms ceiling. Noted only because it leaves a pending timer alive past the assertions; under future `vi.useFakeTimers()` adoption this would need explicit timer advancement.

**Fix:** No change required. If fake timers are introduced project-wide later, advance/flush timers after assertions to drain the orphan deterministically.

### IN-03: `latency_ms === 20` reads as a timing assertion but tests a string parse

**File:** `src/__tests__/batch-e2e.test.ts:98-99`
**Issue:** The assertion `sc.results[0].latency_ms === 20` looks like it verifies measured wall-clock latency, but on the error path `latency_ms` is parsed from the timeout *message string* (`runBatch` `src/index.ts:781-782`: `entry.error.match(/exceeded (\d+)ms timeout/)` → `parseInt`). It therefore always equals the configured `BATCH_TASK_TIMEOUT_MS` (20) regardless of real elapsed time. The assertion is sound and deterministic, but the inline comment ("parsed from ... → 20") is the only thing that prevents a future reader from mistaking it for a real-time check and "fixing" it with a tolerance range.

**Fix:** No behavioral change needed. Optionally strengthen the comment to state explicitly that this asserts the message-derived value, not a measured duration, e.g. `// NOTE: error-path latency_ms is parsed from the timeout message, not measured — always === BATCH_TASK_TIMEOUT_MS`.

---

_Reviewed: 2026-06-27T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
