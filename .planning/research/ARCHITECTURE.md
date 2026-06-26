# Architecture Research

**Domain:** Concurrent batch fan-out tool integrated into an existing single-file Cloudflare Workers MCP server
**Researched:** 2026-06-25
**Confidence:** HIGH (grounded in the actual `src/index.ts`, `.planning/batch.ts` reference, the 9 test files, and `vitest.config.*`; no external claims required)

## Executive Answer (for the roadmapper / plan-phase)

Four decisions, all confirmed against the real code:

1. **Extract `runTask` as a dispatch map of `kind → { tier, maxTokens, buildPrompt(input) }`.** The 11 AI-backed handlers (lines 211–560 of `src/index.ts`) already split cleanly into two halves: a *prompt-build + tier + maxTokens* head, and an identical *try → runAIWithMetrics → log → catch → makeToolError* tail. Lift only the head into a per-kind table; leave the tail in each handler so observable behavior (and therefore the 108 tests) is unchanged.
2. **Layer the per-task timeout as a `Promise.race` wrapper at the pool level, not inside the executor.** `callModel` (line 130) constructs its *own* `AbortController` and takes **no external signal** — passing a signal into `runTask` cannot cancel the in-flight `env.AI.run`. So `withTimeout` (batch.ts lines 119–131) is the *only* wall-clock guarantee: the race rejection is what makes the batch return; `signal.abort()` is best-effort and currently a no-op against Workers AI.
3. **`executeBatch` + `mapWithConcurrency` (pool) + `withTimeout` are pure, dependency-injected functions** taking `(tasks, cfg, runTask)`. They never import `env`, `callModel`, or the MCP SDK transport — so they unit-test in isolation with a fake `runTask`, no Workers runtime, no AI mock. The reference `batch.ts` already has this shape; adopt it nearly verbatim.
4. **Build order: extract `runTask` (behavior-preserving) → land pure batch core + pool + timeout → register `code_assist_batch` + wire `runTask` → E2E verify.** `runTask` extraction MUST precede the batch core because the core's only real dependency is a working `runTask`; everything downstream is injection and registration.

## Standard Architecture

### System Overview — where the batch tool slots in

```
┌──────────────────────────────────────────────────────────────────────┐
│  TRANSPORT (unchanged) — OAuthProvider → createMcpHandler → McpServer │
│  src/index.ts: export default new OAuthProvider (line 762)            │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ per-request: createMcpServer(env) (766)
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  MCP TOOL LAYER — createMcpServer(env)  (line 205)                    │
│  ┌────────────────────────┐   ┌─────────────────────────────────┐    │
│  │ 11 single-task handlers│   │  code_assist_batch (NEW)        │    │
│  │ generateCode, review…  │   │  registerBatchTool(server,{...})│    │
│  │  head: buildPrompt ────┼─┐ │   └── executeBatch(tasks,cfg,   │    │
│  │  tail: try/log/catch   │ │ │            runTask) ────┐        │    │
│  └────────────────────────┘ │ └────────────────────────┼────────┘    │
│                             │                          │             │
│            both call ───────┴──────────┐               │             │
│                                        ▼               ▼             │
│              ┌─────────────────────────────────────────────────┐    │
│              │  runTask(kind, input[, signal])   (NEW, shared)  │    │
│              │  dispatch map: kind → {tier,maxTokens,buildPrompt}│   │
│              └───────────────────────────┬─────────────────────┘    │
└──────────────────────────────────────────┼──────────────────────────┘
                                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  EXECUTOR (unchanged) — runAIWithMetrics (174) → resolveModel (36)    │
│                          → callModel (130) [owns its OWN AbortCtrl]   │
└───────────────────────────────┬──────────────────────────────────────┘
                                ▼
                          env.AI.run  +  OAUTH_KV (model config)
```

The batch tool adds **one new node** in the tool layer and **one new shared node** (`runTask`) one level below it. Everything from `runAIWithMetrics` downward is untouched — that is the "reuse the existing executor, one source of truth" decision (PROJECT.md key decision, line 95).

### Component Responsibilities

