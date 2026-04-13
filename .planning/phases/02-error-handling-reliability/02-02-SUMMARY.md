---
phase: 02-error-handling-reliability
plan: 02
subsystem: api
tags: [cloudflare-workers, mcp, error-handling, auth, workers-ai]

# Dependency graph
requires:
  - phase: 02-error-handling-reliability
    plan: 01
    provides: makeToolError(), errorPage(), ErrorCode type, AI_TIMEOUT callModel wrapping
provides:
  - All 11 AI-calling tool handlers returning MCP-compliant isError: true on failure
  - AI_TIMEOUT vs AI_ERROR classification in every tool catch block
  - Auth GET handler returning styled HTML error page with status 500 on failure
affects:
  - 03-test-infrastructure (error path tests can now assert isError: true and specific error codes)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Tool catch block pattern: classify AI_TIMEOUT by exact string match, default to AI_ERROR"
    - "Auth GET try-catch scoped to GET branch only — POST handler error handling unchanged"
    - "err.message in console.error only — never interpolated into MCP response or HTML"

key-files:
  created: []
  modified:
    - src/index.ts

key-decisions:
  - "try-catch scoped to GET branch only (inside if block) — Pitfall 4 from RESEARCH.md: wrapping entire /authorize handler would cause POST failures to return HTML instead of plain-text 400/403"
  - "AI_TIMEOUT classified before AI_ERROR — timeout is the more specific condition and should surface distinctly to MCP clients"
  - "console.error retained in all catch blocks for Phase 4 structured logging upgrade path"

# Metrics
duration: ~2min
completed: 2026-04-13
---

# Phase 02 Plan 02: Error Handling Wiring Summary

**All 11 AI-calling tool handlers and the auth GET handler now return structured, protocol-compliant error responses — no generic strings, no internal state leakage**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-04-13T01:27:54Z
- **Completed:** 2026-04-13T01:29:55Z
- **Tasks:** 2
- **Files modified:** 1 (src/index.ts)

## Accomplishments

- Replaced the generic `"An error occurred while processing your request"` catch blocks in all 11 AI-calling tool handlers with the structured `makeToolError()` pattern
- Each catch block now classifies `AI_TIMEOUT` (exact string match on `err.message`) before defaulting to `AI_ERROR` — timeout and general AI failure are now distinguished in every tool response
- `err.message` appears only in `console.error` (server-side) and never in the MCP response content, eliminating internal state leakage per T-02-04
- Wrapped the auth GET handler body in a try-catch scoped to the GET branch only — `parseAuthRequest`, `KV.put`, and CSRF generation failures now return a styled HTML error page with status 500 per T-02-05
- The POST handler's existing granular error handling is completely unchanged — scope was correctly limited per Pitfall 4 in RESEARCH.md

## Task Commits

1. **Task 1: Wire makeToolError into all 11 tool handler catch blocks** - `1a6b0a8` (feat)
2. **Task 2: Wrap auth GET handler in try-catch with errorPage** - `2c73d87` (feat)

## Files Created/Modified

- `src/index.ts` — All 11 tool catch blocks replaced with AI_TIMEOUT/AI_ERROR classification pattern; auth GET handler wrapped in try-catch returning `errorPage()` on failure

## Decisions Made

- Scoped the auth GET try-catch inside `if (request.method === "GET")` — not around the entire `/authorize` handler. Wrapping too broadly would cause POST handler failures to return HTML instead of plain-text 400/403 responses (Pitfall 4 from RESEARCH.md).
- Retained `console.error` in all catch blocks — Phase 4 will upgrade these to structured logging without changing the error classification logic.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- `worker-configuration.d.ts` not present in worktree (same artifact as Plan 01). Copied from main workspace for `npx tsc --noEmit` to resolve type definitions. File is gitignored and was not committed.

## User Setup Required

None.

## Next Phase Readiness

- All error paths in the application now return structured, protocol-compliant responses
- Phase 3 test infrastructure can assert `isError: true`, specific error codes (`AI_TIMEOUT`, `AI_ERROR`), and that no internal strings leak into responses
- Phase 4 structured logging upgrade is straightforward — `console.error` calls in each catch block are the natural insertion points

## Self-Check

- `src/index.ts` exists and was modified: CONFIRMED
- Task 1 commit `1a6b0a8` exists: CONFIRMED
- Task 2 commit `2c73d87` exists: CONFIRMED
- `makeToolError` count >= 23: CONFIRMED (23)
- Old generic message count == 0: CONFIRMED (0)
- `errorPage` count >= 2: CONFIRMED (2)
- `npx tsc --noEmit` exits 0: CONFIRMED

## Self-Check: PASSED

---
*Phase: 02-error-handling-reliability*
*Completed: 2026-04-13*
