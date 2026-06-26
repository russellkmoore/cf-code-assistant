# Phase 8: Verify End-to-End - Context

**Gathered:** 2026-06-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Prove the v2.0 batch seam works end-to-end through the **real `createMcpServer`** — clean
build, full suite green, and a mixed batch (a normal task, a deliberately failing task, and a
deliberately slow/timeout task) returning **order-preserving partial results** with both
`structuredContent` and the text summary. The single-task tools and the build stay untouched;
their existing passing tests are the behavior-preservation evidence.

Delivers **BATCH-10**. This is a **verification** phase — it adds test(s) and (at most) docs,
not new product capability. No changes to `src/index.ts`, `src/batch.ts`, the single-task
tools, `package.json`, or `wrangler.toml`.

**State at entry (Phases 5–7 complete, 161 tests green):** `code_assist_batch` is registered
in `createMcpServer` as the repo's first structured-output tool — Zod `BatchOutputSchema`
(discriminated union on `status`), `runBatch` enrichment (`latency_ms`, `error_type` via
`deriveErrorType`, `failedIds`, `summary`), `structuredContent` + text co-return, and
annotations `readOnlyHint:false / destructiveHint:false / idempotentHint:false /
openWorldHint:true`.

</domain>

<decisions>
## Implementation Decisions

### "Clean build" definition (D-01)
- **D-01:** **No `build` script is added.** `package.json` stays untouched (consistent with the
  "build untouched" success criterion). The ROADMAP §Phase 8 SC#1 phrase `npm run build` is
  **mapped onto the existing checks**: "clean build" = `npx tsc --noEmit` clean **+** `npm test`
  green. The verifier must NOT flag the absent `build` script as a gap — this mapping is the
  authoritative interpretation for this phase.
- **D-01a:** **No `wrangler` invocation during verify.** A one-off `wrangler deploy --dry-run`
  bundle check was explicitly considered and **declined**. The build gate is exactly
  `npx tsc --noEmit` + `npm test` — offline, no network, no Worker bundler step.

### Proof model — automated e2e, Inspector optional (D-02)
- **D-02:** The machine-checkable proof is an **automated in-process e2e test that drives the
  real `createMcpServer` registered `code_assist_batch` handler** (the same handler-invocation
  pattern as `batch-tool.test.ts`, with a mock `env`). The actual **MCP Inspector run is
  optional / skipped** — Claude cannot drive the browser-based, OAuth-gated Inspector
  autonomously, and the user has accepted the automated drive as equivalent.
- **D-02a (criterion reframing — record explicitly):** ROADMAP §Phase 8 SC#2 and SC#3 literally
  say "via MCP Inspector." For this phase that wording is **satisfied by the equivalent
  automated drive of the real registered handler** through `createMcpServer`. The verifier MUST
  treat "Inspector demonstrated" as met by the committed e2e test; it must NOT block the phase
  for a missing manual Inspector session.
- **D-02b:** OAuth is **out of the e2e path** — the in-process test calls `createMcpServer(env)`
  and invokes the registered tool directly. The `OAuthProvider` gate wraps `createMcpServer`
  from the outside and is already covered by `auth-flow.test.ts`; the e2e does not re-test it.

### Committed fast e2e — all three statuses, order-preserving (D-03)
- **D-03:** A **new committed e2e test runs in the default `npm test`** (fast, AI mocked) and
  drives a **3-task mixed batch through the real `createMcpServer`**:
  1. **ok** — a normal kind (e.g. `quickTask`/`generateCode`) with valid input, mock AI returns
     text → `status:'ok'`.
  2. **validation-fail** — `transformCode` (or equivalent) with **oversized input (>8KB)**,
     tripping the per-kind `validate()` **inside `runTask`** → `ValidationError` →
     `error_type:'validation'`. Deterministic, no AI mock needed for that task; exercises the
     real per-kind validation seam.
  3. **timeout** — a **deterministic** timeout via a **tiny `BATCH_TASK_TIMEOUT_MS` override**
     (set small on the test `env`) + a mock AI that resolves just after it → batch `withTimeout`
     fires → `status:'error'`, `error_type:'timeout'` (message `…exceeded Xms timeout` →
     `deriveErrorType` → `'timeout'`). Fast and reproducible — the committed suite proves all
     **three** `error_type`/status outcomes in one batch.
