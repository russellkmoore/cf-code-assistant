---
phase: 5
slug: extract-shared-runtask-executor
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-26
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Core invariant: this is a behavior-preserving refactor — the existing 108-test
> suite is the primary regression guard, and a new prompt-snapshot test closes the
> one gap the AI-mocked suite cannot see (prompt drift).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest + @cloudflare/vitest-pool-workers |
| **Config file** | vitest.config.* (existing — no Wave 0 install needed) |
| **Quick run command** | `npx vitest run` |
| **Full suite command** | `npx vitest run` (108 existing + new runtask snapshots) |
| **Type check** | `npx tsc --noEmit` |
| **Estimated runtime** | ~3 seconds (108 tests ran in ~2.2s this session) |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run`
- **After every plan wave:** Run `npx vitest run` + `npx tsc --noEmit`
- **Before `/gsd:verify-work`:** Full suite green AND `tsc --noEmit` clean
- **Max feedback latency:** ~5 seconds

---

## Per-Task Verification Map

> Planner fills the Task ID / Plan / Wave columns. The behaviors below are the
> observable proofs the refactor is correct (mapped to BATCH-01 / BATCH-02).

| Behavior to prove | Requirement | Test Type | Automated Command | Status |
|-------------------|-------------|-----------|-------------------|--------|
| `runTask(env, kind, input)` exists; 11 handler heads delegate to it (routingInfo excluded) | BATCH-01 | unit/integration | `npx vitest run` | ⬜ pending |
| All 108 existing tests green with NO assertion changes (tool-handlers, observability, input-validation) | BATCH-01 | regression | `npx vitest run` | ⬜ pending |
| `npx tsc --noEmit` clean (TASK_SPECS + runTask fully typed, no `as any` regressions) | BATCH-01 | static | `npx tsc --noEmit` | ⬜ pending |
| Byte-identical `buildPrompt` output per kind — all 11 AI-backed kinds | BATCH-02 | snapshot | `npx vitest run runtask` | ⬜ pending |
| Resolved tier + maxTokens correct per kind, incl. explainCode across detailed/brief/eli5 | BATCH-02 | snapshot | `npx vitest run runtask` | ⬜ pending |
| transformCode 8KB byte cap: 8000 passes, 8001 returns the exact INPUT_TOO_LARGE envelope (logs error_type AI_ERROR — preserved quirk) | BATCH-01/02 | unit | `npx vitest run` | ⬜ pending |
| AI failure path unchanged: timeout → AI_TIMEOUT, error → AI_ERROR via existing handler-tail classification | BATCH-01 | regression | `npx vitest run` | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/runtask.test.ts` (or repo's existing test dir) — prompt + tier/maxTokens snapshots for all 11 kinds (the new BATCH-02 guard)

*Existing vitest infrastructure covers everything else — no framework install needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| (none) | — | — | All Phase 5 behaviors have automated verification |

*All phase behaviors have automated verification (suite + snapshots + tsc).*

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers the new snapshot test
- [ ] No watch-mode flags (use `vitest run`, not `vitest`)
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter (after planner maps tasks)

**Approval:** pending
