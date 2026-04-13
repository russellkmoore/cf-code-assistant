# Phase 2: Error Handling & Reliability - Research

**Researched:** 2026-04-12
**Domain:** Cloudflare Workers error handling, MCP protocol error responses, AbortController timeout patterns
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Use AbortController + Promise.race to timeout AI calls. Wrap `env.AI.run()` with an AbortController signal and race against a timeout promise.
- **D-02:** Timeout duration is 30 seconds, hardcoded as a constant (`AI_TIMEOUT_MS = 30_000`). No KV configuration — change requires redeploy.
- **D-03:** MCP tool errors use structured text format: `[ERROR: CODE] Human-readable message about what failed for tool {toolName}.` The error type tag is parseable by Claude clients.
- **D-04:** Three error categories defined: `AI_TIMEOUT` (30s exceeded), `AI_ERROR` (Workers AI 5xx, unexpected response, overloaded), `INTERNAL_ERROR` (catch-all for KV errors, code bugs — no internal details leaked).
- **D-05:** MCP responses for errors set `isError: true` per MCP protocol spec, allowing Claude clients to distinguish errors from content programmatically.
- **D-06:** No retry on AI failures. Fail fast — return structured error immediately. Claude can retry on its own if desired.
- **D-07:** KV failures in `resolveModel()` are caught silently — fall back to `DEFAULT_MODELS`. Model override via KV is a nice-to-have, not critical path.
- **D-08:** User-facing auth errors return styled HTML error pages matching the existing login page design (dark theme, card layout). Not raw text.
- **D-09:** Wrap the entire GET /authorize handler in a single try-catch. Any failure (parseAuthRequest, KV.put, CSRF generation) returns a clean HTML error page.

### Claude's Discretion

- Error message wording and phrasing within the structured format
- Whether to include tool name, tier, or timeout duration in the error text (more info is better)
- HTML error page copy and layout details (match login page style)

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| HARD-01 | All AI calls wrapped with timeout handling and graceful degradation | AbortController + Promise.race pattern verified for Cloudflare Workers; `resolveModel()` KV-failure fallback pattern documented |
| HARD-04 | Structured error responses for all failure modes (AI timeout, invalid input, rate limited) | MCP `isError: true` flag confirmed via official SDK docs; structured `[ERROR: CODE]` format compatible with MCP CallToolResult |
</phase_requirements>

---

## Summary

Phase 2 adds structured error boundaries at every failure surface in the codebase: AI calls (timeouts and model errors), KV access in model resolution, and the OAuth authorization GET path. The existing code already has try-catch blocks in all 12 tool handlers, but they return generic strings without `isError: true`. The primary work is (1) wrapping `callModel()` with a 30-second AbortController timeout, (2) upgrading all tool catch blocks to return `[ERROR: CODE]` format with `isError: true`, (3) hardening `resolveModel()` against KV failures, and (4) wrapping the GET /authorize handler to return styled HTML errors instead of raw 500s.

All four changes are localized to `src/index.ts`. No new dependencies are required. The implementation follows established conventions in the codebase: constants at the top, error type narrowing via `instanceof Error`, and the existing `loginPage()` styling pattern for HTML error pages.

The test infrastructure (vitest + `@cloudflare/vitest-pool-workers`) is already set up with `vitest.config.mts`. Stub test files from Phase 1 exist in `src/__tests__/`. Phase 2 will add new test stubs for error paths; full implementation is Phase 3's responsibility.

