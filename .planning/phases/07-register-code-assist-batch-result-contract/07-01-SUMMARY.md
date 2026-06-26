---
phase: 07-register-code-assist-batch-result-contract
plan: "01"
subsystem: mcp-tool-registration
tags: [batch, zod-schemas, structured-output, mcp-tool, result-contract]
dependency_graph:
  requires: [06-batch-core-bounded-pool-timeout, 05-extract-shared-runtask-executor]
  provides: [code_assist_batch MCP tool, BatchOutputSchema, deriveErrorType]
  affects: [src/index.ts, src/__tests__/batch-tool.test.ts]
tech_stack:
  added: []
  patterns: [registerTool with outputSchema + annotations, structuredContent co-return, Zod discriminated union, runBatch enrichment wrapper]
key_files:
  created: [src/__tests__/batch-tool.test.ts]
  modified: [src/index.ts]
decisions:
  - "Log once per batch at the tool level (not per task) to avoid perturbing observability.test.ts invocation counts"
  - "deriveErrorType uses case-insensitive .toLowerCase() to catch both 'AI_TIMEOUT' and 'Task exceeded Xms timeout'"
  - "runBatch declared as nested async function inside createMcpServer to close over env without parameter threading"
  - "latency_ms=0 for non-timeout error results (timing lost at executeBatch boundary; acceptable per A1 assumption)"
metrics:
  duration_minutes: 3
  completed_date: "2026-06-26"
  tasks_completed: 2
  tasks_total: 2
  files_created: 1
  files_modified: 1
---

# Phase 07 Plan 01: Register code_assist_batch + Result Contract — Summary

**One-liner:** Zod-validated `code_assist_batch` MCP tool with `structuredContent` output, enrichment wrapper deriving `latency_ms`/`error_type`/`failedIds`/`summary` from raw `executeBatch` output, and full BATCH-07/08/09 test coverage (161 tests green).

## What Was Built

### Task 1 — `src/index.ts` additions

- **Imports:** Added `import { executeBatch, readBatchConfig } from "./batch"` and `import type { BatchTask, RunTask } from "./batch"` after the logger import.
- **BatchTaskInputSchema:** `z.object` with `z.enum([...11 TaskKind values...] as const)` for `kind` and `z.record(z.string(), z.unknown())` for `input` (two-argument Zod v4 form — single-argument form crashes at runtime).
- **BatchOutputSchema:** `z.object` with discriminated union `z.discriminatedUnion("status", [TaskResultOkSchema, TaskResultErrorSchema])`. Ok variant: `result: z.unknown()`, `latency_ms: z.number()`. Error variant: `error_type: z.enum(["timeout","validation","ai_error"] as const)`, `latency_ms: z.number()`.
- **`deriveErrorType(errMsg)`:** Case-insensitive substring match — "timeout"/"ai_timeout" → "timeout", "input_too_large"/"validationerror" → "validation", else "ai_error".
- **`runBatch(rawTasks)`:** Nested async function inside `createMcpServer` (closes over `env`). Calls `readBatchConfig` → builds `RunTask` adapter wrapping `runTask` → maps tasks with `id ?? String(i)` → calls `executeBatch` → enriches: ok-path extracts `(result as AIResult).text` and `.latency_ms`; error-path parses timeout ms from `/exceeded (\d+)ms timeout/` else 0, derives `error_type`. Computes `failedIds` and `summary`.
- **`code_assist_batch` registration:** `server.registerTool(...)` with `outputSchema: BatchOutputSchema`, `annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }`. Handler: try → `runBatch(tasks)` → returns `{ content: [{ type: "text", text: structured.summary }], structuredContent: structured }` with single `logToolInvocation` at batch level; catch → `makeToolError("INTERNAL_ERROR", "code_assist_batch")` (isError:true skips outputSchema validation). Inserted before `return server`.
- **Named export block:** Extended with `BatchOutputSchema, deriveErrorType` on the single value-export line.

### Task 2 — `src/__tests__/batch-tool.test.ts` (new file, 252 lines)

Tests anchored to requirement IDs:

