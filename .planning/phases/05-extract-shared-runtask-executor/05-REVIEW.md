---
phase: 05-extract-shared-runtask-executor
reviewed: 2026-06-26T01:16:00Z
depth: standard
files_reviewed: 2
files_reviewed_list:
  - src/index.ts
  - src/__tests__/runtask.test.ts
findings:
  critical: 0
  warning: 3
  info: 3
  total: 6
status: issues_found
---

# Phase 05: Code Review Report

**Reviewed:** 2026-06-26T01:16:00Z
**Depth:** standard
**Files Reviewed:** 2
**Status:** issues_found

## Summary

This phase extracted a shared `runTask(env, kind, input)` executor plus a `TASK_SPECS`
dispatch map out of the 11 AI-backed tool handlers, and added a byte-equality
snapshot test (`runtask.test.ts`, 37 tests, all passing).

The refactor is well-executed and behavior-preserving in the dimensions that matter
most. I compared every `buildPrompt` against the pre-refactor inline prompt build
(`git show 3db80d1`) and confirmed byte-identity for all 11 tasks. The `transformCode`
8KB cap, `ValidationError` path, and the `INPUT_TOO_LARGE` envelope are reproduced
exactly (including the AI_ERROR `error_type` on the over-cap log, which is preserved
verbatim from the original). The `explainCode` depth→tier→maxTokens routing matches
the original (`detailed` → standard/4096, else fast/2048), including the undefined-depth
default. The snapshot test does genuinely guard against prompt drift: each assertion
pins an exact string, so any whitespace/wording change fails the suite.

No correctness regressions or security issues found. The findings below are all
maintainability/robustness concerns introduced (or left unaddressed) by the refactor's
incomplete consolidation — chiefly that `tier` is still duplicated between the new
`resolve()` source-of-truth and each handler's log call, which reintroduces exactly the
drift the extraction was meant to eliminate.

Out of scope per instructions: the `worker-configuration.d.ts` dual-`Env` type friction
(`tsc --noEmit` reports TS2345 on the test files; confirmed all such errors trace to the
dual-Env issue, not to the phase-05 code).

## Warnings

### WR-01: `tier` is duplicated between `resolve()` and every handler's log call — reintroduces the drift the refactor removed

**File:** `src/index.ts` — `resolve()` definitions (e.g. 236, 248, 293, 300-306) vs. log calls (e.g. 415, 439, 545)
**Issue:** The extraction made `TASK_SPECS[kind].resolve(input)` the single source of truth for the tier that the *actual AI call* uses (`runTask` → `runAIWithMetrics(env, tier, ...)`, lines 386-391). But each handler still hardcodes a *second*, independent `tier` literal solely for logging:

```typescript
// explainCode handler (542-546)
const result = await runTask(env, "explainCode", { code, depth });
const tier: ModelTier = depth === "detailed" ? "standard" : "fast";  // re-derived, NOT from resolve()
logToolInvocation({ tool: "explainCode", tier, ... });
```

```typescript
// generateCode handler (414-415)
const result = await runTask(env, "generateCode", { prompt, context, language, style });
logToolInvocation({ tool: "generateCode", tier: "standard", ... });  // hardcoded literal
```

