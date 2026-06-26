---
phase: 05-extract-shared-runtask-executor
plan: 01
subsystem: src/index.ts
tags: [refactor, executor, dispatch, batch-foundation]
dependency_graph:
  requires: []
  provides: [runTask, TASK_SPECS, ValidationError, TaskKind]
  affects: [src/index.ts, all 11 AI-backed tool handlers]
tech_stack:
  added: []
  patterns: [dispatch-map, head-extraction, typed-validation-error]
key_files:
  created: []
  modified:
    - src/index.ts
decisions:
  - "Validation error for transformCode carries meta.codeBytes so the handler tail can interpolate the exact message without re-computing byte length"
  - "explainCode tier for logToolInvocation is re-derived in the handler tail (depth==detailed?standard:fast) rather than threading it through AIResult, preserving the exported AIResult shape"
  - "ValidationError is caught before the generic AI error handler in transformCode so the INPUT_TOO_LARGE quirk (error_type:AI_ERROR) is preserved byte-for-byte"
metrics:
  duration: "~12 minutes"
  completed: "2026-06-26T08:05:00Z"
  tasks_completed: 2
  files_changed: 1
---

# Phase 5 Plan 1: Extract TASK_SPECS Dispatch Map and runTask Executor Summary

Added `TASK_SPECS` dispatch map, `ValidationError` class, and `runTask(env, kind, input)` full executor to `src/index.ts`, then delegated all 11 AI-backed tool handler heads to `runTask`. Observable behavior is identical to before — all 108 existing tests pass with no assertion changes.

## What Was Built

### Task 1: TASK_SPECS, ValidationError, and runTask
Added above `createMcpServer` in `src/index.ts`:

- `TaskKind` — string union of the 11 AI-backed kinds (routingInfo excluded)
- `TaskSpec` interface — `resolve(input)→{tier,maxTokens}`, `buildPrompt(input)→string`, optional `validate?(input)→void`
- `ValidationError extends Error` — carries `meta.codeBytes` for the transformCode handler tail to interpolate the exact INPUT_TOO_LARGE message
- `TASK_SPECS: Record<TaskKind, TaskSpec>` — 11 entries transcribed verbatim from RESEARCH.md:
  - Constant-tier kinds return fixed `{tier, maxTokens}` from `resolve`
  - `explainCode.resolve` branches on `depth` (detailed→standard/4096, else fast/2048)
  - `transformCode.validate` throws `ValidationError` at >8000 bytes (strict `>`; 8000 passes, 8001 throws)
  - `quickTask.buildPrompt` returns `instruction` raw with no wrapping (the only kind)
  - `generateCode` and `generateWorkerBoilerplate` use mutable `parts`-array with conditional pushes
  - `reviewCode` uses `.filter(Boolean)` to drop the empty `criteria` slot
  - `generateCommitMessage` uses `` ```diff `` language tag; all others use bare `` ``` ``
- `runTask(env, kind, input)` — looks up spec, calls `validate?`, resolves tier/maxTokens, returns `runAIWithMetrics(...)`. Does zero logging and does NOT catch AI errors (D-05)
- Exported `runTask`, `TASK_SPECS`, `ValidationError`, `TaskKind` from the named test-export block (additive only)

### Task 2: Delegate 11 Handler Heads to runTask
Replaced the inline prompt-build + `runAIWithMetrics` head of all 11 AI-backed handlers with `await runTask(env, "<kind>", args)`. Per-handler tails preserved byte-for-byte:

- `generateCode`, `reviewCode`, `scaffoldTests`, `quickTask`, `generateDocs`, `generateTypes`, `fixBug`, `generateCommitMessage`, `generateWorkerBoilerplate` — standard head-to-runTask delegation; tail unchanged
- `explainCode` — re-derives `tier` in the tail as `depth === "detailed" ? "standard" : "fast"` to keep `logToolInvocation` correct without widening `AIResult`
- `transformCode` — catches `ValidationError` before the generic AI error branch; reconstructs the exact INPUT_TOO_LARGE envelope including the `error_type:"AI_ERROR"` quirk and the interpolated message using `err.meta.codeBytes`

## Verification

- `npx vitest run` — 108 tests passed (8 files, no assertion changes)
- `npx tsc --noEmit` — pre-existing test-helper type errors (unrelated to this plan's changes; confirmed identical in main repo before any change)
- `git diff --stat src/__tests__/` — no test files modified
- `grep -c "error_type: \"AI_ERROR\""` — quirk preserved

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Missing worker-configuration.d.ts in worktree**
- **Found during:** Task 1 (tsc check)
- **Issue:** `worker-configuration.d.ts` is gitignored/generated and not present in the worktree. TypeScript's `types` compiler option requires it; `tsc --noEmit` errors with "Cannot find type definition file"
- **Fix:** Copied the file from the main repo checkout into the worktree (not staged/committed — gitignored)
- **Files modified:** `worker-configuration.d.ts` (worktree-local, not committed)
- **Commit:** n/a (untracked, gitignored)

### Pre-existing Issues (Out of Scope)

The test-helper types (`Env` partial mock, `CfProperties` vs `IncomingRequestCfProperties`) produce TypeScript errors in `src/__tests__/*.test.ts`. These exist identically in the main repo before this plan's changes and are out of scope for this refactor. Logged to awareness; the vitest Workers pool does not use `tsc` for type-checking test files and all 108 tests run green.

## Known Stubs

None — all 11 handlers fully delegate to `runTask`; no placeholder or TODO code.

## Threat Flags

None — this is a behavior-preserving internal refactor. No new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries. `runTask` does zero logging (T-05-03 preserved).

## Self-Check

Performed below.