- **D-03a (order-preservation assertion):** Use **inverted durations / input order** so
  completion order ≠ input order (e.g. place the slow/timeout task **earlier** than the fast ok
  task), then assert `results[i].index === i` and that kinds appear in **input order** regardless
  of which finished first.
- **D-03b (contract assertions):** The committed e2e asserts: order-preserving partial results
  (all three present, correct statuses), `structuredContent` co-returned with `content` text,
  `BatchOutputSchema.parse(structuredContent)` does not throw, and `summary` / `failedIds`
  reflect the one... two failures (validation + timeout) in order.

### Separate opt-in real-wait e2e — the Inspector replacement (D-04)
- **D-04:** A **second, faithful-fidelity e2e** demonstrates the **real 45s-wait** timeout but is
  **kept OUT of the default `npm test`** — `describe.skip` / `it.skip`-by-default in its own
  file/block, **zero new config, scripts, or deps**. It is run by hand (un-skip) as the manual
  replacement for the Inspector session. The default suite stays ~2.3s and green.
- **D-04a (offline, free):** The opt-in test stays on the **AI mock**, but its timeout task
  **hangs >45s**, so the batch `withTimeout` (45s) and `callModel`'s **own internal**
  `AbortController` (`AI_TIMEOUT_MS` = 45s) race **exactly as in production**. No real Workers AI,
  **no charges, no network/credentials**, reproducible by anyone un-skipping it. (Real-AI
  end-to-end was explicitly declined in favor of this.)
- **D-04b (race is expected — assert loosely):** Per Phase 6 D-01a the two 45s deadlines
  converge, so **which layer settles first is a genuine race**. The opt-in test must assert
  **loosely on the timeout entry** (`status:'error'`, present in order, batch did not hang / no
  unhandled rejection) and **NOT** hard-assert `error_type:'timeout'` vs `'ai_error'`. Document
  this race in the test so a future reader doesn't tighten it into a flaky assertion.

### Claude's Discretion
- Exact new-test file organization (e.g. one `batch-e2e.test.ts` holding both the fast committed
  block and the `describe.skip` real-wait block, or two files) — provided the fast block is in
  default `npm test` and the real-wait block is skip-by-default.
