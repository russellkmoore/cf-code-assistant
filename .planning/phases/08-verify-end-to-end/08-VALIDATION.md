---
phase: 8
slug: verify-end-to-end
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-27
---

# Phase 8 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.x (`@cloudflare/vitest-pool-workers`) |
| **Config file** | `vitest.config.*` (existing — Workers pool already configured) |
| **Quick run command** | `npx vitest run src/__tests__/batch-e2e.test.ts` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~2–3 seconds (fast suite; opt-in real-wait test is `describe.skip`, not run) |

---

## Sampling Rate

- **After every task commit:** Run the quick command for the new e2e file
- **After every plan wave:** Run `npm test` (full suite — must stay green at the expected count)
- **Before `/gsd:verify-work`:** `npm run types && npx tsc --noEmit` clean + `npm test` green
- **Max feedback latency:** ~5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 08-01-01 | 01 | 1 | BATCH-10 | — | Mixed 3-task batch (ok + validation-fail + deterministic timeout) through real `createMcpServer` returns order-preserving partial results; `structuredContent` parses against `BatchOutputSchema`; summary/failedIds correct | e2e (in-process, AI mocked) | `npx vitest run src/__tests__/batch-e2e.test.ts` | ❌ W0 (new file) | ⬜ pending |
| 08-01-02 | 01 | 1 | BATCH-10 | — | `describe.skip` real-45s-wait opt-in test exists, uses a 45s-hanging mock (offline), asserts loosely (status:'error' present in order, no hang / no unhandled rejection); excluded from default `npm test` | e2e (skip-by-default) | un-skip + `npx vitest run src/__tests__/batch-e2e.test.ts` (manual) | ❌ W0 (new file) | ⬜ pending |
| 08-01-03 | 01 | 1 | BATCH-10 | — | Build gate green: `npm run types && npx tsc --noEmit` clean + full `npm test` green at expected count (existing single-task tests still pass → behavior-preserving) | gate | `npm run types && npx tsc --noEmit && npm test` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/__tests__/batch-e2e.test.ts` — new e2e test file (committed fast block + `describe.skip` real-wait block). Mirrors `batch-tool.test.ts`'s `getToolHandler` invocation pattern.

*Existing vitest + Workers-pool infrastructure covers everything else — no framework install, no config changes, no new deps (per D-01a / D-04).*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Faithful real-45s-wait timeout demonstration | BATCH-10 | Real 45s wait would slow/flake the default suite; kept `describe.skip` by design (D-04) | Un-skip the real-wait `describe` block in `src/__tests__/batch-e2e.test.ts`, run `npx vitest run src/__tests__/batch-e2e.test.ts`, observe the timeout task settles as `status:'error'` in input order with no hang |
| Actual MCP Inspector / real-AI session | BATCH-10 | Browser-based, OAuth-gated, incurs AI charges; explicitly OPTIONAL per D-02 (automated in-process drive is the accepted proof) | Optional: `npx @modelcontextprotocol/inspector` against `wrangler dev`/deployed worker, PIN-gated; submit a mixed batch and confirm order-preserving partial results + `structuredContent` + text summary |

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (the new e2e file)
- [ ] No watch-mode flags (`vitest run`, not `vitest`)
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
