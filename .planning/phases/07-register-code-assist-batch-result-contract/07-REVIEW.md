---
phase: 07-register-code-assist-batch-result-contract
reviewed: 2026-06-26T00:00:00Z
depth: standard
files_reviewed: 2
files_reviewed_list:
  - src/index.ts
  - src/__tests__/batch-tool.test.ts
findings:
  critical: 0
  warning: 5
  info: 4
  total: 9
status: issues_found
---

# Phase 7: Code Review Report

**Reviewed:** 2026-06-26
**Depth:** standard
**Files Reviewed:** 2
**Status:** issues_found

## Summary

Reviewed the phase-07 diff that registers the `code_assist_batch` MCP tool in
`src/index.ts`: the `BatchTaskInputSchema`, the discriminated-union
`BatchOutputSchema`, `deriveErrorType()`, the `runBatch()` enrichment closure
bridging `executeBatch` (src/batch.ts) to the partial-results contract, and the
tool registration with Zod input/output schemas plus MCP annotations. Also
reviewed the new `src/__tests__/batch-tool.test.ts`.

The implementation is structurally sound: failure isolation is delegated to the
already-tested pure engine, the discriminated union is well-formed, results are
order-preserving, and the all-ok / mixed / registration paths have test
coverage. Production code type-checks clean.

No BLOCKER-class defects were found. The findings below are all correctness-
adjacent robustness and contract-fidelity issues, plus maintainability concerns.
The two issues most worth fixing before this ships are the `maxTasks` /
Zod-`.max(50)` divergence (WR-01, which silently breaks the documented
`BATCH_MAX_TASKS` override and swallows the actionable over-cap message) and the
duplicated enrichment logic in the test (WR-05, which means the tests cannot
catch drift in the very function they purport to validate).

## Warnings

### WR-01: `BATCH_MAX_TASKS` config override is dead above 50 and yields an opaque error below 50

**File:** `src/index.ts:752-765, 812-820` (interacts with `src/batch.ts:120-126`)
**Issue:** The Zod input schema hard-caps `tasks` at `.max(50)`, while
`runBatch` reads `cfg.maxTasks` from `BATCH_MAX_TASKS` (default 50) and
`executeBatch` independently throws when `tasks.length > cfg.maxTasks`. These
two limits are not reconciled:

- If an operator raises `BATCH_MAX_TASKS` (the comment in `batch.ts:36-37`
  explicitly invites paid-plan users to do this, e.g. 1000), the Zod `.max(50)`
  still rejects any batch over 50 at the input boundary. The documented override
  is silently inert — a contract/usability defect.