- Exact kinds chosen for the ok task and the precise oversized-input payload for the
  validation-fail task (any kind whose `validate()` rejects deterministically is fine;
  `transformCode`'s 8KB cap is the suggested, already-proven path).
- The small `BATCH_TASK_TIMEOUT_MS` value and the mock-AI delay for D-03's deterministic timeout
  (any pair where delay > timeout and both are a few ms).
- Wording of any short "how to run the opt-in real-wait e2e" note.

</decisions>

<specifics>
## Specific Ideas

- The committed fast e2e should **mirror the existing `batch-tool.test.ts` handler-invocation
  pattern** (fetch the registered `code_assist_batch` from `createMcpServer(env)`, invoke with a
  mock `env`, parse `structuredContent` against `BatchOutputSchema`) — but escalate it to a
  **3-task mixed batch with order assertions**, which `batch-tool.test.ts` does not do.
- The "Inspector replacement" is the **opt-in real-wait test**, not a browser session — keep its
  skip-by-default and its loose timeout assertion so it never flakes the default suite.
- Behavior-preservation of the single-task tools is demonstrated **by their existing tests still
  passing** in the same `npm test` run — no new single-task assertions are needed.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase requirement & milestone intent
- `.planning/REQUIREMENTS.md` — **BATCH-10** (the single requirement this phase delivers:
  mixed-batch order-preserving partial results demonstrated end-to-end, single-task tools still
  green, clean build)
- `.planning/ROADMAP.md` §"Phase 8: Verify End-to-End" — goal + 3 success criteria. **Note the
  D-01 / D-02a reframings**: SC#1 `npm run build` → `tsc --noEmit` + `npm test`; SC#2/#3 "via MCP
  Inspector" → equivalent automated drive of the real `createMcpServer` handler.
- `.planning/code-assist-batch-milestone.md` — milestone brief (hard decisions: reuse the
  executor, bounded pool, partial-results contract, zero new deps)

### What was built (the seam under test)
- `.planning/phases/07-register-code-assist-batch-result-contract/07-01-SUMMARY.md` — exact shape
  of `code_assist_batch`: `BatchOutputSchema` (discriminated union on `status`), `runBatch`
  enrichment, `deriveErrorType` rules, `structuredContent` + text co-return, annotations
- `.planning/phases/06-batch-core-bounded-pool-timeout/06-CONTEXT.md` — engine contract,
  **D-01a** (callModel owns its own 45s abort, takes no external signal → the timeout race), the
  `withTimeout` two-handler late-settle guarantee
- `.planning/phases/05-extract-shared-runtask-executor/05-CONTEXT.md` — `runTask(env, kind,
  input)` contract, `TASK_SPECS`, the per-kind `validate()` seam (the validation-fail path) and
  the typed-error taxonomy that maps to `error_type`

### Source under test
- `src/index.ts` — `createMcpServer(env)`, the `code_assist_batch` registration + `runBatch`
  closure, `BatchOutputSchema` + `deriveErrorType` (both exported), `runTask`, `TASK_SPECS`,
  `ValidationError`, `AI_TIMEOUT_MS = 45_000`, `callModel` (owns the internal 45s abort)
- `src/batch.ts` — `executeBatch`, `mapWithConcurrency`, `withTimeout`, `readBatchConfig` and the
  `BatchConfig` / `BatchTask` / `RunTask` types (`BATCH_TASK_TIMEOUT_MS` is read here from `env`)

### Test patterns to mirror
- `src/__tests__/batch-tool.test.ts` — the registered-handler invocation + `BatchOutputSchema`
  parse pattern the committed e2e extends to a 3-task ordered mixed batch
- `src/__tests__/batch.test.ts` — existing timeout / late-settle / order unit coverage (the
  engine-level proof the e2e complements, not duplicates)
- `.planning/codebase/TESTING.md` — Workers-pool vitest layout, the AI-mock + `env` construction
  approach, how `npm test` is structured
- `.planning/codebase/CONVENTIONS.md` — repo style (named exports off `src/index.ts`, colocated
  `src/__tests__/` files)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`batch-tool.test.ts` invocation pattern** — already fetches the registered `code_assist_batch`
  tool from `createMcpServer(env)`, invokes the handler with a mock `env`, and parses
  `structuredContent` against `BatchOutputSchema`. The committed fast e2e reuses this verbatim,
  scaled to a 3-task mixed, order-asserted batch.
- **`BatchOutputSchema`** (exported from `src/index.ts`) — the parse target for the
  `structuredContent` assertion.
- **`transformCode` 8KB cap** — the already-proven deterministic path for the validation-fail
  task (oversized input → `ValidationError` inside `runTask` → `error_type:'validation'`).
- **`env` construction / AI-mock infra** (cloudflare:test pool, `src/__tests__/helpers.ts`) —
  the test builds an `env` with a small `BATCH_TASK_TIMEOUT_MS` (read by `readBatchConfig`) and a
  per-task-controllable mocked `AI`.

### Established Patterns
- New colocated test files under `src/__tests__/`; named exports off `src/index.ts`.
- Default `npm test` runs **everything** (`vitest run`); there is **no** separate test command —
  so "kept out of `npm test`" is achieved via **`describe.skip` / `it.skip`-by-default**, not a
  new script or config (zero new deps/scripts, per D-04).

### Integration Points
- **NEW:** committed fast e2e (in default `npm test`) + a **skip-by-default** real-wait e2e block
  under `src/__tests__/` (file org is Claude's discretion).
- **UNTOUCHED:** `src/index.ts`, `src/batch.ts`, the single-task tools, `package.json`,
  `wrangler.toml`. The single-task tools' existing passing tests are the behavior-preservation
  evidence.
- **Verify gate (D-01):** `npx tsc --noEmit` clean **+** `npm test` green (the existing 161 +
  the new committed e2e). No wrangler step.

</code_context>

<deferred>
## Deferred Ideas

- **Actual MCP Inspector run** + a **real-Workers-AI** end-to-end session — optional human
  confirmation only; **not required** for this phase to pass (D-02 / D-04a). If desired later,
  run `npx @modelcontextprotocol/inspector` against `wrangler dev`/a deployed instance (incurs
  AI charges, OAuth PIN gate applies).
- **Per-task model observability** in batch logging (currently logged once per batch with
  `model:"mixed"`) — deferred to a future phase.
- **BATCH-F01** true per-task cancellation (thread `AbortSignal` into `env.AI.run` so a timed-out
  task actually aborts the upstream call) — deferred to a later milestone.
- **PROJECT.md "Target features" stale `60000ms`** vs the real `45000ms` default — a docs-pass
  fix, out of this verification phase's scope.

</deferred>

---

*Phase: 08-verify-end-to-end*
*Context gathered: 2026-06-26*
