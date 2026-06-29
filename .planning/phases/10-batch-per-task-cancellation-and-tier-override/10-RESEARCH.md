# Phase 10: Batch per-task cancellation and tier override - Research

**Researched:** 2026-06-29
**Domain:** Cloudflare Workers AI binding (AbortSignal threading) + MCP batch fan-out routing
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
The full implementation approach is **locked** and sourced from the user's plan file
(`~/.claude/plans/encapsulated-painting-hedgehog.md`, Changes 2 & 3). The phase resolves two
deferred v2.0 requirements, both confined to the batch fan-out path. **Single-task tool handlers
must remain behavior-identical.**

**Change 2 — BATCH-F01 (real AbortSignal into `env.AI.run`):**
- `callModel` (src/index.ts:133): add 5th param `externalSignal?: AbortSignal`. Link it to the
  existing internal `controller`: if `externalSignal?.aborted` → `controller.abort()`, else
  `externalSignal?.addEventListener("abort", () => controller.abort(), { once: true })`. Pass the
  controller's signal to the AI call: `env.AI.run(model, { messages, max_tokens }, { signal: controller.signal })`.
  Keep the existing `timeoutPromise` race and `finally { clearTimeout }` exactly as-is.
- `runAIWithMetrics` (src/index.ts:177): add optional trailing `signal?: AbortSignal`, forward to
  `callModel`. **`runAI` (src/index.ts:185) is untouched** — not on the batch path.
- Single-task handlers unchanged.

**Change 3 — BATCH-F03 (per-task tier override, tier-only):**
- `runTask` (src/index.ts:389): change signature to
  `runTask(env, kind, input, opts: { tier?: ModelTier; signal?: AbortSignal } = {})`.
  Body: `const tier = opts.tier ?? r.tier`; keep the kind's `maxTokens`; forward `opts.signal`.
- `BatchTaskInputSchema` (src/index.ts:398): add
  `tier: z.enum(["fast", "standard"]).optional().describe(...)`. No new validation.
- `BatchTask` interface (src/batch.ts:48): add `tier?: ModelTier`.
- Task mapping (src/index.ts:760): carry `tier: t.tier` into the mapped `BatchTask`.
- Batch adapter (src/index.ts:757): change `(batchTask, _signal) => ...` to
  `(batchTask, signal) => runTask(env, batchTask.kind, batchTask.input, { tier: batchTask.tier, signal })`.
  This single line wires **both** F01 (signal) and F03 (tier).

### Claude's Discretion
- Exact test file placement/naming (F01 new file vs. extend an existing suite).
- How the `ModelTier` type is shared into `src/batch.ts` (import vs. local duplicate — match the
  existing `TaskKind` precedent already in the file).
- Plan/wave decomposition. F01 and F03 share the `runTask` signature and the batch adapter line, so
  they are tightly coupled and likely belong in one wave / coordinated plans.

### Deferred Ideas (OUT OF SCOPE)
- **BATCH-F02** (internal per-task retry with backoff) — stays deferred.
- Raw per-task `model` override (string at the MCP boundary) — rejected in favor of tier-only.
- A third "premium" tier — rejected; keeps tier names/tests stable.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BATCH-F01 | Thread a real `AbortSignal` into `env.AI.run()` so a timed-out batch task stops spending its subrequest (currently best-effort: the orphaned call runs to completion). | `AiOptions.signal?: AbortSignal` confirmed at worker-configuration.d.ts:9491; `withTimeout` already builds an `AbortController` and passes `.signal` to the injected `RunTask` (src/batch.ts:102-114); adapter currently ignores it via `_signal` (src/index.ts:757). The change is "stop ignoring the signal already in hand" + link it to `callModel`'s internal controller. |
| BATCH-F03 | Tier-only per-task override (`fast` \| `standard`) in the batch input, reusing the allowlist/KV abstraction. | Phase 9 made tiers resolve to different models (`fast`=qwen3-30b, `standard`=kimi-k2.5, src/index.ts:24-27); the zod enum at the boundary + `tier→resolveModel→allowlist` makes an invalid tier impossible without new validation code. |
</phase_requirements>

## Summary

This is a **validation pass over an already-authored, line-level plan**, not a design exercise. I
re-anchored every line number the plan cites against live source and confirmed the plan is factually
correct on all six investigation points. The two changes are tightly coupled — they share the
`runTask` signature change and converge on a **single adapter line** (src/index.ts:757) that wires
both the `AbortSignal` (F01) and the `tier` override (F03) through the existing
`executeBatch`/`withTimeout` machinery that Phase 6 already built. The pure batch engine in
`src/batch.ts` was designed for exactly this: `withTimeout` constructs the `AbortController`, races a
wall-clock timeout, and hands `.signal` to the injected runTask — the adapter has been throwing that
signal away (`_signal`) since v2.0.

