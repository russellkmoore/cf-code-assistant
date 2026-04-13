---
phase: 01-security-hardening
asvs_level: 2
generated: "2026-04-12"
threats_total: 10
threats_closed: 10
threats_open: 0
result: SECURED
---

# Security Audit — Phase 01: Security Hardening

**Phase:** 01 — security-hardening
**Threats Closed:** 10/10
**ASVS Level:** 2
**Result:** SECURED

## Threat Verification

| Threat ID | Category | Disposition | Status | Evidence |
|-----------|----------|-------------|--------|----------|
| T-1-00 | n/a (test infra) | accept | CLOSED | Test files in `src/__tests__/` do not execute in production; no worker bundle impact |
| T-1-01 | Tampering | mitigate | CLOSED | `src/index.ts:16-18` — `isAllowedModel()` type guard; used in `resolveModel` at line 32 to validate KV override before returning |
| T-1-02 | Elevation of Privilege | mitigate | CLOSED | `src/index.ts:119` — `callModel` parameter typed as `model: keyof AiModels`; `env.AI.run(model, ...)` at line 123 passes without cast |
| T-1-03 | Denial of Service | mitigate | CLOSED | `src/index.ts:153-423` — `.max(N).trim()` on every string parameter across all 11 tool `inputSchema` blocks (19 constraints total) |
| T-1-04 | Tampering | mitigate | CLOSED | `src/index.ts:492-498` — type check (`typeof secret !== "string"`), emptiness check (`!secret.trim()`), size cap (`secret.length > 256`) before KV lookup |
| T-1-05 | Elevation of Privilege | mitigate | CLOSED | `src/index.ts:482-486` — `env.AUTH_RATE_LIMITER.limit({ key: ip })` is first operation in POST block, before `request.formData()`; 429 on failure. `wrangler.toml:18-21` declares `[[ratelimits]]` binding with `limit = 5, period = 60` |
| T-1-06 | Information Disclosure | mitigate | CLOSED | `src/index.ts` — all 11 AI-calling tool handlers wrapped with `try/catch`; catch returns generic `"An error occurred while processing your request. Please try again."` — no `err.message` or `err.stack` in MCP content |
| T-1-07 | Information Disclosure | mitigate | CLOSED | `src/index.ts:511-515` — `JSON.parse(stored)` wrapped in `try {} catch {}` returning `new Response("Authorization failed.", { status: 400 })` |
| T-1-08 | Information Disclosure | mitigate | CLOSED | `src/index.ts:517-529` — `oauthHelpers.completeAuthorization(...)` wrapped in separate `try {} catch {}` returning `new Response("Authorization failed.", { status: 400 })` |
| T-1-09 | Information Disclosure | mitigate | CLOSED | `src/index.ts:543-553` — buffers padded to `Math.max(bufA.byteLength, bufB.byteLength)`; `crypto.subtle.timingSafeEqual` always executes on equal-length buffers; length equality check at line 553 placed after constant-time compare |

## Accepted Risks Log

| Threat ID | Accepted Risk | Rationale |
|-----------|--------------|-----------|
| T-1-00 | Test files have no production execution path | Vitest test stubs are dev dependencies; they are not bundled into the Worker. No security surface introduced. |

## Unregistered Flags

None. All `## Threat Flags` sections in SUMMARY.md files for plans 01-01 through 01-04 reported no new threat flags.

## Verification Notes

### T-1-01 / T-1-02: Model Routing
`ALLOWED_MODELS` uses `as const satisfies ReadonlyArray<keyof AiModels>` — this is a compile-time constraint, not a cast. `DEFAULT_MODELS` typed as `Record<ModelTier, keyof AiModels>`. `resolveModel` returns `Promise<keyof AiModels>`. Self-healing preserved: invalid KV entries are deleted via `env.OAUTH_KV.delete(kvKey)` before falling back to default.

### T-1-03: Input Size Caps
Zod chain is `.max(N).trim()` (max before trim), validating raw untrimmed payload size for security then trimming for cleanliness. The `routingInfo` tool has no string parameters and requires no caps — correctly excluded.

### T-1-04: Auth Form Validation
Eliminates unsafe `as string` casts on `formData.get()`. Guards in order: type + emptiness check → size cap → KV lookup. A `!secret` redundant check at line 506 remains before `timingSafeEqual` but is harmless after the earlier guard.

### T-1-05: Rate Limiting
`wrangler.toml` uses `name = "AUTH_RATE_LIMITER"` (not `binding`) per the wrangler config schema. The `simple = { limit = 5, period = 60 }` inline table is valid TOML. IP key falls back to `"unknown"` when `CF-Connecting-IP` is absent, providing a shared bucket for requests without the header.

### T-1-09: Timing Safe Equal
Old early-return `if (bufA.byteLength !== bufB.byteLength) return false` is absent. New implementation always executes `crypto.subtle.timingSafeEqual` on padded equal-length buffers, then checks length equality afterward. PIN length is not observable from timing.