| Component | Responsibility | New / Modified | Location |
|-----------|----------------|----------------|----------|
| `runTask(kind, input, signal?)` | Map a kind + that kind's params → prompt + tier + maxTokens, then call `runAIWithMetrics`. Single source of prompt logic. | **NEW** | new in `src/index.ts` (or `src/runTask.ts`) |
| `TASK_SPECS` dispatch map | `kind → { tier, maxTokens, buildPrompt(input) }`. The lifted "head" of each handler. | **NEW** | same module as `runTask` |
| 11 single-task handlers | Keep try/catch/log/error-mapping tail; call `runTask` instead of inlining the prompt. | **MODIFIED** (head only) | `src/index.ts` 211–560 |
| `executeBatch(tasks, cfg, runTask)` | Cap check → pool → assemble `{total, succeeded, failed, results[]}`. Pure. | **NEW** | `src/batch.ts` |
| `mapWithConcurrency(items, limit, fn)` | Order-preserving bounded worker pool. Pure. | **NEW** | `src/batch.ts` |
| `withTimeout(ms, run)` | `Promise.race` wall-clock bound + best-effort abort. Pure. | **NEW** | `src/batch.ts` |
| `readBatchConfig(env)` | Parse `BATCH_CONCURRENCY` / `BATCH_MAX_TASKS` / `BATCH_TASK_TIMEOUT_MS` with defaults 6 / 50 / 60000. | **NEW** | `src/batch.ts` |
| `registerBatchTool(server, {runTask, env})` | Register `code_assist_batch` with Zod in/out schemas, annotations, `structuredContent` + text summary. | **NEW** | `src/batch.ts` |
| `createMcpServer(env)` | Add one line: `registerBatchTool(server, { runTask: (t,s)=>runTask(t.kind,t.input,s), env })`. | **MODIFIED** (1 line) | `src/index.ts` 205–578 |
| `callModel` / `runAIWithMetrics` / `resolveModel` | **Untouched.** | unchanged | `src/index.ts` 36–185 |

## Recommended Project Structure

The repo is intentionally near-monolithic (`src/index.ts` is the whole app; `src/logger.ts` is the one split-out). Two viable layouts — recommend **Option A** for testability and to mirror the reference file already sitting in `.planning/batch.ts`:

```
src/
├── index.ts            # MODIFIED: handlers call runTask; 1-line registerBatchTool wire
├── runTask.ts          # NEW: TASK_SPECS dispatch map + runTask(kind,input,signal?)
│                       #      imports runAIWithMetrics from index (or a tiny shared exec module)
├── batch.ts            # NEW: executeBatch, mapWithConcurrency, withTimeout,
│                       #      readBatchConfig, registerBatchTool  (pure + registration)
├── logger.ts           # unchanged
└── __tests__/
    ├── runtask.test.ts        # NEW: per-kind prompt/tier/maxTokens byte-equality
    ├── batch-core.test.ts     # NEW: pool ordering, concurrency cap, timeout, partial results
    ├── batch-tool.test.ts     # NEW: code_assist_batch handler shape (structuredContent)
    └── (9 existing test files unchanged)
```

### Structure Rationale

- **`runTask.ts` separate from `index.ts`:** `runTask` is the new shared contract both callers depend on. Isolating it makes the "head" of each handler unit-testable for byte-identical prompt output (the core green-keeping guarantee) without spinning up the MCP server. If a circular import with `runAIWithMetrics` is awkward, lift `runAIWithMetrics`/`callModel`/`resolveModel` into `src/exec.ts` and have both `index.ts` and `runTask.ts` import it — a clean, low-risk move.
- **`batch.ts` mirrors `.planning/batch.ts`:** the reference is already conventions-correct (env-config reader, order-preserving pool, race timeout, `executeBatch`, `registerBatchTool`). Adopt it; the only adaptation is wiring `runTask` and aligning the `kind` enum to real tool names.
- **Pure core, separate from registration:** `executeBatch`/pool/timeout export independently of `registerBatchTool` so tests import them directly with a fake `runTask` — no `env`, no AI mock, no SDK transport. The reference already does this (batch.ts exports `executeBatch`, `mapWithConcurrency` is module-private but trivially testable via `executeBatch`).

## Architectural Patterns

### Pattern 1: Behavior-preserving "head extraction" into a dispatch map