The single highest-risk question for the test suite — "does adding a 3rd `options` argument to
`env.AI.run` break the mocks?" — resolves cleanly to **no**. Every mock in the suite uses
`vi.fn(async () => ({ response }))` style implementations that ignore all arguments, and every
`RunTask` test stub uses a 2-param `(_task, _signal)` signature that already ignores the signal.
Passing a third arg or a populated signal changes nothing observable for the existing 142 tests. The
batch-e2e hanging-mock tests (the most delicate) also ignore the new arg; the wall-clock race still
fires identically, so the `status:"error"`/`error_type:"timeout"` assertions stay green.

One factual correction to flag (does not change the approach): the plan and CONTEXT reference some
test filenames that **do not exist** in the repo (`callmodel.test.ts`, and CONTEXT's
"batch-tool.test.ts or runtask.test.ts" is fine but it also lists a nonexistent split). The real
suite is 12 files under `src/__tests__/`. New tests should extend `tool-handlers.test.ts` (F01) and
`runtask.test.ts` / `batch-tool.test.ts` (F03), or add one new file — Claude's discretion per CONTEXT.

**Primary recommendation:** Execute the plan as written. F01 + F03 belong in one wave (shared
`runTask` signature, shared adapter line). The verification anchor is the adapter line at
src/index.ts:757. Add F01 threading-proof and F03 tier-override tests; keep all 142 existing tests
green by leaning on the fact that the mocks are argument-agnostic.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Per-task abort signal → `env.AI.run` | API / Backend (Worker) | — | The Workers AI subrequest lives in the Worker; cancellation is a binding-level concern owned by `callModel`. |
| Per-task tier override resolution | API / Backend (Worker) | — | Tier→model resolution (`resolveModel` + KV allowlist) is server-owned; the MCP boundary only accepts a constrained enum. |
| Batch fan-out / timeout / partial results | API / Backend (pure engine `src/batch.ts`) | — | Already-built env-free engine; this phase only changes what the injected adapter does with the signal it is handed. |
| Input validation of `tier` | API / Backend (zod at MCP boundary) | — | `z.enum(["fast","standard"])` at `BatchTaskInputSchema` is the validation boundary — no raw model strings ever cross it. |

## Standard Stack

No new dependencies. This phase is a pure internal change to existing TypeScript on the Cloudflare
Workers runtime, using primitives already in the codebase and the Web Platform.

### Core (already present)
| Library / Primitive | Version | Purpose | Why Standard |
|---------------------|---------|---------|--------------|
| `AbortController` / `AbortSignal` | Web Platform (Workers runtime) | Cancellation token threaded into `env.AI.run` | Native; already used in `callModel` (src/index.ts:139) and `withTimeout` (src/batch.ts:103). `[VERIFIED: codebase grep]` |
| Workers AI binding `Ai.run` | `@cloudflare/workers-types` (generated `worker-configuration.d.ts`) | 3rd `options` arg accepts `signal?: AbortSignal` | `AiOptions.signal?: AbortSignal` present at worker-configuration.d.ts:9491; `run<...>(model, inputs, options?: Options)` at :9543. `[VERIFIED: worker-configuration.d.ts:9491,9543]` |
| `zod` | per package.json | `z.enum(["fast","standard"])` for the new `tier` field | Already the schema lib for `BatchTaskInputSchema`. `[VERIFIED: codebase grep src/index.ts:398-416]` |
| `vitest` + `@cloudflare/vitest-pool-workers` | per package.json | Test runner (Workers pool) | Existing test infra; 142 tests across 12 files. `[VERIFIED: codebase grep src/__tests__/]` |

**Installation:** None. `npm test` and `npx tsc --noEmit` are the only commands needed.

## Package Legitimacy Audit

**N/A — this phase installs no external packages.** It is a pure internal refactor of existing
`src/index.ts` and `src/batch.ts`, plus new test cases against the existing vitest infra. No npm
`install` step exists in the plan; slopcheck/registry verification is not applicable.

## Architecture Patterns

### System Architecture Diagram

