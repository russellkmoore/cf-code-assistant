# CF Code Assistant

A Cloudflare Workers MCP server that offloads mechanical code generation from Claude to Workers AI. Claude stays in the driver's seat — handling research, context gathering, and architecture decisions — while this server handles the generation workload at a fraction of the token cost.

## Why

Every `generateCode`, `scaffoldTests`, or `transformCode` call that doesn't need Claude's reasoning is a token cost you don't need to pay. This server routes those tasks to `@cf/qwen/qwen3-30b-a3b-fp8` on Cloudflare Workers AI, keeping Claude free for the work that actually needs it.

## How It Works

```
Claude Code ──MCP──▶ cf-code-assistant (Cloudflare Worker)
                          │
                          ▼
                     Workers AI (qwen3-30b / kimi-k2.5)
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
| `code_assist_batch` | per-task | Fan many bounded tasks out concurrently, one call, order-preserving partial results |

**Tiers:** `fast` uses `@cf/qwen/qwen3-30b-a3b-fp8` — a lightweight model for quick tasks. `standard` uses `@cf/moonshotai/kimi-k2.5` — a Kimi coding-optimized model for generation and review work. Both are configurable via KV at runtime — no redeploy needed.

**Batch fan-out:** `code_assist_batch` runs an array of independent tasks through the shared executor with bounded concurrency (default 6, `BATCH_CONCURRENCY`), a per-call cap (default 50, `BATCH_MAX_TASKS`), and a per-task timeout (default 45s, `BATCH_TASK_TIMEOUT_MS`). Each task returns `{id, index, kind, status:'ok'|'error', ...}` independently — one slow or failing task never stalls or aborts the rest. Each task also accepts an optional `tier` field (`"fast"` or `"standard"`) to override the kind's default model tier for that task; a timed-out task is actually cancelled via a real AbortSignal passed into `env.AI.run`, stopping the subrequest rather than orphaning it. Use it to fan out independent leaf work (test generation, scaffolding, transforms) instead of issuing N sequential calls.

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

- **Compact server** — tool registrations, auth, and routing in `src/index.ts`; pure batch engine in `src/batch.ts`; structured logging in `src/logger.ts`
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
npm test             # Run tests (162 tests)
```

## Token efficiency & known limitations

The point of this server is to spend fewer **Claude** tokens. That only happens when a generated
artifact reaches disk **without Claude re-emitting it** — see [BENCHMARK.md](BENCHMARK.md) for the
measured economics. Practical rules:

- **Producing files?** Use `code_assist_batch` with each task `id` set to `write:<path>` plus the
  `cf-write-results` PostToolUse hook (writes results to disk, keeps the bodies out of Claude's
  context). Calling a single tool and then writing the file yourself **costs more than generating
  inline** — avoid it.
- **Single-task tools** (`generateTypes`, `reviewCode`, `explainCode`, `generateCommitMessage`, …)
  are best when you actually need the output *in context* to reason over — not as a file writer.
- **For one-off file generation, a Haiku sub-agent that writes the file directly is often simpler**
  and just as cheap on Claude tokens (no deploy/auth/hook). Reach for this server when you need
  large fan-out (many files in one call) and server-side concurrency.

**Model fragility:** the default models (`@cf/qwen/qwen3-30b-a3b-fp8`, `@cf/moonshotai/kimi-k2.5`)
are hard-coded defaults. Cloudflare's catalog changes; if a model is delisted you'll get a 4xx.
Override at runtime via the KV keys `config:model:fast` / `config:model:standard` (self-heals to the
default on an invalid id). If output quality is poor: gather richer `context`, or switch the kind to
the `standard` tier. Token usage per call is now logged (`prompt_tokens`/`completion_tokens` in
`wrangler tail`) so you can see the cheap-side cost.

## Security

- OAuth 2.1 with PIN-based authorization
- Rate limiting on auth attempts (5 per minute)
- Input validation on all tool parameters (size caps)
- Timing-safe secret comparison
- Structured error responses that never leak internals
- All auth events logged with IP for audit trail

## License

MIT