**Primary recommendation:** Implement changes in three focused waves: (1) `callModel()` + `runAI()` + `resolveModel()` hardening, (2) all 12 tool catch blocks upgraded, (3) auth GET handler wrapped.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript (native) | 5.8.x | Error type narrowing (`instanceof Error`) | Already in use; no addition needed |
| Web APIs (native) | Workers runtime | `AbortController`, `setTimeout`, `crypto.randomUUID` | Built into Cloudflare Workers runtime — zero-dep timeout pattern |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@cloudflare/vitest-pool-workers` | 0.14.3 | Test mocking for Workers AI + KV | Already installed; used for Phase 2 error path tests |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| AbortController + Promise.race | `AbortSignal.timeout()` | `AbortSignal.timeout()` has a known bug in wrangler local dev: throws un-catchable async DOMException in the log even when the error IS caught. Manual AbortController avoids this spurious noise. [CITED: github.com/cloudflare/workerd/issues/1020] |
| Hardcoded `AI_TIMEOUT_MS` constant | KV-configurable timeout | Decided against (D-02) — adds complexity, change requires redeploy anyway |

**Installation:** No new packages required. All dependencies already installed.

---

## Architecture Patterns

### Recommended Project Structure

No structural change — all code remains in `src/index.ts`. Changes are additive edits to existing functions and handlers.

```
src/
└── index.ts          # All changes: callModel(), runAI(), resolveModel(), tool handlers, authHandler
src/__tests__/
├── model-routing.test.ts      # Existing stubs (Phase 1)
├── error-sanitization.test.ts # Existing stubs (Phase 1)
└── error-handling.test.ts     # New stubs for Phase 2 HARD-01 / HARD-04 paths
```

### Pattern 1: AbortController + Promise.race Timeout

**What:** Wrap `callModel()` with a racing abort promise. If the AI call exceeds `AI_TIMEOUT_MS`, the abort signal fires and the `Promise.race` resolves with the timeout branch, which throws a typed `AI_TIMEOUT` error.

**When to use:** Any async call where the underlying operation may hang indefinitely. Workers AI has no built-in client-side timeout — this is the only guard.

**Implementation approach:**

```typescript
// Source: Web standards (AbortController) + Cloudflare Workers runtime
// [CITED: developers.cloudflare.com/workers/runtime-apis/web-standards/]
const AI_TIMEOUT_MS = 30_000;

async function callModel(
  env: Env,
  model: keyof AiModels,
  userPrompt: string,
  maxTokens: number,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const aiPromise = env.AI.run(model, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => {
        reject(new Error("AI_TIMEOUT"));
      });
    });

    const response = await Promise.race([aiPromise, timeoutPromise]);
    const result = response as { response?: string };
    return result.response ?? JSON.stringify(response);
  } finally {
    clearTimeout(timeoutId);
  }
}
```

**Note:** `env.AI.run()` does not accept an AbortSignal parameter in the current bindings type. The timeout is implemented via `Promise.race` — the AI call continues in the background after timeout fires but the tool handler receives the timeout error immediately. This is acceptable because Workers have a 30-second CPU time limit anyway. [ASSUMED — `env.AI.run` signal support is not documented; verified absence via Cloudflare bindings docs]

### Pattern 2: Structured MCP Error Response

**What:** Return `{ content: [{ type: "text", text: "[ERROR: CODE] message" }], isError: true }` from all tool handlers on failure.

**When to use:** Every catch block in every tool handler. The `isError: true` flag tells Claude clients the result is an error, not content. [CITED: github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md]

```typescript
// Source: MCP TypeScript SDK official docs
// [CITED: github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md]

