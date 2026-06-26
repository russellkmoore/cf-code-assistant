---
phase: 07-register-code-assist-batch-result-contract
verified: 2026-06-26T09:03:00Z
status: passed
score: 6/6 must-haves verified
has_blocking_gaps: false
re_verification: false
---

# Phase 07: Register code_assist_batch + Result Contract — Verification Report

**Phase Goal:** `code_assist_batch` is wired into `createMcpServer` as the repo's first structured-output tool, returning an order-preserving partial-results contract that parses against its declared output schema.
**Verified:** 2026-06-26T09:03:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Each task returns `{id,index,kind,status:'ok',result,latency_ms}` or `{id,index,kind,status:'error',error,error_type,latency_ms}` with `error_type ∈ {timeout,validation,ai_error}`; per-task input is open record validated per-kind inside `runTask` | VERIFIED | `TaskResultOkSchema` and `TaskResultErrorSchema` at `src/index.ts:417-434`; `error_type: z.enum(["timeout","validation","ai_error"] as const)` at line 432; `input: z.record(z.string(), z.unknown())` at line 412 (two-arg form); `deriveErrorType` at lines 445-450; `runTask` dispatch at lines 388-393 with `spec.validate?.(input)` inside |
| 2 | The batch envelope carries `total`, `succeeded`, `failed`, `failedIds`, and a human-readable `summary` string alongside the structured results | VERIFIED | `BatchOutputSchema` at `src/index.ts:436-443` declares all five fields; `runBatch` at lines 795-803 computes `failedIds` by filtering error results and builds `summary` string with both all-ok and mixed formats |
| 3 | `code_assist_batch` returns `structuredContent` AND a `content` text summary together, declares Zod input + output schemas (`result: z.unknown()`, `as const` status literals), and sets annotations `readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:true` | VERIFIED | Handler at `src/index.ts:829-841` returns `{ content: [{ type: "text", text: structured.summary }], structuredContent: structured }`; `outputSchema: BatchOutputSchema` at line 821; `result: z.unknown()` at line 422; `status: z.literal("ok")` at line 421; all four annotations at lines 822-827 confirmed present and correct |
| 4 | A unit test parses real `executeBatch` output (all-ok AND mixed) against `BatchOutputSchema` and both pass; the tool inherits the existing OAuth gate by registering in the same `createMcpServer` | VERIFIED | `src/__tests__/batch-tool.test.ts` lines 80-148: two `BatchOutputSchema.parse()` tests (all-ok and mixed) both call `expect(() => BatchOutputSchema.parse(enriched)).not.toThrow()`; tool registered at `src/index.ts:807` inside `createMcpServer`, before `return server` at line 852; full suite 161/161 passes |
| 5 | Per-task input is an open record validated per-kind INSIDE `runTask` (not a discriminated union at the MCP boundary) | VERIFIED | `input: z.record(z.string(), z.unknown())` at `src/index.ts:412-414` — two-argument form, no discriminated union on `kind` at boundary; per-kind validation happens inside `runTask` via `spec.validate?.(input)` at line 390 |
| 6 | `code_assist_batch` is registered inside `createMcpServer` and inherits the existing OAuth gate (no new unauthenticated entrypoint) | VERIFIED | Registration at `src/index.ts:807-850` is inside `createMcpServer` function body; `return server` at line 852 is the function's only return; `OAuthProvider` wraps `createMcpServer` at lines 1036-1049 — same gate as all other tools |

