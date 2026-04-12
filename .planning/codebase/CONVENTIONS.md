# Coding Conventions

**Analysis Date:** 2026-04-12

## Naming Patterns

**Files:**
- Single file model: `src/index.ts` contains the entire application (monolithic pattern)
- PascalCase for HTML function names: `loginPage()`, `createMcpServer()`

**Functions:**
- camelCase for all function names: `resolveModel()`, `callModel()`, `runAI()`, `timingSafeEqual()`
- Async functions clearly marked with `async` keyword
- Handler functions suffixed with handler context: `authHandler`, descriptive names like `createMcpHandler()`

**Variables:**
- camelCase for all variables: `kvKey`, `csrfToken`, `formData`, `isModelError`
- UPPER_SNAKE_CASE for constants: `DEFAULT_MODELS`, `SYSTEM_PROMPT`, `ROUTING_INFO`
- Descriptive variable names: `depthInstructions`, `styleInstructions`, `oauthHelpers`

**Types:**
- PascalCase for type names: `ModelTier`, `Env`, `ExportedHandler`
- Union types for configuration: `type ModelTier = "fast" | "standard"`
- Record types for lookups: `Record<ModelTier, string>`, `Record<string, string>`

## Code Style

**Formatting:**
- No linter configured (eslint/prettier not in dependencies)
- Default TypeScript formatting is applied through tsconfig
- 2-space indentation observed throughout

**Linting:**
- Single eslint-disable comment: `// eslint-disable-next-line @typescript-eslint/no-explicit-any` at line 102
  - Used for necessary type assertions (`env.AI.run(model as any, ...)`)
  - Justifies casting when external SDK types are unknown

## Import Organization

**Order:**
1. External SDK imports (Cloudflare, MCP, third-party)
2. Internal utility imports from packages
3. Type-only imports using `type` keyword when appropriate

**Pattern:**
```typescript
import { OAuthProvider, type OAuthHelpers, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
```

**Type imports:** Explicitly use `type` keyword for type-only imports to enable tree-shaking

**Path Aliases:**
- No path aliases configured
- Relative paths not used (single-file module)

## Error Handling

**Patterns:**
- Try-catch wrapping async external calls: `resolveModel()` call in `runAI()` wrapped at lines 118-132
- Error type narrowing: Check `instanceof Error` before accessing properties
- Message content matching for specific errors: Check error message strings to determine error type
  - Example: `err.message.includes("Unknown model")` or `err.message.includes("not found")`
- Fallback strategy: Delete bad config and retry with defaults on model lookup errors

**Pattern Example:**
```typescript
try {
  return await callModel(env, model, userPrompt, maxTokens);
} catch (err) {
  const isModelError = 
    err instanceof Error &&
    (err.message.includes("Unknown model") ||
     err.message.includes("not found") ||
     err.message.includes("invalid model"));
  
  if (isModelError && model !== DEFAULT_MODELS[tier]) {
    // Bad KV config — delete it and retry with default
    await env.OAUTH_KV.delete(`config:model:${tier}`);
    return await callModel(env, DEFAULT_MODELS[tier], userPrompt, maxTokens);
  }
  throw err;
}
```

**Re-throw pattern:** Use `throw err` to propagate unexpected errors after exhausting recovery strategies

## Logging

**Framework:** No logging framework (no winston, pino, bunyan)

**Patterns:**
- Console output not observed in source
- Observability enabled in wrangler config at `[observability] enabled = true` (delegates to Cloudflare Workers logging)
- No structured logging implemented

## Comments

**When to Comment:**
- Business logic complexity explained: System prompt documentation at line 24
- Routing decisions and philosophy: Multi-line ROUTING_INFO constant at line 26
- Implementation notes: "Bad KV config — delete it and retry with default" at line 128
- Context about KV keys: "KV keys: config:model:fast, config:model:standard" at line 15

**Style:**
- Double-dash comments for separation: `// --- Model tier config ---`, `// --- Wire it all up ---`
- Inline comments explain "why" not "what": Line 128 explains intent, not the mechanics

**JSDoc/TSDoc:**
- No JSDoc/TSDoc observed
- No function/interface documentation strings
- Types are self-documenting through TypeScript signatures

## Function Design

**Size:**
- Small, focused functions: `resolveModel()`, `timingSafeEqual()` are 5-8 lines each
- Larger factory functions for complex setup: `createMcpServer()` is 260+ lines (acceptable for server initialization)
- Tool registration pattern allows incremental function composition

**Parameters:**
- Explicit Env parameter passed consistently: `env: Env` passed to most functions
- Optional parameters use nullable types: `language?: string`, `style?: string`
- Zod schema for tool input validation instead of function signature typing

**Return Values:**
- Async functions return typed Promises: `Promise<string>`
- Nullable returns use optional chaining: `override ?? DEFAULT_MODELS[tier]`
- Response objects wrapped in MCP content format: `{ content: [{ type: "text", text: ... }] }`

## Module Design

**Exports:**
- Single default export: `export default new OAuthProvider({...})`
- No named exports observed
- Module composition through functional closures: Server created via `createMcpServer(env)` factory

**Barrel Files:**
- Not applicable (single-file module)

**Zod Schema Pattern:**
- Input validation through `z.string().describe()` and `z.enum()` for tool parameters
- Type inference from Zod schemas: Parameter destructuring in tool handlers
- Chained methods for required/optional: `.describe()` for documentation in MCP introspection

## Configuration Pattern

**Environment Management:**
- Config stored in Cloudflare KV: Keys like `config:model:${tier}` at runtime
- Default constants for fallback: `DEFAULT_MODELS` object
- Environment bindings through `Env` interface

**Conditional Behavior:**
- Model tier selection: "fast" for lightweight tasks, "standard" for complex generation
- Max token adjustment per tool: 1024 for commit messages, 8192 for code generation

## Code Organization

**Sections separated by comment headers:**
```
// --- Model tier config ---
// --- Workers AI helper ---
// --- MCP Server factory ---
// --- Auth handler (self-contained, PIN-based) ---
// --- Wire it all up ---
```

**Logical grouping:** Related functions grouped together, no separate files

---

*Convention analysis: 2026-04-12*
