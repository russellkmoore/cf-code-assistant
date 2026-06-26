# Phase 6: Batch Core + Bounded Pool + Timeout - Research

**Researched:** 2026-06-26
**Domain:** Pure TypeScript concurrent worker-pool engine for a Cloudflare Workers MCP server
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**D-01 — Per-task timeout default + layering**
- Default is 45000ms (= `AI_TIMEOUT_MS`), read from `BATCH_TASK_TIMEOUT_MS`.
- The 60000ms value in the reference `.planning/batch.ts` is a generic placeholder and is NOT adopted.
- `callModel` owns an internal `AbortController` firing at `AI_TIMEOUT_MS` (45s) and takes no external signal. For a real AI call the two deadlines converge — `withTimeout` exists primarily to bound promises that hang past the inner abort (fake/never-resolving `runTask` in tests; any future signal-ignoring path).
- PROJECT.md's "60000ms" blurb is stale vs ROADMAP/REQUIREMENTS. Correcting PROJECT.md is out of this phase's scope.

**D-02 — Env→config boundary**
- `src/batch.ts` ships both the pure `executeBatch(tasks, cfg, runTask)` (plain `BatchConfig`, fully env-free) AND the impure adapter `readBatchConfig(env) → BatchConfig`.
- Defaults (concurrency 6 / maxTasks 50 / taskTimeoutMs 45000) are engine concerns, so the parser lives with the engine.
- `BatchConfig` is `{ concurrency, maxTasks, taskTimeoutMs }`. `readBatchConfig` reads `BATCH_CONCURRENCY` / `BATCH_MAX_TASKS` / `BATCH_TASK_TIMEOUT_MS` with the guard `Number.isFinite(n) && n > 0 ? Math.floor(n) : default`.
- `executeBatch` itself never touches `env`. Tests pass a literal `{ concurrency, maxTasks, taskTimeoutMs }`.

