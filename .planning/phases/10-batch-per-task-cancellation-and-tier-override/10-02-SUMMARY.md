---
phase: 10-batch-per-task-cancellation-and-tier-override
plan: "02"
subsystem: test-suite
tags: [batch, abort-signal, tier-override, tests, nyquist]
dependency_graph:
  requires: ["10-01"]
  provides: [F01-signal-threading-tests, F03-tier-override-tests, F03-schema-tests, F03-adapter-flow-tests]
  affects: [src/__tests__/tool-handlers.test.ts, src/__tests__/runtask.test.ts, src/__tests__/batch-tool.test.ts, src/index.ts]
tech_stack:
  added: []
  patterns:
    - Signal-honoring vi.fn mock (custom env.AI.run that inspects AiOptions.signal)
    - BatchTaskInputSchema.safeParse accept/reject pattern for enum allowlist testing
    - Adapter-flow integration test (executeBatch + runTask-backed adapter)
key_files:
  created: []
  modified:
    - src/__tests__/tool-handlers.test.ts
    - src/__tests__/runtask.test.ts
    - src/__tests__/batch-tool.test.ts
    - src/index.ts
decisions:
  - Export BatchTaskInputSchema as a value export (consistent with BatchOutputSchema already there) to enable schema accept/reject test
  - Use argument-agnostic createMockEnv for signal-threading test (spy on mock.calls[0][2].signal); build custom signal-honoring mock only for the pre-abort test
  - Assert maxTokens equality via two separate env instances (before/after override) to avoid inter-test coupling
metrics:
  duration: "3m"
  completed: "2026-06-29"
  tasks_completed: 3
  files_changed: 4
  commits: 2
---

# Phase 10 Plan 02: BATCH-F01/F03 Nyquist Tests Summary

Six Nyquist Wave-0 tests proving BATCH-F01 (AbortSignal threading) and BATCH-F03 (per-task tier override), with full-suite regression gate confirming 7 named suites stay green.

## What Was Built

### Task 1: BATCH-F01 tests — signal threading + pre-aborted abort (tool-handlers.test.ts)

Added `describe("BATCH-F01: AbortSignal threading", ...)` to `tool-handlers.test.ts` with two tests:

**"signal":** Calls `runTask(env, "quickTask", ...)` using the standard `createMockEnv` AI mock, then asserts `env.AI.run.mock.calls[0][2]?.signal instanceof AbortSignal`. This proves `callModel` passes `{ signal: controller.signal }` as the 3rd AiOptions argument to every `env.AI.run` call.

**"abort":** Builds a custom env whose `AI.run` is a `vi.fn` that inspects its 3rd argument and throws `Error("AI_ABORTED")` when `opts?.signal?.aborted` is true. Creates an `AbortController`, calls `controller.abort()` BEFORE dispatch, then asserts `runTask(env, "quickTask", input, { signal: controller.signal })` rejects. This proves the external signal reaches `env.AI.run` and the abort path works end-to-end.

Also added `runTask` to the import from `"../index"` in this file.

### Task 2: BATCH-F03 tests — tier override + maxTokens + schema + adapter flow

**runtask.test.ts — `describe("BATCH-F03: per-task tier override", ...)`:**

Three tests:
- "tier" (override): `runTask(env, "generateCode", input, { tier: "fast" })` → `result.model === DEFAULT_MODELS.fast`
- "tier" (default): `runTask(env, "generateCode", input)` → `result.model === DEFAULT_MODELS.standard`
- "maxTokens": Two separate env instances (one without override, one with `tier:"fast"`) both yield `env.AI.run.mock.calls[0][1].max_tokens === 8192` — the kind's budget, not tier-derived.

Added `vi` to the import in this file.

**batch-tool.test.ts — `describe("BATCH-F03: tier override + schema", ...)`:**

Three tests:
- "schema" (accept): `BatchTaskInputSchema.safeParse({ kind:"generateCode", input:{}, tier:"fast" }).success === true`; same for `tier:"standard"`
- "schema" (reject): `BatchTaskInputSchema.safeParse({ ..., tier:"premium" }).success === false`; same for `"turbo"`
- "tier" (adapter flow): Builds a `runTask`-backed adapter mirroring the `runBatch` wiring, runs `executeBatch([{ kind:"generateCode", tier:"fast", input:{prompt:"hi"} }], stdCfg, adapter)`, and asserts `raw.results[0].result.model === DEFAULT_MODELS.fast`.

Also added `BatchTaskInputSchema`, `runTask`, and `DEFAULT_MODELS` to the import from `"../index"`.

