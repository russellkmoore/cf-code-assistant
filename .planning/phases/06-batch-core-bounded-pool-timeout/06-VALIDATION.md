---
phase: 6
slug: batch-core-bounded-pool-timeout
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-26
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.4 (`@cloudflare/vitest-pool-workers`) |
| **Config file** | `vitest.config.mts` (uses `cloudflarePool`) |
| **Quick run command** | `npm test -- src/__tests__/batch.test.ts` |
| **Full suite command** | `npm test` (9+ files, currently 145 tests) |
| **Estimated runtime** | ~15 seconds full suite; batch file <3s |

---

## Sampling Rate

- **After every task commit:** Run `npm test -- src/__tests__/batch.test.ts`
- **After every plan wave:** Run `npm test` (full suite — 145 existing + new batch tests)
- **Before `/gsd:verify-work`:** Full suite green + `npx tsc --noEmit` clean
- **Max feedback latency:** ~15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 06-01-* | 01 | 1 | BATCH-03 | — | Peak in-flight count never exceeds `cfg.concurrency` (default 6); bounded worker-loop, never `Promise.all` over tasks | unit | `npm test -- src/__tests__/batch.test.ts` | ❌ W0 | ⬜ pending |
| 06-01-* | 01 | 1 | BATCH-04 | — | Over-cap batch (>`BATCH_MAX_TASKS`, default 50) rejected before any dispatch; spy asserts zero `runTask` calls | unit | `npm test -- src/__tests__/batch.test.ts` | ❌ W0 | ⬜ pending |
| 06-01-* | 01 | 1 | BATCH-05 | — | Per-task timeout (default 45000ms) yields `status:'error'`; late resolve is a silent no-op (no double-settle, no unhandled rejection) | unit | `npm test -- src/__tests__/batch.test.ts` | ❌ W0 | ⬜ pending |
| 06-01-* | 01 | 1 | BATCH-06 | — | Inverted-duration batch: `results[i].index === i`; one throwing task yields one error entry while siblings return `status:'ok'`; index-write into pre-sized array, never `push` | unit | `npm test -- src/__tests__/batch.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/batch.ts` — the pure batch engine implementation (`executeBatch` / `mapWithConcurrency` / `withTimeout` / `readBatchConfig`); created as the first task before tests can pass
- [ ] `src/__tests__/batch.test.ts` — covers BATCH-03, BATCH-04, BATCH-05, BATCH-06 (all four success-criteria shapes)

*Existing test infrastructure (vitest + cloudflarePool) covers all other needs — no conftest, no framework install required.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| — | — | — | — |

*All phase behaviors have automated verification — this is a pure, dependency-injected engine with no `env`, no AI binding, and no Workers AI mock.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
