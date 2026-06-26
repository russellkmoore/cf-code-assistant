---
phase: 06-batch-core-bounded-pool-timeout
reviewed: 2026-06-26T02:20:00Z
depth: standard
files_reviewed: 2
files_reviewed_list:
  - src/batch.ts
  - src/__tests__/batch.test.ts
findings:
  critical: 0
  warning: 3
  info: 4
  total: 7
status: issues_found
---

# Phase 6: Code Review Report

**Reviewed:** 2026-06-26T02:20:00Z
**Depth:** standard
**Files Reviewed:** 2
**Status:** issues_found

## Summary

Reviewed the pure, env-free batch engine (`src/batch.ts`) and its test suite. All
8 tests pass and `tsc --noEmit` reports no errors in the batch files (the only tsc
errors are pre-existing and confined to `auth-flow.test.ts`, out of scope).

The core invariants hold:
- `mapWithConcurrency` is a genuine bounded worker-cursor pool (fixed worker count
  pulling from a shared `cursor++`), NOT `Promise.all` over the task array. Peak
  in-flight is capped at `workerCount ≤ limit`. (lines 78-95)
- `executeBatch` performs the over-cap check (lines 120-126) BEFORE calling
  `mapWithConcurrency`, so no task is dispatched on rejection. Verified by test
  BATCH-04.
- Order preservation is via `results[i] = ...` index-write into a pre-sized array
  (line 90), never `push`. Verified by BATCH-06.
- `withTimeout` uses the settle-once + two-handler `.then(onResolve, onReject)`
  form (lines 109-112); a late orphan settle is a no-op against the already-settled
  promise. Verified by BATCH-05.
- Failure isolation works because `fn` inside `executeBatch` wraps `withTimeout` in
  try/catch (lines 130-141), converting throws to `status:'error'` entries.
- Zero new runtime dependencies; pure functions with injected `runTask`.

The findings below are robustness and quality concerns, not correctness failures
under current internal usage. The most important is WR-01: `mapWithConcurrency` is
exported as a public API but its isolation guarantee only holds when the caller
hands it a non-throwing `fn`.

## Warnings

### WR-01: `mapWithConcurrency` fail-fast on rejection contradicts its documented "order-preserving / bounded" contract when used standalone

