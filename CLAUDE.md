# CF Code Assistant

Cloudflare Workers MCP server that offloads mechanical code generation from Claude to `@cf/qwen/qwen3-30b-a3b-fp8` via Workers AI.

## Architecture

- **Server core**: `src/index.ts` — all tool registrations, auth handler, model routing, and wiring
- **Shared executor**: `runTask(env, kind, input)` + `TASK_SPECS` dispatch map — single source of truth for prompt/tier/maxTokens, shared by single-task tools and the batch tool
- **Batch engine**: `src/batch.ts` — pure, env-free `executeBatch` / `mapWithConcurrency` / `withTimeout` / `readBatchConfig` (bounded concurrency, per-task timeout, order-preserving partial results)
- **Stateless MCP** via `createMcpHandler` from `agents/mcp` (no Durable Objects)
- **OAuth 2.1** via `@cloudflare/workers-oauth-provider` with self-contained PIN auth
- **Two-tier model routing**: `fast` and `standard` tiers, configurable via KV keys `config:model:fast` / `config:model:standard`
- **Self-healing**: invalid KV model config auto-reverts to hardcoded defaults

## Key Files

- `src/index.ts` — MCP server, 13 tools, auth handler, model routing, `runTask` executor
- `src/batch.ts` — pure batch engine (concurrency pool, timeout, partial-results contract)
- `src/logger.ts` — structured JSON logging helpers
- `wrangler.toml` — Worker config with AI binding and KV namespace
- `.planning/` — GSD project planning (roadmap, requirements, research, codebase map)

## Development

```bash
npm run dev        # Local dev server (AI binding hits remote — incurs charges)
npm run deploy     # Deploy to Cloudflare
npm run types      # Regenerate worker-configuration.d.ts
npx tsc --noEmit   # Type-check
```

## Tool Registration Pattern

All tools use `server.registerTool()` (not the deprecated `server.tool()`):

```typescript
server.registerTool(
  "toolName",
  {
    description: "...",
    inputSchema: { param: z.string().describe("...") },
  },
  async ({ param }) => {
    const result = await runAI(env, "standard", prompt, 4096);
    return { content: [{ type: "text", text: result }] };
  },
);
```

## Model Tiers

| Tier | KV Key | Default | Used By |
|------|--------|---------|---------|
| `fast` | `config:model:fast` | `@cf/qwen/qwen3-30b-a3b-fp8` | quickTask, explainCode (brief/eli5), generateCommitMessage |
| `standard` | `config:model:standard` | `@cf/moonshotai/kimi-k2.5` | generateCode, reviewCode, transformCode, scaffoldTests, explainCode (detailed), generateDocs, generateTypes, fixBug, generateWorkerBoilerplate |

## Batch Tool

`code_assist_batch` (the 13th tool, added in v2.0) fans an array of bounded tasks out to the
shared `runTask` executor with bounded concurrency. It is the repo's only structured-output
tool: it declares Zod input + output schemas and returns `structuredContent` plus a text summary.

- **Bounded pool**: default 6 in flight, env `BATCH_CONCURRENCY` — never `Promise.all` over all tasks
- **Per-call cap**: default 50, env `BATCH_MAX_TASKS` — over-cap batches fast-reject before any dispatch
- **Per-task timeout**: default 45000ms (= `AI_TIMEOUT_MS`), env `BATCH_TASK_TIMEOUT_MS` — race + real AbortSignal cancellation: a timed-out task threads the signal into `env.AI.run` (AiOptions), actually cancelling the subrequest rather than orphaning it
- **Per-task tier override**: each task may include an optional `tier` field (`"fast"` or `"standard"`) to override the kind's default model tier for that task only; `maxTokens` is preserved from the kind's spec; the model is still resolved through the existing allowlist/KV abstraction — no raw model strings at the MCP boundary
- **Partial-results contract**: each task returns `{id, index, kind, status:'ok'|'error', ...}`; one slow or failing task never stalls or aborts siblings; results are order-preserving by index

## Auth Flow

OAuth 2.1 with `OAuthProvider` wrapping the MCP handler. Auth handler at `/authorize` renders a PIN login page. The `MCP_SECRET` worker secret is the PIN. CSRF tokens stored in `OAUTH_KV` with 5-minute TTL.

## Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `AI` | Workers AI | Model inference |
| `OAUTH_KV` | KV Namespace | OAuth state, CSRF tokens, model config |
| `MCP_SECRET` | Secret | PIN for authorize flow |

## Conventions

- `runAI(env, tier, prompt, maxTokens)` — always pass the tier, never call `callModel` directly
- Tool handlers return `{ content: [{ type: "text", text }] }` — MCP response format
- New McpServer instance per request (required by MCP SDK 1.26.0 CVE fix)
- `env` passed to tools via closure over `createMcpServer(env)`

## Roadmap Status

See `.planning/ROADMAP.md` for full detail.

- ✅ **v1.0 Production Hardening** (Phases 0–4) — shipped: git baseline, security hardening (type-safe routing, input caps, auth rate limiting), error handling (AI timeouts, KV fallback, structured errors), test infrastructure (vitest + Workers pool), structured logging.
- ✅ **v2.0 Concurrent Batch Fan-out** (Phases 5–8) — complete: shared `runTask` executor, pure batch engine, `code_assist_batch` tool, end-to-end verification. 162 tests green.

## Known Issues

None currently tracked. The v1.0 hardening issues (`as any` model cast, missing input caps,
`timingSafeEqual` length leak, zero test coverage, no structured logging) were all resolved in
the v1.0 milestone — see `.planning/PROJECT.md` Validated requirements (SEC-01/02, HARD-*, TEST-*, OBS-01).

Phase 10 resolved BATCH-F01 (real AbortSignal threaded into `env.AI.run`) and BATCH-F03 (per-task
tier override in batch input).

Deferred to a future milestone (tracked in `.planning/REQUIREMENTS.md` Future Requirements):
internal per-task retry with backoff (BATCH-F02).