**What:** Each handler today is `head (build prompt + pick tier + pick maxTokens) → tail (try/runAIWithMetrics/log/catch/makeToolError)`. Lift only the head into `TASK_SPECS[kind] = { tier, maxTokens, buildPrompt(input) }`. `runTask` runs the head + the AI call. Handlers keep their tail and delegate the head to `runTask`.

**When to use:** Whenever two callers (single-task tool + batch) must share prompt logic but one caller (the tool) also owns logging + MCP error envelope that the other (batch) reports differently.

**Trade-offs:** (+) One source of truth for prompts; (+) handler tails — and thus their tests — are untouched; (−) a layer of indirection per handler; (−) you must preserve each kind's exact `maxTokens` and tier (see byte-equality note below) or `tool-handlers.test.ts` still passes but the *prompt the model sees* drifts.

**Example (shape, not final):**
```typescript
// runTask.ts
type Kind = "generateCode" | "reviewCode" | "transformCode" | "scaffoldTests"
          | "explainCode" | "generateDocs" | "generateTypes" | "fixBug"
          | "generateCommitMessage" | "generateWorkerBoilerplate" | "quickTask";

interface TaskSpec {
  tier: ModelTier;
  maxTokens: number;
  buildPrompt(input: Record<string, unknown>): string;
}

const TASK_SPECS: Record<Kind, TaskSpec> = {
  generateCode: {
    tier: "standard",
    maxTokens: 8192,
    buildPrompt: ({ prompt, context, language, style }: any) => {
      const parts: string[] = [];
      if (language) parts.push(`Language: ${language}`);
      if (style) parts.push(`Style: ${style}`);
      if (context) parts.push(`Context:\n${context}`);
      parts.push(`Task:\n${prompt}`);
      return parts.join("\n\n");          // byte-identical to index.ts:224-228
    },
  },
  // ...10 more, copied verbatim from the existing handler heads...
};

export async function runTask(env: Env, kind: Kind, input: Record<string, unknown>, _signal?: AbortSignal) {
  const spec = TASK_SPECS[kind];
  const result = await runAIWithMetrics(env, spec.tier, spec.buildPrompt(input), spec.maxTokens);
  return result;   // {text, model, latency_ms} — handler logs + unwraps .text; batch reports .text
}
```

Then the handler shrinks to (note: tail unchanged, so its 3 tests per tool stay green):
```typescript
async ({ prompt, context, language, style }) => {
  try {
    const result = await runTask(env, "generateCode", { prompt, context, language, style });
    logToolInvocation({ tool: "generateCode", tier: "standard", model: result.model, latency_ms: result.latency_ms });
    return { content: [{ type: "text", text: result.text }] };
  } catch (err) { /* identical AI_TIMEOUT/AI_ERROR mapping + logToolError + makeToolError */ }
}
```

**Two edge cases the head-extraction must preserve (or tests/behavior drift):**
- **`explainCode`** picks tier AND maxTokens dynamically from `depth` (index.ts 393–394: `detailed → standard/4096`, else `fast/2048`). So either its `TaskSpec.tier`/`maxTokens` become functions of input, or `explainCode` gets one spec per depth. Simplest: allow `buildPrompt` plus `resolve(input) → {tier, maxTokens}` in the spec, or special-case explainCode.
- **`transformCode`** has a pre-flight 8KB byte cap (index.ts 287–297) returning `INPUT_TOO_LARGE` *before* any AI call. Decide: keep that guard in the **handler tail only** (single-task behavior unchanged — recommended), or also enforce inside `runTask` so the batch path rejects oversized transforms too. Recommend enforcing in `runTask` (throw) so batch reports it as a per-task `{status:"error"}` rather than silently sending an 8KB+ payload that will hit `AI_TIMEOUT`.

### Pattern 2: Timeout-by-race at the pool boundary (executor ignores the signal)

**What:** `withTimeout(ms, run)` starts a `setTimeout` that `reject`s, and races it against `run(signal)`. Because `callModel` (line 130) creates its own `AbortController` and never reads an external signal, the `signal` handed to `runTask` is decorative against the AI call — the **race rejection is the sole wall-clock guarantee**.

**When to use:** Any time you need a wall-clock bound on a downstream call you cannot cancel. Exactly this situation.

