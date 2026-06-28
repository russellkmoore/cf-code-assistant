# Roadmap: CF Code Assistant

## Milestones

- ✅ **v1.0 Production Hardening** - Phases 0-4 (shipped: security, error handling, 108 tests / 95.5% coverage, structured logging)
- 🚧 **v2.0 Concurrent Batch Fan-out** - Phases 5-10 (in progress; reopened to resolve deferred BATCH-F01/F03 + add model selection)

## Overview

v2.0 is **additive and narrow**: one new MCP tool, `code_assist_batch`, that fans an array of
independent code-assist tasks out to the existing per-kind Qwen executor with bounded concurrency,
a per-task timeout, a per-call cap, and an order-preserving partial-results contract. The build order
is **dependency-forced** (all four HIGH-confidence research tracks converged on it): extract the shared
`runTask` executor (behavior-preserving) → build the pure, importable batch core + bounded pool +
timeout → register the tool with its structured-output contract → verify end-to-end. The dominant risk
is not the pool but the seams where new fan-out code meets frozen v1.0 behavior — so the riskiest work
(prompt-drift-invisible `runTask` extraction) is isolated and front-loaded in Phase 5, guarded by a new
byte-equality prompt-snapshot test the existing AI-mocked suite cannot provide.

## Phases

**Phase Numbering:**

