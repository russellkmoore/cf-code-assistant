# Feature Research

**Domain:** Concurrent batch / fan-out tool for an MCP server (single new `code_assist_batch` tool over 11 existing AI-backed code-assist kinds)
**Researched:** 2026-06-25
**Confidence:** HIGH (MCP content/structuredContent split and batch partial-success conventions verified against official MCP spec discussion + industry batch-API guidance; reference `batch.ts` already encodes the contract)

## Scope Note

This milestone is **additive and narrow**: one new tool that fans an array of independent tasks out to the existing per-kind executor. The 11 single-task tools, their Zod schemas, OAuth, two-tier routing, structured logging, and error handling are **already built and stay untouched**. Feature analysis below is scoped strictly to the batch tool's input/output surface and behavioral contract.

The 11 AI-backed kinds the batch must target (from `src/index.ts`, with their required/optional params):

| kind | required | optional |
|------|----------|----------|
| `generateCode` | `prompt` | `context`, `language`, `style` |
| `reviewCode` | `code` | `criteria` |
| `transformCode` | `code`, `instruction` | — (8KB input cap via `TRANSFORM_CODE_MAX_BYTES`) |
| `scaffoldTests` | `code` | `framework` |
| `quickTask` | `instruction` | — |
| `explainCode` | `code` | `depth` (brief/detailed/eli5) |
| `generateDocs` | `code` | `style` (jsdoc/tsdoc/inline) |
| `generateTypes` | `code` | — |
| `fixBug` | `code`, `error` | — |
| `generateCommitMessage` | `diff` | — |
| `generateWorkerBoilerplate` | `description` | `bindings` |

(`routingInfo` is static, no AI call — **not** a valid batch kind.)

## Feature Landscape

### Table Stakes (Users Expect These)

Features an agent caller assumes a fan-out batch tool has. Missing these = the tool is unsafe or unusable for orchestration.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| `tasks[]` input array, each `{id?, kind, input}` | The whole point — submit N heterogeneous tasks in one call | LOW | `id` optional, defaults to array index (per `batch.ts` line 46-50) |
| `kind` is an enum of the supported AI-backed kinds | Caller must know valid operations; bad kind = fast validation error | LOW | Use the 11 kinds above, **not** the brief's placeholder 5-kind enum in `batch.ts` line 52 |
| `input` is the matching single-task tool's payload | Reuse, don't reinvent — same params the singleton accepts | MEDIUM | See "Recommended Input Shape" — `z.record(z.unknown())` at the batch boundary, validated per-kind inside `runTask` |
| Bounded concurrency (default 6, `BATCH_CONCURRENCY`) | Unbounded `Promise.all` over 50 tasks blows the Workers subrequest/429 budget | MEDIUM | Fixed worker pool pulling a shared cursor (`mapWithConcurrency`, `batch.ts` line 98) |
| Per-call task cap (default 50, `BATCH_MAX_TASKS`), fail-fast over limit | Each task = 1 subrequest; 50 is safe on free + paid plans | LOW | Reject **before** running any task, with an actionable "split it" message (`batch.ts` line 137) |
| Per-task timeout (default 60000ms, `BATCH_TASK_TIMEOUT_MS`) | One hung Qwen call must not stall the batch return | MEDIUM | Race + best-effort `AbortController.abort()`; the rejection is the guarantee since `callModel` ignores external signals |
| Partial-results contract — per-task `status:'ok'\|'error'` | One failure must be a result entry, not a thrown batch (industry standard: HTTP 207 multi-status pattern) | MEDIUM | `try/catch` per task inside the pool; failure → `{status:'error', error}` |
| Order-preserving results indexed by submission order | Caller correlates results to inputs; out-of-order is a footgun | LOW | Write into `results[i]`, not push-on-complete (`batch.ts` line 110) |
| `index` + echoed `id` on every result entry | Correlation back to the submitted task, regardless of completion order | LOW | `id = task.id ?? String(index)` |
| `kind` echoed on every result entry | Caller routes/parses each result by its operation type | LOW | Already in `TaskResultSchema` |
| Batch-level counts: `total`, `succeeded`, `failed` | The "summary" half of the standard `{summary, results}` batch contract | LOW | `BatchOutputShape` already has these |
| `structuredContent` conforming to declared `outputSchema` | MCP 2025-06-18: typed, client-validatable machine output | LOW | Zod `outputSchema` → structuredContent (MCP spec) |
| Short human-readable `content` text summary | MCP convention: `content` = conversational summary, `structuredContent` = machine data; complementary roles | LOW | e.g. "Batch complete: 8/10 ok, 2 failed. Failed ids: x, y" (`batch.ts` line 204) |
| MCP tool annotations | Clients use hints for UX/safety gating | LOW | `readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:true` |
| Actionable error messages on validation failures | Agent needs to self-correct (split batch, fix kind) | LOW | Over-cap message names the limit + the env knob |

