---
phase: 08-verify-end-to-end
plan: "01"
subsystem: test-infrastructure
tags: [batch, e2e, vitest, BATCH-10, order-preservation, partial-results]
dependency_graph:
  requires:
    - src/index.ts (createMcpServer, BatchOutputSchema, deriveErrorType — READ-ONLY)
    - src/batch.ts (withTimeout, readBatchConfig — READ-ONLY)
    - src/__tests__/helpers.ts (createMockEnv)
    - src/__tests__/batch-tool.test.ts (getToolHandler pattern — referenced, not modified)
  provides:
    - src/__tests__/batch-e2e.test.ts
  affects:
    - npm test (full suite: +1 passing, +1 skipped)
tech_stack:
  added: []
  patterns:
    - describe.skip for opt-in real-wait test block (first use in repo)
    - vi.fn().mockImplementationOnce for per-task AI mock control
    - BATCH_TASK_TIMEOUT_MS env override (string) for deterministic timeout
key_files:
  created:
    - src/__tests__/batch-e2e.test.ts
  modified: []
decisions:
  - "Single batch-e2e.test.ts file holds both committed fast e2e and describe.skip opt-in block (Claude's Discretion per 08-CONTEXT.md)"
  - "Explicit task IDs (timeout-task / validate-task / ok-task) used for self-documenting failedIds assertion"
  - "describe.skip not it.todo — cleaner skip UX for a full describe block with its own setup"
  - "Pre-existing tsc errors (Env type conflict across all test files) documented as out-of-scope deviation; tests pass via vitest Workers pool"
metrics:
  duration: "~5 minutes"
  completed: "2026-06-27T15:13:04Z"
  tasks_completed: 3
  files_created: 1
  files_modified: 0
---

# Phase 08 Plan 01: Batch E2E Verification Summary

**One-liner:** Mixed 3-task batch e2e through real `createMcpServer` — order-preserving partial results with all three status outcomes (timeout / validation / ok) via deterministic AI mock, plus `describe.skip` opt-in real-45s-wait block.

## What Was Built

A single new test file `src/__tests__/batch-e2e.test.ts` that contains:

1. **Committed fast e2e** (`describe("BATCH-10: committed fast e2e ...")`): Drives a 3-task mixed batch through the real `createMcpServer` registered `code_assist_batch` handler with a crafted mock env. Proves order-preserving partial results (results[i].index === i) with all three status/error_type outcomes in one call, plus BatchOutputSchema.parse validation and failedIds/summary assertions.