```
code_assist_batch  (MCP tool, src/index.ts:808)
      │  tasks: [{ kind, input, tier? }, ...]   ← NEW: optional tier (zod enum)
      ▼
   runBatch(rawTasks)  (closure over env, src/index.ts:753)
      │  map → BatchTask[] { id, kind, input, tier? }   ← NEW: carry tier
      ▼
   executeBatch(tasks, cfg, adapter)  (pure, src/batch.ts:119)
      │  bounded pool (mapWithConcurrency, default 6 in-flight)
      ▼
   withTimeout(taskTimeoutMs, run)  (src/batch.ts:102)
      │  new AbortController()  ← ALREADY EXISTS
      │  setTimeout → ctrl.abort() + reject("Task exceeded Nms timeout")
      │  run(ctrl.signal)  ← passes signal to adapter
      ▼
   adapter(batchTask, signal)  (src/index.ts:757)   ← CHANGE: stop ignoring signal
      │  runTask(env, kind, input, { tier: batchTask.tier, signal })   ← F01 + F03 here
      ▼
   runTask(env, kind, input, opts)  (src/index.ts:389)   ← CHANGE: opts.tier, opts.signal
      │  tier = opts.tier ?? spec.resolve(input).tier      ← F03 override
      │  runAIWithMetrics(env, tier, prompt, maxTokens, opts.signal)   ← keep kind's maxTokens
      ▼
   runAIWithMetrics(env, tier, prompt, maxTokens, signal?)  (src/index.ts:177)  ← CHANGE: forward signal
      │  model = resolveModel(env, tier)  → KV allowlist / self-heal (unchanged)
      ▼
   callModel(env, model, prompt, maxTokens, externalSignal?)  (src/index.ts:133)  ← CHANGE
      │  internal controller (45s) — UNCHANGED
      │  link externalSignal → controller.abort()   ← F01 plumbing
      │  env.AI.run(model, {messages, max_tokens}, { signal: controller.signal })  ← F01 effect
      ▼
   Workers AI subrequest  (now actually cancelled on timeout, not merely raced)

Single-task handlers (generateCode, etc.) call runTask(env, kind, input)  → opts = {}  → behavior identical.
```

### Component Responsibilities

| File:Line | Component | Current | After Phase 10 |
|-----------|-----------|---------|----------------|
| src/index.ts:133 | `callModel` | 4 params; internal 45s `controller`; `env.AI.run(model, {messages, max_tokens})` — no 3rd arg | +5th `externalSignal?`; links to `controller`; `env.AI.run(..., { signal: controller.signal })` |
| src/index.ts:177 | `runAIWithMetrics` | 4 params | +trailing `signal?`, forward to `callModel` |
| src/index.ts:185 | `runAI` | wraps `runAIWithMetrics` | **UNTOUCHED** (not on batch path) |
| src/index.ts:389 | `runTask` | `(env, kind, input)` | `(env, kind, input, opts = {})`; `tier = opts.tier ?? r.tier`; forward `opts.signal` |
| src/index.ts:398 | `BatchTaskInputSchema` | `{ id?, kind, input }` | +`tier: z.enum(["fast","standard"]).optional()` |
| src/index.ts:757 | adapter | `(batchTask, _signal) => runTask(env, kind, input)` | `(batchTask, signal) => runTask(env, kind, input, { tier: batchTask.tier, signal })` |
| src/index.ts:760 | task mapping | `{ id, kind, input }` | +`tier: t.tier` |
| src/batch.ts:48 | `BatchTask` | `{ id?, kind, input }` | +`tier?: ModelTier` |

### Pattern: Link external signal to existing internal controller

The plan's "link externalSignal to the existing internal controller" is **literally accurate** —
verified against src/index.ts:139-146. `callModel` already builds `const controller = new AbortController()`
and a `setTimeout(() => controller.abort(), AI_TIMEOUT_MS)`. Today the controller's signal drives only
the in-process `timeoutPromise` race (lines 142-146) and is NOT passed to `env.AI.run` (line 149).
The change is two-fold:

```typescript
// Source: derived from src/index.ts:139-155 (current) + locked plan
async function callModel(
  env: Env,
  model: keyof AiModels,
  userPrompt: string,
  maxTokens: number,
  externalSignal?: AbortSignal,            // NEW
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  // NEW: fold the external (per-task batch timeout) signal into the same controller
  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("AI_TIMEOUT")));
  });

  try {
    const aiPromise = env.AI.run(model, {
      messages: [ /* system + user */ ],
      max_tokens: maxTokens,
    }, { signal: controller.signal });   // NEW: 3rd arg threads the abort
    const response = await Promise.race([aiPromise, timeoutPromise]);
    /* ...existing response parsing unchanged... */
  } finally {
    clearTimeout(timeoutId);             // UNCHANGED
  }
}
```

