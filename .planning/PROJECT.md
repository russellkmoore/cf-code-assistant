# CF Code Assistant

## What This Is

A Cloudflare Workers MCP server that offloads mechanical code generation tasks from Claude (Sonnet/Opus) to @cf/qwen/qwen3-30b-a3b-fp8 via Workers AI. Claude remains the orchestrator — handling research, context gathering, architecture decisions, and workflow commands. This server handles the generation after Claude has assembled the context. Protected by OAuth 2.1 with a self-contained PIN-based auth flow.

## Core Value

Reduce Claude API token costs on mechanical code tasks without sacrificing output quality — every tool call that doesn't need Claude's reasoning saves tokens.

## Current Milestone: v2.0 Concurrent Batch Fan-out

**Goal:** Add a single new MCP tool, `code_assist_batch`, that runs many bounded code-assist tasks concurrently in one call — so a GSD executor can fan out independent leaf work (test generation, scaffolding, mechanical transforms) to Qwen instead of issuing N sequential tool calls or generating inline on an expensive model.

**Target features:**
- Reusable, signal-aware `runTask(kind, input)` executor shared by single-task tools and the batch tool (behavior-preserving refactor)
- `executeBatch()` with a bounded worker pool — default 6 in flight (`BATCH_CONCURRENCY`), never unbounded
- Per-task timeout (default 60000ms, `BATCH_TASK_TIMEOUT_MS`) via race + best-effort abort
- Per-call task cap (default 50, `BATCH_MAX_TASKS`) — fail fast with an actionable error over the limit
- Order-preserving partial-results contract — each task returns `{id, index, kind, status:'ok'|'error', ...}`; one slow or failing task never stalls or aborts siblings
- `code_assist_batch` registered with Zod input/output schemas, `structuredContent` + text summary, and MCP tool annotations

**Why:** The single-task tool shape is the bottleneck for parallel work. Adding internal fan-out turns "K parallel Claude executors" into "K executors × an N-wide cheap batch each," keeping Claude thin (orchestrate + validate) instead of generating code inline.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

