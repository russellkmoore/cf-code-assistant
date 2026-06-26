---
phase: 05-extract-shared-runtask-executor
plan: 02
subsystem: src/__tests__/runtask.test.ts
tags: [test, snapshot, prompt-drift-guard, batch-02]
dependency_graph:
  requires: [05-01]
  provides: [BATCH-02 prompt-snapshot guard]
  affects: [src/__tests__/runtask.test.ts]
tech_stack:
  added: []
  patterns: [byte-equality-snapshot, tdd-guard]
key_files:
  created:
    - src/__tests__/runtask.test.ts
  modified: []
decisions:
  - "Transcribed all 11 buildPrompt expected strings verbatim from RESEARCH.md Per-Kind Extraction Table; no re-derivation from code"
  - "Over-cap INPUT_TOO_LARGE envelope assertion goes through the full handler path (getToolHandler) not just validate, preserving byte-identical comparison to the actual MCP response"
  - "runtask.test.ts also asserts constant-tier kinds (generateCode/quickTask/generateCommitMessage/reviewCode) via resolve() as sanity checks alongside the explainCode depth-routing coverage"
metrics:
  duration: "~2 minutes"
  completed: "2026-06-26T08:12:00Z"
  tasks_completed: 1
  files_changed: 1
---

# Phase 5 Plan 2: BATCH-02 Prompt-Snapshot Guard Summary

Added `src/__tests__/runtask.test.ts` — the byte-equality prompt-snapshot guard that closes the regression gap the AI-mocked 108-test suite cannot see (createMockAI is prompt-blind). Asserts byte-identical `buildPrompt` output for all 11 AI-backed kinds, explainCode depth routing, transformCode 8KB boundary, runTask smoke, and the INPUT_TOO_LARGE over-cap envelope. Full suite: 145 tests passed (108 existing + 37 new).

## What Was Built

### Task 1: runtask.test.ts — prompt snapshots, explainCode resolve, transformCode cap, runTask smoke

Created `src/__tests__/runtask.test.ts` with 37 tests across 5 describe blocks:

**BATCH-02: buildPrompt snapshots** (23 tests)
- `generateCode`: prompt-only, language-only, style-only, context-only, all-fields — exercises the mutable `parts`-array conditional pushes
- `reviewCode`: without criteria (`.filter(Boolean)` drops empty slot) and with criteria
- `transformCode`: 3-part `.join("\n\n")` with bare ` ``` ` fence
- `scaffoldTests`: default framework (vitest) and explicit framework (jest)
- `quickTask`: raw instruction passthrough — the only kind with no wrapping
- `explainCode`: brief/detailed/eli5/default depths — exercises depth instructions verbatim
- `generateDocs`: tsdoc/jsdoc/inline style branches
- `generateTypes`: 2-part join
- `fixBug`: 3-part join with `Error:\n` prefix
- `generateCommitMessage`: 5-part join with ` ```diff ` language tag (the only kind using it)
- `generateWorkerBoilerplate`: without/with bindings — exercises conditional parts push

**BATCH-02: explainCode resolve** (8 tests)
- detailed → `{tier:"standard", maxTokens:4096}`
- brief → `{tier:"fast", maxTokens:2048}`
- eli5 → `{tier:"fast", maxTokens:2048}`
- default (no depth) → `{tier:"fast", maxTokens:2048}`
- constant-tier sanity: generateCode, quickTask, generateCommitMessage, reviewCode

**BATCH-02: transformCode 8KB cap** (2 tests)
- `validate` at exactly 8000 bytes: does NOT throw
- `validate` at 8001 bytes: throws

**BATCH-01: runTask wiring** (2 tests)
- generateCode end-to-end via `createMockEnv({aiResponse:"mock AI output"})` — asserts `text`, `model`, `typeof latency_ms`
- quickTask fast-tier smoke

**BATCH-01: transformCode over-cap INPUT_TOO_LARGE envelope** (2 tests)
- Full handler path (via `getToolHandler` mirroring tool-handlers.test.ts) with 8001-byte input
- `isError === true`
- `content[0].text` byte-identical to: `[ERROR: INPUT_TOO_LARGE] transformCode received 8001 bytes; cap is 8000. Full-file rewrites at this size routinely exceed the 45s model timeout. Scope the transformation to a single function or block and splice the result back yourself.`

## Verification

- `npx vitest run src/__tests__/runtask.test.ts` — 37 tests passed
- `npx vitest run` — 145 tests passed (9 files: 8 original + 1 new)
- `npx tsc --noEmit` — pre-existing test-helper type errors only (identical to main repo baseline before any change; `MCP_SECRET` missing in partial mock `Env` affects all test files equally)
- `git diff --stat src/index.ts` — no change (this plan owns only the test file)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Missing worker-configuration.d.ts in worktree**
- **Found during:** tsc check (same pre-existing blocker as Plan 01)
- **Issue:** `worker-configuration.d.ts` is gitignored/generated and not present in the worktree
- **Fix:** Copied from main repo into worktree (untracked, gitignored — not staged)
- **Files modified:** `worker-configuration.d.ts` (worktree-local, not committed)
- **Commit:** n/a

### Pre-existing Issues (Out of Scope)

TypeScript errors in all test files (`MCP_SECRET` missing in partial mock `Env`, `CfProperties` vs `IncomingRequestCfProperties` in auth/rate-limit tests) exist identically in the main repo before any changes. The new `runtask.test.ts` errors are the same pattern. The vitest Workers pool does not use `tsc` for test files and all 145 tests run green.

## Known Stubs

None — the test file asserts real behavior through real implementations; no stubs or TODOs.

## Threat Flags

None — this is a test-only addition. No new network endpoints, auth paths, or external surface introduced.

## Self-Check

- `test -f src/__tests__/runtask.test.ts` — FOUND
- Commit `e39b8cd` — FOUND
- `buildPrompt` count in test: 25 (>= 11 required)
- `.toBe(` count in test: 30 (>= 11 required)
- `INPUT_TOO_LARGE` present: FOUND
- `8001` and `8000` both present: FOUND
- `git diff --stat src/index.ts` — no change

## Self-Check: PASSED
