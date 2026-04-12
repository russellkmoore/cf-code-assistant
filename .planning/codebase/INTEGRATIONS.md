# External Integrations

**Analysis Date:** 2026-04-12

## APIs & External Services

**Cloudflare Workers AI:**
- Service: Cloudflare Workers AI inference API
- What it's used for: LLM inference for code generation and manipulation tasks
- SDK/Client: Native Cloudflare Workers `Ai` binding (injected via `Env`)
- Model: @cf/qwen/qwen3-30b-a3b-fp8 (Qwen 3 30B MoE)
- Auth: Implicit (Cloudflare account credentials)
- Implementation: `src/index.ts` - `callModel()` function calls `env.AI.run(model, { messages, max_tokens })`

**Model Context Protocol (MCP):**
- Service: Standard MCP protocol for AI tool integration
- What it's used for: Tool server for Claude and other AI clients to call code generation/transformation endpoints
- SDK/Client: @modelcontextprotocol/sdk v1.26.0
- Auth: OAuth2 via @cloudflare/workers-oauth-provider
- Endpoints exposed:
  - `GET /.well-known/oauth-authorization-server` - OAuth metadata
  - `POST /mcp` - MCP protocol server endpoint
  - `GET /authorize` - OAuth authorization form
  - `POST /authorize` - PIN-based authorization submission
  - `POST /token` - OAuth token endpoint
  - `POST /register` - OAuth client registration
- Implementation: `src/index.ts` - `createMcpServer()` factory registers 13 tools

## Data Storage

**Databases:**
- None (stateless architecture)

**Key-Value Storage:**
- **Cloudflare KV**
  - Connection: `env.OAUTH_KV` (KV namespace binding in wrangler.toml)
  - Purpose: OAuth session tokens, CSRF tokens, model configuration overrides
  - Key patterns:
    - `csrf:{csrfToken}` - CSRF token storage (300s TTL)
    - `config:model:{tier}` - Model override configuration (no TTL, persistent)
  - Implementation: `src/index.ts` lines 20, 415-431
  - Configured in: `wrangler.toml` under `[[kv_namespaces]]` with binding name "OAUTH_KV"

**File Storage:**
- None (stateless Workers execution, no persistent filesystem)

**Caching:**
- Implicit: Cloudflare's edge caching for HTTP responses
- Application-level: None (each request is independent)

## Authentication & Identity

**Auth Provider:**
- Custom OAuth2 implementation via @cloudflare/workers-oauth-provider
- Implementation: `src/index.ts` lines 405-491 (authHandler, loginPage)
- Flow:
  1. Client discovers OAuth metadata at `/.well-known/oauth-authorization-server`
  2. Client registers via `POST /register`
  3. Client redirects user to `GET /authorize` 
  4. User enters `MCP_SECRET` PIN (form at lines 462-491)
  5. Server validates secret via timing-safe comparison (line 433)
  6. Server creates authorization via `oauthHelpers.completeAuthorization()`
  7. Client receives access token with 24-hour TTL
  
**Session Management:**
- CSRF token: Random UUID generated per authorization request, stored in KV for 300 seconds
- Access token: 24-hour TTL (`accessTokenTTL: 86400` at line 507)
- User identity: Fixed as "owner" with metadata label "claude-code"

**Secrets:**
- `MCP_SECRET`: Set via `wrangler secret put MCP_SECRET` - PIN for authorizing MCP clients
- Storage: Cloudflare Workers environment secrets (not in KV, injected at runtime)

## Monitoring & Observability

**Error Tracking:**
- None (no external error tracking service)

**Logs:**
- Implicit Cloudflare Workers logging (console.* output visible in wrangler tail)
- Observability enabled in wrangler.toml (`[observability] enabled = true`)
- No external log aggregation

**Model Error Handling:**
- Implementation: `src/index.ts` lines 118-133 (`runAI()` function)
- Detects model loading errors ("Unknown model", "not found", "invalid model")
- Fallback: If custom model config is invalid, deletes KV override and retries with default model

## CI/CD & Deployment

**Hosting:**
- Cloudflare Workers (serverless, auto-scaled)
- URL format: `https://cf-code-assistant.<subdomain>.workers.dev/mcp`

**CI Pipeline:**
- Not detected (no CI config files present)
- Manual deployment via `npm run deploy` (wrangler)

**Deployment Process:**
1. Configure wrangler.toml with KV namespace ID
2. Set MCP_SECRET via `wrangler secret put MCP_SECRET`
3. Run `npm run deploy` (calls wrangler CLI)
4. Workers automatically routes to exported handler

## Environment Configuration

**Required Environment Variables:**
- `MCP_SECRET` - Secret PIN for authorizing MCP clients (set via wrangler secret)

**Cloudflare Bindings (wrangler.toml):**
```toml
[ai]
binding = "AI"                    # Workers AI binding

[[kv_namespaces]]
binding = "OAUTH_KV"              # KV namespace for OAuth/config
id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"
```

**Derived Configuration:**
- Compatibility date: 2026-04-12 (runtime version)
- Compatibility flags: nodejs_compat (enables Node.js APIs)
- Model tier defaults in code: both "fast" and "standard" → "@cf/qwen/qwen3-30b-a3b-fp8"

**Secrets Location:**
- Cloudflare Workers environment secrets (not committed, set via CLI)
- KV namespace for non-secret configuration overrides

## Webhooks & Callbacks

**Incoming:**
- None

**Outgoing:**
- None (stateless request/response pattern)

**OAuth Callbacks:**
- Authorization flow is UI-based (user enters PIN in browser form)
- Token endpoint at `/token` (handled by oauth-provider)
- Redirect to client after successful authorization

## MCP Tools Exposed

**Code Generation Tools:**
- `generateCode` - Generate production code from spec (calls AI, 8192 token limit)
- `reviewCode` - Static analysis review (calls AI, 4096 token limit)
- `transformCode` - Mechanical code transformations (calls AI, 8192 token limit)
- `scaffoldTests` - Test scaffolding generator (calls AI, 8192 token limit)
- `quickTask` - Simple self-contained tasks (calls AI, 4096 token limit, fast tier)
- `explainCode` - Code explanation at configurable depth (calls AI, 2048-4096 token limit, tier depends on depth)
- `generateDocs` - Documentation generation (calls AI, 8192 token limit)
- `generateTypes` - TypeScript type inference (calls AI, 8192 token limit)
- `fixBug` - Bug fix from error message (calls AI, 8192 token limit)
- `generateCommitMessage` - Commit message generation (calls AI, 1024 token limit, fast tier)
- `generateWorkerBoilerplate` - Worker scaffolding (calls AI, 8192 token limit)

**Utility Tools:**
- `routingInfo` - Static guide (no AI call)

---

*Integration audit: 2026-04-12*
