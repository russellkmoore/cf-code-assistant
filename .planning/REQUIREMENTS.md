# Requirements: CF Code Assistant — v2.0 Concurrent Batch Fan-out

**Defined:** 2026-06-26
**Core Value:** Reduce Claude API token costs on mechanical code tasks without sacrificing output quality

> v1.0 hardening requirements (TOOL/AUTH/MODEL/INFRA/HARD/TEST/SEC/OBS) shipped and are
> recorded as Validated in PROJECT.md. This file scopes the v2.0 milestone only.

## v2.0 Requirements

A single new `code_assist_batch` MCP tool that fans out many bounded code-assist tasks
concurrently to Workers AI, reusing the existing per-kind executor.

### Shared Executor (behavior-preserving refactor)

- [ ] **BATCH-01**: A single reusable `runTask(kind, input)` dispatch (kind → tier, maxTokens, buildPrompt) is extracted from the 11 AI-backed handlers and used by both the single-task tools and the batch tool — observable behavior unchanged, all 108 existing tests stay green
- [ ] **BATCH-02**: A prompt-snapshot test asserts byte-identical `buildPrompt` output per kind (including `explainCode`'s depth-driven tier/maxTokens and `transformCode`'s 8KB cap), guarding the refactor against prompt drift the existing AI-mocked tests cannot detect

### Batch Core & Bounded Concurrency

- [ ] **BATCH-03**: The batch runs tasks through a fixed-size worker pool whose in-flight count never exceeds the cap (default 6, read from `BATCH_CONCURRENCY`) — no naive `Promise.all` over all tasks
- [ ] **BATCH-04**: A batch with more than the per-call cap (default 50, read from `BATCH_MAX_TASKS`) is rejected fast with an actionable error before any task is dispatched
- [ ] **BATCH-05**: Each task is bounded by a per-task timeout (default 45000ms = `AI_TIMEOUT_MS`, read from `BATCH_TASK_TIMEOUT_MS`) enforced by a `Promise.race`; a timed-out task yields a `status:'error'` entry without hanging the batch and without producing an unhandled rejection when the orphaned AI call settles late
- [ ] **BATCH-06**: Results are order-preserving by index and failure-isolated — one slow or throwing task never stalls or aborts its siblings, which still return `status:'ok'`

### Result Contract

- [ ] **BATCH-07**: Each task returns independently as `{id, index, kind, status:'ok', result, latency_ms}` or `{id, index, kind, status:'error', error, error_type, latency_ms}`, where `error_type` is one of `timeout | validation | ai_error`
- [ ] **BATCH-08**: The batch returns a summary with `total`, `succeeded`, `failed`, and `failedIds`, plus a short human-readable text summary alongside the structured results

### Tool Registration

- [ ] **BATCH-09**: `code_assist_batch` is registered with Zod input and output schemas, returns `structuredContent` plus the text summary, and sets MCP tool annotations (`readOnlyHint:false`, `destructiveHint:false`, `idempotentHint:false`, `openWorldHint:true`)

### End-to-End Verification

- [ ] **BATCH-10**: A mixed batch (a normal task, a deliberately failing task, and a deliberately slow/timeout task) returns correct order-preserving partial results end-to-end, demonstrated via MCP Inspector, with the single-task tools still passing their existing tests and a clean `npm run build`

## Future Requirements

Deferred to a later milestone. Tracked, not in this roadmap.

### Batch Enhancements

- **BATCH-F01**: True per-task cancellation — thread an `AbortSignal` into `env.AI.run()` so a timed-out task stops spending its subrequest (currently best-effort: the orphaned call runs to completion)
- **BATCH-F02**: Internal per-task retry with backoff (deferred — would multiply the 1-subrequest-per-task cap math; callers re-issue failures today)
- **BATCH-F03**: Per-task model/tier override in the batch input (fenced off by the milestone brief; routing changes are out of scope)

## Out of Scope

Explicitly excluded for v2.0. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Discriminated-union task input at the MCP boundary | Would reject the whole batch on one malformed task — conflicts with the partial-results contract; validate per-kind inside `runTask` instead |
| Cross-task dependencies / task graph | Claude orchestrates across calls; batch tasks are independent leaves by design |
| Streaming / progressive batch results | Contract returns a complete order-preserving array |
| New runtime dependency (e.g. `p-limit`) | A ~18-line inline pool suffices; `p-limit` is not already a dependency |
| Removing or replacing single-task tools | Singletons stay — a batch round-trip isn't worth it for one trivial task |
| Batching the static `routingInfo` tool | No AI call, no input — not a fan-out kind |
| Model-tier config / CLAUDE.md usage convention | Separate follow-on work outside this repo |

## Traceability

Populated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| BATCH-01 | Phase 5 | Pending |
| BATCH-02 | Phase 5 | Pending |
| BATCH-03 | Phase 6 | Pending |
| BATCH-04 | Phase 6 | Pending |
| BATCH-05 | Phase 6 | Pending |
| BATCH-06 | Phase 6 | Pending |
| BATCH-07 | Phase 7 | Pending |
| BATCH-08 | Phase 7 | Pending |
| BATCH-09 | Phase 7 | Pending |
| BATCH-10 | Phase 8 | Pending |

**Coverage:**
- v2.0 requirements: 10 total
- Mapped to phases: 10 (proposed — roadmapper confirms)
- Unmapped: 0 ✓

---
*Requirements defined: 2026-06-26*
*Last updated: 2026-06-26 after v2.0 requirements definition*
