# Phase 6: Batch Core + Bounded Pool + Timeout - Context

**Gathered:** 2026-06-26
**Status:** Ready for planning

<domain>
## Phase Boundary

A pure, env-free, dependency-injected batch engine in a new `src/batch.ts` —
`executeBatch` / `mapWithConcurrency` / `withTimeout` — providing bounded concurrency,
a per-call cap, a per-task timeout, order-preservation by index, and failure isolation.
Fully unit-testable with a fake injected `runTask`: **no `env`, no AI mock** in the core.

Delivers BATCH-03 (bounded pool), BATCH-04 (per-call cap), BATCH-05 (per-task timeout),
BATCH-06 (order-preserving + failure-isolated).

**Out of scope (Phase 7 — "Register `code_assist_batch` + Result Contract"):** MCP tool
registration, Zod input/output schemas, `structuredContent` + text summary, per-task
result enrichment (`latency_ms`, `error_type`), `summary.failedIds`, per-kind input
validation surfaced as `status:'error'` (the validation already lives inside Phase 5's
`runTask`). **Out of scope (future milestone, BATCH-F01):** true per-task cancellation
threaded into `env.AI.run` — Phase 6 keeps a signal arg in the port but the abort is
best-effort only.

</domain>

<decisions>
## Implementation Decisions

