# Phase 2: Error Handling & Reliability - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-12
**Phase:** 02-error-handling-reliability
**Areas discussed:** Timeout strategy, Error response format, Graceful degradation, Auth error handling

---

## Timeout Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| AbortController + Promise.race | Wrap env.AI.run() with AbortController and configurable timeout. Clean abort signal, native to Workers. | ✓ |
| Simple Promise.race | Race AI.run() against setTimeout promise. Simpler but underlying request keeps running. | |
| You decide | Claude picks based on Workers AI constraints. | |

**User's choice:** AbortController + Promise.race
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| 30 seconds | Generous for code gen. Workers AI typically 5-15s, 30s catches outliers. | ✓ |
| Per-tier: 15s fast / 45s standard | Shorter leash for fast tier, more time for standard. | |
| You decide | Claude picks reasonable defaults. | |

**User's choice:** 30 seconds
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Hardcoded constant | Simple. const AI_TIMEOUT_MS = 30_000. No KV overhead. Change requires redeploy. | ✓ |
| KV-configurable | Store in OAUTH_KV. Hot-swappable but adds KV read per AI call. | |

**User's choice:** Hardcoded constant
**Notes:** None

---

## Error Response Format

| Option | Description | Selected |
|--------|-------------|----------|
| Structured text with error type | Return '[ERROR: CODE] message'. Claude can parse the type tag. | ✓ |
| JSON error object | Return stringified JSON { error, code, tool, message } in MCP text content. | |
| Simple categorized text | Prefix with category like 'Timeout: ...' Less structured. | |

**User's choice:** Structured text with error type
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| AI_TIMEOUT | Workers AI call exceeded 30s timeout. | ✓ |
| AI_ERROR | Workers AI returned 5xx or unexpected response. | ✓ |
| AI_OVERLOADED | Workers AI rate limited or queue full (429/503). | |
| INTERNAL_ERROR | Catch-all for unexpected failures. No internal details leaked. | ✓ |

**User's choice:** AI_TIMEOUT, AI_ERROR, INTERNAL_ERROR (multi-select)
**Notes:** AI_OVERLOADED not selected — falls under AI_ERROR.

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, set isError: true | MCP spec supports isError flag. Claude clients distinguish errors programmatically. | ✓ |
| No, just return error text | Keep returning normal content with error text. | |

**User's choice:** Yes, set isError: true
**Notes:** None

---

## Graceful Degradation

| Option | Description | Selected |
|--------|-------------|----------|
| No retry | Fail fast. Return structured error immediately. Claude retries if desired. | ✓ |
| One retry with backoff | Retry once after 1-2s. Catches transient glitches but doubles latency. | |
| You decide | Claude picks based on Workers constraints. | |

**User's choice:** No retry (fail fast)
**Notes:** Avoids doubling Workers AI costs and latency.

| Option | Description | Selected |
|--------|-------------|----------|
| Catch and use defaults | Wrap KV.get in try-catch. If KV down, silently use DEFAULT_MODELS. | ✓ |
| Propagate as INTERNAL_ERROR | Let it fail and surface to Claude. | |
| You decide | Claude picks most resilient approach. | |

**User's choice:** Catch and use defaults
**Notes:** Model override is nice-to-have, not critical path.

---

## Auth Error Handling

| Option | Description | Selected |
|--------|-------------|----------|
| User-friendly HTML error pages | Styled HTML matching login page design. Users see clean error with retry link. | ✓ |
| Plain text responses | Keep current pattern. Simple, no design work. | |
| You decide | Claude picks approach fitting existing pattern. | |

**User's choice:** User-friendly HTML error pages
**Notes:** None

| Option | Description | Selected |
|--------|-------------|----------|
| Wrap entire GET handler | Single try-catch around whole GET path. Any failure returns clean error page. | ✓ |
| Targeted try-catch per operation | Separate try-catch for each operation. More granular but more code. | |
| You decide | Claude picks cleanest pattern. | |

**User's choice:** Wrap entire GET handler
**Notes:** None

---

## Claude's Discretion

- Error message wording within structured format
- Whether to include tool name, tier, or timeout duration in error text
- HTML error page copy and layout details

## Deferred Ideas

None — discussion stayed within phase scope.