function makeToolError(code: "AI_TIMEOUT" | "AI_ERROR" | "INTERNAL_ERROR", toolName: string, detail?: string): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  const messages: Record<string, string> = {
    AI_TIMEOUT: `[ERROR: AI_TIMEOUT] The AI model did not respond within 30 seconds for tool ${toolName}. Please retry.`,
    AI_ERROR:   `[ERROR: AI_ERROR] The AI model returned an error for tool ${toolName}. Service may be degraded — please retry.`,
    INTERNAL_ERROR: `[ERROR: INTERNAL_ERROR] An internal error occurred in tool ${toolName}. Please retry.`,
  };
  return {
    content: [{ type: "text", text: messages[code] }],
    isError: true,
  };
}
```

**Error classification in `runAI()`:**

```typescript
async function runAI(env: Env, tier: ModelTier, userPrompt: string, maxTokens = 4096): Promise<string> {
  const model = await resolveModel(env, tier);
  return callModel(env, model, userPrompt, maxTokens);
  // Throws: Error("AI_TIMEOUT") or whatever Workers AI throws on 5xx/overload
}
```

Tool handlers classify the caught error:

```typescript
} catch (err) {
  const msg = err instanceof Error ? err.message : "";
  if (msg === "AI_TIMEOUT") {
    console.error(`Tool error [generateCode]: AI_TIMEOUT`);
    return makeToolError("AI_TIMEOUT", "generateCode");
  }
  console.error(`Tool error [generateCode]:`, msg || "unknown");
  return makeToolError("AI_ERROR", "generateCode");
}
```

### Pattern 3: KV-Failure Graceful Degradation in `resolveModel()`

**What:** Wrap the KV.get call in a try-catch. On any KV failure, log a warning and fall back to `DEFAULT_MODELS[tier]`.

**When to use:** Any optional KV reads where the fallback is well-defined. Per D-07, model override is non-critical — degrading silently to defaults is correct behavior.

```typescript
async function resolveModel(env: Env, tier: ModelTier): Promise<keyof AiModels> {
  const kvKey = `config:model:${tier}`;
  try {
    const override = await env.OAUTH_KV.get(kvKey);
    if (override !== null) {
      if (isAllowedModel(override)) return override;
      // Self-heal: invalid model in KV — delete it, fall back to default
      await env.OAUTH_KV.delete(kvKey);
    }
  } catch (err) {
    // KV degraded — silently fall back to default (D-07)
    console.warn(`[resolveModel] KV unavailable for key ${kvKey}:`, err instanceof Error ? err.message : "unknown");
  }
  return DEFAULT_MODELS[tier];
}
```

### Pattern 4: Auth GET Handler Try-Catch (D-09)

**What:** Wrap the entire GET /authorize block in a try-catch returning a styled HTML error page.

**When to use:** Any handler that calls third-party helpers (`oauthHelpers.parseAuthRequest`) or KV operations whose failure should return user-facing HTML, not a raw 500.

```typescript
if (request.method === "GET") {
  try {
    const authRequest = await oauthHelpers.parseAuthRequest(request);
    const csrfToken = crypto.randomUUID();
    await env.OAUTH_KV.put(`csrf:${csrfToken}`, JSON.stringify(authRequest), { expirationTtl: 300 });
    return new Response(loginPage(csrfToken), {
      headers: { "Content-Type": "text/html" },
    });
  } catch (err) {
    console.error("[authHandler GET] Failed to initialize auth:", err instanceof Error ? err.message : "unknown");
    return new Response(errorPage("Authorization Error", "Failed to initialize the authorization flow. Please try again."), {
      status: 500,
      headers: { "Content-Type": "text/html" },
    });
  }
}
```

`errorPage()` should reuse the same dark-theme card layout as `loginPage()`.

### Anti-Patterns to Avoid

- **Leaking `err.message` in tool error responses:** Workers AI errors may contain internal model details or stack traces. Always use the pre-defined error message strings — never interpolate `err.message` into the user-facing content. (SEC-04 requirement from Phase 1)
- **Retrying AI calls in the Worker:** D-06 is explicit — no retry. Claude decides whether to retry. Double-calling Workers AI doubles cost and latency.
- **Catching errors in `resolveModel()` and rethrowing:** D-07 says KV failures should degrade silently. The existing pattern (delete bad key + retry) should remain for validation failures, but actual KV exceptions should be caught and swallowed.
- **Using `AbortSignal.timeout()`:** Known bug in wrangler local dev throws un-catchable DOMException log noise. Use manual `AbortController` + `setTimeout` instead. [CITED: github.com/cloudflare/workerd/issues/1020]

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| MCP error signaling | Custom error wrapper objects | `isError: true` on `CallToolResult` | Protocol-compliant; Claude clients key off this flag [CITED: MCP SDK docs] |
| Timing-safe comparison | Anything new | Existing `timingSafeEqual()` | Already hardened in Phase 1 — do not touch |
| HTML error pages | Third-party template engine | Extend existing `loginPage()` pattern | Consistent style; no new dependency |

**Key insight:** The error handling work is almost entirely wiring changes — the plumbing already exists. The primary additions are `AI_TIMEOUT_MS` constant, `makeToolError()` helper, and `errorPage()` HTML template.

---

## Common Pitfalls

### Pitfall 1: Background AI call after timeout
**What goes wrong:** After `Promise.race` returns the timeout error, `env.AI.run()` continues running in the background. The Worker is still alive and paying for CPU time.
**Why it happens:** `Promise.race` doesn't cancel the losing promise; it just stops waiting for it.
**How to avoid:** `AbortController.abort()` is called, but Workers AI binding may not honor it. This is acceptable given the Worker's own 30-second CPU limit — the background call will be killed when the Worker response completes. Document this behavior.
**Warning signs:** If Workers AI consistently takes >30s AND the Worker's CPU limit isn't hit, investigate whether `env.AI.run` has grown more expensive.

### Pitfall 2: `isError` omitted from existing tool catch blocks
**What goes wrong:** Catch blocks already exist in all 12 tools (from prior generic error handling), but they currently return `{ content: [...] }` WITHOUT `isError: true`. Claude clients cannot distinguish a successful response from an error response.
**Why it happens:** Phase 1 guards were added for sanitization, not MCP protocol compliance.
**How to avoid:** All 12 tool catch blocks must be updated to use `makeToolError()`. Use a single helper to enforce consistency — don't update each block individually.
**Warning signs:** If a Claude client doesn't seem to be handling errors differently, check whether `isError` is being set.

### Pitfall 3: KV delete failure in `resolveModel()` masking the real error
**What goes wrong:** If `env.OAUTH_KV.delete(kvKey)` itself throws (KV degraded), the outer catch does not currently exist — the delete error propagates and the function throws instead of falling back.
**Why it happens:** The existing `resolveModel()` has no try-catch around KV operations at all. Adding one resolves this.
**How to avoid:** The try-catch wrapping the entire KV block (as shown in Pattern 3 above) covers both `get` and `delete` operations.
**Warning signs:** If Worker crashes with KV-related errors after model config is set, `resolveModel()` is the entry point to investigate.

### Pitfall 4: Auth GET try-catch masking POST handler bugs
**What goes wrong:** D-09 says wrap the GET /authorize handler. If the try-catch is placed too broadly (wrapping both GET and POST), POST handler bugs become silent 500s with HTML responses, confusing debugging.
**Why it happens:** Copy-paste wrapping the entire `if (url.pathname === "/authorize")` block.
**How to avoid:** The try-catch must be scoped to the GET branch only. POST handler already has granular error handling added in Phase 1.
**Warning signs:** POST to /authorize returns HTML "Authorization failed" page instead of plain-text 400/403 — indicates try-catch scope is wrong.

### Pitfall 5: `errorPage()` vs `loginPage()` HTML structure drift
**What goes wrong:** If `errorPage()` is a simplified version of `loginPage()` that doesn't include all the CSS, the error page looks broken (unstyled or mismatched).
**Why it happens:** Handwriting a second HTML template without extracting a shared base.
**How to avoid:** `errorPage()` should be a thin wrapper that reuses the same CSS block. Consider extracting a `renderPage(title, bodyContent)` helper that both `loginPage()` and `errorPage()` call.
**Warning signs:** Error page renders with default browser styling (serif font, white background) instead of dark card.

---

## Code Examples

### AbortController timeout pattern for `callModel()`

```typescript
// Source: Cloudflare Workers web standards + workerd issue #1020
// [CITED: github.com/cloudflare/workerd/issues/1020]
// Note: Use manual AbortController, NOT AbortSignal.timeout() — known wrangler dev bug

