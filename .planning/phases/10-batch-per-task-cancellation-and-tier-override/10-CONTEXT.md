# Phase 10: Batch per-task cancellation and tier override - Context

**Gathered:** 2026-06-29
**Status:** Ready for planning
**Source:** User-supplied implementation plan (`~/.claude/plans/encapsulated-painting-hedgehog.md`, Changes 2 & 3)

<domain>
## Phase Boundary

This phase resolves the two deferred v2.0 batch requirements, both confined to the batch
fan-out path. **Single-task tool handlers must remain behavior-identical.**

- **BATCH-F01** — thread a real `AbortSignal` into `env.AI.run()` so a timed-out batch task
  actually stops spending its Workers AI subrequest, instead of the current best-effort
  wall-clock race that lets the orphaned call run to completion.
- **BATCH-F03** — tier-only per-task override in the batch input (`fast` | `standard`). No raw
  model strings at the MCP boundary — the allowlist/KV abstraction stays intact. Only meaningful
  now that Phase 9 made `fast` (qwen3-30b) and `standard` (Kimi) resolve to different models.

Phase 9 (Change 1 — second model + tier split) is already shipped. This phase depends on it.
</domain>

<decisions>
## Implementation Decisions

All decisions below are **locked** (sourced from the user's plan file). Exact line numbers are
indicative — the executor reads live source via `read_first` and re-anchors.

### Change 2 — BATCH-F01: real AbortSignal into `env.AI.run`
- **`callModel` (~src/index.ts:133):** add a 5th param `externalSignal?: AbortSignal`. Link it to
  the existing internal `controller`: if `externalSignal?.aborted` → `controller.abort()`, else
  `externalSignal?.addEventListener("abort", () => controller.abort(), { once: true })`. Pass the
  controller's signal to the AI call:
  `env.AI.run(model, { messages, max_tokens }, { signal: controller.signal })`.
  Keep the existing `timeoutPromise` race and `finally { clearTimeout }` exactly as-is.
- **`runAIWithMetrics` (~src/index.ts:177):** add optional trailing `signal?: AbortSignal`, forward
  it to `callModel`. **`runAI` is untouched** — it is not on the batch path.
- **Single-task handlers unchanged.** They call `runTask(env, kind, input)` with no signal →
  `externalSignal` undefined → behavior identical, except `env.AI.run` now also receives the
  internal 45s timeout signal (a strict improvement: the call is actually cancelled at 45s rather
  than merely raced).

### Change 3 — BATCH-F03: per-task tier override (tier-only)
- **`runTask`:** change signature to
  `runTask(env, kind, input, opts: { tier?: ModelTier; signal?: AbortSignal } = {})`.
  Body: resolve spec, `spec.validate?.(input)`, `const r = spec.resolve(input)`,
  `const tier = opts.tier ?? r.tier`, then
  `return runAIWithMetrics(env, tier, spec.buildPrompt(input), r.maxTokens, opts.signal)`.
  **Override the tier only; keep the kind's `maxTokens`** — output size is a property of the kind,
  not the model.
- **`BatchTaskInputSchema` (~src/index.ts:398):** add
  `tier: z.enum(["fast", "standard"]).optional().describe("Override the model tier for this task (defaults to the kind's tier).")`.
  No new validation — the zod enum makes an invalid tier impossible; tier→`resolveModel`→allowlist
  still governs the model.
- **`BatchTask` interface (src/batch.ts:48):** add `tier?: ModelTier` (import/duplicate the
  `ModelTier` type as already done for `TaskKind`).
- **Task mapping (~src/index.ts):** carry `tier: t.tier` into the mapped `BatchTask`.
- **Batch adapter (src/index.ts:757):** change from ignoring the signal
  (`const adapter: RunTask = (batchTask, _signal) => ...`) to
  `const adapter: RunTask = (batchTask, signal) => runTask(env, batchTask.kind, batchTask.input, { tier: batchTask.tier, signal });`
  This single line wires **both** F01 (signal) and F03 (tier) through the existing
  `executeBatch`/`withTimeout` machinery.

### Tests (add; do not weaken existing)
- **F01 (new file or extend `tool-handlers.test.ts`):** spy `env.AI.run`; assert it is called with
  a 3rd arg whose `signal` is an `AbortSignal`. Assert a pre-aborted external signal causes the
  call to abort (best-effort — mock honors `signal` to prove threading).
- **F03 (extend `batch-tool.test.ts` or `runtask.test.ts`):**
  `runTask(env, "generateCode", input, { tier: "fast" })` resolves via the `fast` model
  (spy `resolveModel`/`env.AI.run` model arg). A batch task `{ kind:"generateCode", tier:"fast", input }`
  overrides; omitting `tier` uses the kind default.
- **Unchanged guards stay green:** `batch.test.ts`, `batch-e2e.test.ts`, `runtask.test.ts`,
  `model-routing.test.ts`, `observability.test.ts` (mocks ignore the signal; tier names unchanged).

### Docs
- **CLAUDE.md** — note `env.AI.run` signal cancellation and the batch per-task `tier` override on
  the Batch Tool section.
- **README.md** — batch fan-out note (per-task `tier`).
- **.planning/PROJECT.md** + **REQUIREMENTS.md** — move BATCH-F01 and BATCH-F03 from
  Future/Deferred to Validated. Update **STATE.md** Deferred table (F01/F03 resolved; F02 remains).

### Claude's Discretion
- Exact test file placement/naming (F01 new file vs. extend an existing suite).
- How the `ModelTier` type is shared into `src/batch.ts` (import vs. local duplicate — match the
  existing `TaskKind` precedent already in the file).
- Plan/wave decomposition. F01 and F03 share the `runTask` signature and the batch adapter line,
  so they are tightly coupled and likely belong in one wave / coordinated plans.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source under change
- `src/index.ts` — `callModel`, `runAIWithMetrics`, `runTask`, `TASK_SPECS`, `BatchTaskInputSchema`,
  `runBatch`/adapter wiring.
- `src/batch.ts` — `BatchTask` interface, `RunTask` type, `executeBatch`, `withTimeout`
  (already creates the `AbortController` and passes `.signal` to the injected runTask).

### Contracts / facts
- `worker-configuration.d.ts` — `AiOptions` includes `signal?: AbortSignal` (~line 9489). F01 is
  achievable on the raw binding; no AI-SDK refactor needed.
- `.planning/REQUIREMENTS.md` — BATCH-F01 / BATCH-F03 text + the 2026-06-27 reopening note
  (F03 narrowed to tier-only; raw per-task model override remains out of scope).
- `CLAUDE.md` — Batch Tool section (partial-results contract, concurrency/cap/timeout env knobs),
  Model Tiers table (post-Phase-9: `fast`=qwen3-30b, `standard`=Kimi).
- `~/.claude/plans/encapsulated-painting-hedgehog.md` — the source plan (Changes 2 & 3, Tests,
  Docs, Verification, Out-of-scope).
</canonical_refs>

<specifics>
## Specific Ideas

- The batch adapter line is the single integration point that wires **both** F01 and F03 — it is
  the highest-leverage change and the natural verification anchor.
- The partial-results contract is sacred: one slow/aborted task must never stall or abort siblings;
  results stay order-preserving by index. F01 must not regress this.
- Verification (manual, charges money): `npm run dev` + MCP Inspector → run a `code_assist_batch`
  with (a) default `generateCode`, (b) same kind with `tier:"fast"`, (c) a deliberately slow task.
  Via `wrangler tail`: the two kinds log different models, the override task logs the qwen model,
  the slow task hits the timeout path (`status:"error"`, `error_type:"timeout"`).
</specifics>

<deferred>
## Deferred Ideas

- **BATCH-F02** (internal per-task retry with backoff) — stays deferred.
- Raw per-task `model` override (string at the MCP boundary) — rejected in favor of tier-only.
- A third "premium" tier — rejected; keeps tier names/tests stable.

</deferred>

---

*Phase: 10-batch-per-task-cancellation-and-tier-override*
*Context gathered: 2026-06-29 from user-supplied implementation plan*