### Anti-Patterns to Avoid
- **Overriding `maxTokens` along with tier.** `runTask` must override **only** the tier; `maxTokens`
  stays from `spec.resolve(input)` because output size is a property of the kind, not the model.
  (Locked decision; reinforced because it's an easy mistake when refactoring the destructure.)
- **Adding redundant tier validation.** The `z.enum(["fast","standard"])` makes an invalid tier
  structurally impossible. Do not add a runtime `isAllowedTier` check — `tier→resolveModel→allowlist`
  already governs the model. (Locked decision.)
- **Touching `runAI` (src/index.ts:185) or single-task handler call sites.** They must stay
  behavior-identical. They call `runTask(env, kind, input)`; the new `opts` defaults to `{}` so
  `externalSignal` is `undefined` and `opts.tier` is `undefined`. Strict improvement only: the
  internal 45s signal now also reaches `env.AI.run`.
- **Dropping the `{ once: true }` listener option** or forgetting the `externalSignal?.aborted`
  fast-path. Without the fast-path, a pre-aborted signal never fires `abort` again (listeners only
  fire on transition), so the abort would be missed.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Per-task wall-clock cancellation | A new timeout/race wrapper in the adapter | The existing `withTimeout` in src/batch.ts:102 — it already owns the `AbortController` and the race | Re-implementing it risks the documented double-settle / unhandled-rejection trap the two-handler `.then(onResolve, onReject)` form avoids (src/batch.ts:99-101). |
| Tier validation at the MCP boundary | A custom validator/allowlist check for the `tier` field | `z.enum(["fast","standard"])` | Zod already rejects anything else before `runBatch` runs. |
| Signal cancellation primitive | A custom cancellation flag | Native `AbortController`/`AbortSignal` | Already used twice in the codebase; `env.AI.run` consumes `AbortSignal` directly. |

**Key insight:** The hard part of this phase was done in Phase 6 — the pure engine already constructs
and threads the signal. This phase is overwhelmingly "stop ignoring an argument you already have."

## Common Pitfalls

### Pitfall 1: Pre-aborted external signal silently ignored
**What goes wrong:** If you only do `externalSignal?.addEventListener("abort", ...)` and the signal is
already aborted, the listener never fires (AbortSignal fires `abort` only on the not-aborted→aborted
transition). The internal controller never aborts and the subrequest still runs.
**Why it happens:** Forgetting that an already-aborted signal does not re-emit.
**How to avoid:** Include the `if (externalSignal?.aborted) controller.abort()` fast-path (locked in
the plan). The F01 test ("pre-aborted external signal causes the call to abort") guards exactly this.
**Warning signs:** A test that pre-aborts the signal but the AI mock still gets called / resolves.

### Pitfall 2: Mock can't prove signal threading by default
**What goes wrong:** The F01 "best-effort abort" test needs the AI mock to *honor* the signal to prove
threading. The default `createMockAI` (helpers.ts:23) is `vi.fn(async () => ({ response }))` — it
ignores the 3rd arg entirely, so it cannot reject on abort.
**Why it happens:** The shared mock is intentionally argument-agnostic (which is what keeps the other
142 tests safe — see Pitfall 3).
**How to avoid:** For the F01 threading test, build a **local** AI mock whose `run` reads
`options.signal` and either (a) asserts it `instanceof AbortSignal`, or (b) rejects when
`options.signal.aborted` is true / on its `abort` event. Do not change `createMockAI` (that would
ripple into every suite). Assert via `expect(env.AI.run).toHaveBeenCalledWith(model, inputs,
expect.objectContaining({ signal: expect.any(AbortSignal) }))`.
**Warning signs:** Trying to make the global mock honor the signal and watching unrelated suites turn red.

### Pitfall 3: Assuming a 3rd `env.AI.run` arg breaks strict mock signatures (IT DOES NOT)
**What goes wrong (hypothetically):** Fear that adding `{ signal }` as a 3rd arg to `env.AI.run`
breaks mocks that were written for 2 args.
**Reality (verified):** Every AI mock is a `vi.fn` with an implementation that ignores arguments:
- `helpers.ts:25` — `run: vi.fn(async () => ({ response }))`
- `batch-e2e.test.ts:41-47` — `vi.fn().mockImplementationOnce(() => new Promise(...))` (no params read)
- `batch-e2e.test.ts:142` — `vi.fn(() => new Promise(() => {}))` (hanging; ignores args)
`vi.fn` accepts any arity; extra args are harmless. **No existing test breaks from the 3rd arg.**
**How to avoid:** Nothing required — this is a confirmed non-issue. Documented here because the
objective explicitly flagged it as the #1 regression risk; the evidence clears it.
**Warning signs:** None expected.

### Pitfall 4: `RunTask` stubs and `BatchTask` literals
**What goes wrong (hypothetically):** Adding `tier?: ModelTier` to `BatchTask` could break test
literals or `RunTask` stubs.
**Reality (verified):** `tier?` is **optional**, so every existing `BatchTask` literal in
`batch.test.ts` / `batch-tool.test.ts` / `batch-e2e.test.ts` still type-checks. Every `RunTask`
stub is `(_task, _signal) => ...` (2-param, signal ignored), unaffected by what the adapter now passes.
**Warning signs:** None expected; `npx tsc --noEmit` is the gate.

### Pitfall 5: Partial-results contract must not regress
**What goes wrong:** A real abort could, if mishandled, reject a sibling or stall the pool.
**Why it happens:** Only if abort logic leaks outside the per-task `withTimeout` scope.
**How to avoid:** The abort stays inside `callModel`'s own controller, scoped to one task's promise.
`mapWithConcurrency` + `withTimeout` isolation is unchanged. The batch-e2e order-preservation and
"one timeout doesn't abort siblings" assertions are the regression guard.
**Warning signs:** batch-e2e `sc.results[i].index === i` or `succeeded/failed` counts changing.

## Runtime State Inventory

> This phase is a code-only refactor — no renames, no stored-string migration. Inventory included for
> completeness because the objective asked for a thorough validation.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — no datastore stores a tier/signal value; KV stores model overrides under `config:model:fast`/`config:model:standard`, unchanged by this phase. | None |
| Live service config | None — no external service config references the new `tier` field. KV model-config keys are untouched. | None |
| OS-registered state | None — no OS-level registrations involved. | None |
| Secrets/env vars | Behavior knobs `BATCH_CONCURRENCY` / `BATCH_MAX_TASKS` / `BATCH_TASK_TIMEOUT_MS` already read by `readBatchConfig`; no new env var introduced. `MCP_SECRET` unchanged. | None |
| Build artifacts | `worker-configuration.d.ts` is generated by `wrangler types`; already contains `@cf/moonshotai/kimi-k2.5` (line 9464) and `AiOptions.signal` (line 9491). No regeneration required for this phase (Phase 9 already ran the types gate). | None |

**Nothing found in any category that requires a migration task** — verified by grep of `src/`,
`worker-configuration.d.ts`, and `.planning/`.

## Code Examples

### F03: `runTask` with tier override (locked shape)
```typescript
// Source: locked plan Change 3 + current runTask src/index.ts:389-394
async function runTask(
  env: Env,
  kind: TaskKind,
  input: Record<string, unknown>,
  opts: { tier?: ModelTier; signal?: AbortSignal } = {},
): Promise<AIResult> {
  const spec = TASK_SPECS[kind];
  spec.validate?.(input);
  const r = spec.resolve(input);
  const tier = opts.tier ?? r.tier;                 // override tier only
  return runAIWithMetrics(env, tier, spec.buildPrompt(input), r.maxTokens, opts.signal);
}
```

### F01 + F03: the single adapter line (the verification anchor)
```typescript
// Source: locked plan + current adapter src/index.ts:757-758
const adapter: RunTask = (batchTask, signal) =>
  runTask(env, batchTask.kind, batchTask.input, { tier: batchTask.tier, signal });
```

### F03: schema field + task mapping
```typescript
// BatchTaskInputSchema (src/index.ts:398) — add inside the z.object({...})
tier: z.enum(["fast", "standard"]).optional()
  .describe("Override the model tier for this task (defaults to the kind's tier)."),

// task mapping (src/index.ts:760)
const tasks: BatchTask[] = rawTasks.map((t, i) => ({
  id: t.id ?? String(i),
  kind: t.kind,
  input: t.input,
  tier: t.tier,            // NEW
}));
```

### F01 test: local signal-honoring AI mock (do NOT change the shared helper)
```typescript
// New test pattern — proves the signal reaches env.AI.run without touching createMockAI.
const env = createMockEnv();
(env.AI.run as any) = vi.fn(async (_model, _inputs, options) => {
  if (options?.signal?.aborted) throw new Error("aborted");
  return { response: "ok" };
});
// assert threading:
await runTask(env, "quickTask", { instruction: "x" });
expect(env.AI.run).toHaveBeenCalledWith(
  expect.anything(), expect.anything(),
  expect.objectContaining({ signal: expect.any(AbortSignal) }),
);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `fast` and `standard` both → qwen3-30b (tier abstraction bought nothing, F03 meaningless) | `fast`=qwen3-30b, `standard`=kimi-k2.5 (distinct models) | Phase 9 (shipped, commit `b917038` lineage) | Makes the F03 per-task tier override actually meaningful. `DEFAULT_MODELS` at src/index.ts:24-27 confirms the split. |
| Batch timeout = best-effort wall-clock race; orphaned `env.AI.run` runs to completion | Real `AbortSignal` threaded into `env.AI.run` so the subrequest is actually cancelled | This phase (Phase 10) | Stops paying for abandoned subrequests on timeout. |

**Deprecated/outdated:** Nothing. Note the Kimi model id: REQUIREMENTS.md MODEL-03 preferred
`@cf/moonshotai/kimi-k2.7-code` with `@cf/moonshotai/kimi-k2.5` as fallback. **Phase 9 already
resolved this to `@cf/moonshotai/kimi-k2.5`** (src/index.ts:15,26; present in
worker-configuration.d.ts:9464). Phase 10 does **not** revisit the model choice — it is settled.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| — | (none) | — | — |

**This table is empty:** Every claim in this research was verified against live source files
(`src/index.ts`, `src/batch.ts`, `worker-configuration.d.ts`, all 12 test files, `.planning/`) or
the locked CONTEXT/plan. No user confirmation needed.

## Open Questions (RESOLVED)

1. **Test file placement for F01/F03 (Claude's discretion per CONTEXT).** RESOLVED.
   - What we know: real suite is 12 files under `src/__tests__/`. The plan/CONTEXT reference a
     nonexistent `callmodel.test.ts`.
   - Resolution: extend existing suites — F01 threading in `tool-handlers.test.ts`, F03 override in
     `runtask.test.ts` (unit) + `batch-tool.test.ts` (through the adapter). One small new file is fine
     too. Either satisfies the locked decision.

2. **How `ModelTier` reaches `src/batch.ts` (Claude's discretion).** RESOLVED.
   - Correction (verified live): `ModelTier` **is already exported** at `src/index.ts:1033`
     (`export type { ModelTier, ErrorCode, AIResult, TaskKind };`). The earlier note that line 1032
     "does not list ModelTier" was wrong — disregard it.
   - Resolution: mirror the `TaskKind` precedent (src/batch.ts:16) —
     `import type { TaskKind, ModelTier } from "./index"`. No export edit needed. A local duplicate
     `type ModelTier = "fast" | "standard"` remains a zero-coupling fallback but is unnecessary.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node + npm | build/test | ✓ (project already builds) | per package.json | — |
| `wrangler types` output | `AiOptions.signal`, kimi id | ✓ already generated | worker-configuration.d.ts present | — |
| vitest + Workers pool | test suite | ✓ | per package.json | — |
| Workers AI (live) | manual MCP-Inspector verification only | ✗ at research time (costs money; not run) | — | Unit tests with mocked `env.AI` cover all automatable behavior; live run is manual + optional |

**Missing dependencies with no fallback:** None — all automatable verification runs offline against mocks.
**Missing dependencies with fallback:** Live Workers AI is only needed for the optional manual
MCP-Inspector smoke (charges money); the unit layer fully proves threading and tier selection offline.

## Validation Architecture

> `workflow.nyquist_validation` is **absent** from `.planning/config.json` → treated as **enabled**.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest + `@cloudflare/vitest-pool-workers` (Workers pool) |
| Config file | `vitest.config.*` (present; project already runs `npm test`) |
| Quick run command | `npx vitest run src/__tests__/runtask.test.ts src/__tests__/batch-tool.test.ts src/__tests__/tool-handlers.test.ts` |
| Full suite command | `npm test` (all 12 files, currently 142 it() blocks) |
| Type gate | `npx tsc --noEmit` |

### Phase Requirements → Test Map
| Req ID | Behavior (observable) | Test Type | Automated Command | File Exists? |
|--------|-----------------------|-----------|-------------------|-------------|
| BATCH-F01 | `env.AI.run` is invoked with a 3rd arg whose `signal instanceof AbortSignal` | unit (mocked env.AI) | `npx vitest run src/__tests__/tool-handlers.test.ts -t "signal"` | ❌ Wave 0 (new cases; or new file) |
| BATCH-F01 | A pre-aborted external signal causes the AI call to abort (mock honors `options.signal.aborted`) | unit (local signal-honoring mock) | `npx vitest run src/__tests__/tool-handlers.test.ts -t "abort"` | ❌ Wave 0 |
| BATCH-F01 | Single-task path unchanged: handler still returns text / AI_TIMEOUT / AI_ERROR envelopes | unit (regression guard, already passing) | `npx vitest run src/__tests__/tool-handlers.test.ts` | ✅ exists (17 cases) |
| BATCH-F01 | Timed-out batch task still yields `status:"error"`, `error_type:"timeout"`, order preserved | unit (e2e, regression guard) | `npx vitest run src/__tests__/batch-e2e.test.ts` | ✅ exists (2 cases) |
| BATCH-F03 | `runTask(env, "generateCode", input, { tier: "fast" })` resolves via the **fast** model (qwen3-30b), overriding the kind's `standard` default | unit (spy `env.AI.run` model arg or assert `result.model`) | `npx vitest run src/__tests__/runtask.test.ts -t "tier"` | ❌ Wave 0 |
| BATCH-F03 | Omitting `tier` uses the kind default (generateCode → standard/kimi) | unit | `npx vitest run src/__tests__/runtask.test.ts` | ✅ partial (existing `runTask` smoke at runtask.test.ts:296-313 already asserts default model) |
| BATCH-F03 | `maxTokens` is NOT overridden by tier (still the kind's value) | unit (spy `runAIWithMetrics`/`callModel` maxTokens arg, or behavioral) | `npx vitest run src/__tests__/runtask.test.ts -t "maxTokens"` | ❌ Wave 0 |
| BATCH-F03 | A batch task `{ kind:"generateCode", tier:"fast", input }` overrides through the adapter | unit (through `code_assist_batch` handler or `executeBatch` + adapter) | `npx vitest run src/__tests__/batch-tool.test.ts -t "tier"` | ❌ Wave 0 |
| BATCH-F03 | `BatchTaskInputSchema` accepts `tier:"fast"|"standard"` and rejects any other string | unit (zod parse) | `npx vitest run src/__tests__/batch-tool.test.ts -t "schema"` | ❌ Wave 0 |

### Existing guards that MUST stay green (regression proof)
| Suite | What it proves stays intact |
|-------|------------------------------|
| `runtask.test.ts` (37) | buildPrompt byte-equality, resolve tier/maxTokens per kind, transformCode 8KB cap, runTask default-model wiring |
| `tool-handlers.test.ts` (17) | every single-task handler returns text / AI_TIMEOUT / AI_ERROR — behavior-identical guarantee |
| `model-routing.test.ts` (12) | `isAllowedModel`, `resolveModel` (fast=qwen, standard=kimi via `DEFAULT_MODELS`), KV self-heal — asserts against constants, not literals, so unaffected |
| `batch.test.ts` (8) | pure engine: bounded concurrency, partial results, order preservation (RunTask stubs are `(_task,_signal)`) |
| `batch-tool.test.ts` (8) | output-schema parse, summary/failedIds contract, registration + annotations |
| `batch-e2e.test.ts` (2) | end-to-end timeout/validation/ok through the real handler + adapter; hanging-mock no-stall — **the F01 non-regression proof** |
| `observability.test.ts` (8) | structured logging on tier/error paths (asserts tier names, not models) |

### Sampling Rate
- **Per task commit:** quick run (the 3 touched suites) + `npx tsc --noEmit`
- **Per wave merge:** `npm test` (full 142+ green)
- **Phase gate:** full suite green before `/gsd:verify-work`; optional manual MCP-Inspector smoke
  (`npm run dev` + `npx @modelcontextprotocol/inspector` → `http://localhost:8787/mcp`): run
  `code_assist_batch` with (a) default `generateCode`, (b) same kind `tier:"fast"`, (c) a slow task;
  confirm via `wrangler tail` the two kinds log different models, the override logs qwen, the slow
  task logs `status:"error"`/`error_type:"timeout"`. (Charges money — manual, not gating.)

### Wave 0 Gaps
- [ ] F01 threading test — `env.AI.run` called with `{ signal: AbortSignal }` (extend `tool-handlers.test.ts` or new file) — covers BATCH-F01
- [ ] F01 pre-aborted-signal test — local signal-honoring mock aborts the call — covers BATCH-F01
- [ ] F03 tier-override test — `runTask(..., { tier:"fast" })` → fast model; default unchanged — covers BATCH-F03
- [ ] F03 maxTokens-preserved test — tier override does not change `maxTokens` — covers BATCH-F03
- [ ] F03 schema test — `tier` enum accept/reject — covers BATCH-F03
- [ ] F03 adapter test — batch task `tier` flows through `executeBatch`+adapter — covers BATCH-F03
- No framework install needed (vitest + Workers pool already present).

## Security Domain

> `security_enforcement` not set in config → treated as enabled. This phase adds **no new external
> attack surface**; it is internal cancellation/routing.

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Unchanged — OAuth/PIN flow untouched |
| V3 Session Management | no | Unchanged |
| V4 Access Control | no | Unchanged |
| V5 Input Validation | yes | New `tier` field is constrained by `z.enum(["fast","standard"])` at the MCP boundary — no raw model strings can cross; `tier→resolveModel→ALLOWED_MODELS` allowlist remains the model gate |
| V6 Cryptography | no | None introduced |

### Known Threat Patterns for this stack
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Arbitrary model injection via per-task override | Elevation of Privilege / Tampering | Tier-only override (no raw model strings); `z.enum` + `ALLOWED_MODELS` allowlist + KV self-heal — exactly the constraint the user locked. Raw per-task model override is explicitly OUT OF SCOPE. |
| Resource exhaustion via abandoned subrequests | Denial of Service | F01 itself is the mitigation — real `AbortSignal` cancels timed-out subrequests instead of letting them run to completion. |
| Batch fan-out amplification | Denial of Service | Unchanged existing controls: `BATCH_MAX_TASKS` per-call cap (default 50, fast-reject over cap) + `BATCH_CONCURRENCY` bounded pool (default 6). |

## Sources

### Primary (HIGH confidence)
- `worker-configuration.d.ts:9467-9492` — `AiOptions` type incl. `signal?: AbortSignal` (line 9491)
- `worker-configuration.d.ts:9543` — `Ai.run<...>(model, inputs, options?: Options)` 3-arg signature
- `worker-configuration.d.ts:9464` — `@cf/moonshotai/kimi-k2.5` present in `AiModels`
- `src/index.ts:11,13-27,133-188,237-394,398-416,453-806,1032` — all changed/adjacent code re-anchored
- `src/batch.ts:16,48,54,102-114,119-146` — `BatchTask`, `RunTask`, `withTimeout` (AbortController), `executeBatch`
- `src/__tests__/helpers.ts:23-27,42-54` — shared `createMockAI` / `createMockEnv` (argument-agnostic)
- `src/__tests__/{tool-handlers,runtask,model-routing,batch,batch-tool,batch-e2e,observability}.test.ts` — mock/stub signatures
- `.planning/REQUIREMENTS.md:39-41,49-51,86-95` — MODEL-03, BATCH-F01/F03, 2026-06-27 reopening note
- `.planning/STATE.md` — v2.0 milestone, Phase 09 complete
- `~/.claude/plans/encapsulated-painting-hedgehog.md` — locked source plan (Changes 2 & 3)
- `.planning/phases/10-.../10-CONTEXT.md` — locked decisions

### Secondary (MEDIUM confidence)
- None required — every fact was confirmable in primary source.

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new deps; all primitives verified in live source/types
- Architecture: HIGH — every cited line number re-anchored against current `src/`
- Pitfalls: HIGH — the #1 flagged risk (3rd-arg mock break) disproven by reading every mock; signal
  edge-cases verified against AbortSignal semantics and the existing `callModel` controller
- Validation: HIGH — full existing-suite inventory (12 files, 142 it() blocks) mapped to regression guards

**Factual corrections flagged (do not change approach):**
1. `AiOptions.signal` is at worker-configuration.d.ts:**9491** (CONTEXT/plan say ~9489 — off by 2; claim holds).
2. The adapter is at src/index.ts:**757**, task mapping at **760** (plan's "756"/"758" are off by 1; claims hold).
3. Plan/CONTEXT reference test files that don't exist (`callmodel.test.ts`); the real suite is the 12
   files listed above. Test placement is Claude's discretion — extend existing suites.
4. `ModelTier` is not currently in the `src/index.ts` export list (line 1032); to `import type` it into
   `src/batch.ts` you must add it to the type exports, or use a local duplicate (the `TaskKind`
   precedent imports an exported type — `TaskKind` IS effectively exported). Minor, but a real compile gate.

**Research date:** 2026-06-29
**Valid until:** 2026-07-29 (stable — internal code, no fast-moving external deps; only invalidated by
unrelated edits to `callModel`/`runTask`/`batch.ts` or a `wrangler types` regeneration that changes `AiOptions`)

## RESEARCH COMPLETE

**Phase:** 10 - Batch per-task cancellation and tier override
**Confidence:** HIGH

### Key Findings
- The locked plan is factually correct on all six investigation points; line numbers re-anchored
  (minor off-by-1/2 drift noted, no claim invalidated).
- `AiOptions.signal?: AbortSignal` confirmed (worker-configuration.d.ts:9491); F01 needs no AI-SDK
  refactor — `withTimeout` already builds the `AbortController` and the adapter just stops ignoring it.
- **#1 flagged regression risk cleared:** adding a 3rd `options` arg to `env.AI.run` does NOT break any
  mock — all mocks are argument-agnostic `vi.fn`; all `RunTask` stubs are `(_task, _signal)`.
- `BatchTask.tier?` is optional → existing literals/stubs still type-check; F03 is additive.
- Plan references a nonexistent test file (`callmodel.test.ts`); real suite = 12 files / 142 it()s.
  `ModelTier` likely needs adding to `src/index.ts` exports for the `batch.ts` `import type`.

### File Created
`.planning/phases/10-batch-per-task-cancellation-and-tier-override/10-RESEARCH.md`

### Confidence Assessment
| Area | Level | Reason |
|------|-------|--------|
| Standard Stack | HIGH | No new deps; primitives verified in live types/source |
| Architecture | HIGH | Every line number re-anchored to current src |
| Pitfalls | HIGH | Mock-break risk disproven by reading all mocks; signal edge cases verified |
| Validation | HIGH | Full 12-file/142-test inventory mapped to req→test + regression guards |

### Open Questions
- Test file placement (Claude's discretion) — recommend extending existing suites.
- `ModelTier` sharing into `batch.ts` — recommend adding to index exports or local duplicate.

### Ready for Planning
Research complete. Planner can create PLAN.md files; F01 + F03 belong in one coordinated wave
(shared `runTask` signature + single adapter line).
