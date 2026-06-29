---
phase: 10-batch-per-task-cancellation-and-tier-override
fixed_at: 2026-06-29T19:25:00Z
review_path: .planning/phases/10-batch-per-task-cancellation-and-tier-override/10-REVIEW.md
iteration: 1
findings_in_scope: 4
fixed: 4
skipped: 0
status: all_fixed
---

# Phase 10: Code Review Fix Report

**Fixed at:** 2026-06-29T19:25:00Z
**Source review:** .planning/phases/10-batch-per-task-cancellation-and-tier-override/10-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 4 (CR-01, WR-01, WR-02, WR-03)
- Fixed: 4
- Skipped: 0

All 173 tests green (+ 1 skipped) throughout. `npx tsc --noEmit` clean after all fixes.

## Fixed Issues

### CR-01: Pre-aborted external signal causes `timeoutPromise` to never settle

**Files modified:** `src/index.ts`
**Commit:** 28a7c09
**Applied fix:** Added a synchronous `controller.signal.aborted` check at the top of the `timeoutPromise` constructor (before registering the `addEventListener`). When the controller is already aborted before the constructor runs — the case that occurs when `externalSignal.aborted` is true on entry — the `Promise` now rejects immediately with `new Error("AI_TIMEOUT")` and returns. This closes the permanent-hang path identified in the review. The `{ once: true }` option was also added to the `addEventListener` call in the same change (resolving WR-02 in the same commit, since WR-02 was adjacent and the fix touched the same lines).

**Verification:** Re-read confirmed fix text present; test suite 173/1 green.

---

### WR-01: `latency_ms` always `0` for internal-timeout failures in batch results

**Files modified:** `src/index.ts`, `src/__tests__/batch-tool.test.ts`
**Commit:** 58d0d7b
**Applied fix:** Added a secondary condition in the `runBatch` enrichment block: when the regex `/exceeded (\d+)ms timeout/` does not match but the error string contains `"AI_TIMEOUT"` (case-insensitive), `latency_ms` falls back to `cfg.taskTimeoutMs` (the configured batch task timeout). This gives meaningful latency telemetry when `callModel`'s internal 45s timer fires before `withTimeout`'s timer.

The test helper `enrich()` in `batch-tool.test.ts` was updated in parallel to mirror the same fallback logic, with an optional `taskTimeoutMs` parameter (default `0`, backward-compatible). All existing test assertions still pass because the tests exercise the `"Task exceeded 5000ms timeout"` format which matches the original regex.

**Verification:** Re-read confirmed both files updated correctly; test suite 173/1 green.

---

### WR-02: `timeoutPromise` abort listener registered without `{ once: true }`

**Files modified:** `src/index.ts`
**Commit:** 28a7c09 (resolved as part of CR-01 fix)
**Applied fix:** The `{ once: true }` option was added to `controller.signal.addEventListener` inside the `timeoutPromise` constructor as part of the CR-01 fix. Since CR-01 required rewriting the same block (adding the synchronous `aborted` check), WR-02 was addressed in the same edit and committed atomically with CR-01.

**Verification:** Re-read at CR-01 stage confirmed `{ once: true }` is present; test suite 173/1 green.

---

### WR-03: Tier override with incompatible `maxTokens` not validated

**Files modified:** `src/index.ts`
**Commit:** 57ea607
**Applied fix:** Used the reviewer's alternative approach (documentation as caller responsibility) rather than the `TIER_MAX_TOKENS` cap table, because an existing test (`"tier override does NOT change max_tokens — kind's maxTokens is always used"`) explicitly asserts that `max_tokens` is always taken from the spec regardless of tier override. Adding a `Math.min` cap would have broken that test and altered a deliberately documented behavioral contract.

Instead: the `BatchTaskInputSchema.tier` Zod description was expanded with a warning identifying which kinds carry high `maxTokens` (8192: `generateCode`, `scaffoldTests`, `fixBug`, `generateWorkerBoilerplate`) and advising callers to prefer low-maxTokens kinds when overriding to the fast tier. A matching comment was added inside `runTask` cross-referencing the schema description. This makes the risk visible to MCP clients that inspect the schema, without silently capping behavior or breaking existing tests.

**Verification:** Re-read confirmed description and comment present; `npx tsc --noEmit` clean; test suite 173/1 green.

---

_Fixed: 2026-06-29T19:25:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