- ✓ **TOOL-01**: 12 MCP tools registered and functional (generateCode, reviewCode, transformCode, scaffoldTests, quickTask, explainCode, generateDocs, generateTypes, fixBug, generateCommitMessage, generateWorkerBoilerplate, routingInfo) — v1.0
- ✓ **AUTH-01**: OAuth 2.1 authorization with PIN-based self-contained auth flow — v1.0
- ✓ **MODEL-01**: Two-tier model routing (fast/standard) with KV-backed config — v1.0
- ✓ **MODEL-02**: Self-healing model config (auto-revert to default on invalid model) — v1.0
- ✓ **INFRA-01**: Workers AI binding, KV namespace for OAuth/config, observability enabled — v1.0
- ✓ **INFRA-02**: Git repository initialized with .gitignore and baseline commit — v1.0
- ✓ **HARD-01**: Graceful error handling on all AI calls — timeouts, malformed responses, rate limits — v1.0 Phase 2
- ✓ **HARD-02**: Rate limiting on auth PIN attempts to prevent brute force — v1.0 Phase 1
- ✓ **HARD-03**: Input validation and sanitization on all tool inputs and auth form data — v1.0 Phase 1
- ✓ **HARD-04**: Structured error responses for all failure modes — v1.0 Phase 2
- ✓ **TEST-01..05**: Unit + integration coverage for model resolution, timing-safe auth, tool handlers, and error paths (108 tests, 95.5% statement coverage) — v1.0 Phase 3
- ✓ **SEC-01**: Type safety cleanup — eliminated `as any` cast on dynamic model routing — v1.0 Phase 1
- ✓ **SEC-02**: Tool input size validation (cap code/context length) — v1.0 Phase 1
- ✓ **OBS-01**: Structured request/response logging with tool name, tier, model used, latency — v1.0 Phase 4
- ✓ **BATCH-01**: Shared `runTask(env, kind, input)` executor + `TASK_SPECS` dispatch map — single source of truth for prompt/tier/maxTokens; all 11 AI-backed handlers delegate to it with byte-identical observable behavior — v2.0 Phase 5
- ✓ **BATCH-02**: Byte-equality prompt-snapshot guard (`runtask.test.ts`, 37 tests) against prompt drift the AI-mocked suite is structurally blind to — v2.0 Phase 5
- ✓ **BATCH-03**: Bounded worker-cursor pool (`mapWithConcurrency`, default 6 `BATCH_CONCURRENCY`) — peak in-flight never exceeds the cap, never `Promise.all` over the task array — v2.0 Phase 6
- ✓ **BATCH-04**: Per-call task cap (default 50, `BATCH_MAX_TASKS`) — `executeBatch` fast-rejects over-cap batches before any dispatch with an actionable "split it" error (zero `runTask` calls) — v2.0 Phase 6
- ✓ **BATCH-05**: Per-task timeout (default 45000ms = `AI_TIMEOUT_MS`, `BATCH_TASK_TIMEOUT_MS`) via settle-once two-handler `withTimeout` — a late-settling orphan causes no double-settle and no unhandled rejection — v2.0 Phase 6
- ✓ **BATCH-06**: Order-preserving (index-write into a pre-sized array, never `push`) + failure-isolated partial results — one throwing task yields a `status:'error'` entry while siblings still return `status:'ok'` — v2.0 Phase 6
- ✓ **Batch core**: pure, env-free, dependency-injected `src/batch.ts` (`executeBatch`/`mapWithConcurrency`/`withTimeout`/`readBatchConfig`) — fully unit-tested with a fake `runTask`, no `env` and no AI mock (8 tests, zero new deps) — v2.0 Phase 6
- ✓ **BATCH-07**: Per-task result contract — each task returns `{id,index,kind,status:'ok',result,latency_ms}` or `{id,index,kind,status:'error',error,error_type,latency_ms}` with `error_type ∈ {timeout|validation|ai_error}` via `deriveErrorType`; per-task `input` is an open record validated per-kind inside `runTask`, so one bad task is a `status:'error'` entry not a rejected batch — v2.0 Phase 7
- ✓ **BATCH-08**: Batch envelope (`total`, `succeeded`, `failed`, `failedIds`) + human-readable `summary` string alongside the order-preserving structured `results` — v2.0 Phase 7
- ✓ **BATCH-09**: `code_assist_batch` registered in `createMcpServer` as the repo's first structured-output tool — declares Zod input + output schemas (`result: z.unknown()`, `as const` status literals), returns `structuredContent` + text `content` together, sets the four MCP annotations, and inherits the existing OAuth gate (8 new tests, suite 161 green) — v2.0 Phase 7
- ✓ **BATCH-10**: End-to-end seam proven through the real `createMcpServer` — a mixed 3-task batch (ok + validation-fail + deterministic timeout) returns order-preserving partial results (`results[i].index === i`) with all three `status`/`error_type` outcomes, `BatchOutputSchema.parse(structuredContent)` clean, and a `describe.skip` opt-in 45s real-wait race block; single-task tools untouched (1 new test, suite 162 green) — v2.0 Phase 8

### Active

<!-- Current scope. Building toward these (v2.0). Detailed in REQUIREMENTS.md. -->

- [ ] **BATCH-\***: Concurrent batch fan-out — a single `code_assist_batch` tool that runs many bounded tasks with bounded concurrency, per-task timeout, a per-call cap, and an order-preserving partial-results contract, reusing the existing per-kind executor

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- Editing the GSD plugin itself (`~/.claude/plugins/...`) — this milestone changes only the MCP repo
- Auth / routing / model-selection changes beyond what `runTask` already does — out of scope by decision
- New external dependencies if a ~25-line inline pool suffices — prefer zero new deps; `p-limit` only if already present
- Model-tier config and the CLAUDE.md usage convention — separate follow-on work outside this repo
- Removing or replacing the single-task tools — singletons stay; a batch round-trip isn't worth it for one trivial task
- Streaming / progressive batch results — the contract returns a complete order-preserving array
- Multi-user support, admin UI, third-party OAuth — single-owner personal server (unchanged from v1.0)