### Per-task timeout default + layering (D-01)
- **D-01:** The per-task timeout default is **45000ms (= `AI_TIMEOUT_MS`)**, read from
  `BATCH_TASK_TIMEOUT_MS`. This is roadmap-authoritative (ROADMAP §Phase 6 success
  criterion #4 and REQUIREMENTS BATCH-05 both state "default 45000ms = `AI_TIMEOUT_MS`").
  The `60000` in the reference `.planning/batch.ts` is a generic placeholder and is NOT
  adopted.
- **D-01a (layering note):** `callModel` (`src/index.ts:136`) already owns an internal
  `AbortController` firing at `AI_TIMEOUT_MS` (45s) and takes **no external signal**. Because
  the batch wall-clock equals that inner abort, for a *real* AI call the two deadlines
  converge — `withTimeout` exists primarily to bound promises that hang **past** the inner
  abort (a fake/never-resolving `runTask` in tests; any future signal-ignoring path). This is
  intentional, not redundant.
- **D-01b (stale doc):** PROJECT.md's "Target features" blurb says `60000ms`. That is stale
  relative to ROADMAP/REQUIREMENTS. **Flagged for correction; editing PROJECT.md is out of this
  phase's scope** — do not block on it.

### Env→config boundary (D-02)
- **D-02:** `src/batch.ts` ships **both** a pure `executeBatch(tasks, cfg, runTask)` (takes a
  plain `BatchConfig`, fully env-free) **and** the impure adapter
  `readBatchConfig(env) → BatchConfig`. The defaults (concurrency 6 / maxTasks 50 /
  taskTimeoutMs 45000) are engine concerns, so the parser lives with the engine.
- **D-02a:** `BatchConfig` is `{ concurrency, maxTasks, taskTimeoutMs }`. `readBatchConfig`
  reads `BATCH_CONCURRENCY` / `BATCH_MAX_TASKS` / `BATCH_TASK_TIMEOUT_MS` with the
  positive-finite-integer-or-default guard from the reference (`Number.isFinite(n) && n > 0
  ? Math.floor(n) : default`). It is unit-testable with a **plain object** — no `env` binding,
  no Worker runtime required.
- **D-02b:** `executeBatch` itself never touches `env`. Tests pass a literal
  `{ concurrency, maxTasks, taskTimeoutMs }`. Phase 7's registration calls
  `readBatchConfig(env)` once at wiring time.

### Engine shape — concrete-typed envelope (D-03)
- **D-03:** **Concrete-typed now.** `executeBatch` is typed to a `BatchTask` and reads
  `task.id` / `task.kind`, emitting the per-task envelope **this phase**:
  - ok:    `{ id, index, kind, status: 'ok',    result }`
  - error: `{ id, index, kind, status: 'error', error }`
  using `as const` status literals. `id` defaults to `String(index)` when the task omits it
  (`task.id ?? String(index)`).
- **D-03a (Phase 6 ↔ 7 boundary — explicit):** Phase 6's envelope deliberately **stops** at
  `{id, index, kind, status, result|error}`. Phase 7 (BATCH-07/08/09) **enriches** it with
  `latency_ms` and `error_type` (`timeout | validation | ai_error`), promotes it to a Zod
  discriminated output schema, and adds `summary.failedIds` + the human-readable text block.
  **Do not pull that enrichment into Phase 6.**
- **D-03b (summary):** `executeBatch` returns `{ total, succeeded, failed, results }`.
  `failedIds` and the text summary are Phase 7 additions — not in Phase 6.
- **D-03c (`BatchTask` kind enum):** `BatchTask.kind` mirrors the real **11 AI-backed kinds**
  = Phase 5's exported `TaskKind` (generateCode, reviewCode, transformCode, scaffoldTests,
  quickTask, explainCode, generateDocs, generateTypes, fixBug, generateCommitMessage,
  generateWorkerBoilerplate) — NOT the reference's placeholder 5-kind enum. `input` is an open
  record (`z.record(z.unknown())` shape / `Record<string, unknown>`); per-kind validation is
  **not** re-done here (it lives in Phase 5's `runTask`).

### Mechanics — locked by roadmap success criteria (D-04)
- **D-04a (bounded pool):** `mapWithConcurrency<T, R>(items, limit, fn)` is **fully generic** —
  a fixed set of `Math.max(1, Math.min(limit, items.length))` workers pulling from a shared
  `cursor++`, writing `results[i] = await fn(items[i], i)` into a **pre-sized** `new
  Array(items.length)`. **Never** a naive `Promise.all` over the whole task array. Peak
  in-flight ≤ `concurrency` — verified by an in-flight-counter test using a
  deferred/never-resolving mock.
- **D-04b (fast cap):** `executeBatch` rejects **before any dispatch** when
  `tasks.length > cfg.maxTasks`, with an actionable "split it into smaller batches" message
  (mention the `BATCH_MAX_TASKS`/subrequest rationale). A spy asserts **zero** `runTask`
  calls on the over-cap path.
- **D-04c (order + isolation):** Index-write into the pre-sized array guarantees
  `results[i].index === i` (verified with inverted durations: task 0 slow, task N fast). Each
  task's `runTask` call is wrapped in `try/catch` so one throw yields one `status:'error'`
  entry while siblings still return `status:'ok'` — never `push`, never an aborting
  `Promise.all` rejection.
- **D-04d (`withTimeout`):** Keep the reference's exact settle-once form —
  `new Promise((resolve, reject) => { const timer = setTimeout(() => { ctrl.abort();
  reject(...) }, ms); run(ctrl.signal).then(v => {clearTimeout; resolve(v)}, e =>
  {clearTimeout; reject(e)}) })`. The **two-handler `.then(onResolve, onReject)`** form is
  mandatory: it means a late-settling orphaned promise (resolve *or* reject) hits an
  already-settled Promise → **no double-settle, no unhandled rejection**. Verified by a mock
  that resolves *after* the timeout.

### Injected runner port (D-05)
- **D-05:** The engine's task-runner port is **signal-aware**:
  `type RunTask = (task: BatchTask, signal: AbortSignal) => Promise<unknown>` (reference form).
  `withTimeout` passes a best-effort `AbortSignal`; the signal is free future-proofing for
  BATCH-F01 true cancellation. **In tests** the injected `runTask` is a plain fake (deferred,
  throwing, slow, late-resolving variants). **In Phase 7** the injected adapter maps a
  `BatchTask` → the real `runTask(env, kind, input)` and simply **ignores** the signal
  (Phase 5's `runTask`/`callModel` take no external signal).

### Claude's Discretion
- Exact wording of the over-cap error message (must be actionable + mention splitting / the
  `BATCH_MAX_TASKS` rationale) and of the timeout error message.
- Internal naming (`BatchTask`, `BatchConfig`, `RunTask`, `TaskResult` union) and whether the
  per-task envelope is a hand-written TS type or derived — provided D-03's shape holds and no
  new runtime dependency is added.
- Whether `BatchTask`/result types are expressed as plain TS types in Phase 6 (Zod schemas are
  a Phase 7 concern) — either is fine as long as Phase 6 stays import-clean and env-free.
- Test file organization under `src/__tests__/` (e.g. `batch.test.ts`).

</decisions>

<specifics>
## Specific Ideas

- The reference `.planning/batch.ts` is the design template — **adapt** it, do not copy verbatim:
  swap its placeholder 5-kind enum for the real 11 `TaskKind` values, change the timeout default
  60000 → 45000, and **drop** `latency_ms`/`error_type`/`failedIds`/registration (Phase 7).
- "No naive `Promise.all` over the task array" is the hard line for the pool — the worker-cursor
  pattern is the required shape, not an optimization.
- The whole point of `withTimeout`'s two-handler form is the **late-settle** case — that test
  (mock resolves after the timeout → no double-settle, no `unhandledRejection`) is the headline
  guard for this phase.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase requirements & milestone intent
- `.planning/REQUIREMENTS.md` — BATCH-03, BATCH-04, BATCH-05, BATCH-06 (the four requirements
  this phase delivers); BATCH-07/08/09 for the Phase 7 boundary
- `.planning/ROADMAP.md` §"Phase 6: Batch Core + Bounded Pool + Timeout" — goal + 4 success
  criteria (the authoritative source for cap/concurrency/timeout defaults and the test shapes)
- `.planning/code-assist-batch-milestone.md` — milestone brief; hard decision #1 (reuse the
  existing executor, don't reimplement the AI call)

### Design template
- `.planning/batch.ts` — reference engine: `mapWithConcurrency`, `withTimeout`, `executeBatch`,
  `readBatchConfig`. Adapt per D-01/D-03/D-05 (real 11 kinds, 45000 default, drop Phase 7 bits).

### Upstream phase (the injected dependency)
- `.planning/phases/05-extract-shared-runtask-executor/05-CONTEXT.md` — `runTask(env, kind,
  input) → AIResult` contract; `TASK_SPECS`; the typed-error taxonomy Phase 7 later maps to
  `error_type`
- `src/index.ts` — exported `runTask`, `TASK_SPECS`, `TaskKind` (:205), `ValidationError`,
  `AIResult` (:168), `callModel` (:136, owns the internal `AI_TIMEOUT_MS` AbortController, takes
  NO external signal), `AI_TIMEOUT_MS = 45_000` (:26), export line (:871)

### Research (grounded in the real code)
- `.planning/research/ARCHITECTURE.md` — pool/timeout/cap component design
- `.planning/research/PITFALLS.md` — unbounded `Promise.all`, double-settle / orphaned-promise
  late-settle, order-via-`push` bugs
- `.planning/research/STACK.md` — zero-new-deps constraint (inline ~25-line pool; `p-limit` only
  if already present — it is not)

### Repo patterns & tests
- `.planning/codebase/CONVENTIONS.md` — repo style/patterns to match
- `.planning/codebase/TESTING.md` — how the existing 145 tests (108 v1 + 37 runtask) are
  structured; the fake-`runTask` / deferred-promise / in-flight-counter testing approach

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Phase 5 `runTask(env, kind, input)` (exported from `src/index.ts:871`) — the real executor the
  Phase 7 batch adapter wraps; **not** called directly by the Phase 6 core (the core takes an
  injected fake).
- `TaskKind` (`src/index.ts:205`) — the canonical 11-kind enum `BatchTask.kind` mirrors.
- `AI_TIMEOUT_MS = 45_000` (`src/index.ts:26`) — the value `BATCH_TASK_TIMEOUT_MS` defaults to.
- `callModel` (`src/index.ts:136`) — owns its own `AbortController`/`AI_TIMEOUT_MS`, takes no
  external signal; relevant to D-01a layering and D-05 (the adapter ignores the engine's signal).

### Established Patterns
- Named exports off `src/index.ts`; tests under `src/__tests__/`. New `src/batch.ts` follows the
  same named-export + colocated-test convention.
- Zero new runtime dependencies (PROJECT.md "Out of Scope"): the ~25-line worker-cursor pool is
  inline, no `p-limit`.

### Integration Points
- **NEW:** `src/batch.ts` exporting `executeBatch`, `mapWithConcurrency`, `withTimeout`,
  `readBatchConfig`, and the `BatchConfig` / `BatchTask` / `RunTask` / result types.
- **NEW:** `src/__tests__/batch.test.ts` — in-flight cap counter, over-cap zero-dispatch spy,
  inverted-duration order check, failure isolation, timeout → `status:'error'`, and the
  late-settle no-double-settle / no-unhandled-rejection guard. Pure: fake `runTask`, no AI mock,
  no `env`.
- **UNTOUCHED:** `src/index.ts` (the wire-up is Phase 7's one-line registration), `callModel`,
  auth/OAuth, all existing test assertions.
- Verify gate: `npx tsc --noEmit` clean + `npm test` green (existing 145 + new batch tests).

</code_context>

<deferred>
## Deferred Ideas

- Phase 7: `code_assist_batch` registration, Zod in/out schemas, `structuredContent` + text
  summary, per-task `latency_ms` + `error_type`, `summary.failedIds`, MCP annotations.
- BATCH-F01 (future milestone): true per-task cancellation — thread the `AbortSignal` into
  `env.AI.run` so a timed-out task actually aborts the upstream call (Phase 6 keeps the signal
  arg but the abort is best-effort / unobserved by `runTask`).
- PROJECT.md "Target features" blurb says per-task timeout `60000ms` — stale vs ROADMAP/
  REQUIREMENTS (`45000`). Correct it in a docs pass; out of this phase's scope.

None of these are in Phase 6 scope — discussion stayed within the pure-engine boundary.

</deferred>

---

*Phase: 06-batch-core-bounded-pool-timeout*
*Context gathered: 2026-06-26*
