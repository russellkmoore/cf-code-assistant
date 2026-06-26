# Stack Research

**Domain:** Concurrent batch fan-out tool for a Cloudflare Workers MCP server (v2.0 `code_assist_batch`)
**Researched:** 2026-06-25
**Confidence:** HIGH

## Headline Finding

**Zero new dependencies are required.** Everything the `code_assist_batch` feature needs —
bounded-concurrency worker pool, per-task `AbortController` timeout race, MCP `outputSchema` +
`structuredContent`, and tool `annotations` — is already available in the installed stack
(`@modelcontextprotocol/sdk@1.29.0`, `zod@4.3.6`) plus Web-standard globals present on the
Workers runtime (`AbortController`, `setTimeout`/`clearTimeout`, `Promise.all`, `Promise.race`).
`p-limit` is **NOT** a current dependency and should **NOT** be added — the ~25-line inline pool
in the reference `batch.ts` covers the requirement and runs unchanged on Workers.

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `@modelcontextprotocol/sdk` | 1.29.0 (installed; `^1.26.0` in package.json) | Tool registration with `inputSchema`, `outputSchema`, `structuredContent`, `annotations` | **Already a dependency.** Verified via Context7 + installed source: `registerTool(name, config, handler)` config accepts `title`, `description`, `inputSchema`, `outputSchema`, `annotations`, `_meta`. No upgrade needed. |
| `zod` | 4.3.6 (installed; `^4.0.0` in package.json) | Input/output schema definition and validation | **Already a dependency.** SDK 1.29.0 accepts both `ZodRawShape` (plain field object) and `z.object()` for `inputSchema`/`outputSchema`. The existing 12 tools use the `ZodRawShape` form — `batch.ts` matches it exactly (`BatchInputShape`/`BatchOutputShape`). |
| Workers runtime globals | V8 isolate (`nodejs_compat`) | `AbortController`, `AbortSignal`, `setTimeout`, `clearTimeout`, `Promise.all`, `Promise.race`, `Array.from` | All Web-standard, all present on the Workers runtime. `callModel()` in `src/index.ts` already uses `AbortController` + `setTimeout` + `Promise.race` — the batch pool reuses the identical primitives, so there is zero new runtime-API risk. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none) | — | — | **No supporting libraries needed.** The concurrency pool, timeout race, and schema wiring are all covered by core. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `vitest` + `@cloudflare/vitest-pool-workers` | Test the pool, timeout race, cap enforcement, and partial-results contract | Already installed (108 tests passing). `executeBatch()` and `mapWithConcurrency()` are pure/injectable (`runTask` is a parameter) — unit-test them with a fake `runTask` (resolve/reject/hang via a controllable promise). No new AI cost; no real `env.AI.run`. |
| `wrangler types` | Regenerate `worker-configuration.d.ts` if new `env` vars are typed | Only needed if `BATCH_CONCURRENCY` / `BATCH_MAX_TASKS` / `BATCH_TASK_TIMEOUT_MS` are added to `wrangler.toml` `[vars]`. `readBatchConfig` reads them as optional strings, so typing is optional. |

## Installation

```bash
# Core — NOTHING TO INSTALL. All dependencies already present:
#   @modelcontextprotocol/sdk@1.29.0  (registerTool / outputSchema / structuredContent / annotations)
#   zod@4.3.6                         (input + output schemas)
#   Workers runtime globals           (AbortController, setTimeout, Promise.all/race)

# Supporting — none

# Dev dependencies — none new (vitest + vitest-pool-workers already present)
```

## API Verification (the load-bearing checks)

All four claims in the research question were verified against the **installed** SDK (1.29.0,
not just the `^1.26.0` floor) and Context7 docs for `/modelcontextprotocol/typescript-sdk`.