These two tier sources can silently diverge: a future edit to a `resolve()` (e.g. bumping `reviewCode` to `fast`) changes the executed tier but leaves the logged tier stale, producing logs that lie about which model tier actually ran. This is precisely the class of duplication the runTask extraction was supposed to eliminate, and it is *not* covered by the snapshot test (the snapshot only asserts `buildPrompt` and `resolve` outputs, never that the handler's logged tier equals `resolve().tier`).

**Fix:** Make the resolved tier flow back to the caller so the log uses the same value the AI call used. Add `tier` to `AIResult` and have `runTask`/`runAIWithMetrics` populate it:

```typescript
interface AIResult { text: string; model: string; tier: ModelTier; latency_ms: number; }

async function runTask(env: Env, kind: TaskKind, input: Record<string, unknown>): Promise<AIResult> {
  const spec = TASK_SPECS[kind];
  spec.validate?.(input);
  const { tier, maxTokens } = spec.resolve(input);
  const r = await runAIWithMetrics(env, tier, spec.buildPrompt(input), maxTokens);
  return { ...r, tier };
}
```

Then every handler logs `tier: result.tier` and the second derivation is deleted (most impactful for `explainCode`, which currently re-implements the depth branch).

### WR-02: `runTask` throws unvalidated-kind / spec lookup with no guard

**File:** `src/index.ts:386-391`
**Issue:** `runTask` does `const spec = TASK_SPECS[kind]; spec.validate?.(input);`. `kind` is typed as `TaskKind`, but the function is an exported public API (`export { runTask }`, line 871) and the test suite already calls it with a runtime cast (`runTask(env, "generateCode" as TaskKind, ...)`, test line 300). If any caller passes a string that is not a real key (typo, future tool name, deserialized value), `spec` is `undefined` and the next line throws `TypeError: Cannot read properties of undefined (reading 'validate')` — an uncaught error type that the handler catch blocks map to a generic `AI_ERROR`, masking the real "unknown task kind" cause.
**Fix:** Add an explicit guard so a bad kind fails loudly and is classified correctly:

```typescript
const spec = TASK_SPECS[kind];
if (!spec) throw new Error(`INTERNAL_ERROR: unknown task kind "${kind}"`);
spec.validate?.(input);
```

(Or have callers map this to `INTERNAL_ERROR` rather than `AI_ERROR`.)

### WR-03: Snapshot suite does not lock the handler tail (logging + error mapping), so the stated invariant is only half-guarded

**File:** `src/__tests__/runtask.test.ts` (whole file)
**Issue:** The phase goal is that "the 11 handler tails must keep byte-identical logging + error-mapping." The snapshot suite thoroughly pins `buildPrompt` and `resolve` (the `TASK_SPECS` half), and the `transformCode` over-cap envelope is asserted end-to-end through `getToolHandler`. But for the other 10 handlers there is no test asserting that (a) a successful call logs `tool_invocation` with the correct `tier`, or (b) a thrown `AI_TIMEOUT` vs. generic error maps to the right `error_type` and `makeToolError` envelope. WR-01's silent-divergence risk is invisible to the current suite precisely because of this gap. A `buildPrompt` change is caught; a tier-log regression or an error-mapping regression is not.
**Fix:** Add a small parameterized handler-tail test using the existing `getToolHandler` + `createMockEnv` plumbing: for each tool, (1) assert a success path returns `{ content: [...] }` with no `isError`, and (2) inject an AI that throws `new Error("AI_TIMEOUT")` and assert the returned envelope equals `makeToolError("AI_TIMEOUT", tool)`. This closes the loop on the "byte-identical error-mapping" invariant.

## Info

### IN-01: `ValidationError` carries a sentinel message string that is never read

**File:** `src/index.ts:276`
**Issue:** `throw new ValidationError("INPUT_TOO_LARGE", { codeBytes })` sets `.message = "INPUT_TOO_LARGE"`, but the handler that catches it (lines 466-476) builds the user-facing text entirely from `err.meta?.codeBytes` and constants — it never reads `err.message`. The sentinel string is dead data and could mislead a future maintainer into thinking the message is surfaced.
**Fix:** Either surface `err.message` in the response, or pass a descriptive human message (e.g. `\`transformCode input ${codeBytes} bytes exceeds ${TRANSFORM_CODE_MAX_BYTES}\``) so the thrown error is self-describing in stack traces/logs.

### IN-02: `(err.meta?.codeBytes as number)` cast can silently fall through to a recompute

**File:** `src/index.ts:467`
**Issue:** `const codeBytes = (err.meta?.codeBytes as number) ?? new TextEncoder().encode(code).byteLength;`. The `as number` cast is unchecked; if `meta` ever lacked `codeBytes` the `??` fallback recomputes from `code`, which is correct but obscures the contract. Low risk today because `validate` always sets `codeBytes`, but the cast defeats type-checking on the `meta` bag.
**Fix:** Type `TaskSpec.validate`'s thrown meta, or read with a typed narrowing (`typeof err.meta?.codeBytes === "number" ? err.meta.codeBytes : ...`).

### IN-03: Test reaches into SDK internals (`_registeredTools`) — already flagged in-file, noting for completeness

**File:** `src/__tests__/runtask.test.ts:8-14`
**Issue:** `getToolHandler` reads `(server as any)._registeredTools[toolName].handler`, a private MCP SDK field. The file already documents this with a warning comment (lines 6-7), so this is informational: an SDK update can break the two `transformCode` envelope tests with a cryptic "Tool not registered" or undefined-handler error.
**Fix:** No change required now; if the SDK exposes a public handler accessor in a future version, migrate to it. Keep the existing warning comment.

---

_Reviewed: 2026-06-26T01:16:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
