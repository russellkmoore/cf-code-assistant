---
phase: 2
slug: error-handling-reliability
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-12
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.4 |
| **Config file** | vitest.config.mts |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run --reporter=verbose --coverage` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run --reporter=verbose --coverage`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | HARD-01 | — | AI timeout returns structured error, not crash | unit | `npx vitest run -t "timeout"` | ❌ W0 | ⬜ pending |
| 02-01-02 | 01 | 1 | HARD-01 | — | AI 5xx returns structured error with isError:true | unit | `npx vitest run -t "AI error"` | ❌ W0 | ⬜ pending |
| 02-02-01 | 02 | 1 | HARD-04 | — | Auth parse failure returns 400 HTML error page | unit | `npx vitest run -t "auth error"` | ❌ W0 | ⬜ pending |
| 02-02-02 | 02 | 1 | HARD-04 | — | KV fallback handles secondary KV failure without retry loop | unit | `npx vitest run -t "KV fallback"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/__tests__/error-handling.test.ts` — stubs for HARD-01, HARD-04 error paths
- [ ] Reuse existing test fixtures from Phase 1 test infrastructure

*Existing vitest infrastructure covers framework requirements.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| HTML error page matches login page styling | HARD-04 | Visual verification | Compare error page HTML structure with loginPage() output |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
