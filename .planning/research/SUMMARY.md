# Project Research Summary

**Project:** CF Code Assistant — v2.0 Concurrent Batch Fan-out (`code_assist_batch`)
**Domain:** Bounded-concurrency batch fan-out tool added to a stateless Cloudflare Workers MCP server
**Researched:** 2026-06-25
**Confidence:** HIGH

## Executive Summary

This milestone is **additive and narrow**: one new MCP tool, `code_assist_batch`, that fans an array of independent tasks out to the existing per-kind AI executor with bounded concurrency, a per-task timeout, a per-call cap, and an order-preserving partial-results contract. All four research tracks converge on the same conclusion and were grounded directly in the real `src/index.ts`, the 108-test suite, and the `.planning/batch.ts` reference — so confidence is uniformly HIGH and the design is essentially locked. The way experts build this is the way the reference already encodes it: a cursor-based worker pool (not `Promise.all`), a `Promise.race` wall-clock timeout, per-task `try/catch` that converts failures into result entries, and a single shared executor injected into the pool rather than reimplemented.

The load-bearing recommendation is **zero new dependencies**. `p-limit` is not installed and must not be added — an inline ~18-line `mapWithConcurrency` covers the requirement and runs unchanged on the Workers V8 isolate using only Web-standard globals (`AbortController`, `setTimeout`, `Promise.all`/`Promise.race`). The installed MCP SDK is **1.29.0** (satisfies the `^1.26.0` floor), which fully supports `outputSchema`, `structuredContent`, and tool `annotations` — the three APIs the batch tool is the first in this repo to use. Zod 4.3.6 is installed and supports both the repo's `ZodRawShape` convention and discriminated unions. No upgrades are needed, and an unforced bump would risk the green suite.

The dominant risk is **not** the pool — it is the seam where new code meets frozen v1.0 behavior. The highest-risk work is the Phase 1 extraction of a shared `runTask` from 11 non-uniform inline handlers: prompt drift is **invisible to the existing tests** (the AI mock ignores prompt content), so a naive extraction passes CI while silently degrading real output quality. This is why a new prompt-snapshot test is the load-bearing regression guard. The second sharpest risk is timeout semantics: `callModel` owns its own 45s `AbortController` and accepts no external signal, so the batch timeout is a *return-time guarantee* (via the race rejection) and a *best-effort abort*, never a cancellation — the two-handler `.then(onResolve, onReject)` form in `withTimeout` must be preserved to prevent orphaned unhandled rejections.

## Key Findings

### Recommended Stack

Nothing to install. Every capability the feature needs is already in the installed stack plus Workers runtime globals. The inline pool, the timeout race, and the schema wiring are all covered by core; no supporting libraries, no SDK/Zod bump, no Durable Objects or queues (stateless MCP is locked). See **STACK.md**.

**Core technologies:**
- `@modelcontextprotocol/sdk` **1.29.0** (installed) — tool registration with `inputSchema`/`outputSchema`/`structuredContent`/`annotations`; all four verified against the installed source + Context7, not just the `^1.26.0` floor. **Keep the repo's `ZodRawShape` form**, not `z.object()`.
- `zod` 4.3.6 (installed) — input/output schemas and the discriminated-union result shape; **pin it** for this milestone (a minor bump could alter discriminated-union behavior silently).
- Workers runtime globals — `AbortController`, `setTimeout`, `Promise.all`/`Promise.race`, `Array.from`; the exact primitives `callModel` already uses in production, so zero new runtime-API risk.
- (none) supporting libraries — **do NOT add `p-limit`/`p-map`/`p-queue`**; inline `mapWithConcurrency` (~18 lines) is the explicit decision.

### Expected Features

A single new tool over the **11 AI-backed kinds** (`routingInfo` is static — excluded). Input shape is an open per-task `input` record validated per-kind *inside* `runTask`, not a discriminated union at the MCP boundary (a boundary union would reject the whole batch on one malformed task, breaking partial results). See **FEATURES.md**.