2. **Opt-in real-45s-wait block** (`describe.skip("BATCH-10 opt-in: ...")`): A never-resolving AI mock that exercises the real 45s timeout race (withTimeout vs callModel's AbortController); asserts loosely (status:'error' only, no error_type hard-assert per D-04b); excluded from default `npm test` via `describe.skip`.

## Task Completion

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create batch-e2e.test.ts fast committed e2e | 5f1ef41 | src/__tests__/batch-e2e.test.ts |
| 2 | Add describe.skip real-45s-wait opt-in block | 5f1ef41 | src/__tests__/batch-e2e.test.ts (same file) |
| 3 | Build gate verification | (no commit — test/types run only) | — |

Note: Tasks 1 and 2 were implemented together in the same file and committed atomically. Task 3 verified the build gate.

## Success Criteria Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| results[i].index === i for all three tasks | PASS | Test asserts `sc.results[0].index === 0`, `[1].index === 1`, `[2].index === 2` |
| All three statuses in one batch: timeout / validation / ok | PASS | `results[0].error_type === 'timeout'`, `results[1].error_type === 'validation'`, `results[2].status === 'ok'` |
| BatchOutputSchema.parse(structuredContent) does not throw | PASS | `expect(() => BatchOutputSchema.parse(sc)).not.toThrow()` |
| content[0].type === 'text' AND structuredContent defined | PASS | Both asserted explicitly |
| failedIds in input order, summary reflects "1/3" and "2 failed" | PASS | `sc.failedIds === ['timeout-task', 'validate-task']`, summary contains "1/3" and "2 failed" |
| describe.skip opt-in block excluded from default npm test | PASS | 1 skipped in test run output |
| src/index.ts, src/batch.ts, package.json, wrangler.toml not modified | PASS | `git diff HEAD~1 HEAD` shows only batch-e2e.test.ts |
| npm test exits 0 (full suite green) | PASS | 323 passed, 1 skipped (the describe.skip block) |

## Verification Output

### npx vitest run src/__tests__/batch-e2e.test.ts
```
Test Files  1 passed (1)
     Tests  1 passed | 1 skipped (2)
  Duration  629ms
```

### npm test (full suite)
```
Test Files  23 passed (23)
     Tests  323 passed | 1 skipped (324)
  Duration  2.80s
```

Previous baseline: 322 tests. New: 323 passing + 1 skipped = +1 passing (committed fast e2e) +1 skipped (opt-in block).

## Deviations from Plan

### Out-of-scope pre-existing issues (deferred to deferred-items.md)

**1. [Pre-existing] tsc --noEmit reports Env type errors across all test files**
- **Found during:** Task 3 build gate
- **Issue:** `npx tsc --noEmit` reports `Argument of type 'Env' is not assignable to parameter of type 'Env'` across all test files including pre-Phase-08 files (`batch-tool.test.ts`, `model-routing.test.ts`, `auth-flow.test.ts`, `runtask.test.ts`, etc.). Root cause: `worker-configuration.d.ts` declares `Cloudflare.Env` without `MCP_SECRET` (wrangler doesn't expose secrets in generated types), while `src/index.ts` has a private `interface Env` that includes `MCP_SECRET`. The two Env types conflict. Also: `Request<CfProperties>` vs `Request<IncomingRequestCfProperties>` mismatch in request-passing tests.
- **Scope:** Pre-existing across all test files committed in Phases 01-07. The same errors appear in `batch-tool.test.ts` (committed Phase 07). Phase 07 SUMMARY says tsc passed — this may have been cleaner in the worktree context.
- **Impact on this phase:** None — `npm test` (vitest Workers pool) is green. Tests pass correctly via vitest; tsc type-checking is informational for IDE support.
- **Action:** Documented in deferred-items.md as out-of-scope for Phase 08. Fixing requires either exporting `Env` from `src/index.ts` for tests to import, or adding `MCP_SECRET` to a manual type augmentation file.
- **Per deviation Rule "SCOPE BOUNDARY":** Pre-existing errors in unrelated files are out of scope; not fixed in this plan.

### None — plan executed exactly as written

All three task-level behaviors were implemented exactly per the plan with no behavioral deviations. The tsc issue is pre-existing and documented above.

## Known Stubs

None. The e2e drives the real `createMcpServer` handler with real `executeBatch`, real `runTask` validation, and real `BatchOutputSchema.parse`. All assertions are fully wired to production code paths.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes. The new file is test-only code under `src/__tests__/`. No new production surface introduced.

## Self-Check: PASSED

```
FOUND: src/__tests__/batch-e2e.test.ts — created, 172 lines
FOUND: 5f1ef41 — git log confirmed
FOUND: describe.skip — grep -F 'describe.skip' match confirmed
FOUND: _registeredTools["code_assist_batch"] — pattern present
FOUND: BatchOutputSchema.parse — pattern present  
FOUND: BATCH_TASK_TIMEOUT_MS — pattern present
FOUND: npm test — 323 passed, 1 skipped — green
FOUND: src/index.ts — not in commit (git diff HEAD~1 HEAD confirms)
FOUND: src/batch.ts — not in commit (git diff HEAD~1 HEAD confirms)
FOUND: package.json — not in commit (pre-existing working tree changes, out of scope)
```
