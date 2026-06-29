---
phase: 10
slug: batch-per-task-cancellation-and-tier-override
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-29
---

# Phase 10 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `10-RESEARCH.md` § Validation Architecture (HIGH confidence — full 12-file/142-`it()` suite inventory mapped).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest + `@cloudflare/vitest-pool-workers` (Workers pool) |
| **Config file** | `vitest.config.*` (present; project already runs `npm test`) |
| **Quick run command** | `npx vitest run src/__tests__/runtask.test.ts src/__tests__/batch-tool.test.ts src/__tests__/tool-handlers.test.ts` |
| **Full suite command** | `npm test` (12 files, currently 142 `it()` blocks) |
| **Type gate** | `npx tsc --noEmit` |
| **Estimated runtime** | ~20–40 seconds (Workers pool) |

---

## Sampling Rate

- **After every task commit:** Run quick command + `npx tsc --noEmit`
- **After every plan wave:** Run `npm test` (full 142+ green)
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~40 seconds

---

## Per-Task Verification Map

> Task IDs are indicative — the planner assigns final IDs/waves. The Requirement→Behavior→Command
> mapping is the contract; every BATCH-F01 / BATCH-F03 row must land on at least one plan task.

| Behavior (observable) | Requirement | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|-----------------------|-------------|-----------------|-----------|-------------------|-------------|--------|
| `env.AI.run` invoked with 3rd arg whose `signal instanceof AbortSignal` | BATCH-F01 | Timed-out subrequest is actually cancelled (no DoS via abandoned calls) | unit (mocked env.AI) | `npx vitest run src/__tests__/tool-handlers.test.ts -t "signal"` | ❌ W0 | ⬜ pending |
| Pre-aborted external signal causes the AI call to abort | BATCH-F01 | N/A | unit (signal-honoring mock) | `npx vitest run src/__tests__/tool-handlers.test.ts -t "abort"` | ❌ W0 | ⬜ pending |
| Single-task path unchanged: handler returns text / AI_TIMEOUT / AI_ERROR envelopes | BATCH-F01 | Behavior-identical guarantee | unit (regression guard) | `npx vitest run src/__tests__/tool-handlers.test.ts` | ✅ (17) | ⬜ pending |
| Timed-out batch task still yields `status:"error"`,`error_type:"timeout"`, order preserved | BATCH-F01 | Partial-results contract intact | unit (e2e regression guard) | `npx vitest run src/__tests__/batch-e2e.test.ts` | ✅ (2) | ⬜ pending |
| `runTask(env,"generateCode",input,{tier:"fast"})` resolves via fast model (qwen3-30b), overriding the kind's standard default | BATCH-F03 | Only allowlisted tier→model; no raw model string crosses MCP boundary | unit (spy `env.AI.run` model arg / `result.model`) | `npx vitest run src/__tests__/runtask.test.ts -t "tier"` | ❌ W0 | ⬜ pending |
| Omitting `tier` uses the kind default (generateCode → standard/kimi) | BATCH-F03 | N/A | unit | `npx vitest run src/__tests__/runtask.test.ts` | ✅ partial (runtask.test.ts:296-313) | ⬜ pending |
| `maxTokens` is NOT overridden by tier (stays the kind's value) | BATCH-F03 | N/A | unit (spy maxTokens arg) | `npx vitest run src/__tests__/runtask.test.ts -t "maxTokens"` | ❌ W0 | ⬜ pending |
| Batch task `{kind:"generateCode",tier:"fast",input}` overrides through `executeBatch`+adapter | BATCH-F03 | Tier flows via existing allowlist machinery | unit (handler / adapter) | `npx vitest run src/__tests__/batch-tool.test.ts -t "tier"` | ❌ W0 | ⬜ pending |
| `BatchTaskInputSchema` accepts `tier:"fast"\|"standard"`, rejects any other string | BATCH-F03 | `z.enum` blocks arbitrary model injection (V5 / Tampering+EoP) | unit (zod parse) | `npx vitest run src/__tests__/batch-tool.test.ts -t "schema"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] F01 threading test — `env.AI.run` called with `{ signal: AbortSignal }` (extend `tool-handlers.test.ts` or new file) — BATCH-F01
- [ ] F01 pre-aborted-signal test — local signal-honoring mock aborts the call — BATCH-F01
- [ ] F03 tier-override test — `runTask(..., { tier:"fast" })` → fast model; default unchanged — BATCH-F03
- [ ] F03 maxTokens-preserved test — tier override does not change `maxTokens` — BATCH-F03
- [ ] F03 schema test — `tier` enum accept/reject — BATCH-F03
- [ ] F03 adapter test — batch task `tier` flows through `executeBatch`+adapter — BATCH-F03

*No framework install needed — vitest + Workers pool already present. The plan's referenced
`callmodel.test.ts` does not exist; place new cases in existing suites (Claude's discretion).*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Two kinds log different real models; `tier:"fast"` override logs qwen; slow task logs `status:"error"`/`error_type:"timeout"` | BATCH-F01, BATCH-F03 | Requires real Workers AI calls (charges money) + live `wrangler tail` | `npm run dev` → `npx @modelcontextprotocol/inspector` → `http://localhost:8787/mcp`; run `code_assist_batch` with (a) default `generateCode`, (b) same kind `tier:"fast"`, (c) a deliberately slow task; confirm model + timeout logs via `wrangler tail` |

*Non-gating — automated unit coverage above is the gate.*

---

## Existing Guards That MUST Stay Green (regression proof)

| Suite | What it proves stays intact |
|-------|------------------------------|
| `runtask.test.ts` (37) | buildPrompt byte-equality, resolve tier/maxTokens per kind, transformCode 8KB cap, runTask default-model wiring |
| `tool-handlers.test.ts` (17) | every single-task handler returns text / AI_TIMEOUT / AI_ERROR — behavior-identical guarantee |
| `model-routing.test.ts` (12) | `isAllowedModel`, `resolveModel` (fast=qwen, standard=kimi via `DEFAULT_MODELS`), KV self-heal |
| `batch.test.ts` (8) | pure engine: bounded concurrency, partial results, order preservation |
| `batch-tool.test.ts` (8) | output-schema parse, summary/failedIds contract, registration + annotations |
| `batch-e2e.test.ts` (2) | end-to-end timeout/validation/ok + hanging-mock no-stall — **the F01 non-regression proof** |
| `observability.test.ts` (8) | structured logging on tier/error paths (asserts tier names, not models) |

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all ❌ MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 40s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
