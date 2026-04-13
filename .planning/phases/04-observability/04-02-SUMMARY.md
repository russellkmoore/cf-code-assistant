---
phase: "04"
plan: "02"
subsystem: observability
tags: [auth-logging, structured-logs, integration-tests, security-audit]
dependency_graph:
  requires: ["04-01"]
  provides: ["auth-event-logging", "observability-test-coverage"]
  affects: ["src/index.ts", "src/__tests__/observability.test.ts"]
tech_stack:
  added: []
  patterns: ["logAuthEvent for all auth paths", "console spy integration testing"]
key_files:
  created:
    - src/__tests__/observability.test.ts
  modified:
    - src/index.ts
decisions:
  - "Used inline IP extraction in GET handler catch rather than top-level const to minimize scope"
  - "Tests use parseLogCalls helper to parse JSON from console spy — same pattern can be reused"
metrics:
  duration: "3m 37s"
  completed: "2026-04-13T05:58:21Z"
  tasks_completed: 2
  tasks_total: 2
  tests_added: 8
  files_changed: 2
---

# Phase 04 Plan 02: Auth Event Logging and Observability Tests Summary

Wired structured auth event logging into all auth handler paths and added integration tests verifying structured JSON output for tool invocations, tool errors, and auth events across all three OBS requirements.

## Task Results

| Task | Name | Commit | Status |
|------|------|--------|--------|
| 1 | Wire logAuthEvent into auth handler | 3ac6d81 | Done |
| 2 | Add observability integration tests | 84e16a1 | Done |

## Changes Made

### Task 1: Wire logAuthEvent into auth handler

Added `logAuthEvent` import and wired 10 logging calls into the auth handler:

- **rate_limit**: Logged before returning 429 on rate limit hit
- **attempt**: Logged for every POST that passes rate limiting
- **failure** (6 variants): invalid_form_data, input_too_long, csrf_expired, wrong_pin, invalid_csrf_payload, authorization_completion_failed
- **success**: Logged before redirect on successful authorization
- **failure (GET)**: auth_init_failed replaces unstructured `console.error("[authHandler GET]...)`

No secrets, CSRF tokens, or PIN values appear in any log output. The `detail` field uses only fixed enum strings.

### Task 2: Observability integration tests

Created `src/__tests__/observability.test.ts` with 8 tests across 3 describe blocks:

- **OBS-01** (2 tests): Tool invocation produces structured JSON with correct fields; no prompt/response content leaks
- **OBS-02** (3 tests): AI_TIMEOUT and AI_ERROR produce structured error logs; no stack traces in error logs
- **OBS-03** (3 tests): Auth attempt+success logged on valid flow; failure with detail on wrong PIN; rate_limit event logged

## Deviations from Plan

None - plan executed exactly as written.

## Verification Results

- `npx tsc --noEmit`: No errors in src/index.ts or src/logger.ts (pre-existing type errors in other test files are out of scope)
- `npx vitest run`: 108 tests pass (100 existing + 8 new)
- `logAuthEvent` count in src/index.ts: 11 (1 import + 10 calls) -- exceeds minimum of 8
- Unstructured `console.error("[authHandler` in src/index.ts: 0
- OBS requirement test sections: 3 (OBS-01, OBS-02, OBS-03)

## Self-Check: PASSED

- [x] src/__tests__/observability.test.ts exists
- [x] Commit 3ac6d81 exists (Task 1)
- [x] Commit 84e16a1 exists (Task 2)
