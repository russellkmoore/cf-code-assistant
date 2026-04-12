# Technology Stack

**Analysis Date:** 2026-04-12

## Languages

**Primary:**
- TypeScript 5.8.0 - Entire codebase, Worker implementation, type safety across runtime bindings

**Target Runtime:**
- ES2021 (compiled target)
- ES2022 (module output)

## Runtime

**Environment:**
- Cloudflare Workers (serverless edge compute platform)
- Node.js compatibility mode enabled (`nodejs_compat` flag in wrangler.toml)
- Runtime: workerd@1.20260409.1 (generated 2026-04-12)

**Package Manager:**
- npm (Node Package Manager)
- Lockfile: `package-lock.json` present (v3)

## Frameworks

**Core:**
- Cloudflare Workers framework (via wrangler) - HTTP request handling, edge compute
- Model Context Protocol (MCP) SDK v1.26.0 - Server implementation for AI tool integration
- Agents v0.10.0 - MCP handler integration (`createMcpHandler` from agents/mcp)

**Authentication:**
- @cloudflare/workers-oauth-provider v0.4.0 - OAuth2 authorization provider with CSRF protection, token management

## Key Dependencies

**Critical:**
- @modelcontextprotocol/sdk v1.26.0 - MCP server implementation, tool registration, request/response handling
- @cloudflare/workers-oauth-provider v0.4.0 - OAuth2 flow, session management, authorization endpoints
- zod v4.0.0 - Runtime type validation for MCP tool input schemas

**Runtime Support:**
- agents v0.10.0 - MCP handler factory (`createMcpHandler`)

## Configuration

**Environment:**
- Deployment target: Cloudflare Workers
- Configuration via `wrangler.toml` with compatibility date and flags
- Secrets management: `MCP_SECRET` set via `wrangler secret put` CLI
- Runtime environment available as `Env` interface with bindings

**Build:**
- TypeScript strict mode enabled
- Build target: ES2021
- Module resolution: bundler (Wrangler's bundler)
- Configuration: `tsconfig.json`
- Build command: `npm run dev` (local), `npm run deploy` (production)

**Type Generation:**
- `wrangler types` command generates `worker-configuration.d.ts`
- Includes runtime type definitions and Cloudflare bindings
- Env interface includes KV_NAMESPACE and AI bindings

## Platform Requirements

**Development:**
- Node.js 18+ (inferred from wrangler v4 and @types/node v25)
- npm for dependency management
- wrangler CLI v4.14.0 for local development and deployment

**Production:**
- Cloudflare Workers deployment platform
- Requires Cloudflare account with:
  - Workers enabled
  - KV namespace created and configured
  - Workers AI enabled (for @cf/qwen/qwen3-30b-a3b-fp8 model access)
  - Environment variables/secrets configured

**Compatibility:**
- ES2021 target ensures broad browser and runtime support
- Node.js compatibility mode allows Node.js APIs in Workers context

## Key Build Scripts

```bash
npm run dev              # Run local Wrangler dev server (localhost:8787)
npm run deploy           # Deploy to Cloudflare Workers
npm run types            # Regenerate worker-configuration.d.ts from wrangler.toml
```

## Inference and Deployment Model

**Model Backend:**
- Default: @cf/qwen/qwen3-30b-a3b-fp8 (Qwen 3 30B MoE variant)
- Accessed via Cloudflare Workers AI binding
- 32k context window
- Cost: $0.051/M input tokens, $0.34/M output tokens

**Model Selection:**
- Two tiers configured (fast, standard) via KV configuration keys
- Both currently map to same model, override via KV keys `config:model:fast` and `config:model:standard`
- Fallback to defaults if KV override not found or misconfigured

---

*Stack analysis: 2026-04-12*
