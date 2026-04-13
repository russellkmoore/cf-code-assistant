---
phase: 04-observability
plan: "01"
subsystem: logging
tags: [observability, structured-logging, cloudflare-workers]
dependency_graph:
  requires: []
  provides: [structured-logging-module, tool-invocation-logging, tool-error-logging]
  affects: [src/index.ts, src/logger.ts]
tech_stack:
  added: []
  patterns: [structured-json-logging, metrics-collection-via-runAIWithMetrics]
key_files:
  created:
    - src/logger.ts
    - src/__tests__/logger.test.ts
  modified:
    - src/index.ts
decisions:
  - "Used console.log/console.error for structured JSON output (Cloudflare tail logs parse these natively)"
  - "Added runAIWithMetrics wrapper rather than modifying runAI signature to preserve backward compatibility"
  - "Input size logged as byte count only, never prompt content (threat mitigation T-04-02)"
metrics:
  duration: "5m 13s"
  completed: "2026-04-13T05:55:41Z"
  tasks: 2
  files: 3
requirements: [OBS-01, OBS-02]
---

# Phase 04 Plan 01: Structured Logging Summary

Structured JSON logging module with tool invocation and error logging wired into all 11 tool handlers, using runAIWithMetrics for latency tracking.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create src/logger.ts structured logging module with tests (TDD) | 5aad419 | src/logger.ts, src/__tests__/logger.test.ts |
| 2 | Wire structured logging into runAI and all tool handlers | b5fca94 | src/index.ts |

## What Was Built

### src/logger.ts
Three exported functions producing structured JSON for Cloudflare tail logs:
- `logToolInvocation({ tool, tier, model, latency_ms })` -- JSON to console.log with category "tool_invocation"
- `logToolError({ tool, error_type, input_size_bytes })` -- JSON to console.error with category "tool_error"
- `logAuthEvent({ event, ip, detail? })` -- JSON to console.log (info) or console.error (failure/rate_limit) with category "auth_event"

Each entry includes an ISO 8601 timestamp. No stack traces, secrets, or prompt content are logged.

### src/index.ts Changes
- Added `runAIWithMetrics()` returning `{ text, model, latency_ms }` for instrumentation
- Original `runAI()` preserved as thin wrapper for backward compatibility
- All 11 tool handlers updated: success path calls `logToolInvocation`, error path calls `logToolError`
- All old unstructured `console.error("Tool error [...")` calls removed (count: 0 remaining)
- Exported `runAIWithMetrics` and `AIResult` type

### src/__tests__/logger.test.ts
9 unit tests covering:
- JSON structure and field validation for all three log functions
- Console routing (log vs error) for each function
- No stack trace leakage in error logs
- ISO 8601 timestamp validation

## Verification Results

| Check | Result |
|-------|--------|
| `npx tsc --noEmit` on src/index.ts, src/logger.ts | 0 errors |
| `npx vitest run` | 100 tests pass (7 test files) |
| Unstructured `console.error("Tool error [` in index.ts | 0 (all replaced) |
| `logToolInvocation({` call count in index.ts | 11 (one per tool) |
| `logToolError({` call count in index.ts | 11 (one per tool) |

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None. All logging functions are fully wired with real data from runAIWithMetrics.

## Self-Check: PASSED

All files exist. All commits verified in git log.
