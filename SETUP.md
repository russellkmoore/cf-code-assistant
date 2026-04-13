# CF Code Assistant — Setup

## Prerequisites

- Node.js 18+
- A Cloudflare account with Workers AI enabled
- `wrangler` CLI (included as devDependency)

## 1. Install Dependencies

```bash
npm install
```

## 2. Set the MCP Secret

Choose a strong secret (16+ characters) — this is your PIN for authorizing MCP clients:

```bash
npx wrangler secret put MCP_SECRET
# Enter your secret when prompted
```

## 3. Deploy

The deploy script automatically creates the KV namespace if it doesn't exist:

```bash
npm run deploy
```

This will:
- Check if the `OAUTH_KV` namespace is configured in `wrangler.toml`
- Create one if missing and update `wrangler.toml` with the ID
- Warn if `MCP_SECRET` isn't set
- Deploy the Worker

Your MCP server will be live at:
```
https://cf-code-assistant.<your-subdomain>.workers.dev/mcp
```

Replace `<your-subdomain>` with your Cloudflare Workers subdomain.

## 4. Register in Claude Code

Add to `~/.claude/settings.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "cf-code-assistant": {
      "type": "url",
      "url": "https://cf-code-assistant.<your-subdomain>.workers.dev/mcp"
    }
  }
}
```

When Claude Code first connects, it will:
1. Discover the OAuth metadata at `/.well-known/oauth-authorization-server`
2. Register as a client via `/register`
3. Open your browser to `/authorize`
4. You enter your `MCP_SECRET` to approve
5. Claude Code receives an access token (valid 1 year)

After first auth, it's automatic — no re-entry needed until the token expires or you revoke.

## 5. Test Locally

```bash
npm run dev
# In another terminal:
npx @modelcontextprotocol/inspector
# Enter http://localhost:8787/mcp in the inspector
```

Note: Local dev still hits Cloudflare Workers AI remotely, so AI calls will incur charges.

## 6. Configure Claude Code for Routing

See [examples/CLAUDE.md](examples/CLAUDE.md) for a ready-to-use routing block you can paste into your project's `CLAUDE.md`. This teaches Claude when to delegate tasks to cf-code-assistant vs. handle them directly.

For a more structured approach, see [examples/skills/cf-delegate.md](examples/skills/cf-delegate.md) — a Claude Code skill that automates the context-gathering and delegation workflow.

## Changing Models

The default model is `@cf/qwen/qwen3-30b-a3b-fp8`. To change it at runtime without redeploying:

```bash
# Set a different model for the "fast" tier
npx wrangler kv key put "config:model:fast" "@cf/meta/llama-4-scout-17b-16e-instruct" --namespace-id <your-kv-id>

# Set a different model for the "standard" tier
npx wrangler kv key put "config:model:standard" "@cf/meta/llama-4-scout-17b-16e-instruct" --namespace-id <your-kv-id>
```

Invalid model names auto-revert to the default on next request (self-healing).

## Troubleshooting

**"Too many attempts"** — Auth rate limiter triggered (5 attempts per minute). Wait 60 seconds.

**Tools return generic errors** — Check `wrangler tail` for structured log output. Every tool call and auth event produces JSON logs.

**KV namespace not found** — Run `npm run deploy` again; the deploy script will detect and fix missing KV configuration.
