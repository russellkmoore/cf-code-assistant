---
phase: 7
slug: register-code-assist-batch-result-contract
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-26
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from `07-RESEARCH.md` → Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.4 (`@cloudflare/vitest-pool-workers` 0.14.3) |
| **Config file** | `vitest.config.mts` (existing) |
| **Quick run command** | `npx vitest run src/__tests__/batch-tool.test.ts` |
| **Full suite command** | `npm test` (153 existing + new batch-tool tests) |
| **Estimated runtime** | ~30 seconds (Workers pool warmup dominates) |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/__tests__/batch-tool.test.ts`
- **After every plan wave:** Run `npm test` (full suite)
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~30 seconds

---

## Per-Task Verification Map

> Task IDs are assigned by the planner. Requirement→behavior→command rows below are the
> Nyquist sampling contract; the planner's tasks must each map to one or more of these.

| Requirement | Behavior | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|-------------|----------|------------|-----------------|-----------|-------------------|-------------|--------|
| BATCH-07 | Output schema parses all-ok batch (latency_ms, status:'ok', result=string) | — | N/A | unit | `npx vitest run src/__tests__/batch-tool.test.ts -t "all-ok"` | ❌ W0 | ⬜ pending |
| BATCH-07 | Output schema parses mixed batch (error_type timeout/validation/ai_error) | T-7-01 | One bad task does not reject the whole batch (open-record input) | unit | `npx vitest run src/__tests__/batch-tool.test.ts -t "mixed"` | ❌ W0 | ⬜ pending |
| BATCH-07 | `error_type` derivation matches expected values for all three error patterns | — | N/A | unit | `npx vitest run src/__tests__/batch-tool.test.ts -t "error_type"` | ❌ W0 | ⬜ pending |
| BATCH-08 | `failedIds` array contains IDs of all error results in order | — | N/A | unit | `npx vitest run src/__tests__/batch-tool.test.ts -t "failedIds"` | ❌ W0 | ⬜ pending |
| BATCH-08 | `summary` text reflects correct succeeded/failed counts | — | N/A | unit | `npx vitest run src/__tests__/batch-tool.test.ts -t "summary"` | ❌ W0 | ⬜ pending |
| BATCH-09 | Tool registered in `createMcpServer` (inherits OAuth gate) | T-7-02 | Batch tool sits behind the same OAuth gate as all other tools | unit | `npx vitest run src/__tests__/batch-tool.test.ts -t "registration"` | ❌ W0 | ⬜ pending |
| BATCH-09 | `structuredContent` + `content` co-return verified via handler invocation | — | N/A | unit | `npx vitest run src/__tests__/batch-tool.test.ts -t "structuredContent"` | ❌ W0 | ⬜ pending |
| BATCH-09 | Annotations: readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:true | — | N/A | unit | `npx vitest run src/__tests__/batch-tool.test.ts -t "annotations"` | ❌ W0 | ⬜ pending |
| Regression | All 153 existing tests continue to pass | — | N/A | regression | `npm test` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/__tests__/batch-tool.test.ts` — covers all BATCH-07/08/09 cases above (all-ok + mixed output-schema parse, error_type derivation, failedIds, summary, registration, structuredContent, annotations)
- [ ] `BatchOutputSchema` exported from `src/index.ts` test-export block (required for direct `.parse()` in tests)
- [ ] `deriveErrorType` exported from `src/index.ts` (or covered indirectly through the enrichment function)

*No framework install needed — vitest and the Workers pool are already configured.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| MCP Inspector mixed-batch render of `structuredContent` + text | BATCH-10 (Phase 8) | Requires live Inspector UI; deferred to Phase 8 E2E | Covered by Phase 8, not Phase 7 |

*Phase 7 itself has full automated verification — the manual row above is the Phase 8 handoff, listed for traceability only.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (`batch-tool.test.ts`, schema/helper exports)
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
