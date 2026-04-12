## AI Model Routing

This project uses a hybrid routing strategy. Claude handles orchestration,
reasoning, and context gathering. The cf-code-assistant MCP server handles
generation workloads via Cloudflare Workers AI (qwen3-30b-a3b-fp8).

### Route to cf-code-assistant MCP tools when:
- Generating new code from a description
- Scaffolding tests for existing code
- Generating JSDoc/TSDoc documentation
- Inferring TypeScript types from untyped code
- Mechanical transforms (rename, reformat, convert patterns)
- Fixing a specific bug given the code and error message
- Writing a commit message from a diff
- Scaffolding Cloudflare Worker boilerplate

### Keep with Claude when:
- Running /gsd commands or any slash command workflow
- Research tasks requiring web search or Context7
- Architecture decisions and tradeoff analysis
- Multi-file reasoning or cross-cutting changes
- Anything where you need to fetch docs or API references first

### Context injection rule (critical):
Never call generateCode or generateWorkerBoilerplate cold.
Always gather relevant context first (via Context7, Cloudflare MCP,
or existing codebase), then pass it as the `context` parameter.
This is what keeps qwen3 output accurate — it has no MCP access
of its own. Claude gathers, qwen3 generates.

### Example delegation pattern:
1. User asks to build a Durable Object with the current CF API
2. Claude fetches current Durable Objects docs via Cloudflare MCP
3. Claude calls generateWorkerBoilerplate with description + fetched docs as context
4. Claude reviews output, integrates into codebase
