---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Concurrent Batch Fan-out
status: in_progress
stopped_at: Phase 9 planned (09-01, plan-checker PASSED); ready for /gsd:execute-phase 9
last_updated: 2026-06-27
last_activity: 2026-06-27 -- Phase 9 planned (09-01); MODEL-03 formalized
progress:
  total_phases: 6
  completed_phases: 4
  total_plans: 6
  completed_plans: 5
  percent: 67
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-25)

**Core value:** Reduce Claude API token costs on mechanical code tasks without sacrificing output quality
**Current focus:** v2.0 reopened — Phases 9 & 10 (model selection + batch cancellation/override)

## Current Position

Phase: 09
Plan: Not planned yet
Status: Reopened — Phases 9 & 10 added, awaiting /gsd:plan-phase 9
Last activity: 2026-06-27

Progress: [██████░░░░] 67%

## Performance Metrics

**Velocity:**

- Total plans completed: 16 (all v1.0)
- Average duration: -
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 4 | - | - |
| 02 | 2 | - | - |
| 03 | 3 | - | - |
| 04 | 2 | - | - |
| 05 | 2 | - | - |
| 06 | 1 | - | - |
| 07 | 1 | - | - |
| 08 | 1 | - | - |

**Recent Trend:**

- Last 5 plans: none in v2.0 yet
- Trend: -

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work (v2.0):

- Reuse the existing executor, don't reimplement — batch injects a shared `runTask` (one source of truth for the Qwen call)
- Bounded pool (default 6), never `Promise.all` over tasks — cap concurrent subrequests
- Per-call task cap 50 (one subrequest per task) — safe on free (50) and paid (1000) plans
- Partial-results contract (status per task) — one failure/timeout is a result entry, not a thrown batch
- Prefer zero new deps — ~18-line inline pool; do NOT add p-limit; pin zod for the milestone

### Roadmap Evolution

- v2.0 reopened 2026-06-27 (was milestone_complete) to absorb deferred batch reqs + model selection discovered in the June 2026 Workers AI model review.
- Phase 9 added: Second model and tier split — `standard` tier → Kimi coding model, `fast` stays qwen3 (enables per-task tier override).
- Phase 10 added: Batch per-task cancellation and tier override — resolves BATCH-F01 (real AbortSignal into `env.AI.run`) and BATCH-F03 (tier-only per-task override). Depends on Phase 9.

### Pending Todos

None yet.

### Blockers/Concerns

- **Phase 5 is the highest-risk work:** prompt drift in the `runTask` extraction is invisible to the existing AI-mocked suite — the new `runtask.test.ts` byte-equality snapshot is the load-bearing regression guard
- **explainCode** depth-conditional tier/maxTokens must be modeled as a function of `input` or `observability.test.ts` turns red
- **transformCode** 8KB cap: keep in handler tail (single-task unchanged) AND enforce inside `runTask` so the batch path reports oversized transforms as a per-task `status:'error'`
- **Timeout is best-effort abort, not cancellation:** `callModel` ignores external signals; keep `withTimeout`'s two-handler `.then(onResolve, onReject)` form so the orphaned late settle is no unhandled rejection
- **Planner decision (Phase 6):** `BATCH_TASK_TIMEOUT_MS` default set to 45000 (= `AI_TIMEOUT_MS`) per the locked brief — confirm interaction with the inner 45s timeout during planning
- **Confirm** `observability.test.ts` does not assert exactly one invocation log per request before deciding whether batch tasks emit `logToolInvocation`

## Deferred Items

Carried forward to a later milestone (tracked in REQUIREMENTS.md Future Requirements):

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Batch | BATCH-F01 true per-task cancellation (AbortSignal into env.AI.run) | Deferred | v2.0 scoping |
| Batch | BATCH-F02 internal per-task retry with backoff | Deferred | v2.0 scoping |
| Batch | BATCH-F03 per-task model/tier override | Deferred | v2.0 scoping |

## Session Continuity

Last session: 2026-06-27T15:14:19.460Z
Stopped at: Phase 8 context gathered
Resume file: .planning/phases/08-verify-end-to-end/08-CONTEXT.md