**D-03 — Engine shape: concrete-typed envelope**
- `executeBatch` is typed to a `BatchTask` and reads `task.id` / `task.kind`.
- Per-task envelope emitted this phase: ok → `{ id, index, kind, status: 'ok', result }` / error → `{ id, index, kind, status: 'error', error }` using `as const` status literals.
- `id` defaults to `String(index)` when the task omits it (`task.id ?? String(index)`).
- Phase 7 enriches the envelope with `latency_ms` and `error_type`. Phase 6 stops at `{id, index, kind, status, result|error}`.
- `executeBatch` returns `{ total, succeeded, failed, results }`. `failedIds` and text summary are Phase 7 additions.
- `BatchTask.kind` mirrors the real 11 AI-backed kinds from Phase 5's exported `TaskKind` (generateCode, reviewCode, transformCode, scaffoldTests, quickTask, explainCode, generateDocs, generateTypes, fixBug, generateCommitMessage, generateWorkerBoilerplate). NOT the reference's placeholder 5-kind enum.
- `input` is an open record (`Record<string, unknown>`); per-kind validation is not re-done here (it lives in Phase 5's `runTask`).

**D-04 — Mechanics: locked by roadmap success criteria**
- D-04a (bounded pool): `mapWithConcurrency<T, R>(items, limit, fn)` is fully generic. Fixed set of `Math.max(1, Math.min(limit, items.length))` workers pulling from a shared `cursor++`. Writes `results[i] = await fn(items[i], i)` into a pre-sized `new Array(items.length)`. Never a naive `Promise.all` over the whole task array.
- D-04b (fast cap): `executeBatch` rejects before any dispatch when `tasks.length > cfg.maxTasks`, with an actionable "split it into smaller batches" message mentioning the `BATCH_MAX_TASKS`/subrequest rationale.
- D-04c (order + isolation): Index-write into the pre-sized array. Each task's `runTask` call is wrapped in `try/catch` so one throw yields one `status:'error'` entry while siblings still return `status:'ok'`. Never `push`.
- D-04d (`withTimeout`): The two-handler `.then(onResolve, onReject)` form is mandatory. Exactly: `new Promise((resolve, reject) => { const timer = setTimeout(() => { ctrl.abort(); reject(...) }, ms); run(ctrl.signal).then(v => {clearTimeout(timer); resolve(v)}, e => {clearTimeout(timer); reject(e)}) })`. A late-settling orphaned promise hits an already-settled Promise → no double-settle, no unhandled rejection.

**D-05 — Injected runner port**
- `type RunTask = (task: BatchTask, signal: AbortSignal) => Promise<unknown>` (signal-aware for forward compatibility).
- `withTimeout` passes a best-effort `AbortSignal`; the signal is free future-proofing for BATCH-F01 true cancellation.
- In tests the injected `runTask` is a plain fake (deferred, throwing, slow, late-resolving variants). No `env`, no AI mock.
- In Phase 7 the injected adapter maps a `BatchTask` → `runTask(env, kind, input)` and ignores the signal.

### Claude's Discretion
- Exact wording of the over-cap error message (must be actionable + mention splitting / the `BATCH_MAX_TASKS`/subrequest rationale) and of the timeout error message.
- Internal naming (`BatchTask`, `BatchConfig`, `RunTask`, `TaskResult` union) and whether the per-task envelope is a hand-written TS type or derived — provided D-03's shape holds and no new runtime dependency is added.
- Whether `BatchTask`/result types are expressed as plain TS types in Phase 6 (Zod schemas are a Phase 7 concern).
- Test file organization under `src/__tests__/` (e.g. `batch.test.ts`).

### Deferred Ideas (OUT OF SCOPE)
- Phase 7: `code_assist_batch` registration, Zod in/out schemas, `structuredContent` + text summary, per-task `latency_ms` + `error_type`, `summary.failedIds`, MCP annotations.
- BATCH-F01 (future milestone): true per-task cancellation threaded into `env.AI.run`.
- PROJECT.md "Target features" blurb says 60000ms — stale vs ROADMAP/REQUIREMENTS (45000). Correct in a docs pass, out of this phase.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BATCH-03 | The batch runs tasks through a fixed-size worker pool whose in-flight count never exceeds the cap (default 6, `BATCH_CONCURRENCY`) — no naive `Promise.all` over all tasks | `mapWithConcurrency` cursor-pool pattern; deferred-mock in-flight-counter test shape |
| BATCH-04 | A batch with more than the per-call cap (default 50, `BATCH_MAX_TASKS`) is rejected fast with an actionable error before any task is dispatched | Pre-dispatch cap check in `executeBatch`; spy-asserts-zero-calls test shape |
| BATCH-05 | Each task is bounded by a per-task timeout (45000ms, `BATCH_TASK_TIMEOUT_MS`) enforced by a `Promise.race`; a timed-out task yields a `status:'error'` entry without hanging the batch and without producing an unhandled rejection when the orphaned AI call settles late | `withTimeout` settle-once two-handler form; late-resolve test with `AbortController` |
| BATCH-06 | Results are order-preserving by index and failure-isolated — one slow or throwing task never stalls or aborts its siblings, which still return `status:'ok'` | Index-write into pre-sized array; per-task `try/catch` in `mapWithConcurrency`'s `fn` |
</phase_requirements>

---

## Summary

Phase 6 creates `src/batch.ts` — a pure, env-free batch engine exporting `executeBatch`, `mapWithConcurrency`, `withTimeout`, and `readBatchConfig`. The entire file is testable with a fake `runTask` and zero Worker-runtime machinery. Phase 5 has already extracted `runTask` from `src/index.ts` and the project is at 145 green tests; this phase adds new tests only in `src/__tests__/batch.test.ts`.

The three core algorithms are well-understood and have a reference implementation in `.planning/batch.ts`. The planner's job is to adapt that reference: update the task-kind enum from 5 placeholder values to the real 11 `TaskKind` values, change the timeout default from 60000 to 45000, drop all Phase 7 content (Zod output schema, `registerBatchTool`, `structuredContent`, `failedIds`, `latency_ms`, `error_type`), and emit the concrete-typed envelope decided in D-03. All four success criteria map to exactly four test shapes described in detail below.

The scope is intentionally narrow: `src/index.ts` is untouched. The verify gate is `npx tsc --noEmit` clean plus `npm test` green (145 existing + new batch tests).

**Primary recommendation:** Adapt `.planning/batch.ts` per D-01/D-03/D-05 as the single source. Keep the two-handler `.then(onResolve, onReject)` form in `withTimeout` unchanged — it is the load-bearing guard against the orphaned-late-settle unhandled-rejection. The four headline test cases (in-flight cap counter, zero-dispatch spy, inverted-duration order, late-resolve no-double-settle) are the verification backbone.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Bounded concurrency pool | New `src/batch.ts` module | — | Pure function, no env; can be unit-tested in isolation |
| Per-task timeout (wall-clock guarantee) | `withTimeout` in `src/batch.ts` | `callModel`'s internal 45s abort (convergent backstop) | `callModel` ignores external signals; `withTimeout` is the sole return guarantee |
| Per-call task cap enforcement | `executeBatch` pre-dispatch check | — | Must fire before any subrequest is consumed |
| Config parsing from env vars | `readBatchConfig` in `src/batch.ts` | — | Defaults are engine concerns; lives with the engine |
| Actual AI invocation | Phase 5's `runTask` (injected as `RunTask`) | — | Injection keeps the batch core env-free and testable |
| Task-kind enum | `TaskKind` from `src/index.ts` (imported) | — | One source of truth; `BatchTask.kind` mirrors it |
| Test harness | vitest + `@cloudflare/vitest-pool-workers` | — | Already installed (145 tests passing); pure batch tests need no Worker pool env |

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript (built-in) | 5.8.x | Types for `BatchTask`, `BatchConfig`, `RunTask`, result union | Already in devDeps; no Zod needed in Phase 6 (Phase 7 concern) |
| Web-standard globals | Workers V8 isolate | `AbortController`, `AbortSignal`, `setTimeout`, `clearTimeout`, `Promise.all` | Used verbatim in `callModel` today; zero new API risk |
| vitest | 4.1.4 (installed) | Test runner for the 4 batch test shapes | Already drives 145 green tests |

[VERIFIED: direct source read of `package.json` and `node_modules/`]

### Supporting

No new dependencies. The ~25-line inline pool in `.planning/batch.ts` covers the requirement exactly.

[VERIFIED: direct source read of `package.json` — `p-limit` is absent; not a dependency]

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Inline `mapWithConcurrency` (~18 lines) | `p-limit` | `p-limit` not in project; adding it violates the zero-new-deps constraint and adds supply-chain surface for 18 lines of logic |
| Cursor-based pool | Chunked `Promise.all` (run N, await, run next N) | Chunking wastes time when one slow task stalls its whole chunk; cursor pool keeps `concurrency` tasks always in flight |
| `Promise.race` + `setTimeout` for timeout | `AbortSignal.timeout(ms)` | `AbortSignal.timeout` only aborts the signal; it does NOT reject the outer promise when the executor ignores the signal — which `callModel` does. The race is what guarantees the batch returns. |

**Installation:** Nothing to install. All dependencies already present.

---

## Package Legitimacy Audit

No new external packages are introduced in this phase. The inline `mapWithConcurrency` pool replaces any candidate third-party concurrency library. This section is therefore empty by design.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| (none) | — | — | — | — | — | No new packages |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

---

## Architecture Patterns

### System Architecture Diagram

```
src/batch.ts (NEW — Phase 6 scope only)
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  readBatchConfig(env)                                           │
│  ─────────────────                                              │
│  reads BATCH_CONCURRENCY / BATCH_MAX_TASKS / BATCH_TASK_TIMEOUT │
│  returns plain { concurrency, maxTasks, taskTimeoutMs }         │
│                                                                 │
│  executeBatch(tasks, cfg, runTask)          ─── pure, env-free  │
│  ──────────────────────────────────────────                     │
│  tasks.length > cfg.maxTasks?                                   │
│    └─ throw Error("Batch has N tasks … split …") [zero dispatch]│
│                                                                 │
│  mapWithConcurrency(tasks, cfg.concurrency, perTask)            │
│  ──────────────────────────────────────────                     │
│  cursor = 0; results = new Array(tasks.length)                  │
│  workerCount = Math.max(1, Math.min(limit, items.length))       │
│  [workerCount independent workers, each]:                       │
│    i = cursor++;  if i >= tasks.length: return                  │
│    results[i] = await perTask(tasks[i], i)   ← index-write     │
│  await Promise.all([...workers])                                │
│                                                                 │
│  perTask(task, i):                                              │
│    id = task.id ?? String(i)                                    │
│    try                                                          │
│      result = await withTimeout(cfg.taskTimeoutMs,              │
│                   signal => runTask(task, signal))  ←injected  │
│      return { id, index:i, kind, status:'ok', result }         │
│    catch (err)                                                  │
│      return { id, index:i, kind, status:'error',               │
│               error: err.message ?? String(err) }              │
│                                                                 │
│  withTimeout(ms, run)                       ─── pure           │
│  ─────────────────────────────────────────                      │
│  ctrl = new AbortController()                                   │
│  return new Promise((resolve, reject) => {                      │
│    timer = setTimeout(() => { ctrl.abort(); reject(...) }, ms)  │
│    run(ctrl.signal).then(                                       │
│      v => { clearTimeout(timer); resolve(v) },   ← onResolve   │
│      e => { clearTimeout(timer); reject(e)  }    ← onReject    │
│    )                                                            │
│  })                                                             │
│                                                                 │
│  Exports: executeBatch, mapWithConcurrency, withTimeout,        │
│           readBatchConfig, BatchConfig, BatchTask, RunTask,     │
│           TaskResult (ok|error union)                           │
└─────────────────────────────────────────────────────────────────┘
          │                                          │
          │ injected RunTask                         │ (Phase 7 wires)
          ▼                                          ▼
  fake/deferred/slow/throwing mock          runTask(env, kind, input)
  (tests only — no env, no AI)             (src/index.ts, exported)
```

### Recommended Project Structure

```
src/
├── index.ts         # UNTOUCHED in Phase 6 (exports runTask, TaskKind — Phase 7 wires)
├── batch.ts         # NEW: executeBatch, mapWithConcurrency, withTimeout,
│                    #      readBatchConfig, BatchConfig, BatchTask, RunTask, TaskResult
├── logger.ts        # unchanged
└── __tests__/
    ├── batch.test.ts         # NEW (Phase 6): 4 headline test shapes (see below)
    └── (10 existing test files unchanged — 145 tests still green)
```

---

### Pattern 1: Cursor Worker Pool (the bounded-pool pattern)

**What:** A fixed number of worker coroutines each pull the next unprocessed index off a shared `cursor` variable. Each worker writes its result into a pre-sized array by index. The pool terminates when all workers' `while (true)` loops find `i >= items.length` and return. `Promise.all` over the fixed worker array (not the task array) collects them.

**When to use:** Any fan-out of N async units with a hard in-flight cap and stable output order. This is the only acceptable pattern — chunked `Promise.all` is explicitly banned by the project constraints.

**Critical distinction:** `Promise.all` over the *worker array* (length = `min(limit, N)`) is correct and bounded. `Promise.all` over the *task array* (length = N) is banned.

**Example (from `.planning/batch.ts`):**
```typescript
// Source: .planning/batch.ts lines 98–115
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
```

[VERIFIED: direct source read of `.planning/batch.ts`]

---

### Pattern 2: Settle-Once Timeout Wrapper (the `withTimeout` pattern)

**What:** A `Promise` constructor wraps a `setTimeout`-based reject and the actual task. The task's resolution (either direction) is attached using the **two-handler form** `.then(onResolve, onReject)` — this attaches a rejection handler to the inner promise so a late rejection from an orphaned task is always *handled* (hitting the already-settled outer reject), not unhandled.

**Why the two-handler form is mandatory:** If you use `.then(onResolve).catch(onReject)` or `.then(onResolve)` (bare), a late rejection from the orphaned task becomes an unhandled promise rejection event — noise in `wrangler tail` and potentially a crash in strict runtimes. The two-handler form is the only shape that handles the late settle silently.

**Example (from `.planning/batch.ts`):**
```typescript
// Source: .planning/batch.ts lines 119–131
function withTimeout<R>(ms: number, run: (signal: AbortSignal) => Promise<R>): Promise<R> {
  const ctrl = new AbortController();
  return new Promise<R>((resolve, reject) => {
    const timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`Task exceeded ${ms}ms timeout`));
    }, ms);
    run(ctrl.signal).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
```

[VERIFIED: direct source read of `.planning/batch.ts`]

**The late-settle invariant:** Once the outer Promise resolves or rejects (first settle), subsequent calls to `resolve`/`reject` from the orphaned task's `.then(onResolve, onReject)` are no-ops — the JS Promise contract guarantees a promise can only settle once. This is the guard the Phase 6 test for late-resolve validates explicitly.

---

### Pattern 3: Pre-Dispatch Cap Check with Zero-Dispatch Guarantee

**What:** `executeBatch` checks `tasks.length > cfg.maxTasks` as the very first operation and throws an actionable Error before any worker is spawned or any `runTask` is called.

**Why the wording matters:** The error message must mention (1) the actual count, (2) the limit, (3) the action ("split into smaller batches"), and (4) the rationale (subrequest budget). This gives the caller everything needed to self-correct.

**Example:**
```typescript
// Source: .planning/batch.ts lines 137–143
if (tasks.length > cfg.maxTasks) {
  throw new Error(
    `Batch has ${tasks.length} tasks but the per-call limit is ${cfg.maxTasks}. ` +
    `Split it into smaller batches. (Raise BATCH_MAX_TASKS only if your Workers ` +
    `plan's subrequest budget allows — each task is one subrequest.)`,
  );
}
```

[VERIFIED: direct source read of `.planning/batch.ts`]

---

### Pattern 4: Index-Write Order Preservation with Per-Task Failure Isolation

**What:** Inside `mapWithConcurrency`'s `fn` argument, each task is wrapped in `try/catch` that converts any throw (from `runTask` OR from `withTimeout`) into a `{status:'error', error}` object. The result object is always written by index into the pre-sized array — never pushed. This means `results[i].index === i` regardless of completion order.

**Critical point:** `fn` as called by `mapWithConcurrency` must NEVER reject — it always resolves to a result object. This prevents a task failure from bubbling to the `Promise.all([...workers])` which would abort all workers.

```typescript
// Source: .planning/batch.ts lines 145–158
const results = await mapWithConcurrency(tasks, cfg.concurrency, async (task, index) => {
  const id = task.id ?? String(index);
  try {
    const result = await withTimeout(cfg.taskTimeoutMs, (signal) => runTask(task, signal));
    return { id, index, kind: task.kind, status: "ok" as const, result };
  } catch (err) {
    return {
      id,
      index,
      kind: task.kind,
      status: "error" as const,
      error: err instanceof Error ? err.message : String(err),
    };
  }
});
```

[VERIFIED: direct source read of `.planning/batch.ts`]

---

### Pattern 5: `readBatchConfig` with Positive-Finite-Integer Guard

**What:** A minimal int-parser that validates an env-var string is a positive finite integer, falling back to a hardcoded default otherwise. This makes `readBatchConfig` unit-testable with a plain object (no Workers `Env` binding).

```typescript
// Source: .planning/batch.ts lines 26–39 (adapted: default 60000 → 45000 per D-01)
export function readBatchConfig(env: Record<string, string | undefined>): BatchConfig {
  const int = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
  };
  return {
    concurrency: int(env.BATCH_CONCURRENCY, 6),
    maxTasks:    int(env.BATCH_MAX_TASKS, 50),
    taskTimeoutMs: int(env.BATCH_TASK_TIMEOUT_MS, 45_000),   // D-01: 45000, not 60000
  };
}
```

[VERIFIED: direct source read of `.planning/batch.ts`, adapted per D-01]

---

### Anti-Patterns to Avoid

- **`Promise.all(tasks.map(runTask))`:** Unbounded concurrency. Fires all N subrequests at once, risks Workers AI 429s and subrequest limit overruns. One rejection aborts the entire aggregate — violates partial-results contract. Explicitly banned.
- **`results.push(v)` in the worker:** Silently scrambles result-to-input correlation when tasks complete out of order. Use index-write only.
- **`run(ctrl.signal).then(onResolve).catch(onReject)` (chained catch):** Creates a new promise for the `.catch` — when the late orphaned rejection hits `onReject` via the chain, the original `reject` may already have been called, but the intermediate chained promise's rejection could be unhandled. Use the two-argument `.then(onResolve, onReject)` form.
- **`try/catch` around `mapWithConcurrency` instead of around each task:** Means the first task throw aborts the whole pool — siblings' completed results are lost.
- **Checking `cursor < items.length` before incrementing:** Must capture `i = cursor++` and then check `i >= items.length`. The post-increment + check is the race-condition-free form for cooperative async workers pulling from a shared counter.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Bounded concurrency | Custom semaphore / token-bucket / chunked Promise.all | `mapWithConcurrency` cursor pool from `.planning/batch.ts` | Already 100% specified; cursor pattern is the correct shape per D-04a |
| Per-task wall-clock timeout | Wrapping in `Promise.race` ad hoc | `withTimeout` from `.planning/batch.ts` (exact form) | The two-handler settle-once form is load-bearing; hand-rolling risks the orphaned-rejection bug |
| Env var parsing | Custom parsers | The `int(v, default)` guard in `readBatchConfig` | Handles NaN, Infinity, 0, negative, float, and undefined in 3 lines |
| Per-task isolation | Try/catch around the pool | Try/catch inside `fn` before returning a result object | Outer catch aborts all workers; inner catch preserves siblings |

**Key insight:** The `.planning/batch.ts` reference is functionally complete for Phase 6. The planner's job is to adapt it (3 concrete changes: kind enum, timeout default, drop Phase 7 bits) — not redesign.

---

## Common Pitfalls

### Pitfall 1: Orphaned Late-Settle → Unhandled Rejection
**What goes wrong:** A task's `runTask` resolves or rejects after the timeout has already rejected the outer `withTimeout` promise. If the inner promise has no rejection handler attached (bare `.then(onResolve)` without a second arg), the late rejection is unhandled — Workers logs a warning or crashes.
**Why it happens:** The reflex is `run(...).then(resolve).catch(reject)` — this creates a chain where a late rejection hits an intermediate promise whose catch is still attached. The outer Promise's `reject` has already been called, but the chained `.catch`'s callback calls an inert `reject` — this is safe. BUT: `.then(onResolve)` alone with no rejection handler leaves the late rejection unhandled entirely.
**How to avoid:** Strictly preserve the `.then(onResolve, onReject)` two-argument form. Both handlers are attached to the same promise; a late reject hits `onReject`, which calls the already-settled outer `reject` — a no-op.
**Warning signs:** Any refactor of `withTimeout` that changes `.then(v => ..., e => ...)` to `.then(v => ...).catch(e => ...)` is a semantic change, not a style change.

### Pitfall 2: Timeout Default vs Inner `AI_TIMEOUT_MS` Alignment
**What goes wrong:** Setting `BATCH_TASK_TIMEOUT_MS` ≤ 45000 means the `withTimeout` race fires first — the per-task error message says "exceeded Nms timeout" instead of the structured `AI_TIMEOUT` error from `callModel`. This makes all timeout errors look generic.
**Why it happens:** The locked default is 45000 (= `AI_TIMEOUT_MS`) per D-01. At exactly equal deadlines both races fire near-simultaneously; which fires first depends on event-loop scheduling.
**How to avoid:** D-01a documents this intentionally: for real AI calls the two deadlines converge, and `withTimeout` exists primarily to bound fake/never-resolving tasks in tests. Accept that real-AI timeout error messages will say "Task exceeded 45000ms timeout" rather than "AI_TIMEOUT" when the `withTimeout` wins the race. This is acceptable and expected per D-01.
**Warning signs:** Tests using a deferred/never-resolving mock will correctly produce the `withTimeout` error. Tests using the real AI (Phase 7/8) may see either error message.

### Pitfall 3: Index Capture in Worker Loop
**What goes wrong:** Worker code that reads `cursor` after the `await` instead of capturing it before: `const i = cursor; cursor++; ... results[i] = ...` is safe; but restructured code that re-reads `cursor` after an `await` is not, because other workers have advanced `cursor` in the meantime.
**Why it happens:** JavaScript is single-threaded, but `cursor++` must happen synchronously before the first `await` in each worker iteration.
**How to avoid:** Always capture: `const i = cursor++; if (i >= items.length) return;` — both the read and increment happen before any `await`.

### Pitfall 4: `mapWithConcurrency`'s `fn` Rejecting
**What goes wrong:** If `fn` (the per-task function) throws or rejects, the worker's `while` loop propagates the rejection to the worker promise, which then propagates to `Promise.all([...workers])` — aborting all remaining workers and losing their results.
**Why it happens:** `mapWithConcurrency` is fully generic and does not catch `fn` rejections internally. The per-task try/catch lives in `executeBatch`'s lambda passed as `fn`, not inside `mapWithConcurrency`.
**How to avoid:** Always wrap `fn` (the lambda passed to `mapWithConcurrency`) in try/catch — this is `executeBatch`'s responsibility. `mapWithConcurrency` itself must remain generic/pure.

### Pitfall 5: Importing Zod into `src/batch.ts` (Phase 6 scope violation)
**What goes wrong:** Phase 7 uses Zod for `BatchInputShape` and `BatchOutputShape`. Phase 6 must NOT import Zod — types are plain TypeScript (`interface BatchTask`, `type RunTask`, hand-written discriminated union for TaskResult).
**Why it happens:** The reference `.planning/batch.ts` imports Zod at the top. Phase 6 must drop those imports.
**How to avoid:** The Zod schema in `.planning/batch.ts` is the Phase 7 output schema and tool-registration layer — drop `import { z } from "zod"`, `BatchTaskSchema`, `BatchInputShape`, `BatchOutputShape`, `TaskResultSchema`, and `registerBatchTool` from the Phase 6 `src/batch.ts`. Plain TS types only.

---

## Code Examples

### The Four Required Test Shapes

These are the headline tests mandated by the four success criteria. The planner must ensure these exact scenarios are covered.

**Test Shape 1 — In-flight cap counter (BATCH-03)**
```typescript
// Source: CONTEXT.md D-04a + PITFALLS.md Pitfall 3 test shape
it("peak in-flight count never exceeds concurrency cap", async () => {
  let inFlight = 0;
  let peakInFlight = 0;

  const runTask = async (task: BatchTask, _signal: AbortSignal) => {
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    // never resolves — held open by a deferred promise
    await new Promise(() => {}); // in a real test, use a controllable deferred
    inFlight--;
    return "result";
  };

  // In practice: use a deferred that resolves on demand after measuring peak
  // Verify: peakInFlight <= cfg.concurrency after the batch completes
});
```

**Test Shape 2 — Zero-dispatch spy on over-cap (BATCH-04)**
```typescript
// Source: CONTEXT.md D-04b
it("rejects before any runTask call when tasks.length > maxTasks", async () => {
  const spy = vi.fn();
  const tasks = Array.from({ length: 51 }, (_, i) => ({
    id: String(i), kind: "quickTask" as TaskKind, input: { instruction: "x" }
  }));
  await expect(
    executeBatch(tasks, { concurrency: 6, maxTasks: 50, taskTimeoutMs: 45000 }, spy)
  ).rejects.toThrow(/split/i);
  expect(spy).not.toHaveBeenCalled();
});
```

**Test Shape 3 — Order preservation + failure isolation (BATCH-06)**
```typescript
// Source: CONTEXT.md D-04c — inverted durations: task 0 slow, task N fast
it("results[i].index === i with inverted durations, and error entries don't abort siblings", async () => {
  const tasks = [
    { id: "slow", kind: "quickTask" as TaskKind, input: {} },
    { id: "fast", kind: "quickTask" as TaskKind, input: {} },
    { id: "fail", kind: "quickTask" as TaskKind, input: {} },
  ];
  const runTask = async (task: BatchTask, _signal: AbortSignal) => {
    if (task.id === "slow") await delay(50);
    if (task.id === "fast") await delay(5);
    if (task.id === "fail") throw new Error("task failed");
    return "ok";
  };
  const { results } = await executeBatch(tasks, cfg, runTask);
  expect(results[0].index).toBe(0);
  expect(results[1].index).toBe(1);
  expect(results[2].index).toBe(2);
  expect(results[0].status).toBe("ok");
  expect(results[1].status).toBe("ok");
  expect(results[2].status).toBe("error");
});
```

**Test Shape 4 — Late-resolve no-double-settle, no unhandled rejection (BATCH-05)**
```typescript
// Source: CONTEXT.md D-04d — orphaned promise resolves after timeout
it("late resolve after timeout produces no double-settle and no unhandled rejection", async () => {
  let lateResolve!: (v: unknown) => void;
  const runTask = (_task: BatchTask, _signal: AbortSignal) =>
    new Promise((resolve) => { lateResolve = resolve; });

  const tasks = [{ id: "t0", kind: "quickTask" as TaskKind, input: {} }];
  const batchPromise = executeBatch(tasks, { concurrency: 1, maxTasks: 50, taskTimeoutMs: 10 }, runTask);

  // Wait for the batch to complete (timeout fires at 10ms)
  const { results } = await batchPromise;
  expect(results[0].status).toBe("error");
  expect(results[0].error).toMatch(/timeout/i);

  // Now resolve the orphaned promise — must be silent (no error, no crash)
  lateResolve("late value");
  // Allow microtasks to flush
  await new Promise(r => setTimeout(r, 0));
  // If we reach here without an unhandled rejection, the test passes
});
```

---

### `BatchTask` Type Shape (Phase 6 — plain TS, no Zod)

```typescript
// Phase 6 src/batch.ts — plain TS types, no Zod import
import type { TaskKind } from "./index"; // the real 11-kind union from Phase 5

