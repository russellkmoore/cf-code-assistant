# CF Code Assistant — Setup

## 1. Create KV Namespace

```bash
npx wrangler kv namespace create "OAUTH_KV"
```

Copy the output `id` into `wrangler.toml` under `[[kv_namespaces]]`.

## 2. Set the MCP Secret

Choose a strong secret — this is your PIN for authorizing MCP clients:

```bash
npx wrangler secret put MCP_SECRET
# Enter your secret when prompted
```

## 3. Deploy

```bash
npx wrangler deploy
```

Your MCP server will be live at:
```
https://cf-code-assistant.<your-subdomain>.workers.dev/mcp
```

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
5. Claude Code receives an access token (valid 24h, auto-refreshes)

After first auth, it's automatic — no re-entry needed until you revoke.

Replace `<your-subdomain>` with your Cloudflare Workers subdomain.

## CLAUDE.md Routing Block

Paste this into your project's `CLAUDE.md`:

```markdown
## Code Generation Routing — cf-code-assistant MCP

When a task is pure code generation, transformation, review, or testing — delegate to the
`cf-code-assistant` MCP server to save tokens. Claude handles orchestration; the Worker handles generation.

### Routing Rules

**ALWAYS delegate to cf-code-assistant when:**
- Generating new code from a clear spec → `generateCode`
- Reviewing code for bugs/style/security → `reviewCode`
- Mechanical transforms (rename, reformat, add types, convert patterns) → `transformCode`
- Generating test scaffolding → `scaffoldTests`
- Simple self-contained tasks (regex, snippets, format conversions) → `quickTask`

**NEVER delegate — Claude handles directly:**
- Anything involving /gsd commands or workflow orchestration
- Research tasks (web search, Context7 lookups, Cloudflare docs)
- Architecture decisions or multi-file reasoning
- Tasks requiring reading/exploring the codebase first
- Anything needing MCP tool output as input (Claude fetches first, then may pass as `context`)

### Context-First Pattern
Before calling `generateCode`, Claude MUST gather relevant context:
1. Use Context7, Cloudflare MCP, or file reads to collect API docs, existing code, or patterns
2. Pass gathered context via the `context` parameter
3. Include `language` and `style` when applicable

Example flow:
1. User asks: "Add a KV caching layer to the auth middleware"
2. Claude reads the auth middleware file
3. Claude fetches KV API docs via Context7 or Cloudflare MCP
4. Claude calls `generateCode(prompt="Add KV caching to this auth middleware", context="<middleware code + KV docs>", language="typescript")`

### Model Info
- Backend: `@cf/qwen/qwen3-30b-a3b-fp8` on Workers AI
- 32k context window, MoE (3B active params)
- Cost: $0.051/M input, $0.34/M output tokens
- Best for: mechanical code tasks where Claude's reasoning isn't needed
```

## Test Locally

```bash
npm run dev
# In another terminal:
npx @modelcontextprotocol/inspector
# Enter http://localhost:8787/mcp in the inspector
```
