# CF Code Assistant

Cloudflare Workers MCP server that offloads mechanical code generation from Claude to `@cf/qwen/qwen3-30b-a3b-fp8` via Workers AI.

## Architecture

- **Single file**: `src/index.ts` — all tools, auth handler, and wiring
- **Stateless MCP** via `createMcpHandler` from `agents/mcp` (no Durable Objects)
- **OAuth 2.1** via `@cloudflare/workers-oauth-provider` with self-contained PIN auth
- **Two-tier model routing**: `fast` and `standard` tiers, configurable via KV keys `config:model:fast` / `config:model:standard`
- **Self-healing**: invalid KV model config auto-reverts to hardcoded defaults

## Key Files

- `src/index.ts` — MCP server, 12 tools, auth handler, model routing
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
| `standard` | `config:model:standard` | `@cf/qwen/qwen3-30b-a3b-fp8` | generateCode, reviewCode, transformCode, scaffoldTests, explainCode (detailed), generateDocs, generateTypes, fixBug, generateWorkerBoilerplate |

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

## Current Hardening Roadmap

See `.planning/ROADMAP.md` for the full 5-phase plan. In order:
1. Phase 0 — Repository foundation (done: git init, .gitignore)
2. Phase 1 — Security hardening (CVE fix, rate limiting, input validation)
3. Phase 2 — Error handling (retry logic, graceful degradation)
4. Phase 3 — Test infrastructure (vitest, mocks, coverage)
5. Phase 4 — Observability (structured logging, AI Gateway)

## Known Issues

- `as any` cast on dynamic model name in `callModel()` — tracked as SEC-01
- No input size limits on tool parameters — tracked as SEC-02
- `timingSafeEqual` leaks secret length via early return — fix planned in Phase 1
- Zero test coverage — Phase 3
- No structured logging — Phase 4