| Question | Answer | Evidence |
|----------|--------|----------|
| Does SDK 1.26.0+ `registerTool` support `outputSchema` + `structuredContent`? | **YES** | Context7 `server.md`: `registerTool` config takes `outputSchema` (Zod); handler returns `{ content, structuredContent }`. Installed `@modelcontextprotocol/sdk@1.29.0` satisfies `^1.26.0`. |
| Does it support `annotations` (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`)? | **YES** | Context7 migration doc lists `annotations` as a `registerTool` config field; behavioral-annotations example shows `destructiveHint`/`idempotentHint`. The four hint fields are the standard MCP `ToolAnnotations` set. |
| Can a hand-rolled async pool over an `AbortController` race run unchanged on Workers (no Node APIs)? | **YES** | `batch.ts` uses only `AbortController`, `setTimeout`, `clearTimeout`, `Promise.all`, `Promise.race`, `Array.from` — all Web-standard globals. `src/index.ts` `callModel()` already runs the same `AbortController`+`setTimeout`+`Promise.race` pattern in production. No `node:*` import, no `worker_threads`, no `child_process`. |
| Is `p-limit` already a dependency? | **NO** | `package.json` dependencies: `@cloudflare/workers-oauth-provider`, `@modelcontextprotocol/sdk`, `agents`, `zod`. `node_modules/p-limit` absent. Per the brief, do **not** add it. |

### `inputSchema` shape note (avoid a refactor footgun)

The Context7 examples show `inputSchema: z.object({...})`, but **this repo uses the `ZodRawShape`
form** — a plain object of Zod fields, e.g. `inputSchema: { prompt: z.string()... }`
(`src/index.ts:215`). SDK 1.29.0 accepts both. The reference `batch.ts` already uses `ZodRawShape`
(`BatchInputShape`, `BatchOutputShape`), so it is convention-consistent. **Keep the `ZodRawShape`
form** when adapting `batch.ts` to match the existing 12 tools — do not rewrite the existing tools
to `z.object()` and do not wrap the batch shapes.

## Integration with Existing `runAI` / `callModel`

- **Inject, don't reimplement.** `batch.ts` is correct: `registerBatchTool` takes a `runTask`
  closure. Wire each `kind` to the **same** prompt-build + `runAIWithMetrics(env, tier, prompt, maxTokens)`
  path the single-task tools use. One source of truth for the Qwen call.
- **AbortSignal is best-effort by design.** `callModel()` (`src/index.ts:130`) owns an internal
  `AI_TIMEOUT_MS` (45s) `AbortController` and **accepts no external signal**. So the batch
  `withTimeout()` race is the actual wall-clock guarantee; the `signal` it passes to `runTask`
  is currently unused by the executor. That is fine — `withTimeout()` rejects regardless, so the
  batch always returns. (Optional future enhancement, out of scope: thread an external signal into
  `callModel` for true cancellation.)
- **Timeout budget interaction (flag for requirements):** `callModel`'s internal timeout is 45s;
  the batch default `BATCH_TASK_TIMEOUT_MS` is 60s. The inner 45s timeout fires first and surfaces
  as an `AI_TIMEOUT`-flavored rejection, which `executeBatch` records as a per-task `{status:'error'}`.
  Net behavior is correct (batch never hangs), but the effective per-task ceiling is ~45s, not 60s.
  Either accept this or align the two values — a roadmap decision, not a stack one.
- **Subrequest budget:** each task = one `env.AI.run` = one subrequest. Cap of 50 keeps any plan
  safe (free=50, paid=1000). Concurrency 6 stays clear of Workers AI 429s. Both already encoded in
  `readBatchConfig` defaults.

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Inline `mapWithConcurrency` (~18 lines) | `p-limit` | Only if the repo already depended on it (it does **not**) or if you needed a battle-tested limiter across many call sites. For one call site, the inline pool is simpler, dependency-free, and order-preserving by construction. |
| Cursor-based fixed worker pool | Semaphore / chunked `Promise.all` batches | Chunking (run N, await all, run next N) is simpler but wastes time when task durations vary — a single slow task stalls its whole chunk. The cursor pool keeps `concurrency` tasks always in flight. Prefer the cursor pool. |
| `Promise.race` + `setTimeout` for per-task timeout | `AbortSignal.timeout(ms)` | `AbortSignal.timeout()` is available on Workers and cleaner, but it only *aborts* — it does not by itself reject the awaited `runTask` when the executor ignores the signal (which `callModel` does). The race is what guarantees the batch returns. Keep the race; you may additionally pass `AbortSignal.timeout` if you later make `callModel` signal-aware. |

## What NOT to Use / Add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `p-limit` (or `p-map`, `p-queue`) | Not a current dependency; the brief mandates zero new deps when a ~25-line inline pool suffices. Adds supply-chain + maintenance surface for ~18 lines of logic. | Inline `mapWithConcurrency` from `batch.ts`. |
| Naive `Promise.all(tasks.map(runTask))` | Unbounded — fires all N subrequests at once, risks Workers AI 429s and subrequest-limit overruns; one rejection loses sibling results unless individually wrapped. Explicitly banned by the constraints. | Bounded cursor pool. |
| `node:async_hooks`, `worker_threads`, `child_process`, `os` | Not available / not meaningful on the Workers V8 isolate; concurrency here is cooperative async, not OS threads. | Web-standard `Promise` + `AbortController`. |
| Durable Objects / queues for batching | Stateless MCP is a locked decision; a single in-request fan-out needs no state or external queue. Adds deployment + cost complexity. | In-request `executeBatch`. |
| Upgrading the MCP SDK or Zod | Installed versions (1.29.0 / 4.3.6) already support every required API. No upgrade is needed and an unforced bump risks the 108 green tests. | Keep `^1.26.0` / `^4.0.0` ranges as-is. |
| Wrapping batch schemas in `z.object()` to match Context7 examples | Repo convention is `ZodRawShape`; mixing forms invites confusion and a needless diff to existing tools. | Keep `ZodRawShape` (as `batch.ts` already does). |

## Stack Patterns by Variant

**If `runTask` stays signal-unaware (current state):**
- Use the `withTimeout()` race exactly as written in `batch.ts`.
- The per-task wall-clock bound comes entirely from the race; `signal` is passed but ignored.
- Effective ceiling is `min(AI_TIMEOUT_MS=45s, BATCH_TASK_TIMEOUT_MS=60s)` = 45s.

**If you later make `callModel` accept an external `AbortSignal` (out of scope for v2.0):**
- Thread `signal` from `withTimeout` into `env.AI.run({ ..., signal })` (Workers AI supports an abort signal on `fetch`-backed bindings).
- Gains true cancellation (stops the in-flight request, frees the subrequest sooner) instead of best-effort.
- Still keep the race as the return guarantee.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `@modelcontextprotocol/sdk@1.29.0` | `zod@4.3.6` | SDK 1.29.0 supports Zod 4 raw-shape and `z.object()` schemas; verified by the 12 existing tools + 108 passing tests. |
| `@modelcontextprotocol/sdk@1.29.0` | `agents@0.10.0` (`createMcpHandler`) | Stateless handler path already in production; batch tool registers on the same `McpServer` instance via `createMcpServer(env)` closure. |
| Inline pool | Workers runtime (V8, `nodejs_compat`) | Uses only Web-standard globals — no `nodejs_compat`-gated APIs required. |

## Sources

- `/modelcontextprotocol/typescript-sdk` (Context7) — `server.md` `registerTool` with `inputSchema`/`outputSchema`/`structuredContent`; behavioral-`annotations` example (`destructiveHint`/`idempotentHint`); `migration-SKILL.md` confirming `annotations` + `_meta` config fields. **HIGH confidence.**
- Installed `node_modules/@modelcontextprotocol/sdk/package.json` → `1.29.0` (satisfies `^1.26.0`). **HIGH confidence.**
- `package.json` + `node_modules/` inspection — `p-limit` absent; `zod@4.3.6`; deps list. **HIGH confidence.**
- `src/index.ts` (lines 130–166, 211–270) — existing `callModel` `AbortController`+`setTimeout`+`Promise.race` pattern; `ZodRawShape` `inputSchema` convention; `runAIWithMetrics` integration point. **HIGH confidence (direct source read).**
- `.planning/batch.ts` — reference implementation; uses only Web-standard globals + `ZodRawShape` + `outputSchema`/`structuredContent`/`annotations`. **HIGH confidence (direct source read).**

---
*Stack research for: v2.0 concurrent batch fan-out (`code_assist_batch`)*
*Researched: 2026-06-25*