**Trade-offs:** (+) Guarantees the batch returns even if a Qwen call hangs past `BATCH_TASK_TIMEOUT_MS`; (+) zero change to `callModel`; (−) the in-flight `env.AI.run` keeps running until *its own* `AI_TIMEOUT_MS` (45s, line 26) — it's not actually cancelled, just abandoned. Note the interaction: `BATCH_TASK_TIMEOUT_MS` defaults to **60_000** while `callModel`'s `AI_TIMEOUT_MS` is **45_000**, so in practice `callModel` rejects first with `"AI_TIMEOUT"` and the batch surfaces that as the per-task error; the 60s race is a backstop. Flag for the roadmapper: consider documenting/aligning these two so the per-task error message is predictable.

**Example:** the reference `withTimeout` (batch.ts 119–131) is correct as-is. Keep `signal.abort()` — it's the right forward-compatible hook for when/if a signal-aware executor lands; it just no-ops today.

### Pattern 3: Order-preserving bounded worker pool as a pure function

**What:** `mapWithConcurrency(items, limit, fn)` (batch.ts 98–115): allocate `results[items.length]`, run `min(limit, n)` workers, each pulling the next index off a shared `cursor++` and writing `results[i] = await fn(items[i], i)`. Order is preserved because workers write by index, not by completion order; concurrency is bounded because exactly `limit` workers exist; it's never an unbounded `Promise.all` over all tasks (PROJECT.md constraint, line 76).

**When to use:** Fan-out of N independent async units with a hard in-flight cap and a stable output order. Ideal for Workers, where each AI call is one subrequest and the plan caps subrequests (50 free / 1000 paid — hence `maxTasks` default 50, batch.ts 36).

**Trade-offs:** (+) ~25 lines, zero deps (satisfies "prefer zero new deps" decision, PROJECT.md line 99); (+) trivially unit-testable with a synchronous/fake `fn`; (−) no work-stealing nuance needed at this scale — the simple cursor pool is correct and sufficient.

**Example:** adopt batch.ts `mapWithConcurrency` verbatim. Unit tests should assert: (a) output array order matches input order even when later tasks resolve first; (b) at most `limit` `fn` invocations are in flight (instrument with a counter); (c) a rejecting `fn` for one index does not abort siblings — but note in `executeBatch` the per-task `try/catch` (batch.ts 147–158) means `fn` never rejects, it returns an `{status:"error"}` record, so the pool itself never sees a rejection. Test both layers.

## Data Flow

### Batch request flow

```
client → code_assist_batch({ tasks: [...] })
   ↓  registerBatchTool handler (batch.ts 196)
executeBatch(tasks, cfg, runTask)
   ↓  cap check: tasks.length > cfg.maxTasks → throw (fail fast, actionable)
mapWithConcurrency(tasks, cfg.concurrency, perTask)
   ↓  ≤ concurrency workers, each:
perTask(task, i):
   id = task.id ?? String(i)
   try  withTimeout(cfg.taskTimeoutMs, signal => runTask(env, task.kind, task.input, signal))
        ↓                              ↓ (signal ignored by callModel)
        race( runAIWithMetrics → resolveModel → callModel → env.AI.run ,  setTimeout-reject )
   ok   → { id, index:i, kind, status:"ok",    result }
   err  → { id, index:i, kind, status:"error", error: message }   // siblings continue
   ↓
{ total, succeeded, failed, results[] }  →  structuredContent + text summary
```

### Single-task flow (after refactor — observably identical to today)

```
client → generateCode({...})
   ↓ handler tail (try)
runTask(env, "generateCode", {...})   ← was: inline prompt build + runAIWithMetrics
   ↓
runAIWithMetrics → resolveModel → callModel → env.AI.run
   ↓ handler logs, returns { content:[{type:"text", text}] }   ← unchanged
   ↓ on throw: same AI_TIMEOUT/AI_ERROR mapping → makeToolError   ← unchanged
```

### Why the tests stay green (grounded in the test files)