**Score:** 6/6 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/index.ts` | `BatchTaskInputSchema`, `BatchOutputSchema`, `deriveErrorType`, `runBatch`, `code_assist_batch` registration; both exported | VERIFIED | All six identifiers present; `BatchOutputSchema` and `deriveErrorType` exported at line 1031 |
| `src/__tests__/batch-tool.test.ts` | Output-schema parse tests (all-ok + mixed), `error_type` derivation, `failedIds`, `summary`, `registration`, `structuredContent`, `annotations`; min 80 lines | VERIFIED | 252 lines; all 8 named test cases present |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/index.ts code_assist_batch` handler | `executeBatch` (`src/batch.ts`) | `runBatch` wrapper injecting `runTask` adapter | VERIFIED | `runBatch` at lines 752-805 calls `executeBatch(tasks, cfg, adapter)` at line 765 |
| `src/index.ts runBatch` | `BatchOutputSchema`-conformant `structuredContent` | result enrichment (`latency_ms`, `error_type`, `failedIds`, `summary`) | VERIFIED | `deriveErrorType(entry.error)` at line 789; `failedIds` at lines 795-797; `summary` at lines 799-803; `structuredContent: structured` at line 840 |
| `src/__tests__/batch-tool.test.ts` | `BatchOutputSchema.parse` | `import { BatchOutputSchema } from "../index"` | VERIFIED | Import at `batch-tool.test.ts:4`; `BatchOutputSchema.parse(enriched)` at lines 95-97 and 128-130 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `code_assist_batch` handler | `structured` (batch output) | `runBatch(tasks)` → `executeBatch` → per-task `runTask(env, kind, input)` → `runAIWithMetrics` | Yes — wraps real AI call chain; `AIResult.text` and `AIResult.latency_ms` extracted in ok-path enrichment | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| All 8 batch-tool tests pass | `npx vitest run src/__tests__/batch-tool.test.ts` | `Tests 8 passed (8)` | PASS |
| Full 161-test suite passes (no regressions) | `npm test` | `Tests 161 passed (161)`, `Test Files 11 passed (11)` | PASS |
| `src/batch.ts` untouched | `git diff --stat src/batch.ts` | No output (no changes) | PASS |
| Two-arg `z.record` form used | `grep "z.record" src/index.ts` | `z.record(z.string(), z.unknown())` at line 412 | PASS |
| `outputSchema: BatchOutputSchema` present | `grep "outputSchema: BatchOutputSchema" src/index.ts` | Match at line 821 | PASS |
| `structuredContent: structured` on success path | `grep "structuredContent: structured" src/index.ts` | Match at line 840 | PASS |
| Both `BatchOutputSchema` and `deriveErrorType` in named export block | `grep -n` on line 1031 | Both present in single export block at line 1031 | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| BATCH-07 | `07-01-PLAN.md` | Per-task result contract `{id,index,kind,status,result\|error,error_type,latency_ms}` | SATISFIED | `TaskResultOkSchema` + `TaskResultErrorSchema` + `deriveErrorType` in `src/index.ts`; BATCH-07 describe block with all-ok + mixed parse tests |
| BATCH-08 | `07-01-PLAN.md` | Batch summary with `total`, `succeeded`, `failed`, `failedIds`, human-readable text | SATISFIED | `BatchOutputSchema` includes all five fields; `runBatch` computes and returns them; BATCH-08 describe block tests `failedIds` order and summary text format |
| BATCH-09 | `07-01-PLAN.md` | `code_assist_batch` registered with Zod input+output schemas, `structuredContent`, four annotations | SATISFIED | Tool registered at `src/index.ts:807-850` with `outputSchema: BatchOutputSchema`, all four annotations, co-returns `structuredContent`; BATCH-09 describe block tests registration, structuredContent, and annotations |

**Note on BATCH-10:** BATCH-10 (end-to-end MCP Inspector verification) maps to Phase 8 per REQUIREMENTS.md traceability table. It is not a Phase 7 requirement and is not expected here.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/index.ts` | 835 | `model: "mixed"` placeholder in `logToolInvocation` | Info | Semantic placeholder satisfying type; per SUMMARY.md decision log, per-task model observability is deferred to a future phase. Not a stub — batch logging is intentionally coarser-grained. No TBD/FIXME/XXX debt markers present. |

No `TBD`, `FIXME`, or `XXX` debt markers found in modified files.

### Human Verification Required

None. All success criteria are programmatically verifiable and confirmed.

### Gaps Summary

No gaps. All six must-have truths are VERIFIED, all artifacts pass all three levels (exists, substantive, wired) plus Level 4 data-flow trace, all three requirement IDs (BATCH-07, BATCH-08, BATCH-09) are satisfied, and the full 161-test suite is green with no regressions.

---

_Verified: 2026-06-26T09:03:00Z_
_Verifier: Claude (gsd-verifier)_