- Integer phases (5, 6, 7, 8): Planned milestone work (continued from v1.0, which ended at Phase 4)
- Decimal phases (6.1, 6.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

<details>
<summary>✅ v1.0 Production Hardening (Phases 0-4) - SHIPPED</summary>

- [x] **Phase 0: Repository Foundation** - Git baseline + .gitignore + setup docs (INFRA-01, INFRA-02)
- [x] **Phase 1: Security Hardening** - Type-safe routing, input caps, model allowlist, auth rate limiting (SEC-01/02, HARD-02/03)
- [x] **Phase 2: Error Handling & Reliability** - AI timeouts, KV fallback, structured error responses (HARD-01, HARD-04)
- [x] **Phase 3: Test Infrastructure** - vitest + Workers pool, mocked AI, 108 tests / 95.5% coverage (TEST-01..05)
- [x] **Phase 4: Observability** - Structured request/response/error logging (OBS-01)

Full v1.0 phase detail is recorded in PROJECT.md (Validated requirements) and git history.

</details>

### 🚧 v2.0 Concurrent Batch Fan-out (In Progress)

**Milestone Goal:** Add a single `code_assist_batch` MCP tool that runs many bounded code-assist
tasks concurrently in one call, reusing the existing executor — turning "K parallel Claude executors"
into "K executors × an N-wide cheap batch each," keeping Claude thin (orchestrate + validate).

- [x] **Phase 5: Extract Shared `runTask` Executor** - Behavior-preserving refactor lifting the prompt-build head of 11 handlers into a `runTask(kind, input)` dispatch map; all 108 tests stay green + new prompt-snapshot guard (completed 2026-06-26)
- [x] **Phase 6: Batch Core + Bounded Pool + Timeout** - Pure, env-free, dependency-injected `executeBatch` / `mapWithConcurrency` / `withTimeout` with cap, bounded concurrency, per-task timeout, order-preservation, and failure isolation (completed 2026-06-26)
- [x] **Phase 7: Register `code_assist_batch` + Result Contract** - First structured-output tool in the repo: Zod in/out schemas, `structuredContent` + text summary, per-task + batch result contract, MCP annotations (completed 2026-06-26)
- [x] **Phase 8: Verify End-to-End** - Clean build, full suite green, MCP Inspector mixed batch (normal + failing + timeout) confirms order-preserving partial results (completed 2026-06-27)

## Phase Details

### Phase 5: Extract Shared `runTask` Executor

**Goal**: A single reusable `runTask(kind, input)` dispatch is the one source of truth for prompt + tier + maxTokens across both the single-task tools and the (future) batch tool — with observable behavior identical to today
**Depends on**: Phase 4 (v1.0 shipped)
**Requirements**: BATCH-01, BATCH-02
**Success Criteria** (what must be TRUE):

  1. `runTask(kind, input)` exists as a `TASK_SPECS` dispatch map (kind → tier, maxTokens, buildPrompt); the 11 AI-backed handler heads call it while each handler's try/runAIWithMetrics/log/catch tail is unchanged (routingInfo, the static no-AI tool, is excluded)
  2. All 108 existing tests pass and `npx tsc --noEmit` is clean — `tool-handlers`, `observability`, and `input-validation` suites are green with no changes to their assertions
  3. A new `runtask.test.ts` asserts byte-identical `buildPrompt` output per kind (the only guard against prompt drift, which the AI-mocked suite cannot see) — covering at minimum generateCode, reviewCode, transformCode, explainCode
  4. `explainCode`'s depth-conditional routing is preserved (detailed → standard/4096, brief/eli5 → fast/2048) — modeled as a function of `input`, not a constant — and `transformCode`'s pre-AI 8KB byte cap still fires

**Plans**: 2 plans

Plans:
**Wave 1**

- [x] 05-01-PLAN.md — Extract TASK_SPECS dispatch map + runTask executor + ValidationError; delegate all 11 AI-backed handler heads (BATCH-01)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 05-02-PLAN.md — Add runtask.test.ts: byte-identical buildPrompt snapshots for all 11 kinds, explainCode resolve, transformCode 8KB cap (BATCH-02)

### Phase 6: Batch Core + Bounded Pool + Timeout

**Goal**: A pure, importable batch engine runs tasks through a bounded worker pool with a per-call cap, a per-task timeout, order-preservation, and failure isolation — fully unit-testable with a fake `runTask`, no `env` and no AI mock
**Depends on**: Phase 5 (the core's only real dependency is a working `runTask`)
**Requirements**: BATCH-03, BATCH-04, BATCH-05, BATCH-06
**Success Criteria** (what must be TRUE):

  1. Peak in-flight task count never exceeds the concurrency cap (default 6, `BATCH_CONCURRENCY`) — verified by an in-flight counter test using a deferred/never-resolving mock; never a naive `Promise.all` over the task array
  2. A batch with more than the per-call cap (default 50, `BATCH_MAX_TASKS`) is rejected fast with an actionable "split it" message before any task dispatches — a spy asserts zero `runTask` calls
  3. Results are order-preserving by index (verified with inverted durations: task 0 slow, task N fast → `results[i].index === i`) and failure-isolated (one throwing task yields one `status:'error'` entry while siblings still return `status:'ok'`) — index-write into a pre-sized array, never `push`
  4. A task exceeding the per-task timeout (default 45000ms = `AI_TIMEOUT_MS`, `BATCH_TASK_TIMEOUT_MS`) returns a `status:'error'` entry without hanging the batch; a mock that resolves *after* the timeout produces no double-settle and no unhandled rejection — `withTimeout` keeps the settle-once + two-handler `.then(onResolve, onReject)` form

**Plans**: 1 plan

Plans:
**Wave 1**

- [x] 06-01-PLAN.md — Pure env-free batch engine (src/batch.ts: executeBatch / mapWithConcurrency / withTimeout / readBatchConfig) + four headline tests in src/__tests__/batch.test.ts (BATCH-03, BATCH-04, BATCH-05, BATCH-06)

### Phase 7: Register `code_assist_batch` + Result Contract

**Goal**: `code_assist_batch` is wired into `createMcpServer` as the repo's first structured-output tool, returning an order-preserving partial-results contract that parses against its declared output schema
**Depends on**: Phase 6 (registration needs `executeBatch`) and Phase 5 (needs `runTask`)
**Requirements**: BATCH-07, BATCH-08, BATCH-09
**Success Criteria** (what must be TRUE):

  1. Each task returns independently as `{id, index, kind, status:'ok', result, latency_ms}` or `{id, index, kind, status:'error', error, error_type, latency_ms}` where `error_type` is one of `timeout | validation | ai_error`; per-task `input` is an open record validated per-kind *inside* `runTask` (not a discriminated union at the MCP boundary, which would reject the whole batch on one bad task)
  2. The batch returns a summary with `total`, `succeeded`, `failed`, and `failedIds`, plus a short human-readable text block alongside the structured results
  3. The tool returns `structuredContent` AND a `content` text summary together, declares Zod input + output schemas (keeping `result: z.unknown()` and `as const` status literals), and sets annotations `readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:true`
  4. A unit test parses real `executeBatch` output (all-ok AND mixed) against the output schema and both pass; the tool inherits the existing OAuth gate by registering in the same `createMcpServer` (one-line wire)

**Plans**: 1 plan

Plans:
**Wave 1**

- [x] 07-01-PLAN.md — Add batch schemas + deriveErrorType + runBatch enrichment, register code_assist_batch (structured-output tool, output schema + annotations), and batch-tool.test.ts (BATCH-07, BATCH-08, BATCH-09)

### Phase 8: Verify End-to-End

**Goal**: The whole seam is proven end-to-end through the real `createMcpServer` — order-preserving partial results and the timeout path both demonstrated, with the single-task tools and build untouched
**Depends on**: Phase 7
**Requirements**: BATCH-10
**Success Criteria** (what must be TRUE):

  1. `npm run build` is clean and the full suite (108 existing + new runtask/batch-core/batch-tool tests) is green
  2. An MCP Inspector run (`npx @modelcontextprotocol/inspector`) of a mixed batch — a normal task, a deliberately failing task, and a deliberately slow/timeout task — returns order-preserving partial results: the failing task is a `status:'error'` entry, the timeout task hits the timeout path, and the normal task is `status:'ok'`, all in input order
  3. Inspector confirms the response renders both `structuredContent` and the text summary; the single-task tools still pass their existing tests, demonstrating the refactor stayed behavior-preserving end-to-end

**Plans**: 1 plan

Plans:
**Wave 1**

- [x] 08-01-PLAN.md — Add src/__tests__/batch-e2e.test.ts: committed fast 3-task mixed-batch e2e (ok+validation+timeout, order-preserving) through real createMcpServer + describe.skip real-45s-wait opt-in block + build gate (BATCH-10)

## Progress

**Execution Order:**
Phases execute in numeric order: 5 → 6 → 7 → 8 → 9 → 10 (dependency-forced; do not reorder)

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 0. Repository Foundation | v1.0 | — | Complete | shipped |
| 1. Security Hardening | v1.0 | 4/4 | Complete | shipped |
| 2. Error Handling & Reliability | v1.0 | 2/2 | Complete | shipped |
| 3. Test Infrastructure | v1.0 | 3/3 | Complete | shipped |
| 4. Observability | v1.0 | 2/2 | Complete | shipped |
| 5. Extract Shared `runTask` Executor | v2.0 | 2/2 | Complete   | 2026-06-26 |
| 6. Batch Core + Bounded Pool + Timeout | v2.0 | 1/1 | Complete   | 2026-06-26 |
| 7. Register `code_assist_batch` + Result Contract | v2.0 | 1/1 | Complete   | 2026-06-26 |
| 8. Verify End-to-End | v2.0 | 1/1 | Complete   | 2026-06-27 |
| 9. Second model and tier split | v2.0 | 1/1 | Complete   | 2026-06-28 |
| 10. Batch per-task cancellation and tier override | v2.0 | 0/0 | Not planned | — |

### Phase 9: Second model and tier split

**Goal:** Make the dormant two-tier routing real — the `standard` tier resolves to a Kimi coding model (`@cf/moonshotai/kimi-k2.7-code`, or `kimi-k2.5` fallback) while `fast` stays on qwen3-30b. Behavior-shape preserving (same prompts/parsing); only the model behind `standard` changes. Enables Phase 10's per-task tier override.
**Requirements**: MODEL-03 (model selection); enables BATCH-F03
**Depends on:** Phase 8
**Plans:** 1/1 plans complete

Plans:
**Wave 1**

- [x] 09-01-PLAN.md — Types gate + Kimi-id decision, ALLOWED_MODELS/DEFAULT_MODELS standard→Kimi, model-routing tests, Model Tiers docs (MODEL-03)

### Phase 10: Batch per-task cancellation and tier override

**Goal:** Resolve the two deferred batch requirements — BATCH-F01 (thread a real `AbortSignal` into `env.AI.run` so a timed-out batch task actually cancels instead of best-effort racing) and BATCH-F03 (tier-only per-task override in the batch input, reusing the allowlist/KV abstraction — no raw model strings at the MCP boundary). Single-task tools stay behavior-identical.
**Requirements**: BATCH-F01, BATCH-F03 (promoted from REQUIREMENTS.md Future Requirements)
**Depends on:** Phase 9 (F03's override is only meaningful once the two tiers resolve to different models)
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd:plan-phase 10 to break down)
