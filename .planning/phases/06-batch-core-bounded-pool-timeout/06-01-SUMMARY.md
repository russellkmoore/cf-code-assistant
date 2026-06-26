---
phase: 06-batch-core-bounded-pool-timeout
plan: "01"
subsystem: batch-engine
tags: [batch, concurrency, timeout, pure-module, no-deps]
dependency_graph:
  requires:
    - src/index.ts (TaskKind type — 11-kind union)
  provides:
    - src/batch.ts (executeBatch, mapWithConcurrency, withTimeout, readBatchConfig)
    - src/__tests__/batch.test.ts (four headline test shapes: BATCH-03/04/05/06)
  affects:
    - Phase 7 (code_assist_batch tool registration consumes this engine)
tech_stack:
  added: []
  patterns:
    - Worker-cursor bounded pool (mapWithConcurrency) — inline ~25 lines, no p-limit
    - Settle-once two-handler .then(onResolve, onReject) pattern for late-settle safety
    - Pre-dispatch cap check as first operation in executeBatch
    - Index-write into pre-sized array for order preservation
key_files:
  created:
    - src/batch.ts
    - src/__tests__/batch.test.ts
  modified: []
decisions:
  - "D-01 adopted: BATCH_TASK_TIMEOUT_MS default is 45000 (= AI_TIMEOUT_MS), not 60000 from reference"
  - "D-03 adopted: plain TS types (no Zod), TaskResult discriminated union, as const status literals"
  - "D-04a: mapWithConcurrency uses worker-cursor pool, never Promise.all over the task array"
  - "D-04d: withTimeout uses two-handler .then(v=>{...}, e=>{...}) — load-bearing for orphaned late-settle"
  - "BATCH-03 test uses real delays (10ms) rather than never-resolving deferreds to avoid timeout interaction"
metrics:
  duration: "~7 minutes"
  completed: "2026-06-26T09:09:17Z"
  tasks_completed: 2
  files_created: 2
  tests_added: 8
  tests_total: 153
---

# Phase 06 Plan 01: Batch Core Engine Summary

**One-liner:** Pure worker-cursor batch engine with 45s per-task timeout, pre-dispatch cap check, and settle-once late-settle guard — zero new runtime dependencies.

## What Was Built

### Task 1: src/batch.ts

Pure, env-free batch engine adapted from `.planning/batch.ts` with three concrete mutations:

1. **Timeout default changed:** `BATCH_TASK_TIMEOUT_MS` defaults to `45_000` (= `AI_TIMEOUT_MS`), not 60000 from the reference (D-01).
2. **Phase 7 content dropped:** Removed `import { z } from "zod"`, `import type { McpServer }`, `BatchTaskSchema`, `BatchInputShape`, `BatchOutputShape`, `TaskResultSchema`, and `registerBatchTool`. All are Phase 7 concerns.
3. **TaskKind typed correctly:** `BatchTask.kind` uses `import type { TaskKind } from "./index"` — the real 11-kind union, not the reference's 5-kind placeholder.

The four exports:
- `executeBatch(tasks, cfg, runTask)` — pre-dispatch cap check, then `mapWithConcurrency` with per-task `try/catch`
- `mapWithConcurrency(items, limit, fn)` — `Math.max(1, Math.min(limit, items.length))` workers, cursor-pull loop, pre-sized array index-write
- `withTimeout(ms, run)` — `AbortController` + `setTimeout` race with the two-handler `.then(onResolve, onReject)` settle-once form
- `readBatchConfig(env)` — positive-finite-integer guard, defaults 6/50/45000

End-of-file grouped export block per src/index.ts convention.

### Task 2: src/__tests__/batch.test.ts

Eight tests covering the four mandated shapes plus `readBatchConfig` parsing:

- **BATCH-03:** 10 tasks, concurrency=3, real 10ms delays — asserts `peakInFlight <= 3` after batch completes
- **BATCH-04:** 51 tasks, `maxTasks: 50` — `vi.fn()` spy asserts `not.toHaveBeenCalled()`; batch rejects with `/split/i`
- **BATCH-06:** "slow" (50ms) / "fast" (5ms) / "fail" tasks — asserts `results[i].index === i`, statuses ok/ok/error, counts 3/2/1
- **BATCH-05 (a):** Never-resolving `runTask` with `taskTimeoutMs: 10` — asserts `status: "error"` and `/timeout/i`
- **BATCH-05 (b):** Captures `lateResolve`, awaits batch (timeout wins), calls `lateResolve("late value")`, flushes microtasks — passes without unhandled rejection
- **readBatchConfig:** Defaults, floor of floats, fallback from zero/negative/NaN

All tests are env-free — no `createMockEnv`, no AI mock, no `vi.useFakeTimers`.

## Deviations from Plan

### Auto-adapted Issues

**1. [Rule 1 - Bug] Duplicate export declarations**
- **Found during:** Task 1 compilation
- **Issue:** Initially had both `export async function executeBatch` declarations AND `export { executeBatch, ... }` at the bottom — TypeScript TS2323 "Cannot redeclare exported variable"
- **Fix:** Removed `export` keyword from all function/interface/type declarations; kept only the grouped export block at end-of-file (matching src/index.ts convention)
- **Files modified:** src/batch.ts
- **Commit:** 2a50d51 (same task commit)

**2. [Rule 1 - Bug] BATCH-03 test timeout**
- **Found during:** Task 2 first run
- **Issue:** The deferred/resolver approach (never-resolving tasks released by pushing resolvers) caused the test to hit the 5000ms vitest timeout. With 10 tasks and concurrency=3, workers pick up tasks in batches; the single `setTimeout(r, 0)` flush wasn't enough to get all 3 workers in-flight before checking resolvers
- **Fix:** Changed to real short delays (10ms per task) instead of never-resolving deferreds. The batch completes naturally while `peakInFlight` accumulates the true peak. Added `10000` ms test timeout to give headroom
- **Files modified:** src/__tests__/batch.test.ts
- **Commit:** 87100e2 (same task commit)

**3. [Pre-existing - Out of scope] npx tsc --noEmit exits 2**
- The `worker-configuration.d.ts` file is gitignored and missing from the worktree (it's generated by `wrangler types`). Copying it from the main repo exposes pre-existing type errors in test files (MCP_SECRET missing in mock Env type, CfProperties mismatches with IncomingRequestCfProperties). These errors exist in the main repo's tsc run as well and do not affect vitest execution (cloudflarePool provides its own type environment).
- `src/batch.ts` has **zero** tsc errors — confirmed by `npx tsc --noEmit 2>&1 | grep "src/batch.ts"` returning empty
- This is a pre-existing issue outside Phase 6 scope; all 153 tests pass

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or trust-boundary schema changes were introduced. `src/batch.ts` is a pure compute module; the MCP/OAuth boundary is Phase 7. Threat model T-06-01/02/03/04 mitigations are implemented and verified:

| Threat | Mitigation | Test |
|--------|-----------|------|
| T-06-01 DoS: unbounded concurrency | Worker-cursor pool caps peak at cfg.concurrency | BATCH-03 peak counter |
| T-06-02 DoS: oversized batch | Pre-dispatch cap throws before any runTask | BATCH-04 zero-dispatch spy |
| T-06-03 DoS: hung task / orphaned promise | withTimeout + two-handler settle-once | BATCH-05 late-settle test |
| T-06-04 Info disclosure: error stack | err.message only (not stack) in error entry | per-task catch in executeBatch |

## Self-Check

Files exist:
- [x] src/batch.ts
- [x] src/__tests__/batch.test.ts

Commits exist:
- [x] 2a50d51 feat(06-01): implement pure batch engine in src/batch.ts
- [x] 87100e2 test(06-01): add four headline batch tests in src/__tests__/batch.test.ts

Test suite: 153 passed (145 existing + 8 new)
src/index.ts: UNTOUCHED (git diff --quiet src/index.ts exits 0)