- `tool-handlers.test.ts` reaches handlers via `(server as any)._registeredTools[name].handler` (lines 7–13) and asserts only on `result.content[0].text === "mock AI output"` and `result.isError === true` with `AI_TIMEOUT` / `AI_ERROR` substrings. These are *observable outputs of the handler tail*, which we do not change. As long as `runTask` calls `env.AI.run` (it does, via `runAIWithMetrics → callModel`) and re-throws on rejection, every assertion holds.
- The AI mock (`helpers.ts` `createMockAI`) returns `{ response }` regardless of prompt content — so prompt-text changes are invisible to existing tests. **This is exactly why a NEW `runtask.test.ts` is required**: it must assert each kind's `buildPrompt` is byte-identical to the current inline string (snapshot the joined prompt), because the existing suite cannot catch prompt drift. This is the one place the refactor can silently regress real behavior.
- `model-routing`, `auth-flow`, `rate-limiting`, `error-sanitization`, `observability`, `input-validation`, `logger` tests touch functions we don't modify — untouched.
- `vitest.config.*` runs in the Workers pool with mocked `OAUTH_KV` + `MCP_SECRET`. Pure batch-core tests don't need that pool at all (no `env`), so they're fast and runtime-independent.

## Scaling Considerations

This is a single-owner personal server; "scale" here means subrequests and concurrency, not users.

| Scale | Adjustment |
|-------|------------|
| Typical batch (≤ 6–10 tasks) | Defaults are right: 6 in flight, completes in ~ceil(N/6) AI round-trips. |
| Large batch (up to 50) | `maxTasks=50` keeps you under the free-plan 50-subrequest cap. Raise `BATCH_MAX_TASKS` only on paid (1000). Each task = one subrequest. |
| Hot/rate-limited (Workers AI 429s) | Lower `BATCH_CONCURRENCY`; the pool already bounds in-flight. Consider future per-task retry/backoff (out of scope this milestone). |

### Scaling Priorities

1. **First bottleneck — subrequest cap.** Enforced by `maxTasks` fail-fast in `executeBatch` (batch.ts 137–143). Correct as designed.
2. **Second — Workers AI 429 under concurrency.** Tune `BATCH_CONCURRENCY` (default 6 chosen to stay clear of 429s, batch.ts 32–33). No code change needed; it's env-config.

## Anti-Patterns

### Anti-Pattern 1: Duplicating the Workers AI call inside the batch tool

**What people do:** Re-implement `env.AI.run` / prompt assembly in the batch handler for "independence."
**Why it's wrong:** Two sources of truth for prompts, tiers, timeouts, model resolution — they drift; bug fixes land in one path only. Directly violates PROJECT.md decision (line 95).
**Do this instead:** Inject the shared `runTask`; the batch tool knows nothing about Workers AI.

### Anti-Pattern 2: Unbounded `Promise.all(tasks.map(runTask))`

**What people do:** Fan out all tasks at once.
**Why it's wrong:** Blows the subrequest cap, triggers Workers AI 429s, and one rejection (without per-task catch) aborts the whole batch — losing the partial-results contract.
**Do this instead:** Bounded `mapWithConcurrency` + per-task `try/catch` returning `{status}` records (batch.ts 145–159). One failure is a result entry, not a thrown batch (PROJECT.md decision, line 98).

### Anti-Pattern 3: Relying on the AbortSignal to enforce the timeout

**What people do:** Assume passing `signal` into `runTask` cancels the AI call when the timer fires.
**Why it's wrong:** `callModel` (line 130) ignores all external signals — it owns its own controller. The signal abort is a no-op against `env.AI.run`.
**Do this instead:** Treat the `Promise.race` rejection in `withTimeout` as the *sole* guarantee the batch returns; keep `signal.abort()` only as a forward-compatible best-effort hook.

### Anti-Pattern 4: Moving handler try/catch/logging into `runTask`

**What people do:** Over-extract — pull the whole handler body (including `makeToolError` + `logToolInvocation`) into `runTask`.
**Why it's wrong:** The batch path reports errors as `{status:"error", error}` records, NOT as MCP `isError` envelopes; and it logs differently (or not per-task). Folding the tail into `runTask` couples it to the single-task envelope and risks breaking `tool-handlers.test.ts` error assertions.
**Do this instead:** Extract only the head (prompt + tier + maxTokens + the AI call). Let each caller own its own error/log/return shape.

