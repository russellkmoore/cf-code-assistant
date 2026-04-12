# Codebase Structure

**Analysis Date:** 2026-04-12

## Directory Layout

```
cf-code-assistant/
├── src/                      # TypeScript source code
│   └── index.ts              # Single entry point (monolithic Worker)
├── examples/                 # Example configurations and skills
│   ├── CLAUDE.md             # Routing guide for project
│   └── skills/
│       └── cf-delegate.md    # Delegation pattern documentation
├── .planning/
│   └── codebase/             # GSD codebase analysis output
├── .wrangler/                # Wrangler dev/deploy cache (generated)
├── worker-configuration.d.ts # Cloudflare Worker bindings type definitions
├── package.json              # Dependencies + build scripts
├── tsconfig.json             # TypeScript compiler config
├── wrangler.toml             # Cloudflare Worker configuration
├── SETUP.md                  # Deployment and setup instructions
└── .gitignore                # Git exclusions
```

## Directory Purposes

**`src/`:**
- Purpose: Single TypeScript file containing entire Worker implementation
- Contains: MCP server factory, OAuth handlers, AI integration, tool definitions
- Key files: `index.ts` (509 lines, all logic)

**`examples/`:**
- Purpose: Reference material for users deploying this server
- Contains: CLAUDE.md (routing rules for hybrid Claude+MCP setup), delegation patterns
- Key files: `examples/CLAUDE.md`, `examples/skills/cf-delegate.md`

**`.planning/codebase/`:**
- Purpose: GSD (Get Stuff Done) analysis documents
- Generated: Yes (written by `/gsd-map-codebase` orchestrator)
- Committed: Yes (part of repo for future Claude instances)

**`.wrangler/`:**
- Purpose: Wrangler dev server cache and metadata
- Generated: Yes (runtime)
- Committed: No

**`worker-configuration.d.ts`:**
- Purpose: Type definitions for Cloudflare Worker environment bindings (Env interface)
- Generated: Yes (by `wrangler types` command)
- Committed: Yes (required for build)

## Key File Locations

**Entry Points:**
- `src/index.ts`: Main Worker file. Exports OAuthProvider default handler wired to MCP server factory and OAuth auth handler. Triggered by all requests to Worker domain.

**Configuration:**
- `wrangler.toml`: Defines Worker name, bindings (AI, OAUTH_KV), compatibility date, and observability settings. Main config file for deployment.
- `tsconfig.json`: TypeScript compilation config targeting ES2021, bundler module resolution, strict type checking.
- `package.json`: Dependencies (MCP SDK, Cloudflare OAuth provider, Zod, agents), build scripts (dev, deploy, types).

**Core Logic:**
- `src/index.ts` lines 6-22: Model tier configuration (DEFAULT_MODELS record)
- `src/index.ts` lines 99-134: AI invocation (callModel, runAI, resolveModel)
- `src/index.ts` lines 138-402: MCP server factory with 10 tool registrations
- `src/index.ts` lines 404-508: OAuth authorization handler and login page

**Documentation:**
- `SETUP.md`: Step-by-step deployment guide, KV namespace creation, MCP registration in Claude Code
- `examples/CLAUDE.md`: Hybrid routing rules for teams using this server with Claude Code

## Naming Conventions

**Files:**
- TypeScript files: `*.ts` (single source file `index.ts`)
- Config files: Specific Cloudflare convention (wrangler.toml, tsconfig.json)
- Documentation: Uppercase.md (SETUP.md, CLAUDE.md)

**Functions:**
- camelCase: `createMcpServer`, `createMcpHandler`, `callModel`, `runAI`, `resolveModel`, `timingSafeEqual`, `loginPage`
- Async functions: `fetch`, `run`, `get`, `put`, `delete` (standard Web API names)

**Variables:**
- camelCase constants: `SYSTEM_PROMPT`, `ROUTING_INFO`, `DEFAULT_MODELS`
- UPPERCASE constants: `SYSTEM_PROMPT`, `ROUTING_INFO`
- Lowercase runtime: `server`, `env`, `ctx`, `request`, `response`, `model`, `code`, `prompt`

**Types:**
- PascalCase interfaces: `ModelTier`, `Env`, `ExportedHandler<Env>`, `OAuthHelpers`, `AuthRequest`
- Type aliases: `ModelTier = "fast" | "standard"`

## Where to Add New Code

**New Tool (Code Generation/Transformation):**
- Primary code: `src/index.ts` in `createMcpServer()` function (after line 383, before `return server`)
- Pattern: Call `server.registerTool(name, schema, handlerFn)` where:
  - `name`: string (e.g., "generateTests")
  - `schema`: Zod object with `.describe()` on each field
  - `handlerFn`: async function that assembles prompt and calls `runAI(env, tier, prompt, maxTokens)`
- Example: See `generateCode` tool (lines 144-165) — simplest pattern

**New Utility (Helper Function):**
- Location: `src/index.ts` as a standalone function above `createMcpServer()` (e.g., before line 138)
- Pattern: Top-level function with clear parameter types and return type
- Guideline: Keep small; if longer than 20 lines, consider whether it should exist in Worker constraints

**New Configuration:**
- Model tier adjustment: Edit `DEFAULT_MODELS` record (line 10) or modify `resolveModel()` to add new override logic
- KV key pattern: Add documentation in comment (line 15) following pattern `config:*`
- Secrets: Use `wrangler secret put VAR_NAME` (edit `wrangler.toml` Env interface and `src/index.ts` Env type)

**OAuth Handler Extension:**
- Location: `src/index.ts` authHandler (lines 406-452)
- Pattern: Add new route in fetch handler's `if (url.pathname === "/new-path")` block
- Guideline: Keep auth paths separate from API paths (/authorize, /token, /register are OAuthProvider-managed)

## Special Directories

**`.wrangler/`:**
- Purpose: Wrangler development server cache and artifacts
- Generated: Yes (created by `npm run dev`)
- Committed: No (in .gitignore)

**`worker-configuration.d.ts`:**
- Purpose: Auto-generated type definitions for Worker environment bindings
- Generated: Yes (by `wrangler types` command)
- Committed: Yes (required for TypeScript compilation)

**`.planning/codebase/`:**
- Purpose: GSD orchestrator output (architecture, structure, conventions, testing, tech, concerns)
- Generated: Yes (by `/gsd-map-codebase` command)
- Committed: Yes (guides future implementation phases)

## Monolithic Design Rationale

This project is intentionally single-file (`src/index.ts`, 509 lines) because:
- **Cloudflare Workers constraint:** Bundle size and cold start favor single-file handlers
- **No heavy dependencies:** Dependencies (Zod, MCP SDK, OAuth provider) are tree-shaken aggressively
- **Clear boundaries:** OAuth layer, MCP server layer, AI layer are logically separated but physically co-located
- **Simplicity:** New tool additions require only appending one `server.registerTool()` block

If the project grows beyond ~800 lines, refactor into:
- `src/index.ts` — Entry point, wire OAuthProvider + createMcpServer
- `src/mcp-server.ts` — MCP tool definitions (export createMcpServer)
- `src/auth-handler.ts` — OAuth endpoints (export authHandler)
- `src/ai.ts` — Model resolution and AI calls (export runAI, callModel)

---

*Structure analysis: 2026-04-12*