**Must have (table stakes):**
- `tasks[]` of `{id?, kind(enum of 11), input(record)}` — the tool's reason to exist; `id` defaults to array index
- Shared `runTask` executor reused by both single-task tools and batch — one source of truth for the Qwen call
- Bounded pool (default 6, `BATCH_CONCURRENCY`), never `Promise.all` over tasks
- Per-call cap (default 50, `BATCH_MAX_TASKS`), **fail-fast before any dispatch** with an actionable "split it" message
- Per-task timeout (default 60000ms, `BATCH_TASK_TIMEOUT_MS`) via race + best-effort abort
- Partial-results contract: per-task `status:'ok'|'error'`, order-preserving by `index`, `id` echoed, `kind` echoed
- Batch summary `total`/`succeeded`/`failed`; `structuredContent` (typed via `outputSchema`) **plus** a short `content` text summary
- MCP annotations: `readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:true`

**Should have (cheap differentiators — fold in if room):**
- `error_type:'timeout'|'validation'|'ai_error'` on error entries — lets the caller re-issue timeouts without string-matching
- `failedIds` + `total_latency_ms` in the summary, and per-task `latency_ms` — re-issue convenience + parallelism sanity check
- Per-kind input validation surfaced as a per-task error (reusing the exact v1.0 Zod caps, e.g. transformCode 8KB)

**Defer / out of scope (anti-features, by design):**
- Cross-task dependencies / DAG, streaming/progressive results, internal retries, unbounded `Promise.all`, sibling-abort on one timeout, per-task model/tier override, external artifact store — each re-opens a fenced-off decision or breaks the order-preserving complete-array contract.

### Architecture Approach

The batch tool adds **one new node** in the tool layer (`code_assist_batch`) and **one new shared node** one level below it (`runTask`); everything from `runAIWithMetrics` downward is untouched. The pure core (`executeBatch` + `mapWithConcurrency` + `withTimeout` + `readBatchConfig`) is dependency-injected — it never imports `env`, `callModel`, or the SDK — so it unit-tests in isolation with a fake `runTask`. See **ARCHITECTURE.md**.

**Major components:**
1. `runTask(env, kind, input, signal?)` + `TASK_SPECS` dispatch map (`kind → {tier, maxTokens, buildPrompt}`) — NEW shared executor; the lifted prompt-build *head* of each handler. Handlers keep their try/log/catch *tail* unchanged so the 108 tests stay green.
2. `executeBatch` / `mapWithConcurrency` / `withTimeout` / `readBatchConfig` — NEW pure batch core in `src/batch.ts`, order-preserving via index-write into a pre-sized array.
3. `registerBatchTool(server, {runTask, env})` — NEW registration with Zod in/out schemas, annotations, `structuredContent` + text summary; wired into `createMcpServer` with one line.

### Critical Pitfalls

1. **`runTask` extraction regression (HIGHEST RISK)** — 11 handlers differ in prompt, tier (`explainCode` is depth-conditional), `maxTokens`, input guards, and logging. Prompt drift is invisible to the existing suite. Avoid: strictly behavior-preserving extraction, run all 108 tests green, and add a **prompt-snapshot test** for `generateCode`/`reviewCode`/`transformCode`/`explainCode` as the only guard that catches drift.
2. **Timeout / leaked work / unhandled rejection** — `callModel` ignores external signals; the race rejection is the *only* return guarantee, the AI call leaks until its own 45s timeout. Avoid: keep `withTimeout`'s settle-once + two-handler `.then(onResolve, onReject)` form (prevents orphaned unhandled rejections); keep `BATCH_TASK_TIMEOUT_MS (60s) > AI_TIMEOUT_MS (45s)` so clean `AI_TIMEOUT` classification survives.
3. **Subrequest exhaustion** — each task = 1 subrequest; 50 free / 1000 paid. Avoid: enforce `BATCH_MAX_TASKS` fail-fast *before* any dispatch (cap is the guardrail, concurrency is not — concurrency bounds simultaneity, not cumulative count).
4. **Error isolation / order preservation** — one rejecting task must not abort the batch; pool tasks finish in completion order. Avoid: per-task `try/catch` returning `{status:'error'}` (never rejects the pool), and index-write into a pre-sized array (never `push`).
5. **Output-schema / `structuredContent` mismatch** — first structured-output tool in the repo. Avoid: keep `result: z.unknown()` (shallow O(N) validation, avoids CPU-limit blowup on large batches), keep `as const` on the `status` literals, always return `structuredContent` AND a `content` text block, align `BatchOutputShape` exactly with the `executeBatch` return object.

