---
phase: 1
slug: security-hardening
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-12
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | none — Wave 0 installs |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run --coverage` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run --coverage`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 1-01-01 | 01 | 1 | SEC-01 | T-1-01 / — | Type-safe model routing — no `as any` cast | unit | `npx vitest run src/__tests__/model-routing.test.ts` | ❌ W0 | ⬜ pending |
| 1-01-02 | 01 | 1 | SEC-03 | T-1-02 / — | KV model names validated against allowlist | unit | `npx vitest run src/__tests__/model-validation.test.ts` | ❌ W0 | ⬜ pending |
| 1-02-01 | 02 | 1 | SEC-02 | T-1-03 / — | Oversized inputs rejected with 400 | unit | `npx vitest run src/__tests__/input-validation.test.ts` | ❌ W0 | ⬜ pending |
| 1-02-02 | 02 | 1 | HARD-03 | T-1-04 / — | Input size limits enforced per tool | unit | `npx vitest run src/__tests__/input-validation.test.ts` | ❌ W0 | ⬜ pending |
| 1-03-01 | 03 | 2 | HARD-02 | T-1-05 / — | Rate limiting returns 429 after 5 attempts/60s | integration | `npx vitest run src/__tests__/rate-limiting.test.ts` | ❌ W0 | ⬜ pending |
| 1-04-01 | 04 | 2 | SEC-04 | T-1-06 / — | Error responses contain no stack traces or internal state | unit | `npx vitest run src/__tests__/error-sanitization.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `vitest` and `@cloudflare/vitest-pool-workers` — install test framework
- [ ] `vitest.config.ts` — vitest config for Workers environment
- [ ] `src/__tests__/model-routing.test.ts` — stubs for SEC-01, SEC-03
- [ ] `src/__tests__/input-validation.test.ts` — stubs for SEC-02, HARD-03
- [ ] `src/__tests__/rate-limiting.test.ts` — stubs for HARD-02
- [ ] `src/__tests__/error-sanitization.test.ts` — stubs for SEC-04

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Rate limit uses correct IP from CF headers | HARD-02 | Requires real Cloudflare edge | Deploy to staging, send 6 rapid PIN attempts from same IP, verify 429 on 6th |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
