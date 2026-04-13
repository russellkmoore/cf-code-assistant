---
phase: 01-security-hardening
verified: 2026-04-12T17:15:00Z
status: human_needed
score: 5/5 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Trigger a rate-limited auth scenario by sending 6 rapid POST requests to /authorize from the same IP"
    expected: "First 5 return 403 (wrong PIN) or redirect; the 6th returns 429 Too Many Attempts before any form parsing"
    why_human: "Cannot test the Workers RateLimit binding against a live deployment from a static grep check; Miniflare simulates it but live Cloudflare behavior requires a deploy"
---

# Phase 1: Security Hardening Verification Report

**Phase Goal:** The server rejects malformed inputs, validates model names, protects auth from brute force, and uses type-safe model routing
**Verified:** 2026-04-12T17:15:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | The `as any` cast on Workers AI model routing is replaced with type-safe narrowing — TypeScript strict mode passes clean | VERIFIED | `grep -c "as any" src/index.ts` returns 0; `callModel` accepts `keyof AiModels`; `ALLOWED_MODELS` uses `as const satisfies ReadonlyArray<keyof AiModels>`; `eslint-disable` comments removed |
| 2 | Tool inputs with oversized code or context payloads are rejected with a 400 before reaching Workers AI | VERIFIED | All 19 Zod `.max(N).trim()` constraints present across 11 tools; `grep -c ".max(" src/index.ts` = 20; caps correct per research table (100k code, 50k context/diff, 20k prompt, 10k instruction/error/description, 2k criteria, 500 bindings, 100 language/style/framework) |
| 3 | Model names read from KV are validated against an allowlist — an unrecognized model name never reaches `ai.run()` | VERIFIED | `ALLOWED_MODELS` const at line 10; `isAllowedModel()` type guard at line 16; `resolveModel()` validates KV value via `isAllowedModel` before returning (line 32); invalid entries deleted from KV and default returned (line 34) |
| 4 | More than 5 PIN attempts within 60 seconds from the same IP returns 429 without processing the attempt | VERIFIED (code) | `AUTH_RATE_LIMITER` in `Env` interface (line 112); `wrangler.toml` `[[ratelimits]]` with `simple = { limit = 5, period = 60 }`; rate limit check at line 483 (before `request.formData()` at line 488); 429 response on `!success`; `CF-Connecting-IP` header used as key |
| 5 | Error responses to clients never include stack traces, internal state, or KV contents | VERIFIED | 11 tool handlers wrapped with try/catch returning generic "An error occurred while processing your request. Please try again."; auth JSON.parse and completeAuthorization each in separate try/catch returning "Authorization failed."; `grep -c '} catch' src/index.ts` = 13; `err.message` only appears in `console.error()` calls, not in any Response body or MCP content text |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/index.ts` | Type-safe model routing with allowlist, Zod caps, rate limiting, error sanitization | VERIFIED | Contains `ALLOWED_MODELS`, `isAllowedModel`, `keyof AiModels` (4 occurrences), `.max(` (20 occurrences), `AUTH_RATE_LIMITER`, 13 catch clauses |
| `wrangler.toml` | Rate limit binding declaration | VERIFIED | `[[ratelimits]]` stanza with `name = "AUTH_RATE_LIMITER"`, `namespace_id = "1"`, `simple = { limit = 5, period = 60 }` |
| `vitest.config.mts` | Vitest config for Workers pool | VERIFIED | Uses `cloudflarePool` from `@cloudflare/vitest-pool-workers`; `remoteBindings: false`; `kvNamespaces: ["OAUTH_KV"]`; `AUTH_RATE_LIMITER` rate limit mock; `MCP_SECRET` binding |
| `package.json` | vitest dev dependency and test script | VERIFIED | `vitest: ^4.1.4`; `@cloudflare/vitest-pool-workers: ^0.14.3`; `"test": "vitest run --reporter=verbose"` |
| `src/__tests__/model-routing.test.ts` | Test stubs for SEC-01 and SEC-03 | VERIFIED | 7 `it.todo()` stubs covering both requirement areas |
| `src/__tests__/input-validation.test.ts` | Test stubs for SEC-02 and HARD-03 | VERIFIED | 12 `it.todo()` stubs |
| `src/__tests__/rate-limiting.test.ts` | Test stubs for HARD-02 | VERIFIED | 4 `it.todo()` stubs |
| `src/__tests__/error-sanitization.test.ts` | Test stubs for SEC-04 | VERIFIED | 5 `it.todo()` stubs |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `resolveModel` | `callModel` | returns `keyof AiModels` which callModel accepts without cast | WIRED | `resolveModel` returns `Promise<keyof AiModels>` (line 28); `callModel` accepts `model: keyof AiModels` (line 119); `runAI` chains them directly (lines 136-137) |
| `ALLOWED_MODELS` | `isAllowedModel` | type guard narrows string to AllowedModel | WIRED | `isAllowedModel` uses `ALLOWED_MODELS` at line 17; called in `resolveModel` at line 32 |
| `z.string().max(N)` | tool inputSchema | Zod validation runs before handler executes | WIRED | All tool `inputSchema` blocks contain `.max(N).trim()` chains; Zod validates at MCP layer before handler function is invoked |
| `wrangler.toml [[ratelimits]]` | `env.AUTH_RATE_LIMITER` | Cloudflare Workers binding injection | WIRED | `name = "AUTH_RATE_LIMITER"` in wrangler.toml; `AUTH_RATE_LIMITER: RateLimit` in `Env` interface (line 112) |
| `auth handler POST` | `env.AUTH_RATE_LIMITER.limit` | rate limit check before form processing | WIRED | Line 483 (`AUTH_RATE_LIMITER.limit`) precedes line 488 (`request.formData()`) in POST block |
| `tool handler catch` | MCP response | generic error message, no err.message or err.stack | WIRED | 11 tool catch blocks verified; `err.message` only in `console.error()` context, not in MCP content text |

### Data-Flow Trace (Level 4)

Not applicable — this phase modifies security enforcement logic (type constraints, validation gates, error handling), not data-rendering components. No state-to-render data flow to trace.

### Behavioral Spot-Checks

| Behavior | Command / Check | Result | Status |
|----------|----------------|--------|--------|
| `npm test` exits 0 with 28 todo tests | `npm test; echo $?` | 28 todo tests, exit 0 | PASS |
| `as any` count is zero | `grep -c "as any" src/index.ts` | 0 | PASS |
| `.max(` constraints count | `grep -c "\.max(" src/index.ts` | 20 (requirement: 17+) | PASS |
| `} catch` clause count | `grep -c '} catch' src/index.ts` | 13 (requirement: 13+) | PASS |
| Rate limit before formData | Line comparison: `AUTH_RATE_LIMITER.limit` (483) vs `formData()` (488) | 483 < 488 | PASS |
| timingSafeEqual length check after comparison | Line 551: `crypto.subtle.timingSafeEqual`; Line 553: `bufA.byteLength === bufB.byteLength` | 551 < 553 | PASS |
| `err.message`/`err.stack` absent from responses | `grep -n "err\.message\|err\.stack" src/index.ts \| grep -v "console.error"` | 0 matches outside console.error | PASS |
| No `bufA.byteLength !== bufB.byteLength` early return | `grep -c "bufA.byteLength !== bufB.byteLength" src/index.ts` | 0 | PASS |
| No unsafe `as string` form casts | `grep "formData.get.*as string" src/index.ts` | 0 matches | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| SEC-01 | 01-02-PLAN.md | Eliminate `as any` type cast — use proper type narrowing | SATISFIED | `callModel` typed as `keyof AiModels`; `ALLOWED_MODELS` with `satisfies`; zero `as any` in file |
| SEC-02 | 01-03-PLAN.md | Cap input sizes on tool parameters | SATISFIED | 20 `.max(N).trim()` constraints across all 11 tools per research table |
| SEC-03 | 01-02-PLAN.md | Validate model names from KV against an allowlist | SATISFIED | `ALLOWED_MODELS` allowlist; `isAllowedModel()` gate in `resolveModel`; invalid KV entries deleted |
| SEC-04 | 01-04-PLAN.md | Sanitize error messages — never leak internal state or stack traces | SATISFIED | 11 tool handlers + 2 auth paths with generic error returns; no `err.message`/`err.stack` in responses |
| HARD-02 | 01-04-PLAN.md | Rate limiting on auth PIN attempts (max 5 per minute per IP) | SATISFIED (code) | `[[ratelimits]]` in wrangler.toml; `AUTH_RATE_LIMITER.limit()` called before formData(); 429 on rate limit breach |
| HARD-03 | 01-03-PLAN.md | Input validation on all tool inputs and auth form data | SATISFIED | Auth POST validates `typeof secret`, `!secret.trim()`, `secret.length > 256`; all tool schemas have Zod max constraints |

**Orphaned requirements check:** REQUIREMENTS.md maps SEC-01, SEC-02, SEC-03, SEC-04, HARD-02, HARD-03 to Phase 1. All 6 are claimed by plans (01-02, 01-03, 01-04). No orphaned requirements.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None found | — | — | — | — |

All scanned files are clean. No TODO/FIXME/placeholder comments, no hardcoded empty returns in handlers, no `as any` casts remaining.

### Human Verification Required

#### 1. Live Rate Limiting Behavior

**Test:** Deploy the Worker to Cloudflare (`npm run deploy`). From the same IP address, send 6 rapid POST requests to `/authorize` with arbitrary form data within a 60-second window.
**Expected:** Requests 1-5 proceed to form parsing and return 400 (invalid form data) or 403 (wrong PIN); request 6 returns `429 Too Many Attempts. Try again later.` before any form body is parsed (confirmed by the 429 response body matching the pre-formData guard).
**Why human:** The `AUTH_RATE_LIMITER` Workers RateLimit binding is a native Cloudflare service. Miniflare simulates it in tests, and the code wiring is verified. But actual enforcement behavior (per-IP counting across Cloudflare's edge, the exact 60-second window semantics) requires a live deployment test. The test stubs for HARD-02 are also `it.todo()` — they will be implemented in Phase 3 and provide automated coverage then.

---

### Gaps Summary

No gaps found. All 5 roadmap success criteria are met by the implementation in `src/index.ts` and `wrangler.toml`.

The human verification item (live rate limiting) is a deployment-level behavioral check that cannot be completed without deploying the Worker. The code wiring is fully verified — the gap is environmental, not a missing implementation.

---

_Verified: 2026-04-12T17:15:00Z_
_Verifier: Claude (gsd-verifier)_
