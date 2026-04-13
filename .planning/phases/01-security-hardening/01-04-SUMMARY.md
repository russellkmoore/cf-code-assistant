---
phase: 01-security-hardening
plan: "04"
subsystem: auth-rate-limiting-error-sanitization
tags: [rate-limiting, error-sanitization, security, cloudflare-workers]
requirements: [HARD-02, SEC-04]

dependency_graph:
  requires: [01-03]
  provides: [rate-limit-on-auth, error-sanitized-tool-responses]
  affects: [src/index.ts, wrangler.toml]

tech_stack:
  added:
    - "Workers RateLimit binding (AUTH_RATE_LIMITER) — native Cloudflare per-IP rate limiter"
  patterns:
    - "try/catch on all AI-calling tool handlers returning generic MCP error text"
    - "Rate limit check before formData() parsing in auth POST handler"
    - "Separate try/catch blocks for JSON.parse and completeAuthorization in auth handler"

key_files:
  modified:
    - path: src/index.ts
      changes: "Added AUTH_RATE_LIMITER to Env interface; rate limit guard in auth POST; try/catch on all 11 AI tool handlers and 2 auth error paths"
    - path: wrangler.toml
      changes: "Added [[ratelimits]] stanza: AUTH_RATE_LIMITER binding, namespace_id=1, simple={limit=5, period=60}"
    - path: worker-configuration.d.ts
      changes: "Regenerated via npm run types (rate limit binding not reflected — manual Env interface is authoritative)"

decisions:
  - "Used `name` field in [[ratelimits]] stanza (not `binding`) per wrangler config-schema.json — IDE schema validator was using an outdated schema"
  - "Used inline TOML table `simple = { limit = 5, period = 60 }` instead of separate [ratelimits.simple] sub-table — avoids TOML parser ambiguity with array-of-tables"
  - "Added console.error in tool catch blocks for server-side visibility via wrangler tail — Phase 4 will replace with structured logging"
  - "Two separate try/catch blocks in auth handler (JSON.parse and completeAuthorization) rather than one combined block — clearer error attribution"

metrics:
  duration: "~15 minutes"
  completed_date: "2026-04-12"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 3
---

# Phase 01 Plan 04: Rate Limiting and Error Sanitization Summary

**One-liner:** Per-IP rate limiting on auth POST (5 req/60s via Workers RateLimit binding) and generic error sanitization across all 11 AI tool handlers and 2 auth error paths.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add rate limiting binding and auth handler guard | 2bffdfd | wrangler.toml, src/index.ts |
| 2 | Wrap all tool handlers and auth JSON parsing with error sanitization | 278aa14 | src/index.ts |

## What Was Built

### Task 1: Rate Limiting (HARD-02)

Added the Workers `RateLimit` binding to `wrangler.toml` as a `[[ratelimits]]` stanza with `name = "AUTH_RATE_LIMITER"`, `namespace_id = "1"`, and `simple = { limit = 5, period = 60 }`. Added `AUTH_RATE_LIMITER: RateLimit` to the manual `Env` interface in `src/index.ts` (the module-scoped interface shadows the generated global one).

In the auth handler POST block, the rate limit check is the first operation — before `request.formData()` — using `CF-Connecting-IP` as the key. Rate-limited requests (6th attempt within 60 seconds) receive a `429 Too Many Attempts` before any form body is parsed.

### Task 2: Error Sanitization (SEC-04)

Wrapped all 11 AI-calling tool handlers (`generateCode`, `reviewCode`, `transformCode`, `scaffoldTests`, `quickTask`, `explainCode`, `generateDocs`, `generateTypes`, `fixBug`, `generateCommitMessage`, `generateWorkerBoilerplate`) with try/catch blocks. Each catch returns the generic MCP text response "An error occurred while processing your request. Please try again." — no `err.message`, no `err.stack`, no internal state reaches the client. Server-side `console.error` logs tool name and error message for `wrangler tail` visibility.

The auth handler's `JSON.parse(stored)` call and `oauthHelpers.completeAuthorization()` call are each wrapped in separate try/catch blocks returning `"Authorization failed."` with status 400.

`routingInfo` was correctly excluded — it has no AI call and no external I/O that can fail in ways needing sanitization.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Incorrect wrangler.toml ratelimits schema**
- **Found during:** Task 1
- **Issue:** Plan specified `binding = "AUTH_RATE_LIMITER"` and a separate `[ratelimits.simple]` sub-table, but `wrangler/config-schema.json` shows the field is `name` (not `binding`) and `simple` must be an inline property of the same `[[ratelimits]]` object
- **Fix:** Changed to `name = "AUTH_RATE_LIMITER"` and `simple = { limit = 5, period = 60 }` inline
- **Files modified:** wrangler.toml
- **Commit:** 2bffdfd

**2. [Rule 3 - Blocking] Missing node_modules (vitest) caused tsc to fail**
- **Found during:** Task 1 verification
- **Issue:** `npx tsc --noEmit` failed because `src/__tests__/*.test.ts` import `vitest` which wasn't installed in the worktree's context; vitest was added to package.json in Plan 01-01 but `npm install` hadn't been run in the main project
- **Fix:** Ran `npm install` in the main project directory to install all dependencies including vitest
- **Files modified:** None (dependency installation only)

**3. [Rule 3 - Blocking] Missing worker-configuration.d.ts in worktree**
- **Found during:** Task 1 verification
- **Issue:** The worktree didn't have `worker-configuration.d.ts` (generated file, gitignored); `npm run types` was run in main project but the generated file isn't in git
- **Fix:** Copied `worker-configuration.d.ts` from main project to worktree for type-checking
- **Files modified:** worker-configuration.d.ts (copied)

## Threat Model Coverage

| Threat ID | Mitigation | Status |
|-----------|-----------|--------|
| T-1-05 | Auth POST rate limited 5/60s per CF-Connecting-IP; 429 before formData() | Implemented |
| T-1-06 | All 11 tool handlers catch and return generic message; no err.message/stack | Implemented |
| T-1-07 | JSON.parse(stored) wrapped in try/catch; returns generic 400 | Implemented |
| T-1-08 | completeAuthorization wrapped in try/catch; returns generic 400 | Implemented |

## Verification Results

- `npx tsc --noEmit`: PASSED
- `grep "AUTH_RATE_LIMITER" wrangler.toml`: 1 match
- `grep "429" src/index.ts`: 1 match (rate limit response)
- `grep -c '} catch' src/index.ts`: 13 (11 tool handlers + 2 auth paths)
- `grep "err.message" src/index.ts` in response strings: 0 matches
- `grep "err.stack" src/index.ts`: 0 matches

## Known Stubs

None. All rate limiting and error sanitization is fully wired.

## Self-Check: PASSED

- `src/index.ts` exists and contains `AUTH_RATE_LIMITER`, 13 catch clauses, generic error messages
- `wrangler.toml` exists and contains `[[ratelimits]]` stanza
- Commits 2bffdfd and 278aa14 verified in git log