- **BATCH-07:** `all-ok batch parses against BatchOutputSchema` — verifies all 2 tasks succeed, `latency_ms === 100`, `result === "generated output"`, schema parse does not throw. `mixed batch (ok + error + timeout) parses against BatchOutputSchema` — verifies `error_type` "ai_error" and "timeout" classified correctly, `latency_ms` parsed from timeout message. `error_type derivation matches expected values` — all four message patterns.
- **BATCH-08:** `failedIds contains the IDs of all error results in order` — bad1, bad2 in order. `summary text reflects succeeded/failed counts` — "2/2 tasks succeeded." and mixed summary contains counts and IDs.
- **BATCH-09:** `code_assist_batch is registered in createMcpServer` — `_registeredTools["code_assist_batch"]` defined. `handler returns structuredContent alongside content text` — invokes handler with mock env, asserts both `content` array and `structuredContent` with `BatchOutputSchema.parse(sc)` succeeding. `annotations are readOnlyHint:false destructiveHint:false idempotentHint:false openWorldHint:true` — reads annotations from registered tool.

## Test Results

```
Test Files  11 passed (11)
     Tests  161 passed (161)   ← 153 existing + 8 new
  Duration  2.28s
```

All -t filter commands from VALIDATION.md Per-Task Verification Map: `all-ok`, `mixed`, `error_type`, `failedIds`, `summary`, `registration`, `structuredContent`, `annotations` — each passes with 1 test (others skipped).

## Deviations from Plan

### Auto-added items

**1. [Rule 2 - Missing functionality] Generated worker-configuration.d.ts before type-checking**
- **Found during:** Task 1 verification
- **Issue:** `npx tsc --noEmit` returned `Cannot find type definition file for './worker-configuration.d.ts'` — the file was missing from the worktree (pre-existing gap, not caused by our changes)
- **Fix:** Ran `npm run types` to generate it via `wrangler types`
- **Files modified:** `worker-configuration.d.ts` (generated, not staged — gitignored)
- **Commit:** Not committed (auto-generated file)

**2. [Rule 2 - Observability] logToolInvocation call uses `model: "mixed"` placeholder**
- **Found during:** Task 1 implementation
- **Issue:** The existing `logToolInvocation` signature requires `model: string` but batch tasks use per-kind models that vary. The RESEARCH.md and PATTERNS.md both confirm logging once at batch level with succeeded/failed counts, not per task.
- **Fix:** Used `model: "mixed"` as a semantic placeholder string to satisfy the type while communicating the multi-model nature. Per-task model observability is deferred to a future phase per STATE.md Deferred Items.
- **Files modified:** `src/index.ts`

### Out of scope (deferred)

None discovered.

## Known Stubs

None. All data sources are wired: `runBatch` calls the real `executeBatch` (which calls the real `runTask` adapter through the mock in tests); `BatchOutputSchema` is fully declared and exported.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries beyond what was planned in the threat model. `code_assist_batch` is registered inside `createMcpServer` (inherits the existing `OAuthProvider` gate — T-7-02 mitigated). The `z.record(z.string(), z.unknown())` open boundary defers per-kind validation into `runTask` (T-7-01 mitigated by existing `TASK_SPECS[kind].validate?`). DoS bounded by `max(50)` inputSchema cap + `executeBatch` pre-dispatch cap (T-7-03 mitigated). `structuredContent` validated by SDK automatically (T-7-04 mitigated).

## Self-Check: PASSED

```
FOUND: src/index.ts (modified)
FOUND: src/__tests__/batch-tool.test.ts (created)
FOUND: f362f19 (task 1 commit)
FOUND: 284bc9f (task 2 commit)
FOUND: BatchOutputSchema in named export block
FOUND: deriveErrorType in named export block
FOUND: z.record(z.string(), z.unknown()) — two-arg form
FOUND: outputSchema: BatchOutputSchema in registerTool
FOUND: structuredContent: structured in handler return
FOUND: openWorldHint: true in annotations
FOUND: src/batch.ts — zero changes (git diff --stat shows nothing)
FOUND: 161 tests passing, 0 failures
```