const AI_TIMEOUT_MS = 30_000;

async function callModel(
  env: Env,
  model: keyof AiModels,
  userPrompt: string,
  maxTokens: number,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  const timeoutPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => {
      reject(new Error("AI_TIMEOUT"));
    });
  });

  try {
    const aiPromise = env.AI.run(model, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
    });

    const response = await Promise.race([aiPromise, timeoutPromise]);
    const result = response as { response?: string };
    return result.response ?? JSON.stringify(response);
  } finally {
    clearTimeout(timeoutId);
  }
}
```

### MCP error response helper

```typescript
// Source: MCP TypeScript SDK docs
// [CITED: github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md]

type ErrorCode = "AI_TIMEOUT" | "AI_ERROR" | "INTERNAL_ERROR";

function makeToolError(code: ErrorCode, toolName: string) {
  const messages: Record<ErrorCode, string> = {
    AI_TIMEOUT:     `[ERROR: AI_TIMEOUT] The AI model did not respond within 30 seconds for tool ${toolName}. Please retry.`,
    AI_ERROR:       `[ERROR: AI_ERROR] The AI model returned an error for tool ${toolName}. The service may be temporarily degraded.`,
    INTERNAL_ERROR: `[ERROR: INTERNAL_ERROR] An internal error occurred in tool ${toolName}. Please retry.`,
  };
  return {
    content: [{ type: "text" as const, text: messages[code] }],
    isError: true as const,
  };
}
```

### Tool handler catch block (all 12 tools follow this pattern)

```typescript
} catch (err) {
  const msg = err instanceof Error ? err.message : "";
  if (msg === "AI_TIMEOUT") {
    console.error("Tool error [generateCode]: AI_TIMEOUT");
    return makeToolError("AI_TIMEOUT", "generateCode");
  }
  console.error("Tool error [generateCode]:", msg || "unknown");
  return makeToolError("AI_ERROR", "generateCode");
}
```

### HTML error page (reusing loginPage styling)

```typescript
function errorPage(heading: string, message: string): string {
  // Reuses exact same CSS as loginPage() — dark theme card layout
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CF Code Assistant — Error</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #e5e5e5; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 2rem; max-width: 400px; width: 100%; }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; color: #f97316; }
    p { color: #999; font-size: 0.875rem; margin: 0 0 1.5rem; }
    a { color: #f97316; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${heading}</h1>
    <p>${message}</p>
    <p><a href="/authorize">Try again</a></p>
  </div>
</body>
</html>`;
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| MCP tools throw on error (SDK catches, auto-sets isError) | Explicit `return { isError: true }` with controlled message | MCP SDK best practice | Full control over user-facing message; no internal details leaked |
| Generic catch block returning plain string | Structured `[ERROR: CODE]` format | Phase 2 | Claude clients can parse error type; enables retry logic |
| `AbortSignal.timeout()` | Manual `AbortController` + `setTimeout` | workerd issue #1020 (ongoing) | Avoids spurious DOMException log noise in local dev |

**Deprecated/outdated:**
- Raw `console.error` + generic return: Phase 2 replaces this with structured error return + `isError: true`. The `console.error` call is retained for server-side observability.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `env.AI.run()` does not accept an `AbortSignal` parameter — the timeout is implemented via `Promise.race` only, and the AI call continues in the background after timeout | Architecture Patterns (Pattern 1) | If AI binding DOES accept a signal, we should pass it to cancel the underlying HTTP request and save AI compute cost. Low risk: the race pattern works regardless. |
| A2 | Background continuation of `env.AI.run()` after timeout is acceptable because the Worker's own CPU limit kills it | Pitfall 1 | If the Worker response closes but the AI call somehow persists and charges, this is a cost concern. Low probability in Workers serverless model. |

---

## Open Questions

1. **Does `env.AI.run()` accept a signal or timeout option not reflected in the type definitions?**
   - What we know: Cloudflare's bindings docs for Workers AI show model + options params, but no `signal` field. The Workers runtime supports AbortController in general.
   - What's unclear: Whether the binding internally supports cancellation at the HTTP level.
   - Recommendation: Use the `Promise.race` pattern as decided (D-01). If Cloudflare adds signal support later, it can be wired in as an enhancement.

2. **Should `INTERNAL_ERROR` be used for KV failures in tool handlers (if `runAI()` itself fails due to `resolveModel()` throwing)?**
   - What we know: `resolveModel()` is now wrapped in try-catch and will NOT throw. But if `resolveModel()` somehow still throws (a future code regression), the tool's catch block will hit with a non-AI error.
   - What's unclear: Whether the distinction between `AI_ERROR` and `INTERNAL_ERROR` needs finer granularity.
   - Recommendation: With `resolveModel()` hardened, `runAI()` only throws AI-related errors. Use `AI_ERROR` as the default catch-all in tool handlers. `INTERNAL_ERROR` is reserved for explicitly non-AI exceptions.

---

## Environment Availability

Step 2.6: SKIPPED — Phase 2 is purely code changes within `src/index.ts`. No new external tools, services, CLIs, or runtimes are introduced. The existing Cloudflare Workers AI binding, KV namespace, and OAuth provider are already operational from Phase 1.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.4 |
| Config file | `vitest.config.mts` |
| Quick run command | `npm test` |
| Full suite command | `npm run test:coverage` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| HARD-01 | `callModel()` returns `AI_TIMEOUT` error after 30s | unit | `npm test -- --grep "AI timeout"` | ❌ Wave 0 |
| HARD-01 | `resolveModel()` falls back to DEFAULT_MODELS on KV failure | unit | `npm test -- --grep "KV failure fallback"` | ❌ Wave 0 |
| HARD-04 | Tool handler returns `isError: true` on AI timeout | unit | `npm test -- --grep "isError timeout"` | ❌ Wave 0 |
| HARD-04 | Tool handler returns `isError: true` on AI error | unit | `npm test -- --grep "isError AI error"` | ❌ Wave 0 |
| HARD-04 | Auth GET handler returns HTML error on parseAuthRequest failure | unit | `npm test -- --grep "auth GET error"` | ❌ Wave 0 |
| HARD-04 | Error messages do not contain `err.message` or stack traces | unit | Existing `error-sanitization.test.ts` stubs | ❌ (stubs only) |

### Sampling Rate
- **Per task commit:** `npm test`
- **Per wave merge:** `npm run test:coverage`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/__tests__/error-handling.test.ts` — covers HARD-01 timeout, HARD-01 KV fallback, HARD-04 isError flag
- [ ] Stub implementations in `error-sanitization.test.ts` need full test body (Phase 3 owns implementation, Phase 2 adds stubs only)

Note: `@cloudflare/vitest-pool-workers` is already configured in `vitest.config.mts` with KV and rate limiter mocks. Workers AI binding will need mocking for error-path tests — this is Phase 3's domain. Phase 2 adds test stub files only.

---

## Security Domain

Phase 2 does not introduce new authentication or authorization logic. The changes are error response formatting and timeout wrapping. Relevant carry-forward from Phase 1:

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | no (unchanged in this phase) | Already added in Phase 1 |
| V6 Cryptography | no | `timingSafeEqual()` hardened in Phase 1 — not touched |
| V7 Error Handling | yes | SEC-04: error messages must not leak internal state — `makeToolError()` uses pre-defined strings only |

### Known Threat Patterns for This Phase

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Error message information disclosure | Information Disclosure | Never interpolate `err.message` into tool response content; `makeToolError()` uses static strings |
| Auth error page injection | Tampering | `errorPage()` heading and message are hardcoded strings — not user input; no injection surface |

---

## Sources

### Primary (HIGH confidence)
- [CITED: github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md] — `isError: true` flag, `CallToolResult` format, auto-catch behavior when handlers throw
- [CITED: developers.cloudflare.com/workers/runtime-apis/web-standards/] — `AbortController` and `AbortSignal` support confirmed in Workers runtime

### Secondary (MEDIUM confidence)
- [CITED: github.com/cloudflare/workerd/issues/1020] — `AbortSignal.timeout()` bug in local dev; manual AbortController recommended as workaround
- [CITED: mcpcat.io/guides/error-handling-custom-mcp-servers/] — MCP error handling best practices including `isError` usage and structured error codes

### Tertiary (LOW confidence)
- WebSearch result: `env.AI.run()` accepts `requestTimeoutMs` via AI Gateway options — not verified against workers-types or official binding docs; not used in this implementation

---

## Project Constraints (from CLAUDE.md)

| Directive | Impact on Phase 2 |
|-----------|-------------------|
| All tools use `server.registerTool()` | Error returns must use the same `{ content: [{ type: "text", text }] }` format — add `isError: true` to this existing shape |
| `runAI(env, tier, prompt, maxTokens)` — always pass tier | `callModel()` and `runAI()` signatures unchanged; timeout wrapping is internal to `callModel()` |
| New McpServer instance per request | No change; error handling is within tool handlers, not at server construction level |
| `env` passed to tools via closure | `makeToolError()` is a pure helper function, no env dependency |
| Single file: `src/index.ts` | All changes in one file; organize under existing section headers |

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; all patterns use web-standard APIs present in Cloudflare Workers
- Architecture: HIGH — code analysis of `src/index.ts` is direct; patterns derived from codebase conventions
- Pitfalls: MEDIUM — timeout behavior with background Workers AI call is assumed based on Workers execution model, not directly verified
- MCP `isError` behavior: HIGH — verified via official MCP TypeScript SDK docs

**Research date:** 2026-04-12
**Valid until:** 2026-07-12 (stable — Workers runtime APIs and MCP SDK error format change infrequently)