- If an operator *lowers* `BATCH_MAX_TASKS` (e.g. 10) and a caller submits 30
  tasks, Zod accepts (≤50) but `executeBatch` throws. That throw is caught by the
  handler at `src/index.ts:842-848` and flattened to a generic
  `INTERNAL_ERROR` ("An internal error occurred... Please retry."). The
  actionable engine message ("Batch has N tasks but the per-call limit is M.
  Split it into smaller batches.") is discarded, and "Please retry" is
  misleading because retrying the same payload will fail identically.

**Fix:** Make the Zod cap track the configured limit, or at minimum surface the
over-cap condition as a distinct, non-retryable error instead of
`INTERNAL_ERROR`. Since the Zod `.max()` must be a static literal, the cleanest
option is to drop the hardcoded `.max(50)` and let `executeBatch` be the single
source of truth, returning its message verbatim:

```typescript
} catch (err) {
  const msg = err instanceof Error ? err.message : "";
  if (/per-call limit/.test(msg)) {
    logToolError({ tool: "code_assist_batch", error_type: "AI_ERROR", input_size_bytes: 0 });
    return {
      content: [{ type: "text" as const, text: `[ERROR: BATCH_TOO_LARGE] ${msg}` }],
      isError: true as const,
    };
  }
  logToolError({ tool: "code_assist_batch", error_type: "AI_ERROR", input_size_bytes: 0 });
  return makeToolError("INTERNAL_ERROR", "code_assist_batch");
}
```

### WR-02: `deriveErrorType` substring match misclassifies AI errors that merely contain "timeout"

**File:** `src/index.ts:445-450`
**Issue:** `deriveErrorType` does an unanchored `msg.includes("timeout")` over the
lowercased error message and returns `"timeout"` for any match. The only intended
"timeout" source is the engine's `"Task exceeded {ms}ms timeout"` string. But the
real AI error path (`callModel`) and upstream Workers AI failures can produce
messages that legitimately contain the word "timeout" without being a batch
wall-clock timeout — e.g. `"connection timeout to upstream"` or a 524 surfaced as
text. Those would be mislabeled `timeout`, and worse, would then fall into the
WR-04 latency-derivation branch and silently report `latency_ms: 0` (no
`exceeded (\d+)ms` match) while the caller believes the task timed out.
**Fix:** Anchor the timeout detection on the exact engine sentinel rather than a
loose substring, and keep `AI_TIMEOUT` (the `callModel` abort sentinel) as a
separate explicit check:

```typescript
function deriveErrorType(errMsg: string): "timeout" | "validation" | "ai_error" {
  if (/exceeded \d+ms timeout/i.test(errMsg) || /\bAI_TIMEOUT\b/i.test(errMsg)) return "timeout";
  const msg = errMsg.toLowerCase();
  if (msg.includes("input_too_large") || msg.includes("validationerror")) return "validation";
  return "ai_error";
}
```

### WR-03: Batch with all (or some) tasks failing still logs a successful invocation, never `logToolError`

**File:** `src/index.ts:829-841`
**Issue:** The handler only reaches `logToolError` when `runBatch` *throws*
(over-cap or unexpected). Because the engine isolates failures, a batch in which
every single task fails still returns normally, so the handler logs
`logToolInvocation({ tool: "code_assist_batch", ..., latency_ms: 0 })` and never
records the failures. Observability is blind to partial and total in-batch
failure — the failure counts live only in `structuredContent`, which is not
logged. For a fan-out tool whose whole value proposition is partial failure, this
is the metric that matters most.
**Fix:** After computing `structured`, emit a `logToolError` (or a structured
failure metric) when `structured.failed > 0`, including the failed count:

```typescript
const structured = await runBatch(tasks);
if (structured.failed > 0) {
  logToolError({ tool: "code_assist_batch", error_type: "AI_ERROR", input_size_bytes: structured.failed });
}
logToolInvocation({ tool: "code_assist_batch", tier: "standard", model: "mixed", latency_ms: 0 });
```
(Reusing `input_size_bytes` for a failure count is itself a smell — prefer adding
a dedicated field to the logger if the signature allows.)

### WR-04: `latency_ms` on error results is fabricated, not measured — misleading contract field

**File:** `src/index.ts:781-791`
**Issue:** On the error path, `latency_ms` is derived from the timeout message
(`parseInt` of the *configured* timeout, e.g. 45000) or hardcoded to `0` for all
other failures. The output schema (`TaskResultErrorSchema`, line 433) presents
`latency_ms: z.number()` with no indication it is synthetic. A caller reading
`latency_ms: 45000` will believe the task ran for 45s when in fact it may have
failed at 200ms (e.g. a connection refused that happened to be wrapped by
`withTimeout` only nominally); a caller reading `latency_ms: 0` on a real AI error
will believe it failed instantly. Neither reflects measured wall time, because
`executeBatch`/`runTask` do not surface elapsed time on the failure path.
**Fix:** Either (a) document the field as best-effort and rename to
`approx_latency_ms` in the error variant, or (b) measure actual elapsed time in
the enrichment by timing around `executeBatch` per task. Given the engine does
not currently return per-task timing on failure, the low-cost fix is to make the
schema honest:

```typescript
// in TaskResultErrorSchema
latency_ms: z.number().describe("Best-effort: configured timeout on timeout, 0 otherwise. Not measured."),
```

### WR-05: Test re-implements `runBatch` enrichment instead of exercising it — cannot catch production drift

**File:** `src/__tests__/batch-tool.test.ts:28-73`
**Issue:** The `enrich()` helper in the test is a hand-copied duplicate of the
enrichment block inside `runBatch` (`src/index.ts:769-804`). The BATCH-07 and
BATCH-08 suites validate `enrich()`, not the production `runBatch`. If someone
changes the real enrichment (e.g. fixes WR-04's latency derivation, or alters the
summary string), these tests keep passing against the stale copy and give false
confidence — the file's own docstring claims it "mirrors the enrichment logic
exactly," but nothing enforces that mirror. Only the BATCH-09 "handler returns
structuredContent" test (line 213) actually drives `runBatch` via the registered
handler.
**Fix:** Either export `runBatch` (or a pure `enrichBatchResult(raw)` helper
extracted from it) and import it in the test so both call sites share one
implementation, or route the BATCH-07/08 assertions through `getToolHandler(env,
"code_assist_batch")` against a mocked AI the way BATCH-09 does. Extracting a pure
`enrichBatchResult` is the cleaner refactor and removes the duplication entirely.

## Info

### IN-01: `void msg` is dead code; the caught error is captured then discarded

**File:** `src/index.ts:843, 846`
**Issue:** `const msg = err instanceof Error ? err.message : ""` is assigned and
then explicitly thrown away with `void msg`. The message is never logged or
inspected, so the assignment exists only to be voided. This also discards
genuinely useful diagnostic text (e.g. the over-cap message from WR-01).
**Fix:** Remove both lines, or — preferably, tied to WR-01 — actually use `msg`
to branch/log. If kept purely for a future hook, a comment explaining why is
better than `void`.

### IN-02: `getToolHandler` mock-env / `Env` typing relies on test-harness identity cast

**File:** `src/__tests__/batch-tool.test.ts:15`
**Issue:** `getToolHandler(env: Env, ...)` references the global `Env` and the
SDK-internal `_registeredTools` via `(server as any)`. This is the same tolerated
test-harness `Env`/`Request` identity pattern already present in
`runtask.test.ts`, and per the review instructions it is out of scope as a
defect. Noted only for completeness — the `as any` SDK-internals access is
explicitly guarded by the WARNING comment on lines 13-14, which is good practice.
**Fix:** None required; the guarding comment is the right mitigation. Consider a
shared `getToolHandler` test util to avoid re-deriving it per test file.

### IN-03: `kind` widened to `z.string()` in output schema loses the enum guarantee

**File:** `src/index.ts:419, 428`
**Issue:** Input `kind` is a strict `z.enum([...11 kinds])`, but both output
result schemas type `kind` as bare `z.string()`. Since `kind` is copied verbatim
from the input task, the output could safely reuse the same enum and give
consumers a stronger contract. Not a bug (the value is always valid), purely a
lost type-narrowing opportunity.
**Fix:** Extract the 11-kind enum to a shared `const TaskKindEnum = z.enum([...])`
and reuse it for `BatchTaskInputSchema.kind` and both result schemas' `kind`.

### IN-04: Over-cap message claims "Please retry" for a deterministically non-retryable failure

**File:** `src/index.ts:847` (via `makeToolError` `INTERNAL_ERROR`, line 197)
**Issue:** When `executeBatch` throws the per-call-limit error, the handler
returns `INTERNAL_ERROR` whose text ends with "Please retry." Retrying the same
oversized batch will fail identically, so the guidance is wrong. This is the
caller-facing symptom of WR-01.
**Fix:** Addressed by the WR-01 fix (distinct non-retryable `BATCH_TOO_LARGE`
message). Listed separately as the user-visible wording defect.

---

_Reviewed: 2026-06-26_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