export interface BatchTask {
  id?: string;
  kind: TaskKind;
  input: Record<string, unknown>;
}

export interface BatchConfig {
  concurrency: number;
  maxTasks: number;
  taskTimeoutMs: number;
}

export type RunTask = (task: BatchTask, signal: AbortSignal) => Promise<unknown>;

type TaskResultOk = {
  id: string;
  index: number;
  kind: TaskKind;
  status: "ok";
  result: unknown;
};

type TaskResultError = {
  id: string;
  index: number;
  kind: TaskKind;
  status: "error";
  error: string;
};

export type TaskResult = TaskResultOk | TaskResultError;
```

[ASSUMED] — The exact type names are Claude's discretion per CONTEXT.md. The shapes above reflect D-03 requirements.

---

## Cloudflare Workers Subrequest Limits Context

[VERIFIED: direct source read of `.planning/research/ARCHITECTURE.md` and `.planning/research/PITFALLS.md`]

| Plan | Subrequest Limit | Implication |
|------|------------------|-------------|
| Free | 50 per request | `BATCH_MAX_TASKS=50` leaves no headroom; consider documenting this in the error message |
| Paid | 1000 per request | `BATCH_MAX_TASKS` can safely be raised by env var override |

Each `env.AI.run()` call is one subrequest. KV reads (`env.OAUTH_KV.get`) are NOT subrequests. Pool concurrency bounds simultaneity, not total count — both caps matter independently.

**Timeout interaction with subrequest budget:** A timed-out task still holds its subrequest until `callModel`'s internal 45s abort fires. Under a near-cap batch with several timeouts, leaked in-flight calls can push toward the per-request subrequest ceiling. The concurrency default of 6 and the task cap of 50 are jointly calibrated for this.

---

## Upstream Phase 5 Interface (what Phase 6 imports)

Phase 5 has shipped. The following are confirmed exports from `src/index.ts` (verified by direct source read at lines 871–872):

```typescript
// From src/index.ts:871-872
export { ..., runTask, TASK_SPECS, ValidationError };
export type { ..., AIResult, TaskKind };
```

Phase 6 uses `TaskKind` as the `kind` field type on `BatchTask`. It does NOT call `runTask` directly — the engine takes an injected `RunTask` callback. The wiring (`BatchTask → runTask(env, kind, input)`) is Phase 7's responsibility.

The `callModel` function (src/index.ts:130–166):
- Owns its own `AbortController` with `AI_TIMEOUT_MS = 45_000` (line 26)
- Takes NO external `AbortSignal` parameter
- Rejects with `new Error("AI_TIMEOUT")` when the internal timeout fires
- Therefore, `withTimeout`'s `signal.abort()` is a no-op against a real AI call

This is the reason `withTimeout` uses a `Promise.race` (not just a signal) as the actual wall-clock guarantee.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Chunked `Promise.all` batches | Cursor-based worker pool | Established pattern for Workers fan-out | Eliminates slow-task stall, maintains constant concurrency |
| Bare `.then(resolve)` timeout wrapper | Two-handler `.then(onResolve, onReject)` | Known Node.js/Workers pitfall | Prevents unhandled rejection from orphaned late-settle |
| `push` for async result collection | Pre-sized array index-write | Known concurrency bug | Preserves correlation even with completion-order variation |
| Zod schema in batch engine core | Plain TS types in engine, Zod only at MCP boundary (Phase 7) | Architectural boundary decision | Keeps engine import-clean and env-free |

**Deprecated/outdated patterns in the reference `.planning/batch.ts` that must NOT be carried into Phase 6:**
- `import { z } from "zod"` — only valid in Phase 7
- `BatchTaskSchema = z.object({...})` with 5-kind placeholder enum — replace with `interface BatchTask` using `TaskKind`
- `registerBatchTool(server, deps)` — Phase 7 only
- `taskTimeoutMs: int(env.BATCH_TASK_TIMEOUT_MS, 60_000)` — must be 45_000 per D-01
- `latency_ms`, `error_type`, `failedIds` in any form — Phase 7 enrichment

---

## Environment Availability

Phase 6 creates a pure module (`src/batch.ts`) with no external dependencies or service calls. The test file (`src/__tests__/batch.test.ts`) uses vitest's fake timers and in-process deferred promises — no Worker pool environment needed for the pure engine tests.

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| vitest | Test runner | ✓ | 4.1.4 | — |
| TypeScript | `tsc --noEmit` gate | ✓ | 5.8.x | — |
| `@cloudflare/vitest-pool-workers` | Existing tests (NOT needed for new batch tests) | ✓ | 0.14.3 | — |

**Missing dependencies with no fallback:** none
**Missing dependencies with fallback:** none

The existing test suite runs in `cloudflarePool` mode but the new `batch.test.ts` tests the pure engine with no Worker bindings. Whether to opt the pure tests into or out of `cloudflarePool` is Claude's discretion (either works; the pool adds overhead but the pure tests are fast regardless).

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 4.1.4 |
| Config file | `vitest.config.mts` (uses `cloudflarePool`) |
| Quick run command | `npm test` |
| Full suite command | `npm test` (all 9+ files, currently 145 tests) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| BATCH-03 | Peak in-flight count ≤ `cfg.concurrency` | unit | `npm test -- --reporter=verbose src/__tests__/batch.test.ts` | ❌ Wave 0 |
| BATCH-04 | Over-cap batch throws before any `runTask` call (spy asserts zero calls) | unit | same | ❌ Wave 0 |
| BATCH-05 | Timeout produces `status:'error'` entry; late resolve is silent (no double-settle, no unhandled rejection) | unit | same | ❌ Wave 0 |
| BATCH-06 | Inverted-duration batch: `results[i].index === i`; throwing task yields one error entry, siblings ok | unit | same | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm test`
- **Per wave merge:** `npm test` (full suite — 145 existing + new batch tests must all pass)
- **Phase gate:** Full suite green + `npx tsc --noEmit` clean before proceeding to Phase 7