**File:** `src/batch.ts:86-93`
**Issue:** The worker loop `await fn(items[i], i)` (line 90) is unguarded. If `fn`
rejects, the worker's promise rejects, and `Promise.all(...)` (line 93) rejects
immediately — aborting the whole map and leaving the other in-flight workers'
promises orphaned (their eventual settle becomes an unhandled rejection if they
also throw). This is the exact failure mode the file header warns against ("one
task failing never aborts the others"). It is currently masked because the only
caller, `executeBatch`, passes a try/catch-wrapped `fn` (lines 130-141) that never
throws. But `mapWithConcurrency` is a named export (line 151), so any future caller
(or a Phase 7 integration that forgets the wrapper) silently loses isolation. There
is no test exercising `mapWithConcurrency` with a throwing `fn`.
**Fix:** Either document the precondition explicitly in the signature, or harden the
loop so a throwing `fn` cannot abort siblings:
```typescript
const worker = async () => {
  while (true) {
    const i = cursor++;
    if (i >= items.length) return;
    try {
      results[i] = await fn(items[i], i);
    } catch (err) {
      // Re-throw is the caller's contract; if isolation is intended, the
      // caller's fn must catch. At minimum, add a unit test that pins the
      // chosen behavior so Phase 7 wiring can't regress it.
      throw err;
    }
  }
};
```
Add a unit test that calls `mapWithConcurrency` directly with a rejecting `fn` to
pin the intended behavior (fail-fast vs. isolate). Right now the contract is
implicit and untested.

### WR-02: `withTimeout` leaks the timer when `run()` throws synchronously

**File:** `src/batch.ts:102-113`
**Issue:** `run(ctrl.signal)` is invoked on line 109. If `run` throws *synchronously*
(rather than returning a rejected promise), the exception escapes the executor
before `.then(...)` is attached. The Promise constructor catches it and rejects the
outer promise — but `clearTimeout(timer)` is never reached, so the timer keeps
running and fires its callback at `ms`, calling `ctrl.abort()` and `reject(...)` on
an already-settled promise. The reject is a harmless no-op, but the dangling timer
and needless `abort()` are avoidable, and in a Workers environment a lingering timer
can keep the request alive longer than necessary. A `runTask` that does input
validation with an early `throw` (plausible in Phase 7) would hit this.
**Fix:** Wrap the call so synchronous throws clear the timer:
```typescript
const timer = setTimeout(() => {
  ctrl.abort();
  reject(new Error(`Task exceeded ${ms}ms timeout`));
}, ms);
Promise.resolve()
  .then(() => run(ctrl.signal))
  .then(
    (v) => { clearTimeout(timer); resolve(v); },
    (e) => { clearTimeout(timer); reject(e); },
  );
```
Wrapping in `Promise.resolve().then(() => run(...))` converts a synchronous throw
into a rejection that flows through the `onReject` handler, which clears the timer.

### WR-03: `id`/`index` correlation can produce duplicate `id`s when only some tasks supply one

**File:** `src/batch.ts:129`
**Issue:** `const id = task.id ?? String(index)`. The header advertises results as
"id-correlated." If task at index 3 omits `id`, it is assigned `"3"`. If another
task elsewhere has an explicit `task.id === "3"`, two result entries now share
`id:"3"`. Callers keying a result map by `id` (a natural Phase 7 consumer pattern)
would collide and lose a result. `index` is unique, so the data isn't lost, but the
documented `id` correlation is not actually guaranteed to be unique.
**Fix:** Either (a) document that `index` is the authoritative correlation key and
`id` is a non-unique label, or (b) namespace the fallback to avoid collision with
caller-supplied ids, e.g. `task.id ?? \`#${index}\`` (still collidable but less
likely), or (c) reject/normalize duplicate ids in `executeBatch` before dispatch.
Option (a) plus a one-line comment is the lowest-risk fix.

## Info

### IN-01: `readBatchConfig` is exported and depends on `env` but the engine is declared "env-free"

**File:** `src/batch.ts:27-41, 151`
**Issue:** The file header (lines 1-5) states "No AI bindings, no env dependency."
`readBatchConfig(env)` reads from an env-like record, which is the only env coupling
in the file. This is intentional (the *engine* — `executeBatch`/`mapWithConcurrency`/
`withTimeout` — is env-free; config reading is a separate concern) but the header
wording slightly overstates it. The env vars `BATCH_CONCURRENCY`, `BATCH_MAX_TASKS`,
`BATCH_TASK_TIMEOUT_MS` are not yet declared in `wrangler.toml` — fine for Phase 6
(Phase 7 wires it), but flag so it isn't forgotten.
**Fix:** Reword the header to "the batch *engine* takes no env" and note that
`readBatchConfig` is the single env adapter. Track the `wrangler.toml` var
declarations as a Phase 7 task.

### IN-02: `limit <= 0` is silently coerced to 1 worker rather than rejected

**File:** `src/batch.ts:85`
**Issue:** `Math.max(1, Math.min(limit, items.length))` means a caller passing
`limit = 0` or a negative value silently runs sequentially with 1 worker instead of
erroring. `readBatchConfig` guards `concurrency > 0`, so `executeBatch` is safe, but
`mapWithConcurrency` is a public export and a caller could pass `0`.
**Fix:** Acceptable as defensive defaulting, but consider a comment documenting that
`limit <= 0` degrades to single-worker rather than throwing, so the behavior is
intentional and not mistaken for a bug.

### IN-03: `while (true)` worker loop relies solely on the cursor bound to terminate

**File:** `src/batch.ts:87-91`
**Issue:** `while (true)` with `const i = cursor++; if (i >= items.length) return;`
is correct (single-threaded JS means no cursor race), but `while (true)` is a code
smell that invites scrutiny. The termination guard is sound only because every
iteration increments `cursor` before the bounds check.
**Fix:** Optional readability improvement — express the bound directly:
```typescript
const worker = async () => {
  for (let i = cursor++; i < items.length; i = cursor++) {
    results[i] = await fn(items[i], i);
  }
};
```
Functionally identical, but the loop's termination is self-evident.

### IN-04: Test suite has no direct coverage of `mapWithConcurrency` or `withTimeout`, and no empty-batch / single-task-pool cases

**File:** `src/__tests__/batch.test.ts` (whole file)
**Issue:** Both `mapWithConcurrency` and `withTimeout` are exported (line 151 of
batch.ts) but tested only indirectly through `executeBatch`. Untested edge cases
that matter for the invariants: empty `tasks` array (does `executeBatch` return
`total:0` cleanly?), `concurrency >= tasks.length` (worker count clamps correctly),
and `mapWithConcurrency` with a throwing `fn` (see WR-01). The late-settle test
(lines 138-163) asserts "reaching here = pass" but does not install an
`unhandledRejection` listener, so a real unhandled rejection might not actually fail
the test in all runner configurations.
**Fix:** Add direct unit tests for the two helpers, plus an empty-batch case for
`executeBatch`. For the late-settle test, register a `process.on('unhandledRejection')`
(or equivalent vitest hook) that fails the test if fired, so the guarantee is
actively verified rather than implied.

---

_Reviewed: 2026-06-26T02:20:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
