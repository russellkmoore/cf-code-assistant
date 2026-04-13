# CF Code Assistant

A Cloudflare Workers MCP server that offloads mechanical code generation from Claude to Workers AI. Claude stays in the driver's seat — handling research, context gathering, and architecture decisions — while this server handles the generation workload at a fraction of the token cost.

## Why

Every `generateCode`, `scaffoldTests`, or `transformCode` call that doesn't need Claude's reasoning is a token cost you don't need to pay. This server routes those tasks to `@cf/qwen/qwen3-30b-a3b-fp8` on Cloudflare Workers AI, keeping Claude free for the work that actually needs it.

## How It Works

```
Claude Code ──MCP──▶ cf-code-assistant (Cloudflare Worker)
                          │
                          ▼
                     Workers AI (qwen3-30b)
                          │
                          ▼
                     Generated code ──MCP──▶ back to Claude
```

1. Claude gathers context (reads files, fetches docs, reasons about architecture)
2. Claude calls an MCP tool with a precise prompt + gathered context
3. The Worker runs the prompt through Workers AI
4. Claude reviews the output and integrates it into the codebase

The key insight: qwen3 has no MCP access of its own. Claude is its only source of truth, which is why the context-first pattern matters — always gather context before delegating.

## Tools

| Tool | Tier | What It Does |
|------|------|-------------|
| `generateCode` | standard | Generate code from a description + context |
| `reviewCode` | standard | Review code for bugs, style, and security issues |
| `transformCode` | standard | Mechanical transforms (rename, reformat, convert patterns) |
| `scaffoldTests` | standard | Generate test scaffolding for existing code |
| `quickTask` | fast | Simple self-contained tasks (regex, snippets, conversions) |
| `explainCode` | fast/standard | Explain code at brief, detailed, or eli5 depth |
| `generateDocs` | standard | Generate JSDoc/TSDoc documentation |
| `generateTypes` | standard | Infer TypeScript types from untyped code |
| `fixBug` | standard | Fix a bug given the code and error message |
| `generateCommitMessage` | fast | Write a commit message from a diff |
| `generateWorkerBoilerplate` | standard | Scaffold Cloudflare Worker boilerplate |
| `routingInfo` | — | Returns model tier info (no AI call) |

**Tiers:** `fast` uses the lightweight model for quick tasks. `standard` uses the full model for generation work. Both are configurable via KV at runtime — no redeploy needed.

## Setup

See [SETUP.md](SETUP.md) for full installation, deployment, and Claude Code registration instructions.

Quick start:

```bash
npm install
npx wrangler secret put MCP_SECRET    # Set your auth PIN
npm run deploy                         # Creates KV, deploys Worker
```

Then add the MCP server URL to `~/.claude/settings.json` and authorize via browser.

## Architecture

- **Single file server** — all tools, auth, and routing in `src/index.ts`
- **Stateless MCP** via `createMcpHandler` from `agents/mcp` (no Durable Objects)
- **OAuth 2.1** with self-contained PIN auth flow via `@cloudflare/workers-oauth-provider`
- **Two-tier model routing** — `fast` and `standard` tiers, hot-swappable via KV
- **Self-healing config** — invalid KV model entries auto-revert to defaults
- **Structured logging** — every tool call, error, and auth event produces JSON logs visible in `wrangler tail`

## Examples

The [`examples/`](examples/) directory contains ready-to-use configuration for teaching Claude Code how to delegate effectively.

### [examples/CLAUDE.md](examples/CLAUDE.md)

A routing block you can paste into any project's `CLAUDE.md`. It teaches Claude:
- **When to delegate** — code generation, transforms, reviews, test scaffolding, docs
- **When to keep** — research, architecture, multi-file reasoning, workflow commands
- **The context-first pattern** — always gather context before calling a tool, because qwen3 has no MCP access of its own

Use this when you want simple, project-level routing rules.

### [examples/skills/cf-delegate.md](examples/skills/cf-delegate.md)

A Claude Code skill that automates the full delegation workflow:
1. Classify the task to pick the right tool
2. Gather context (Cloudflare docs, Context7, codebase reads)
3. Build a precise prompt with all context inlined
4. Call the tool
5. Review output before passing to user

Use this when you want a structured, repeatable delegation process. Drop it into your project's `.claude/skills/` directory.

## Development

```bash
npm run dev          # Local dev server (AI calls hit remote — incurs charges)
npm run deploy       # Deploy to Cloudflare (handles KV setup automatically)
npm run types        # Regenerate worker-configuration.d.ts
npx tsc --noEmit     # Type-check
npm test             # Run tests (108 tests across 8 suites)
```

## Security

- OAuth 2.1 with PIN-based authorization
- Rate limiting on auth attempts (5 per minute)
- Input validation on all tool parameters (size caps)
- Timing-safe secret comparison
- Structured error responses that never leak internals
- All auth events logged with IP for audit trail

## License

MIT