### Wave 0 Gaps
- [ ] `src/__tests__/batch.test.ts` — covers BATCH-03, BATCH-04, BATCH-05, BATCH-06 (all four shapes)
- [ ] `src/batch.ts` — the implementation file itself (created as Wave 0 / Wave 1 task 1)

*(Existing test infrastructure covers all other files — no conftest, no framework install needed)*

---

## Security Domain

This phase creates a pure engine module with no network calls, no auth, and no user-visible input handling. It does not introduce new attack surface beyond what was already analyzed in v1.0 phases.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Phase 6 code is called only from within the already-authenticated MCP handler |
| V3 Session Management | no | Stateless pure function |
| V4 Access Control | no | Tool access controlled by existing OAuth gate |
| V5 Input Validation | partial | Per-task `runTask` call is injected; in Phase 7 the adapter calls Phase 5's `runTask` which validates per-kind. Phase 6's `BatchTask.input` is an open record — validation is explicitly deferred to the injected executor. |
| V6 Cryptography | no | No crypto in this module |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Error message leaking stack traces | Information disclosure | `err instanceof Error ? err.message : String(err)` — message only, no stack (consistent with v1.0 logger discipline) |
| Over-cap bypass | Denial of service (subrequest exhaustion) | Pre-dispatch cap check is first operation in `executeBatch`; cannot be bypassed by task content |
| Timeout starvation (never-resolving task consuming a worker slot) | DoS | `withTimeout` guarantees the worker slot is released at `taskTimeoutMs`; orphaned AI call eventually self-terminates at `callModel`'s internal 45s |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `BatchTask`/result types will be expressed as plain TS types (no Zod) in Phase 6 | Standard Stack, Code Examples | Low — if planner opts for Zod, it will conflict with CONTEXT.md D-03 which says "Zod schemas are a Phase 7 concern"; must use plain TS |
| A2 | `batch.test.ts` will run inside `cloudflarePool` (the existing vitest config) | Validation Architecture | Low — pure engine tests work in either pool or standard vitest; performance difference is negligible |
| A3 | `src/batch.ts` imports `TaskKind` from `./index` as a type import | Code Examples | Low — alternative is to redeclare the union locally; importing keeps one source of truth and matches CONTEXT.md D-03c |

