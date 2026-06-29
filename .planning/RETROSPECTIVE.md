# Retrospective: CF Code Assistant

A living retrospective across milestones. Newest milestone sections are appended above the
Cross-Milestone Trends section.

---

## Milestone: v2.0 — Concurrent Batch Fan-out

**Shipped:** 2026-06-29
**Phases:** 6 (5–10) | **Plans:** 9 | **Tasks:** 16 | **Tests:** ~173 green

### What Was Built

A single `code_assist_batch` MCP tool that fans many bounded code-assist tasks out to Workers AI
concurrently in one call. Built on a shared `runTask(kind, input)` executor (one source of truth for
prompt/tier/maxTokens), a pure env-free batch engine (`src/batch.ts`) with a bounded worker pool, a
per-call cap, and a per-task timeout backed by a real `AbortSignal` threaded into `env.AI.run`. The
two-tier routing was made real (`fast` qwen3-30b / `standard` Kimi), with a tier-only per-task
override at the batch boundary.

### What Worked

- **Dependency-forced build order.** All four research tracks converged on the same sequence
  (extract `runTask` → pure batch core → register tool → verify E2E). Front-loading the riskiest
  work (prompt-drift-invisible `runTask` extraction) in Phase 5 meant the scariest seam was proven
  first, behind a byte-equality snapshot guard the AI-mocked suite structurally could not provide.
- **Pure, env-free batch engine.** Keeping `src/batch.ts` dependency-injected (a fake `runTask`, no
  `env`, no AI mock) made the concurrency/timeout/ordering invariants unit-testable in isolation —
  the bounded-pool and late-settle guarantees were verified without touching Workers AI.
- **Partial-results contract over discriminated-union input.** Validating per-kind *inside* `runTask`
  (one bad task → one `status:'error'` entry) rather than at the MCP boundary kept one malformed task
  from rejecting the whole batch.
- **Reopen-with-archive discipline.** v2.0 was reopened mid-stream (Phases 9–10) to absorb deferred
  reqs after the June 2026 Workers AI model review; promoting BATCH-F01/F03 from Future Requirements
  with traceability kept scope honest.

### What Was Inefficient

- **Doc-lag on requirement checkboxes.** REQUIREMENTS.md traceability stayed "Planned" while phases
  shipped; PROJECT.md was the real source of truth. Reconciled at milestone close.
- **Spec drift in PROJECT.md.** The "Target features" block still described best-effort abort and a
  60s default after Phase 10 had shipped real cancellation at 45s — caught and corrected during the
  milestone review.
- **Stale STATE.md body.** Frontmatter tracked status well, but the body's blockers/decisions/deferred
  table needed a manual sweep at close.

### Patterns Established

- **One executor, two entry points.** Single-task tools and the batch tool share `runTask`; the batch
  path never reimplements the model call.
- **Settle-once `withTimeout`.** Two-handler `.then(onResolve, onReject)` + index-write into a
  pre-sized array → order-preserving, failure-isolated, no double-settle on late orphans.
- **Tier abstraction at the boundary, never raw model strings.** Per-task overrides go through the
  existing allowlist/KV resolution.

### Key Lessons

- A test the existing suite is *structurally blind to* (byte-equal prompt snapshot) is worth more than
  another assertion in a suite that already passes. Identify the invisible regression risk first.
- When a milestone reopens, promote deferred reqs explicitly with traceability — don't smuggle scope.
- Keep PROJECT.md's forward-looking "Target features" honest as phases land, or it silently becomes
  fiction by milestone close.

### Cost Observations

- ~93 commits in the v2.0 range; zero new runtime dependencies added.
- Notable: isolating the pure batch core meant most logic was verifiable without incurring Workers AI
  charges (tests mock/inject the executor).

---

## Cross-Milestone Trends

| Milestone | Phases | Plans | Tests | Shipped |
|-----------|--------|-------|-------|---------|
| v1.0 Production Hardening | 0–4 | — | 108 | shipped |
| v2.0 Concurrent Batch Fan-out | 5–10 | 9 | ~173 | 2026-06-29 |

**Recurring strengths:** behavior-preserving refactors guarded by targeted tests; zero-dep bias;
KV-backed config with self-healing.

**Recurring friction:** planning-doc bookkeeping (checkbox/traceability lag, forward-looking sections
drifting from shipped reality) reconciled at milestone boundaries rather than continuously.