## Integration Points

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| handlers ↔ `runTask` | direct call `runTask(env, kind, input)` → `{text, model, latency_ms}` | handlers keep their try/catch/log/return; only the prompt-build head moves |
| batch tool ↔ `runTask` | injected `RunTask` closure: `(task, signal) => runTask(env, task.kind, task.input, signal)` | wired once in `registerBatchTool` deps |
| `executeBatch` ↔ pool/timeout | pure function composition | no `env`, no SDK — unit-testable standalone |
| `registerBatchTool` ↔ `createMcpServer` | one new line at ~line 576, before `return server` | the only edit to `createMcpServer` besides handler heads |
| `readBatchConfig` ↔ `Env` | reads `BATCH_CONCURRENCY` / `BATCH_MAX_TASKS` / `BATCH_TASK_TIMEOUT_MS` | add these as optional `string` fields on `Env` (line 121) or read via `env as Record<string,string\|undefined>` as the reference does (batch.ts 26) |

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Workers AI (`env.AI`) | unchanged — only via `callModel` | each batch task = 1 subrequest; cap via `maxTasks` |
| `OAUTH_KV` | unchanged — model config + OAuth | batch adds no new KV keys |

## Recommended Build Order (dependency-driven)

| Step | Component | New/Mod | Gate (what proves it) | Why this order |
|------|-----------|---------|------------------------|----------------|
| **1** | Extract `runTask` + `TASK_SPECS`; rewrite 11 handler heads to call it | NEW + MOD | `npx tsc --noEmit` clean; all 108 existing tests green; NEW `runtask.test.ts` asserts byte-identical prompt per kind (incl. explainCode depth + transformCode cap) | Pure refactor. The batch core's only real dependency is a working `runTask`; nothing else can be correct first. Lowest-risk if done in isolation. |
| **2** | Pure batch core: `mapWithConcurrency`, `withTimeout`, `executeBatch`, `readBatchConfig` in `src/batch.ts` | NEW | `batch-core.test.ts`: order preserved, ≤`limit` in flight, timeout rejects + surfaces partial, cap throws actionable error, all with a **fake** `runTask` (no env/AI) | Self-contained, no MCP/env coupling; can be built and fully tested before touching the server wiring. |
| **3** | `registerBatchTool` + wire into `createMcpServer` (1 line); add `Env` config fields | NEW + MOD (1 line) | `batch-tool.test.ts`: `code_assist_batch` registered; returns `structuredContent` + text summary; failed-id list correct | Depends on both 1 (runTask) and 2 (executeBatch). |
| **4** | E2E verify | — | Full suite green (108 + new); manual/integration: a 3-task batch with one forced failure returns 2 ok + 1 error, order preserved | Confirms the seam end-to-end through the real `createMcpServer`. |

**Critical dependency:** Step 1 (runTask) MUST precede Step 2 — the pure core is meaningless without the shared executor it injects. Steps 2 and 3 cannot reorder (registration needs `executeBatch`). The quality gate's required ordering (extract runTask → pure core+pool → register → E2E) is exactly this sequence.

**Test-green guarantee, restated for the planner:** the only behavior the existing suite *cannot* see is prompt-string drift (the AI mock ignores prompt content). Step 1's NEW `runtask.test.ts` byte-equality assertions are therefore the load-bearing regression guard — without them, "108 tests green" does not prove behavior preservation.

## Sources

- `src/index.ts` (lines cited inline: callModel 130–166, runAIWithMetrics 174–185, createMcpServer 205–578, handlers 211–560, OAuthProvider wiring 762–775) — HIGH (the actual code)
- `.planning/batch.ts` (reference: mapWithConcurrency 98–115, withTimeout 119–131, executeBatch 136–163, registerBatchTool 168–215, readBatchConfig 26–39) — HIGH (provided reference impl)
- `src/__tests__/tool-handlers.test.ts`, `helpers.ts`, `vitest.config.*` — HIGH (grounds the "keeps tests green" analysis)
- `.planning/PROJECT.md` (key decisions, constraints, milestone scope) — HIGH
- `.planning/codebase/ARCHITECTURE.md`, `CONVENTIONS.md` — MEDIUM (dated 2026-04-12; line numbers there predate logger.ts split, but patterns hold)

---
*Architecture research for: batch fan-out integration into a single-file Workers MCP server*
*Researched: 2026-06-25*