**If this table is short:** Most claims in this research were verified against direct source reads of the actual codebase (package.json, src/index.ts, .planning/batch.ts, .planning/research/*.md, 06-CONTEXT.md). The only truly assumed items are Claude's-discretion choices about type declaration style.

---

## Open Questions

1. **`npm test` vs. vitest `--pool=threads` for pure batch tests**
   - What we know: existing tests use `cloudflarePool`, which adds ~3s startup. Pure batch tests need no Worker bindings.
   - What's unclear: whether to add a separate vitest config for pure tests or accept the pool overhead.
   - Recommendation: Accept the pool overhead for simplicity — one test command, one config. The pool correctly handles plain async/await, and the batch tests are fast (< 100ms).

2. **`vi.useFakeTimers()` for timeout tests**
   - What we know: `setTimeout`-based timeouts require either real delays or fake timers in tests.
   - What's unclear: whether vitest's fake timer support in `cloudflarePool` mode works correctly.
   - Recommendation: Use real short timeouts (10ms) for the timeout test rather than fake timers to avoid potential `cloudflarePool` + fake-timer interaction issues. The deferred-mock approach (Task Shape 4) with a 10ms timeout and a `setTimeout(r, 0)` flush is simpler and more reliable.

---

## Sources

### Primary (HIGH confidence)
- `.planning/batch.ts` — reference engine implementation; all four patterns verified by direct source read
- `src/index.ts` lines 26, 130–166, 203–391, 871–872 — `AI_TIMEOUT_MS`, `callModel`, `TASK_SPECS`/`runTask`, export line; verified by direct source read
- `.planning/phases/06-batch-core-bounded-pool-timeout/06-CONTEXT.md` — locked decisions D-01 through D-05
- `.planning/research/ARCHITECTURE.md` — component responsibilities, data flow, Workers subrequest limits
- `.planning/research/PITFALLS.md` — all 8 pitfalls with `this-codebase` specificity
- `.planning/research/STACK.md` — zero-new-deps verdict, installed version confirmation
- `package.json` + `node_modules/` — vitest 4.1.4, no `p-limit`, zod 4.3.6, @modelcontextprotocol/sdk 1.29.0
- `src/__tests__/helpers.ts` — `createMockEnv`, `createMockAI` patterns for test construction

### Secondary (MEDIUM confidence)
- `.planning/codebase/CONVENTIONS.md` — naming, code style, comment patterns (dated 2026-04-12; patterns still current per src/index.ts review)
- `.planning/REQUIREMENTS.md` — BATCH-03 through BATCH-06 requirement text
- `.planning/STATE.md` — v2.0 milestone decisions

### Tertiary (LOW confidence)
- None — all claims in this document are grounded in direct source reads of the actual codebase.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — verified by direct source read (package.json, node_modules); zero new packages
- Architecture: HIGH — reference implementation exists; decisions fully locked in CONTEXT.md; codebase read confirms Phase 5 exports
- Pitfalls: HIGH — grounded in actual `src/index.ts` code paths (`callModel` no-external-signal, `AI_TIMEOUT_MS = 45_000`, test seam via `_registeredTools`)
- Test shapes: HIGH — all four shapes are explicitly specified in CONTEXT.md success criteria with exact test invariants

**Research date:** 2026-06-26
**Valid until:** 2026-07-26 (stable — no external dependencies; all risk is in the seam with Phase 5's exports, which are now locked)
