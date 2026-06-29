# Roadmap: CF Code Assistant

## Milestones

- ✅ **v1.0 Production Hardening** — Phases 0–4 (shipped: security, error handling, 108 tests / 95.5% coverage, structured logging)
- ✅ **v2.0 Concurrent Batch Fan-out** — Phases 5–10 (shipped 2026-06-29) — see [milestones/v2.0-ROADMAP.md](milestones/v2.0-ROADMAP.md)

## Phases

<details>
<summary>✅ v1.0 Production Hardening (Phases 0–4) — SHIPPED</summary>

- [x] **Phase 0: Repository Foundation** — Git baseline + .gitignore + setup docs (INFRA-01, INFRA-02)
- [x] **Phase 1: Security Hardening** — Type-safe routing, input caps, model allowlist, auth rate limiting (SEC-01/02, HARD-02/03)
- [x] **Phase 2: Error Handling & Reliability** — AI timeouts, KV fallback, structured error responses (HARD-01, HARD-04)
- [x] **Phase 3: Test Infrastructure** — vitest + Workers pool, mocked AI, 108 tests / 95.5% coverage (TEST-01..05)
- [x] **Phase 4: Observability** — Structured request/response/error logging (OBS-01)

Full v1.0 detail is recorded in PROJECT.md (Validated requirements) and git history.

</details>

<details>
<summary>✅ v2.0 Concurrent Batch Fan-out (Phases 5–10) — SHIPPED 2026-06-29</summary>

- [x] **Phase 5: Extract Shared `runTask` Executor** (2/2 plans) — completed 2026-06-26
- [x] **Phase 6: Batch Core + Bounded Pool + Timeout** (1/1) — completed 2026-06-26
- [x] **Phase 7: Register `code_assist_batch` + Result Contract** (1/1) — completed 2026-06-26
- [x] **Phase 8: Verify End-to-End** (1/1) — completed 2026-06-27
- [x] **Phase 9: Second Model + Tier Split** (1/1) — completed 2026-06-28
- [x] **Phase 10: Batch Per-Task Cancellation + Tier Override** (3/3) — completed 2026-06-29

Full v2.0 phase detail (goals, success criteria, plans) archived in [milestones/v2.0-ROADMAP.md](milestones/v2.0-ROADMAP.md).

</details>

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 0. Repository Foundation | v1.0 | — | Complete | shipped |
| 1. Security Hardening | v1.0 | 4/4 | Complete | shipped |
| 2. Error Handling & Reliability | v1.0 | 2/2 | Complete | shipped |
| 3. Test Infrastructure | v1.0 | 3/3 | Complete | shipped |
| 4. Observability | v1.0 | 2/2 | Complete | shipped |
| 5. Extract Shared `runTask` Executor | v2.0 | 2/2 | Complete | 2026-06-26 |
| 6. Batch Core + Bounded Pool + Timeout | v2.0 | 1/1 | Complete | 2026-06-26 |
| 7. Register `code_assist_batch` + Result Contract | v2.0 | 1/1 | Complete | 2026-06-26 |
| 8. Verify End-to-End | v2.0 | 1/1 | Complete | 2026-06-27 |
| 9. Second Model + Tier Split | v2.0 | 1/1 | Complete | 2026-06-28 |
| 10. Batch Per-Task Cancellation + Tier Override | v2.0 | 3/3 | Complete | 2026-06-29 |

---
*Next milestone: define with `/gsd:new-milestone`.*
