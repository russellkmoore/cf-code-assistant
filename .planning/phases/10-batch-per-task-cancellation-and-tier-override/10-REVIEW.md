---
phase: 10-batch-per-task-cancellation-and-tier-override
reviewed: 2026-06-29T18:58:25Z
depth: standard
files_reviewed: 5
files_reviewed_list:
  - src/index.ts
  - src/batch.ts
  - src/__tests__/batch-tool.test.ts
  - src/__tests__/runtask.test.ts
  - src/__tests__/tool-handlers.test.ts
findings:
  critical: 1
  warning: 3
  info: 1
  total: 5
status: issues_found
---

# Phase 10: Code Review Report

**Reviewed:** 2026-06-29T18:58:25Z
**Depth:** standard
**Files Reviewed:** 5
**Status:** issues_found

## Summary

Phase 10 added two features to the batch engine: real `AbortSignal` threading into `env.AI.run` (BATCH-F01) and per-task tier override (BATCH-F03). The overall architecture is sound — the `withTimeout` / `callModel` dual-signal design avoids double-settle and unhandled rejections, and the tier-override precedence (`opts.tier ?? r.tier`) is correctly wired at every level.

However, there is one correctness bug affecting `latency_ms` on timeout results, one behavioral bug in the pre-abort (`externalSignal.aborted === true`) fast-path that makes recovery rely on Workers AI runtime behavior rather than the code itself, and two secondary issues around the `timeoutPromise` listener and the missing `maxTokens` cap validation for tier-overridden tasks.

---

## Critical Issues

### CR-01: Pre-aborted external signal causes `timeoutPromise` to never settle; function hangs if AI runtime ignores `signal.aborted`

**File:** `src/index.ts:144-165`

**Issue:** When `externalSignal` is already aborted on entry, the code calls `controller.abort()` on line 145, *before* `timeoutPromise` is constructed on line 150. By the time `controller.signal.addEventListener("abort", ...)` runs inside the `timeoutPromise` constructor (line 151), the abort event has already fired. The Web `AbortSignal` specification does not retroactively re-fire the `"abort"` event for late-added listeners — the listener is registered but never invoked. `timeoutPromise` therefore remains permanently pending (neither resolves nor rejects).

The `Promise.race([aiPromise, timeoutPromise])` then resolves only when `aiPromise` settles. Whether the already-aborted signal passed to `env.AI.run` causes that promise to reject immediately is entirely a Workers AI runtime detail — the mock test at `tool-handlers.test.ts:203-226` only passes because the mock AI explicitly checks `opts?.signal?.aborted`. The real `env.AI.run` binding behavior on a pre-aborted signal is undocumented and may not reject immediately.

**Reproduction path:**

```
batchTask submitted → withTimeout fires its timer first →
ctrl.abort() on withTimeout's controller → adapter's runTask gets an already-aborted signal →
callModel receives externalSignal.aborted=true →
controller.abort() called on line 145 →
timeoutPromise constructor runs at line 150 — abort event already consumed →
timeoutPromise NEVER settles →
callModel blocks on Promise.race until aiPromise settles (potentially never if AI hangs)
```

**Fix:** Move `timeoutPromise` construction *before* the `externalSignal` linkage, or use `AbortSignal.any()` (if available in the Workers runtime), or check `controller.signal.aborted` synchronously inside the `timeoutPromise` constructor:

```typescript
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

// Link external signal BEFORE constructing timeoutPromise so the
// abort event is guaranteed to fire after the listener is registered.
if (externalSignal?.aborted) {
  controller.abort();
} else {
  externalSignal?.addEventListener("abort", () => controller.abort(), { once: true });
}

const timeoutPromise = new Promise<never>((_, reject) => {
  // Use controller.signal.aborted check to handle the already-aborted case
  // synchronously: listener may never fire if abort already occurred.
  if (controller.signal.aborted) {
    reject(new Error("AI_TIMEOUT"));
    return;
  }
  controller.signal.addEventListener("abort", () => {
    reject(new Error("AI_TIMEOUT"));
  }, { once: true });
});
```

---

## Warnings

### WR-01: `latency_ms` is always `0` for internal-timeout failures in batch results

**File:** `src/index.ts:794-795`

**Issue:** The batch result enrichment extracts `latency_ms` from the error message using `entry.error.match(/exceeded (\d+)ms timeout/)`. This regex matches the `withTimeout` rejection format (`"Task exceeded 45000ms timeout"`), but when `callModel`'s own internal 45s timer fires first, it rejects with `"AI_TIMEOUT"` (line 152). That string does not match the regex, so `latency_ms` is set to `0` for any timeout where `callModel` races `withTimeout`.

Since both timers default to the same 45000ms, which one fires first is a race. In production, callers observing a timeout result see `latency_ms: 0` instead of `45000`, making latency telemetry meaningless for the most common timeout path.