## Context

- Brownfield project. v1.0 hardened the single-session build: security (type safety, input validation, rate limiting, error sanitization), error handling (AI timeout, KV fallback, structured MCP errors), test infrastructure (108 tests), and observability (structured JSON logging).
- Codebase mapped in `.planning/codebase/` — 7 documents covering stack, architecture, conventions, testing, integrations, structure, and concerns.
- **v2.0 integration point (grounded in code):** each tool handler in `src/index.ts` builds a prompt inline and calls `runAIWithMetrics(env, tier, prompt, maxTokens)`. `callModel()` owns an internal `AI_TIMEOUT_MS` AbortController but accepts **no external signal** — so the batch per-task timeout must rely on a race + best-effort abort, and Phase 1 extracts a reusable `runTask(kind, input)` dispatch over the 11 AI-backed kinds (routingInfo is static, no AI call).
- Reference implementation `batch.ts` attached in `.planning/` — a conventions-correct design (env config reader, order-preserving pool, race timeout, `executeBatch`, `registerBatchTool`) to adapt, not copy verbatim.
- Workers AI model ecosystem changes frequently — dynamic model config via KV is key to staying current.

## Constraints

- **Runtime**: Cloudflare Workers (V8 isolate, no Node.js APIs beyond nodejs_compat)
- **Subrequests**: Each Workers AI call is one subrequest — 50/request on free, 1000 on paid. Batch task cap defaults to 50 to stay safe on any plan.
- **Concurrency**: Bounded worker pool only — never naive `Promise.all` over all tasks
- **Auth**: Must use MCP-standard OAuth 2.1 (Claude Code expects this)
- **Cost**: Workers AI usage charges even in dev — tests must mock AI calls
- **Model**: @cf/qwen/qwen3-30b-a3b-fp8 as default, configurable via KV
- **State**: Stateless MCP server (createMcpHandler, no Durable Objects)
- **Compatibility**: Batch refactor must be behavior-preserving — existing single-task tools and their 108 tests stay green

## Key Decisions

<!-- Decisions that constrain future work. Add throughout project lifecycle. -->

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Stateless MCP (createMcpHandler) over McpAgent | No per-session state needed, simpler deployment | ✓ Good |
| Self-contained PIN auth over third-party OAuth | Single user, minimal setup, no external IdP dependency | ✓ Good |
| Two-tier model routing (fast/standard) | Cost optimization without per-tool complexity | ✓ Good |
| KV for model config | Hot-swap models without redeploy | ✓ Good |
| Self-healing model fallback | Prevent misconfigured KV from breaking all tools | ✓ Good |
| Reuse OAUTH_KV for model config | Avoid creating a second KV namespace for 2 keys | ✓ Good |
| v2.0: reuse existing executor, don't reimplement | One source of truth for the Qwen/Workers AI call; batch injects `runTask` | — Pending |
| v2.0: bounded pool (default 6), never `Promise.all` | Cap concurrent subrequests; avoid overrunning Workers limits | — Pending |
| v2.0: per-call task cap 50 | One subrequest per task; safe on free (50) and paid (1000) plans | — Pending |
| v2.0: partial-results contract (status per task) | One failure/timeout is a result entry, not a thrown batch | — Pending |
| v2.0: prefer zero new deps (~25-line inline pool) | Keep the dependency surface minimal | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-06-27 — Phase 8 complete; **milestone v2.0 Concurrent Batch Fan-out complete** (BATCH-01..10 all validated; the `code_assist_batch` seam is proven end-to-end through the real `createMcpServer` with order-preserving partial results; 162 tests green, single-task tools behavior-preserving). Next: `/gsd:complete-milestone` to archive v2.0.*