## Implications for Roadmap

The build order is **dependency-forced** and matches all four research tracks: extract `runTask` → pure batch core + pool → register tool → verify E2E. The core's only real dependency is a working `runTask`; registration needs `executeBatch`; nothing reorders.

### Phase 1: Extract shared `runTask` (behavior-preserving refactor)
**Rationale:** The batch core is meaningless without the shared executor it injects; this is a pure refactor that must land first and in isolation. It is also the highest-risk work.
**Delivers:** `runTask(env, kind, input, signal?)` + `TASK_SPECS` map; 11 handler heads rewritten to call it, tails unchanged.
**Addresses:** "Reusable `runTask` executor reused by single-task tools and batch" (FEATURES table stakes; PROJECT key decision #1 — one source of truth).
**Avoids:** Pitfall 7 (refactor regression). **Gate:** `tsc --noEmit` clean + all 108 tests green + NEW prompt-snapshot test asserting byte-identical prompts (incl. `explainCode` depth→tier/tokens and `transformCode` 8KB cap).

### Phase 2: Pure batch core + bounded pool + timeout
**Rationale:** Self-contained, no MCP/env coupling — fully testable before any server wiring, with a fake `runTask`.
**Delivers:** `mapWithConcurrency`, `withTimeout`, `executeBatch`, `readBatchConfig` in `src/batch.ts`.
**Uses:** Inline pool + `Promise.race` + Web-standard globals (STACK — zero new deps).
**Implements:** The pure-core component. **Avoids:** Pitfalls 1 (fail-fast cap before dispatch), 3 (bounded concurrency), 4 (index-write ordering + error isolation), 6 (settle-once timeout, two-handler form). **Gate:** unit tests for order preservation under inverted durations, peak in-flight ≤ concurrency, over-cap rejects with zero `runTask` calls, timeout returns `status:'error'` with no hang and no unhandled rejection on late resolve.

### Phase 3: Register `code_assist_batch` + wire into `createMcpServer`
**Rationale:** Depends on both Phase 1 (`runTask`) and Phase 2 (`executeBatch`); cannot precede them.
**Delivers:** `registerBatchTool` with Zod in/out schemas, annotations, `structuredContent` + text summary; one-line wire; optional `Env` config fields.
**Addresses:** Structured-output + annotations table stakes; the P2 differentiators (`error_type`, `failedIds`, `latency_ms`) fold in here if room.
**Avoids:** Pitfall 8 (output-schema mismatch — keep `result: z.unknown()`, `as const` literals, `BatchOutputShape` ≡ runtime object; inherits OAuth gate by registering in the same server). **Gate:** real `executeBatch` outputs (all-ok + mixed) parse against `BatchOutputShape`.

### Phase 4: E2E verification
**Rationale:** Confirms the seam end-to-end through the real `createMcpServer`.
**Delivers:** Full suite green (108 + new); a forced-failure mixed batch returns ok+error entries in order; Inspector renders structured + text; near-full large-output batch confirms CPU headroom.

### Phase Ordering Rationale

- **Dependency-forced:** `runTask` → core → register → verify is the only valid order; the quality gate requires exactly this sequence. Every research track independently arrived at it.
- **Risk-front-loaded:** the riskiest work (prompt-drift-invisible refactor) is isolated in Phase 1 with the existing suite + new snapshots as the guard, so failures surface before any new surface is built on top.
- **Pitfall placement:** subrequest cap, concurrency, ordering, error isolation, and timeout semantics all concentrate in Phase 2 (the pure core), where they are cheaply and deterministically testable without `env` or AI.

### Research Flags

Phases likely needing deeper research during planning:
- **None.** All four research files are HIGH confidence and grounded in the actual code + a conventions-correct reference. No `/gsd:plan-phase --research-phase` is warranted.

Phases with standard patterns (skip research-phase):
- **Phase 1** — behavior-preserving extraction; the per-kind config (prompt/tier/maxTokens/guards/logging) is fully enumerated in PITFALLS and ARCHITECTURE.
- **Phase 2** — the reference `batch.ts` encodes the pool, race, cap, and partial-results contract; adopt nearly verbatim.
- **Phase 3** — SDK 1.29.0 `outputSchema`/`structuredContent`/`annotations` verified; the output schema is fully specified in FEATURES.
- **Phase 4** — verification only.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Verified against installed `@modelcontextprotocol/sdk@1.29.0` source + Context7; `p-limit` confirmed absent; zero-dep path proven by `callModel`'s existing use of the same primitives. |
| Features | HIGH | MCP `content`/`structuredContent` split + batch partial-success conventions verified against the official spec + maintainer discussion; reference `batch.ts` already encodes the contract; 11 kinds enumerated from source. |
| Architecture | HIGH | Grounded in the actual `src/index.ts` line ranges, the 9 test files, and the reference; the test seam analysis proves which behavior is/isn't observable. |
| Pitfalls | HIGH | Every pitfall is THIS-codebase-specific, tied to real line numbers, the 108-test seam, and verified subrequest/CPU limits. |

**Overall confidence:** HIGH

### Gaps to Address

- **`BATCH_TASK_TIMEOUT_MS` (60s) vs `AI_TIMEOUT_MS` (45s) interaction** — the inner 45s timeout fires first, so the effective per-task ceiling is ~45s and the 60s race is a backstop. This is a **planner decision**: accept it (and document the best-effort-abort semantics) or align the two values. Net behavior is correct either way (the batch never hangs).
- **Does a batch task emit `logToolInvocation`?** — confirm `observability.test.ts` does not assert exactly one invocation log per request before deciding whether 50-task batches produce 50 log lines or log under a distinct `tool` name. Decide deliberately in Phase 1.
- **transformCode 8KB guard placement** — keep it in the handler tail (single-task unchanged) and additionally enforce inside `runTask` (recommended) so the batch path reports oversized transforms as a per-task `{status:'error'}` rather than letting them hit the 45s timeout.
- **`explainCode` depth-conditional tier/tokens** — the `TASK_SPECS` value must be a function of `input` (not a constant) for this kind; model it that way in Phase 1 or `observability.test.ts` turns red.

## Sources

### Primary (HIGH confidence)
- `/modelcontextprotocol/typescript-sdk` (Context7) — `registerTool` with `inputSchema`/`outputSchema`/`structuredContent`; `annotations` config fields.
- Installed `node_modules/@modelcontextprotocol/sdk/package.json` → 1.29.0; `package.json` + `node_modules/` (p-limit absent, zod 4.3.6).
- `src/index.ts` — `callModel` (own 45s timeout, no external signal, 130-166), `runAIWithMetrics`, the 11 inline handlers (per-kind prompt/tier/maxTokens/guards/logging), transformCode 8KB cap, `ZodRawShape` convention.
- `src/__tests__/tool-handlers.test.ts`, `observability.test.ts`, `helpers.ts`, `vitest.config.*` — the `_registeredTools[name].handler` seam and the exact assertions that constrain the refactor.
- `src/logger.ts` — `logToolInvocation`/`logToolError` structured fields the refactor must preserve.
- `.planning/batch.ts` — reference pool, settle-once `withTimeout`, `executeBatch` cap check, discriminated-union output schema, annotations.
- `.planning/PROJECT.md` — key decisions, constraints, milestone scope.

### Secondary (MEDIUM confidence)
- MCP spec discussions / blog posts on `content` vs `structuredContent`, large-result handling, and the 2025-06-18 structured-output update.
- Batch-API partial-success / 207 multi-status conventions (corroborated across multiple industry sources).
- `.planning/codebase/ARCHITECTURE.md`, `CONVENTIONS.md`, `CONCERNS.md` (dated 2026-04-12; predate the logger.ts split but patterns hold; flagged the Zod `^4.0.0` caret risk).

---
*Research completed: 2026-06-25*
*Ready for roadmap: yes*