### Differentiators (Competitive Advantage)

Not required for a correct batch tool, but cheap, high-value additions that make it pleasant for an agent orchestrator. Align with Core Value (keep Claude thin, surface enough to re-issue without re-reasoning).

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Distinguish timeout from generic error in result shape | Lets caller re-issue timeouts (retryable) vs. fix validation errors (not retryable) without parsing message strings | LOW | Add `error_type:'timeout'\|'validation'\|'ai_error'` to the error entry; mirrors existing `AI_TIMEOUT`/`AI_ERROR` codes in `src/index.ts`. Recommended — low cost, real value |
| `failedIds` (or `failed` list) precomputed in the summary | Caller re-issues just the failures without filtering the array itself | LOW | `batch.ts` already computes this inline for the text summary; promote it into `structuredContent` |
| Per-task `latency_ms` in the result entry | Observability parity with the existing single-task `logToolInvocation`; lets caller see which kinds are slow | LOW | The singletons already capture `latency_ms`; thread it through `runTask`'s return |
| Batch-level `total_latency_ms` (wall-clock) | Confirms the fan-out actually parallelized vs. serialized; a sanity signal | LOW | Single `Date.now()` delta around `executeBatch` |
| Per-kind validation at the batch boundary (reject bad `input` shape as a per-task `error`, not a thrown batch) | A malformed `input` for one task becomes a `status:'error'` entry, not a 500 that loses the other 49 results | MEDIUM | Validate `task.input` against the per-kind Zod schema **inside** the task's try/catch, so it degrades to a partial error like any other failure |
| `model`/`tier` echoed per result | Lets caller confirm which tier each kind ran on (fast vs standard) | LOW | Already known inside the executor; cheap to surface |

### Anti-Features (Commonly Requested, Often Problematic)

