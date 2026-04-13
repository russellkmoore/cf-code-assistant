---
phase: 02-error-handling-reliability
plan: 01
subsystem: api
tags: [cloudflare-workers, workers-ai, mcp, abort-controller, error-handling]

# Dependency graph
requires:
  - phase: 01-security-hardening
    provides: hardened callModel type safety, input validation, timingSafeEqual
provides:
  - AI_TIMEOUT_MS constant (30s) for use by tool handlers
  - callModel() with AbortController + Promise.race timeout wrapping
  - resolveModel() with KV-failure try-catch fallback to DEFAULT_MODELS
  - makeToolError() helper returning MCP-compliant isError: true responses
  - errorPage() HTML template matching loginPage dark-theme card layout
  - ErrorCode type ("AI_TIMEOUT" | "AI_ERROR" | "INTERNAL_ERROR")
affects:
  - 02-02 (wires makeToolError into all 12 tool catch blocks and auth GET handler)
  - 03-test-infrastructure (error path tests mock callModel timeout behavior)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "AbortController + Promise.race for AI call timeout (avoids AbortSignal.timeout() wrangler bug)"
    - "Structured MCP error format: [ERROR: CODE] message with isError: true"
    - "KV-failure silent fallback: try-catch around OAUTH_KV.get/delete in resolveModel"
    - "Static pre-defined error messages in makeToolError — never interpolate err.message (SEC-04)"

key-files:
  created: []
  modified:
    - src/index.ts

key-decisions:
  - "30s timeout via manual AbortController rather than AbortSignal.timeout() — avoids known wrangler local dev DOMException noise"
  - "No retry on AI failure (D-06) — fail fast and let Claude retry at orchestrator level"
  - "KV failures in resolveModel degrade silently to DEFAULT_MODELS (D-07) — model override is non-critical path"
  - "makeToolError uses static pre-defined strings only — never interpolates err.message to prevent internal detail leakage"

patterns-established:
  - "Pattern: callModel timeout — AbortController + Promise.race racing against abort-signal promise"
  - "Pattern: MCP error response — makeToolError(code, toolName) returns { content, isError: true }"
  - "Pattern: KV degradation — try-catch wrapping all KV ops in resolveModel with console.warn fallback"

requirements-completed:
  - HARD-01
  - HARD-04

# Metrics
duration: ~15min
completed: 2026-04-13
---

# Phase 02 Plan 01: Error Handling Infrastructure Summary

**30-second AbortController timeout on Workers AI calls, KV-failure fallback in resolveModel, makeToolError MCP helper with isError: true, and dark-theme errorPage HTML template**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-04-13T01:20:00Z
- **Completed:** 2026-04-13T01:24:24Z
- **Tasks:** 2
- **Files modified:** 1 (src/index.ts)

## Accomplishments

- Wrapped `callModel()` with AbortController + Promise.race so any AI call exceeding 30 seconds rejects with `Error("AI_TIMEOUT")` instead of hanging the Worker indefinitely
- Hardened `resolveModel()` with a try-catch around all KV operations — KV failures now log a warning and fall back to `DEFAULT_MODELS` rather than crashing the Worker
- Added `makeToolError(code, toolName)` helper that returns MCP-protocol-compliant `{ content, isError: true }` with three static pre-defined message formats (AI_TIMEOUT, AI_ERROR, INTERNAL_ERROR)
- Added `errorPage(heading, message)` HTML template with exact same dark-theme card layout as `loginPage()` — ready for use in auth GET handler hardening (Plan 02)

## Task Commits

1. **Task 1: AI timeout wrapping and resolveModel hardening** - `477ea6b` (feat)
2. **Task 2: makeToolError helper and errorPage template** - `6060ede` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `src/index.ts` — Added AI_TIMEOUT_MS constant, rewrote callModel() with timeout, wrapped resolveModel() in try-catch, added ErrorCode type + makeToolError() helper + errorPage() function

## Decisions Made

- Used manual `AbortController` + `setTimeout` instead of `AbortSignal.timeout()` to avoid a known wrangler local dev bug (cloudflare/workerd#1020) that throws un-catchable DOMException log noise
- No retry logic in callModel — per D-06, fail fast; Claude orchestrator can retry at its discretion
- KV failures in resolveModel swallowed silently (D-07) — model config override is a nice-to-have, not load-bearing
- `makeToolError` uses only static message strings per SEC-04 carry-forward — `err.message` is never interpolated into user-facing responses

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- `worker-configuration.d.ts` was not present in the worktree (only in the main workspace directory). Copied it from the main workspace so `npx tsc --noEmit` could resolve the type definitions. This is a worktree setup artifact, not a code issue.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- All error handling primitives are in place for Plan 02 to wire into all 12 tool handlers and the auth GET handler
- `makeToolError("AI_TIMEOUT", toolName)`, `makeToolError("AI_ERROR", toolName)`, and `makeToolError("INTERNAL_ERROR", toolName)` are ready to replace the existing generic catch blocks
- `errorPage()` is ready to be used in the auth GET handler try-catch (Pattern 4 from research)
- TypeScript compiles clean with zero errors

---
*Phase: 02-error-handling-reliability*
*Completed: 2026-04-13*