```typescript
// Current — fails when callModel's internal "AI_TIMEOUT" wins the race
const timeoutMatch = entry.error.match(/exceeded (\d+)ms timeout/);
const latency_ms = timeoutMatch ? parseInt(timeoutMatch[1], 10) : 0;

// Fix — add fallback for the AI_TIMEOUT string case
const timeoutMatch = entry.error.match(/exceeded (\d+)ms timeout/);
const latency_ms = timeoutMatch
  ? parseInt(timeoutMatch[1], 10)
  : entry.error.toUpperCase().includes("AI_TIMEOUT")
    ? cfg.taskTimeoutMs   // use the configured timeout as the latency
    : 0;
```

Alternatively, have `callModel` re-throw with a structured error object that includes elapsed time, instead of relying on regex parsing of the message string.

### WR-02: `timeoutPromise` abort listener registered without `{ once: true }` — paired with missing cleanup path

**File:** `src/index.ts:151-153`

**Issue:** The listener on `controller.signal` inside `timeoutPromise` is registered without `{ once: true }`:

```typescript
controller.signal.addEventListener("abort", () => {
  reject(new Error("AI_TIMEOUT"));
});
```

`AbortController` can only abort once, so the practical risk of double-rejection is zero. However, on the **success path** (aiPromise resolves before the timeout), the `timeoutPromise` is left permanently pending with a live listener on `controller.signal`. The `controller` is local and will be GC'd, but the listener prevents early GC and the pending `timeoutPromise` creates an orphaned promise chain. In a Workers isolate that runs many requests before recycling, these accumulate as garbage.

**Fix:** Add `{ once: true }` to match the defensive pattern used on the external signal listener at line 147:

```typescript
controller.signal.addEventListener("abort", () => {
  reject(new Error("AI_TIMEOUT"));
}, { once: true });
```

For the orphaned-promise concern, move to `AbortSignal.any()` or use a structured `Promise.race` where both branches self-clean.

### WR-03: Tier override with incompatible `maxTokens` is not validated — silently sends oversized `max_tokens` to fast-tier models

**File:** `src/index.ts:397-403`

**Issue:** `runTask` applies the tier override but always uses `r.maxTokens` from the spec:

```typescript
const tier = opts.tier ?? r.tier;
return runAIWithMetrics(env, tier, spec.buildPrompt(input), r.maxTokens, opts.signal);
```

A batch caller can override `generateCode` (spec: `maxTokens: 8192`) to run on the `fast` tier model (`@cf/qwen/qwen3-30b-a3b-fp8`). The fast model's actual context limit depends on the quantization — sending `max_tokens: 8192` to it may cause a Workers AI 400 error or silent truncation, both of which surface as `ai_error` in the batch result with no indication of the cause.

There is no validation that the overridden tier's model supports the spec's `maxTokens`. The `BatchTaskInputSchema` accepts the override without warning.

**Fix:** Either document this as a caller responsibility (and note it in the schema description), or add a per-tier cap table:

```typescript
const TIER_MAX_TOKENS: Record<ModelTier, number> = {
  fast: 4096,    // qwen3-30b-a3b-fp8 practical safe ceiling
  standard: 8192,
};

const tier = opts.tier ?? r.tier;
const maxTokens = Math.min(r.maxTokens, TIER_MAX_TOKENS[tier]);
return runAIWithMetrics(env, tier, spec.buildPrompt(input), maxTokens, opts.signal);
```

---

## Info

### IN-01: `readBatchConfig` env-variable env vars (`BATCH_CONCURRENCY`, `BATCH_MAX_TASKS`, `BATCH_TASK_TIMEOUT_MS`) are not declared in the `Env` interface

**File:** `src/index.ts:764`

**Issue:** `readBatchConfig(env as unknown as Record<string, string | undefined>)` relies on a double cast to pass environment bindings as arbitrary string variables. The `Env` interface does not include `BATCH_CONCURRENCY`, `BATCH_MAX_TASKS`, or `BATCH_TASK_TIMEOUT_MS`. If an operator sets these in `wrangler.toml [vars]` to tune the pool, TypeScript won't catch a typo (e.g., `BATCH_CONCURENCY`) — the cast bypasses the type system entirely and `readBatchConfig` silently uses defaults.

**Fix:** Add the optional vars to the `Env` interface:

```typescript
interface Env {
  AI: Ai;
  OAUTH_KV: KVNamespace;
  MCP_SECRET: string;
  AUTH_RATE_LIMITER: RateLimit;
  // Optional batch-pool tuning (set in wrangler.toml [vars])
  BATCH_CONCURRENCY?: string;
  BATCH_MAX_TASKS?: string;
  BATCH_TASK_TIMEOUT_MS?: string;
}
```

Then remove the double cast: `readBatchConfig(env)`.

---

_Reviewed: 2026-06-29T18:58:25Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
