# Phase 2: Error Handling & Reliability - Context

**Gathered:** 2026-04-12
**Status:** Ready for planning

<domain>
## Phase Boundary

All Workers AI calls handle timeouts and failures gracefully. Every failure mode — AI timeout, AI error, KV degradation, auth flow errors — returns a structured error response instead of crashing the worker or returning generic messages.

Requirements: HARD-01, HARD-04

</domain>

<decisions>
## Implementation Decisions

### Timeout Strategy
- **D-01:** Use AbortController + Promise.race to timeout AI calls. Wrap `env.AI.run()` with an AbortController signal and race against a timeout promise.
- **D-02:** Timeout duration is 30 seconds, hardcoded as a constant (`AI_TIMEOUT_MS = 30_000`). No KV configuration — change requires redeploy.

### Error Response Format
- **D-03:** MCP tool errors use structured text format: `[ERROR: CODE] Human-readable message about what failed for tool {toolName}.` The error type tag is parseable by Claude clients.
- **D-04:** Three error categories defined: `AI_TIMEOUT` (30s exceeded), `AI_ERROR` (Workers AI 5xx, unexpected response, overloaded), `INTERNAL_ERROR` (catch-all for KV errors, code bugs — no internal details leaked).
- **D-05:** MCP responses for errors set `isError: true` per MCP protocol spec, allowing Claude clients to distinguish errors from content programmatically.

### Graceful Degradation
- **D-06:** No retry on AI failures. Fail fast — return structured error immediately. Claude can retry on its own if desired. Avoids doubling Workers AI costs and latency.
- **D-07:** KV failures in `resolveModel()` are caught silently — fall back to `DEFAULT_MODELS`. Model override via KV is a nice-to-have, not critical path.

### Auth Error Handling
- **D-08:** User-facing auth errors return styled HTML error pages matching the existing login page design (dark theme, card layout). Not raw text.
- **D-09:** Wrap the entire GET /authorize handler in a single try-catch. Any failure (parseAuthRequest, KV.put, CSRF generation) returns a clean HTML error page.

### Claude's Discretion
- Error message wording and phrasing within the structured format
- Whether to include tool name, tier, or timeout duration in the error text (more info is better, but Claude can decide what's useful for the MCP client)
- HTML error page copy and layout details (match login page style)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Codebase Analysis
- `.planning/codebase/CONCERNS.md` — Lists all missing error handling paths (auth form parsing, AI call failures, KV cascading failures)
- `.planning/codebase/ARCHITECTURE.md` — Data flow diagrams for tool execution and OAuth flow; current error handling strategy documented
- `.planning/codebase/CONVENTIONS.md` — Existing error handling patterns (try-catch, error narrowing, re-throw)

### Source Code
- `src/index.ts` — Single file containing all code. Key areas: `callModel()` (L117-133), `runAI()` (L135-138), `resolveModel()` (L28-37), auth handler (L465-537), tool registrations (L140-461)

### Requirements
- `.planning/REQUIREMENTS.md` — HARD-01 (AI call timeout/graceful degradation), HARD-04 (structured error responses)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `timingSafeEqual()` (L539-553): Already hardened in Phase 1 — no changes needed
- `loginPage()` (L556-585): HTML template for auth page — error pages should reuse this styling pattern
- Tool handler try-catch pattern: Every tool already has try-catch returning generic error — needs to be updated to use structured format

### Established Patterns
- Error type narrowing via `instanceof Error` + message content matching (seen in old model fallback code)
- MCP response format: `{ content: [{ type: "text", text }] }` — error responses add `isError: true`
- Constants at top of file: `ALLOWED_MODELS`, `DEFAULT_MODELS` — add `AI_TIMEOUT_MS` in same section

### Integration Points
- `callModel()` — needs AbortController + timeout wrapping
- `runAI()` — needs try-catch to classify errors into AI_TIMEOUT / AI_ERROR / INTERNAL_ERROR
- `resolveModel()` — needs try-catch around KV.get for graceful KV degradation
- All 12 tool handlers — update catch blocks to use structured error format with isError
- Auth handler GET path (L470-478) — wrap in try-catch returning HTML error page

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches within the decisions captured above.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 02-error-handling-reliability*
*Context gathered: 2026-04-12*