**src/index.ts:** Added `BatchTaskInputSchema` to the value export list (line 1044), enabling the schema accept/reject test. Consistent with the existing `BatchOutputSchema` export already there.

### Task 3: Full-suite regression gate

- `npx tsc --noEmit`: exits 0 — production sources type-check clean
- `npm test`: 12 test files, **173 passed** (165 baseline + 8 new), 1 skipped — all 7 named regression suites green

## Commits

| Task | Commit | Type | Description |
|------|--------|------|-------------|
| 1 | d986119 | test | BATCH-F01 AbortSignal threading tests |
| 2 | 0e9c169 | test | BATCH-F03 tier override + schema + adapter flow tests |
| 3 | — | (gate only) | No code changes; type-check + npm test verified green |

## Verification Results

- `npx vitest run src/__tests__/tool-handlers.test.ts -t "signal"`: 2 passed (AbortSignal suite filter)
- `npx vitest run src/__tests__/tool-handlers.test.ts -t "abort"`: 1 passed
- `npx vitest run src/__tests__/tool-handlers.test.ts`: 40 passed (38 existing + 2 new)
- `npx vitest run src/__tests__/runtask.test.ts -t "tier"`: 8 passed (2 new tier tests + existing tier-related)
- `npx vitest run src/__tests__/runtask.test.ts -t "maxTokens"`: 5 passed (1 new + existing snapshots)
- `npx vitest run src/__tests__/batch-tool.test.ts -t "schema"`: 6 passed
- `npx vitest run src/__tests__/batch-tool.test.ts -t "tier"`: 3 passed
- `npx tsc --noEmit`: exits 0
- `npm test`: 12/12 files, 173 tests passed, 1 skipped

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] BatchTaskInputSchema not exported**
- **Found during:** Task 2 (schema accept/reject test needs `import { BatchTaskInputSchema } from "../index"`)
- **Issue:** The `<schema_export_note>` in the plan predicted this: `BatchTaskInputSchema` existed in index.ts (from Plan 01) but was not in the value export list on line 1044.
- **Fix:** Added `BatchTaskInputSchema` to the export list alongside the existing `BatchOutputSchema`. This is a test-support export, not a behavioral change.
- **Files modified:** src/index.ts
- **Commit:** 0e9c169

**2. [Rule 3 - Blocking] vi import missing in runtask.test.ts**
- **Found during:** Task 2 (maxTokens test uses `vi.fn` cast)
- **Issue:** `vi` was not imported in runtask.test.ts. The new test uses `(env.AI.run as ReturnType<typeof vi.fn>).mock.calls`.
- **Fix:** Added `vi` to the vitest import.
- **Files modified:** src/__tests__/runtask.test.ts
- **Commit:** 0e9c169

**3. [Rule 3 - Blocking] worker-configuration.d.ts + node_modules missing in worktree**
- **Found during:** Pre-flight setup (same deviation as Plan 01)
- **Issue:** Worktree had no node_modules and no worker-configuration.d.ts (gitignored).
- **Fix:** Copied worker-configuration.d.ts from main repo; symlinked node_modules from main repo to worktree. Neither is committed (both gitignored).
- **Files modified:** worker-configuration.d.ts (untracked), node_modules (symlink, untracked)
- **Commit:** N/A (gitignored)

## Known Stubs

None. All changes are test additions and a single export line — no placeholder values or hardcoded stubs.

## Threat Surface Scan

No new external attack surface. Changes are test files and a single export of an existing internal constant (`BatchTaskInputSchema`). The export does not expose the schema at runtime — it is only importable in the test environment.

| Threat | Status |
|--------|--------|
| T-10-04: regression of F01/F03 security behavior | Mitigated — 8 new tests committed as gates |
| T-10-SC: no new package installs | Confirmed — vitest + Workers pool already present |

## Self-Check: PASSED

Files modified:
- src/__tests__/tool-handlers.test.ts: FOUND (committed d986119)
- src/__tests__/runtask.test.ts: FOUND (committed 0e9c169)
- src/__tests__/batch-tool.test.ts: FOUND (committed 0e9c169)
- src/index.ts: FOUND (committed 0e9c169)

Commits verified:
- d986119: test(10-02): BATCH-F01 AbortSignal threading tests — FOUND
- 0e9c169: test(10-02): BATCH-F03 tier override + schema + adapter flow tests — FOUND

Production type-check gate: npx tsc --noEmit exits 0
Test suite: 12/12 files passed, 173 tests green (165 baseline + 8 new)
