# Architecture

**Analysis Date:** 2026-04-12

## Pattern Overview

**Overall:** OAuth-secured MCP (Model Context Protocol) server running on Cloudflare Workers, delegating code generation tasks to Workers AI.

**Key Characteristics:**
- Serverless architecture (Cloudflare Workers + Workers AI)
- Token-optimized hybrid model (Claude orchestrates, Qwen generates)
- PIN-based OAuth security with CSRF protection
- Single-file monolithic design for Worker constraints
- Stateless handlers with KV for temporary session storage

## Layers

**Transport Layer:**
- Purpose: Handle HTTP requests, OAuth flows, and MCP protocol
- Location: `src/index.ts` lines 406-508 (authHandler and Worker factory)
- Contains: OAuth authorization endpoints, login page, CSRF token management
- Depends on: @cloudflare/workers-oauth-provider, Request/Response APIs
- Used by: Cloudflare Workers runtime

**MCP Server Layer:**
- Purpose: Expose code generation tools via MCP protocol
- Location: `src/index.ts` lines 138-402 (createMcpServer function)
- Contains: Tool definitions, input schemas (Zod), routing logic
- Depends on: @modelcontextprotocol/sdk, Workers AI runtime
- Used by: MCP clients (Claude Code)

**Model & AI Layer:**
- Purpose: Execute code generation/transformation tasks via Workers AI
- Location: `src/index.ts` lines 99-134 (callModel, runAI, resolveModel)
- Contains: Model selection, KV-based config overrides, error recovery
- Depends on: Cloudflare Workers AI binding, KV namespace for config
- Used by: All MCP tools

**Configuration Layer:**
- Purpose: Manage model selection and secrets
- Location: `src/index.ts` lines 6-22 (DEFAULT_MODELS, resolveModel)
- Contains: Model tier definitions, KV config key patterns
- Depends on: OAUTH_KV namespace, MCP_SECRET env var
- Used by: Model resolution and auth

## Data Flow

**Tool Execution Flow:**

1. MCP client (Claude Code) calls a tool with parameters (e.g., `generateCode`)
2. Tool handler extracts parameters and constructs AI prompt
3. `runAI` is invoked with tier ("fast" or "standard") and assembled prompt
4. `resolveModel` fetches model override from KV (`config:model:{tier}`), falls back to DEFAULT_MODELS
5. `callModel` sends prompt + system prompt to Workers AI
6. Workers AI responds with generated code/analysis
7. Handler wraps response in MCP content format
8. Client receives result

**OAuth Flow:**

1. MCP client initiates OAuth: POST to `/register` (client registration) → discovered via `/.well-known/oauth-authorization-server`
2. Client redirects user to `/authorize` with `response_type=code`
3. `/authorize` GET: Generate CSRF token, store auth request in KV (5min TTL), return login form
4. User enters MCP_SECRET, POST to `/authorize`
5. Handler verifies CSRF token and secret (timing-safe comparison)
6. Handler calls `oauthHelpers.completeAuthorization` → redirects to callback with authorization code
7. Client exchanges code for access token (24h TTL)
8. Subsequent requests include bearer token

**State Management:**
- Temporary: CSRF tokens in KV (`csrf:{token}`, 5 min TTL)
- Persistent: Model configuration in KV (`config:model:{tier}`)
- No session state — auth tokens managed by OAuthProvider

## Key Abstractions

**Tool Registrations:**
- Purpose: Define MCP tool interface (name, description, input schema)
- Examples: `generateCode`, `reviewCode`, `transformCode`, `scaffoldTests`, `explainCode`, `generateDocs`, `generateTypes`, `fixBug`, `generateCommitMessage`, `generateWorkerBoilerplate`
- Pattern: Each tool registered via `server.registerTool(name, schema, handlerFn)`. Handler assembles prompt context and calls `runAI(env, tier, fullPrompt, maxTokens)`

**Prompt Assembly:**
- Purpose: Build complete AI prompt with system context, user instruction, and optional code/diff
- Examples: Lines 156-161 (generateCode), 177-186 (reviewCode), 202-206 (transformCode)
- Pattern: Conditional parts (language, style, context) joined with `\n\n`, wrapped in code blocks with triple backticks

**Model Tier Selection:**
- Purpose: Route tools to appropriate model based on complexity
- Examples: "fast" for simple tasks (quickTask, generateCommitMessage), "standard" for complex (generateCode, generateDocs)
- Pattern: Defined in tool handler via `runAI(env, "fast"|"standard", ...)`

**Error Recovery:**
- Purpose: Handle bad KV config (stale model overrides)
- Location: Lines 118-133
- Pattern: Catch "Unknown model" errors, delete bad KV key, retry with DEFAULT_MODELS

## Entry Points

**Worker Fetch Handler:**
- Location: `src/index.ts` lines 495-508 (export default)
- Triggers: Cloudflare Workers runtime on all requests to Worker domain
- Responsibilities: Wire OAuthProvider with apiRoute="/mcp", defaultHandler=authHandler, create MCP server on demand

**OAuth Authorization Endpoint:**
- Location: Lines 411-448 (/authorize path)
- Triggers: OAuth client initiates flow or user submits PIN form
- Responsibilities: Generate login form (GET), validate CSRF + secret (POST), complete authorization

**MCP API Endpoint:**
- Location: Handled by OAuthProvider at /mcp route
- Triggers: MCP client calls discovered endpoint with Bearer token
- Responsibilities: Invoke createMcpServer, delegate to tool handler

## Error Handling

**Strategy:** Fail-fast with minimal recovery

**Patterns:**
- **Missing CSRF token:** Return 400 "Session expired"
- **Invalid secret:** Return 403 "Invalid secret" (no timing leak)
- **Model not found:** Log error, delete KV override, retry with default
- **AI response malformed:** Return raw JSON stringification of response
- **KV operation failure:** Let error bubble to Workers runtime (5xx)

**Timing-Safe Comparisons:** Secret comparison uses `crypto.subtle.timingSafeEqual` to prevent timing attacks

## Cross-Cutting Concerns

**Logging:** Not implemented (Workers platform limitation — observability via wrangler logstream or tail)

**Validation:** Zod schemas applied at MCP tool registration level. Input schema validation is automatic via MCP SDK.

**Authentication:**
- OAuth 2.0 with PIN-based user flow (user has single identity "owner")
- Token TTL: 24 hours (auto-refresh via OAuthProvider)
- Secret stored via `wrangler secret put MCP_SECRET` (Cloudflare managed secrets, not in code)
- CSRF protection: Random UUID token, 5-min KV TTL

**Rate Limiting:** Not implemented (reliant on Cloudflare Workers rate limiting and AI quota)

---

*Architecture analysis: 2026-04-12*
