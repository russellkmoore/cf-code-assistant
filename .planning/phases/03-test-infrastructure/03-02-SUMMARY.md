---
phase: 03-test-infrastructure
plan: 02
subsystem: test-infrastructure
tags: [testing, auth, security, rate-limiting, vitest]
dependency_graph:
  requires: [03-01]
  provides: [auth-flow-tests, error-sanitization-tests, rate-limiting-tests]
  affects: [src/__tests__/auth-flow.test.ts, src/__tests__/error-sanitization.test.ts, src/__tests__/rate-limiting.test.ts]
tech_stack:
  added: []
  patterns: [vitest-cloudflare-pool, mock-kv, mock-rate-limiter, integration-test-auth-handler]
key_files:
  created:
    - src/__tests__/auth-flow.test.ts
  modified:
    - src/__tests__/error-sanitization.test.ts
    - src/__tests__/rate-limiting.test.ts
decisions:
  - Mock ExecutionContext with oauth property for authHandler integration tests
  - Import authHandler directly from index (exported by 03-01) and call authHandler.fetch!()
  - Pre-seed createMockKV with CSRF entries to test valid/invalid auth flows
metrics:
  duration_minutes: 12
  completed_date: "2026-04-13"
  tasks_completed: 2
  files_changed: 3
---

# Phase 3 Plan 02: Auth Flow and Error Path Tests Summary

**One-liner:** Auth handler integration tests with CSRF flow, PIN validation, error sanitization, and rate-limit short-circuit coverage using mocked KV and RateLimit bindings.

## What Was Built

22 tests across 3 files covering TEST-02 and TEST-04 requirements:

### src/__tests__/auth-flow.test.ts (14 tests, new file)

**TEST-02: timingSafeEqual (6 tests)**
- identical strings → true
- same-length different content → false
- different lengths → false
- both empty → true
- one empty → false
- prefix match but different lengths → false

**TEST-02: Auth GET /authorize (2 tests)**
- Returns 200 HTML with `name="csrf"`, `name="secret"`, `<form`, and verifies `KV.put` called with `csrf:*` key and `expirationTtl: 300`
- Returns 500 error page when `parseAuthRequest` throws

**TEST-02/TEST-04: Auth POST /authorize (6 tests)**
- Correct PIN + valid CSRF → 302 redirect
- Wrong PIN → 403 "Invalid secret." (no secret value leaked)
- Missing CSRF in KV (expired) → 400 "Session expired"
- Empty form fields → 400 "Invalid form data."
- Secret > 256 chars → 400 "Invalid form data."
- Valid CSRF but malformed JSON in KV → 400 "Authorization failed."

### src/__tests__/error-sanitization.test.ts (5 tests, replaced stubs)

- AI_TIMEOUT includes tool name, no stack trace, no `env.` references
- AI_ERROR includes tool name, no KV/OAUTH_KV mentions
- INTERNAL_ERROR no `stack` or `config:` text
- All 3 error codes produce MCP-compatible `{ content: [{ type: "text", text }], isError: true }` shape
- Auth 403 hardcoded string verified not to contain secret value

### src/__tests__/rate-limiting.test.ts (3 tests, replaced stubs)

- Rate-limited POST → 429, KV.get not called (short-circuit confirmed)
- CF-Connecting-IP present → `limit({ key: "10.0.0.1" })` called
- No CF-Connecting-IP header → `limit({ key: "unknown" })` called

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | d9fa112 | feat(03-02): implement timingSafeEqual and auth flow tests |
| 2 | 2116c11 | feat(03-02): implement error sanitization and rate limiting tests |

## Decisions Made

1. **Mock ExecutionContext with oauth property** — authHandler reads `(ctx as unknown as { oauth: OAuthHelpers }).oauth`, so tests pass a plain object with `oauth: { parseAuthRequest, completeAuthorization }`. This matches the production injection pattern without needing a real OAuthProvider.

2. **Pre-seeded KV for POST tests** — `createMockKV({ "csrf:valid-csrf-token": JSON.stringify({...}) })` pre-seeds the store so tests exercise the full CSRF lookup → delete → PIN check flow without mocking individual calls.

3. **authHandler.fetch! call pattern** — `authHandler` is typed as `ExportedHandler<Env>`, so tests call `authHandler.fetch!(request, env, ctx)` with non-null assertion. This matches the plan's interface spec.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — all `.todo` stubs in the three test files have been replaced with passing tests.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes introduced. Tests mock at the binding level and do not add production surface.

## Self-Check: PASSED

- [x] src/__tests__/auth-flow.test.ts exists (275 lines, 14 tests)
- [x] src/__tests__/error-sanitization.test.ts exists (5 tests, no .todo)
- [x] src/__tests__/rate-limiting.test.ts exists (3 tests, no .todo)
- [x] Commit d9fa112 exists
- [x] Commit 2116c11 exists
- [x] All 22 tests pass: `npx vitest run` exits 0
- [x] Zero `it.todo` stubs in any of the three files