Features that sound useful for a "batch" tool but break the contract, the runtime, or the Core Value. Documented to prevent scope creep — all are already excluded by the brief/PROJECT.md, this records *why*.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Cross-task dependencies / DAG (task B uses task A's output) | "Real workflows have ordering" | Turns a stateless fan-out into a workflow engine; needs topological scheduling, partial-failure propagation, state. Out of scope and out of character for a stateless Worker | Keep tasks **independent**. The orchestrating agent (Claude) sequences dependent steps across multiple batch calls — that's exactly the "Claude stays thin, orchestrates" split |
| Streaming / progressive results | "I want to see results as they finish" | Contract is a complete order-preserving array; streaming breaks index-ordering guarantees and the single `structuredContent` return. MCP tool return is one CallToolResult, not a stream | Return the complete array. PROJECT.md explicitly scopes streaming out |
| Retries inside the batch | "Auto-retry transient Qwen 429s/timeouts" | Hidden retries multiply subrequests (blowing the 50-cap math), inflate wall-clock unpredictably, and mask which tasks are flaky. The cap assumes 1 subrequest/task | Return the failure as a `status:'error'` (ideally tagged `timeout`) entry; the caller re-issues a fresh small batch of just the failures. Retry policy lives with the orchestrator, not the fan-out primitive |
| Unbounded `Promise.all` over all tasks | "Simpler / faster" | Fires up to 50 concurrent Workers AI subrequests → 429s and subrequest-limit errors; one slow task still can't be bounded | Fixed worker pool, default 6 in flight (`BATCH_CONCURRENCY`) |
| Throwing the whole batch on first failure | "Fail fast" | Loses the 49 good results; defeats the entire reason to batch | Partial-results contract — failures are entries, never thrown (the one hard rule) |
| Mixing `routingInfo` (static) into the kind enum | "Support all 12 tools uniformly" | `routingInfo` makes no AI call and takes no input; it has no place in a fan-out of bounded AI work | Enum is the **11 AI-backed kinds only** |
| Aborting siblings when one task times out | "Stop wasting compute if something's wrong" | One slow task is normal under load; killing siblings throws away in-flight good work | Per-task timeout isolates the slow one; siblings run to completion |
| Per-task model/tier override in the batch input | "Let me pick the cheap model per task" | Re-opens model-selection, which the brief explicitly fences off ("beyond what `runTask` already does"); each kind already has a fixed tier | Tier stays an implementation detail of each kind, unchanged from v1.0 |
| Returning a download URL / external artifact store for large outputs | A real MCP large-result pattern (offload rows to a sandbox file) | Adds R2/storage + lifecycle the brief excludes; batch outputs here are code strings sized by the existing per-tool `maxTokens`, not thousands of rows | Return results inline in `structuredContent`; the per-tool token caps already bound size |

## Recommended Input Shape (lock this in requirements)

A task can target **any of the 11 kinds with that kind's own parameters**. Two viable encodings — recommend **Option A (open `input` record, validated per-kind inside the executor)** because it keeps the batch schema small, matches `batch.ts`, and degrades a bad payload to a per-task `error` instead of rejecting the whole batch at the MCP boundary.

```ts
// Option A — RECOMMENDED. Open input at the batch boundary; per-kind Zod
// validation happens inside runTask, so a malformed input for one task is a
// status:'error' entry, not a thrown batch.
const BatchTaskSchema = z.object({
  id: z.string().optional()
    .describe("Optional caller id echoed back for correlation. Defaults to the array index."),
  kind: z.enum([
    "generateCode", "reviewCode", "transformCode", "scaffoldTests", "quickTask",
    "explainCode", "generateDocs", "generateTypes", "fixBug",
    "generateCommitMessage", "generateWorkerBoilerplate",
  ]).describe("Which single-task code-assist operation to run."),
  input: z.record(z.unknown())
    .describe("Operation-specific payload — same shape as the matching single-task tool's input."),
});

const BatchInputShape = {
  tasks: z.array(BatchTaskSchema).min(1)
    .describe("Bounded tasks to run concurrently. Each runs independently; failures are reported per-task, never aborting the batch."),
};
```

> **Option B (discriminated union per kind)** gives stronger MCP-boundary typing but explodes the input schema into 11 branches and makes a single malformed task reject the entire call before any task runs — which **conflicts with the partial-results contract**. Use Option A and push validation inward.

**Dependency on existing schemas:** the per-kind validation inside `runTask` must reuse the **exact** Zod shapes from `src/index.ts` (e.g. `generateCode`'s `prompt`/`context`/`language`/`style` with their `.max()` caps; `transformCode`'s 8KB byte cap). Phase 1's `runTask` extraction is the natural home for those reused validators — do **not** duplicate or weaken the caps.

## Recommended Per-Task Result Shape (lock this in requirements)

```ts
const TaskResultSchema = z.discriminatedUnion("status", [
  z.object({
    id: z.string(),
    index: z.number().int(),
    kind: z.string(),
    status: z.literal("ok"),
    result: z.unknown(),                       // the tool's text output
    latency_ms: z.number().int().optional(),   // differentiator
  }),
  z.object({
    id: z.string(),
    index: z.number().int(),
    kind: z.string(),
    status: z.literal("error"),
    error: z.string(),                                          // human-readable
    error_type: z.enum(["timeout", "validation", "ai_error"]).optional(), // differentiator
  }),
]);

const BatchOutputShape = {
  total: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  failedIds: z.array(z.string()).optional(),       // differentiator: ready to re-issue
  total_latency_ms: z.number().int().optional(),   // differentiator: parallelism sanity check
  results: z.array(TaskResultSchema),
};
```

**Return BOTH** (MCP convention, verified): `structuredContent` = the `BatchOutputShape` object (machine-validatable against `outputSchema`, zero model-token cost in capable clients); `content[0].text` = a short summary like `"Batch complete: 8/10 ok, 2 failed. Failed ids: a, c"`. Not one or the other — the human summary is table stakes for older/non-structured clients and for the model's conversational view.

## Feature Dependencies

```
code_assist_batch tool registration
    └──requires──> executeBatch() + bounded pool + withTimeout()
                       └──requires──> runTask(kind, input, signal)   ← Phase 1 extraction
                                          └──reuses──> the 11 single-task Zod schemas + runAIWithMetrics

Partial-results contract ──requires──> per-task try/catch inside the pool
error_type tagging ──enhances──> Partial-results contract (caller can re-issue timeouts)
Per-kind input validation ──requires──> reused Zod schemas (must NOT weaken existing caps)
Per-kind input validation ──conflicts──> Option B discriminated-union input (boundary rejection breaks partial results)
Streaming ──conflicts──> order-preserving complete-array contract
```

### Dependency Notes

- **Batch core requires `runTask`:** the brief's hard decision #1 — no duplicating the Workers AI call. `runTask` is the Phase 1 deliverable; everything else depends on it.
- **`error_type` enhances partial-results:** without it, callers string-match `error` to decide retryability. With it, "re-issue all `timeout` tasks" is a clean filter. Low cost, recommend including.
- **Per-kind validation conflicts with Option B input:** a discriminated-union input schema rejects a malformed task at the MCP boundary, throwing away sibling results — directly contradicting the partial-results contract. Hence Option A.

## MVP Definition

### Launch With (this milestone — all table stakes)

- [ ] `tasks[]` input, `{id?, kind(enum of 11), input(record)}` — the tool's reason to exist
- [ ] `runTask(kind, input, signal)` reused executor (Phase 1, behavior-preserving) — hard decision #1
- [ ] Bounded pool, default 6 (`BATCH_CONCURRENCY`) — never `Promise.all`
- [ ] Per-call cap 50 (`BATCH_MAX_TASKS`), fail-fast actionable error — subrequest safety
- [ ] Per-task timeout 60000ms (`BATCH_TASK_TIMEOUT_MS`), race + best-effort abort
- [ ] Partial-results contract: per-task `status:'ok'|'error'`, order-preserving by `index`, `id` echoed
- [ ] Batch summary: `total`/`succeeded`/`failed`
- [ ] `structuredContent` (typed via `outputSchema`) **plus** short text summary
- [ ] MCP annotations (readOnly false, destructive false, idempotent false, openWorld true)

### Add After Validation (cheap differentiators — fold in if Phase 3 has room)

- [ ] `error_type` tag (timeout/validation/ai_error) — trigger: caller wants selective retry
- [ ] `failedIds` + `total_latency_ms` in summary — trigger: orchestrator wants one-glance re-issue + parallelism check
- [ ] Per-task `latency_ms` — trigger: observability parity with single-task logging
- [ ] Per-kind input validation as a per-task error — trigger: first malformed-input report from real use

### Future Consideration (explicitly deferred / out of scope)

- [ ] Anything in the Anti-Features table — deferred permanently by design (dependencies, streaming, retries, overrides, artifact store)

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| `tasks[]` + 11-kind enum + `runTask` reuse | HIGH | MEDIUM | P1 |
| Bounded pool + cap + timeout | HIGH | MEDIUM | P1 |
| Partial-results contract (order-preserving) | HIGH | MEDIUM | P1 |
| `structuredContent` + text summary + annotations | HIGH | LOW | P1 |
| `error_type` tagging | MEDIUM | LOW | P2 |
| `failedIds` + `total_latency_ms` summary fields | MEDIUM | LOW | P2 |
| Per-task `latency_ms` | LOW | LOW | P2 |
| Per-kind input validation as per-task error | MEDIUM | MEDIUM | P2 |
| Cross-task deps / streaming / internal retries | (negative) | HIGH | P3 (never) |

**Priority key:** P1 = must have for this milestone. P2 = should have, fold in if cheap. P3 = anti-feature, do not build.

## Competitor Feature Analysis

The relevant "competitors" are batch-API conventions and MCP large-result patterns, not products.

| Feature | REST bulk APIs (207 Multi-Status) | MCP large-result pattern | Our Approach |
|---------|-----------------------------------|--------------------------|--------------|
| Partial success | `{summary:{total,succeeded,failed}, results:[{status,data}]}` per-item | n/a | Same shape: `{total,succeeded,failed,results[]}` with per-task `status` |
| Status signaling | HTTP 207 "look inside the body" | single CallToolResult | One CallToolResult; per-task status inside `structuredContent` (MCP has no 207) |
| Result vs summary split | only-failed-items optimization | `content` summary + `structuredContent` data | Return all results inline (token caps bound size) + lean `content` summary |
| Size limits | enforce max batch (100–1000 typical) | offload to download URL when >500 rows | `BATCH_MAX_TASKS=50` (subrequest-bound, not size-bound); no offload — code outputs are token-capped |
| Concurrency | "process items concurrently" | n/a | Bounded pool of 6, never unbounded |
| Idempotency | `Idempotency-Key` header | n/a | `idempotentHint:false`; AI generation is non-idempotent by nature, no key |

## Sources

- MCP `content` vs `structuredContent` complementary roles, `outputSchema` validation — https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/1563 and https://modelcontextprotocol.io/specification/draft/server/tools (HIGH — official spec + maintainer discussion)
- MCP large-result handling (content lean, structuredContent for widgets, download URL for >500 rows) — https://futuresearch.ai/blog/mcp-results-widget/ (MEDIUM — informs the "no artifact store needed here" anti-feature call)
- MCP 2025-06-18 structured output update — https://forgecode.dev/blog/mcp-spec-updates/ (MEDIUM)
- Batch API partial-success contract (`{status, summary{total,succeeded,failed}, results[]}`), parallel processing, max-batch-size, 207 multi-status — https://oneuptime.com/blog/post/2026-02-02-rest-bulk-api-partial-success/view and https://codelit.io/blog/api-batch-endpoints (MEDIUM — industry convention, corroborated across sources)
- Reference implementation `batch.ts` (`.planning/batch.ts`) — encodes the exact pool, timeout race, `executeBatch`, and `registerBatchTool` contract (HIGH — provided design)
- Existing tool schemas — `src/index.ts` lines 211-560 (HIGH — source of truth for the 11 kinds and their params/caps)

---
*Feature research for: concurrent batch fan-out MCP tool*
*Researched: 2026-06-25*
