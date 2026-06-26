# Phase 5: Extract Shared `runTask` Executor - Context

**Gathered:** 2026-06-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Extract the prompt-building + AI-invocation logic out of the 11 AI-backed tool handlers in
`src/index.ts` into a single reusable `runTask(env, kind, input)` executor backed by a
`TASK_SPECS` dispatch map (kind → tier, maxTokens, buildPrompt, validation). Both the existing
single-task tools and the future `code_assist_batch` tool call this one executor. Observable
behavior must be identical to today — all 108 existing tests stay green — and a new
prompt-snapshot test guards against prompt drift the AI-mocked suite cannot detect.

Covers BATCH-01 and BATCH-02. The static `routingInfo` tool is excluded (no AI call, no input).
Out of scope for this phase: the concurrency pool, timeout, cap, and the batch tool itself
(Phases 6–7).
</domain>

<decisions>
## Implementation Decisions

### runTask boundary (D-01)
- **D-01:** `runTask` is a **full executor**, not just a prompt-builder. Signature
  `runTask(env, kind, input)` looks up `TASK_SPECS[kind]`, builds the prompt, calls
  `runAIWithMetrics(env, tier, prompt, maxTokens)`, and returns the `AIResult`
  `{text, model, latency_ms}`. This is the single source of truth for prompt + tier + maxTokens
  **and** the AI call, so the batch tool reuses it directly without re-wrapping the model call.
- **D-02:** Each single-task handler **delegates** to `runTask` for the work; the handler's
  per-tool `logToolInvocation` / `logToolError` calls and its `makeToolError` mapping stay in
  the handler tail (logging keeps the correct per-tool name tag). Handlers shrink to: validate
  (Zod boundary) → `runTask` → log + return `{content:[{type:'text', text}]}` / catch → log +
  `makeToolError`.

### Per-kind validation (D-03)
- **D-03:** Per-kind input validation is **built into `runTask` now in Phase 5** (not deferred).
  Each `TASK_SPECS` entry reuses the **exact** Zod caps/shape already on that tool's
  `inputSchema` in `src/index.ts` (e.g. `generateCode` prompt `.max(20_000)`, context
  `.max(50_000)`; do not weaken or duplicate-with-drift). For the single-task path this inner
  validation is redundant with the MCP boundary Zod (boundary catches first → inner validation
  always passes → no behavior change). It exists so the batch path (Phase 7) can downgrade a bad
  task to a `status:'error'` entry instead of rejecting the whole batch.

### Special-case placement (D-04)
- **D-04:** Kind-specific logic travels **with the kind in `TASK_SPECS`**, so the batch inherits
  it for free:
  - `explainCode` — its spec resolves tier + maxTokens as a **function of input** (`depth`):
    `detailed → standard/4096`, `brief|eli5 → fast/2048` (preserve the current mapping exactly;
    verify against the live handler before locking the numbers).
  - `transformCode` — its **8KB pre-AI byte cap** is enforced inside `runTask` before the model
    call (it currently fires in the handler before `runAIWithMetrics`).

### Error mapping — behavior preservation (D-05)
- **D-05:** `runTask` throws **distinguishable typed errors** (at minimum: validation failure vs
  AI timeout vs AI error). In Phase 5 each single-task handler tail maps these to the **exact
  same** response it returns today — `transformCode`'s over-8KB path must return its current
  error response byte-for-byte, and AI failures must still map to `makeToolError('AI_TIMEOUT' | 'AI_ERROR', toolName)`.
  The typed-error taxonomy is what Phase 7 later surfaces as `error_type` (`timeout | validation | ai_error`),
  but Phase 5 only needs the single-task responses unchanged. This is the highest-risk seam —
  the regression guard is the full 108-test suite plus the new snapshot test.

### Prompt-snapshot test (D-06)
- **D-06:** The new `runtask.test.ts` asserts **byte-identical `buildPrompt` output for all 11
  AI-backed kinds** (not just the 4 with special logic), plus asserts the resolved tier/maxTokens
  per kind — including `explainCode` across all three depths and `transformCode` at/over the 8KB
  boundary. This is the only guard against prompt drift, since the existing tool-handler tests
  mock the AI and assert only on the response envelope/logs.

### Claude's Discretion
- The concrete shape of `TASK_SPECS` entries (e.g. a static `{tier, maxTokens, buildPrompt}` vs
  a `resolve(input) → {tier, maxTokens}` field for `explainCode`) — planner/executor choice, as
  long as D-01..D-06 hold.
- Internal naming (`TaskKind` type, error classes/sentinels) and file organization (keep in
  `src/index.ts` vs a new module) — provided no new runtime dependency is added.
- How typed errors are represented (custom Error subclasses vs a tagged result) — any form the
  handler tails can map to today's exact responses.
</decisions>

<specifics>
## Specific Ideas

- The reference `batch.ts` ships a placeholder 5-kind enum — the real enum is the **11 AI-backed
  kinds** from `src/index.ts`: generateCode, reviewCode, transformCode, scaffoldTests, quickTask,
  explainCode, generateDocs, generateTypes, fixBug, generateCommitMessage, generateWorkerBoilerplate.
- "Behavior-preserving" is the hard constraint: if a test changes its assertion, that's a smell —
  the refactor should not require touching `tool-handlers`, `observability`, or `input-validation`
  test assertions.
</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase requirements & milestone intent
- `.planning/REQUIREMENTS.md` — BATCH-01, BATCH-02 (the two requirements this phase delivers)
- `.planning/ROADMAP.md` §"Phase 5: Extract Shared `runTask` Executor" — goal + 4 success criteria
- `.planning/code-assist-batch-milestone.md` — milestone brief; hard decision #1 (reuse, don't reimplement)

### Research (grounded in the real code)
- `.planning/research/ARCHITECTURE.md` — runTask = dispatch map (kind → {tier, maxTokens, buildPrompt});
  extract head, keep tail; explainCode depth routing; transformCode 8KB cap; new-vs-modified component list
- `.planning/research/PITFALLS.md` — refactor regression (prompt drift invisible to AI-mocked tests),
  the snapshot-test guard, typed-error taxonomy
- `.planning/research/SUMMARY.md` — consolidated load-bearing decisions
- `.planning/research/STACK.md` — zero new deps; ZodRawShape `inputSchema` convention to preserve

### Implementation target & existing tests
- `src/index.ts` — the 11 handlers (lines ~211–560), `callModel` (~130), `runAIWithMetrics`/`runAI` (~174–185),
  `resolveModel`, `makeToolError` (~191), `logToolInvocation`/`logToolError`, `createMcpServer` (~205)
- `.planning/batch.ts` — reference design (adapt the kind enum + runTask switch to the real 11 kinds)
- `.planning/codebase/CONVENTIONS.md`, `.planning/codebase/TESTING.md` — repo patterns + how the 108 tests are structured
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `runAIWithMetrics(env, tier, prompt, maxTokens)` (src/index.ts:174) — returns `{text, model, latency_ms}`;
  `runTask` wraps this. `runAI` (:182) is the thin text-only variant.
- `callModel(env, model, prompt, maxTokens)` (:130) — owns its own `AI_TIMEOUT_MS` AbortController;
  takes NO external signal (relevant in Phase 6, not here). Leave untouched.
- `resolveModel` / two-tier routing, `makeToolError(code, toolName)` (:191), `logToolInvocation` / `logToolError`
  — all reused unchanged; logging stays in handler tails.

### Established Patterns
- Tools registered via `server.registerTool(name, {description, inputSchema: <ZodRawShape>}, handler)`
  inside `createMcpServer(env)` (CLAUDE.md convention). Keep the `ZodRawShape` form — do NOT refactor
  to `z.object()`.
- Each handler today: build prompt inline from validated inputs → `try { runAIWithMetrics; logToolInvocation; return }`
  `catch { classify AI_TIMEOUT vs AI_ERROR; logToolError; makeToolError }`. The try/catch tail is the part
  that stays; only the prompt-build head moves into `TASK_SPECS`.
- `explainCode` routes tier by `depth`; `transformCode` enforces an 8KB byte cap before the AI call —
  both must be preserved exactly (D-04).

### Integration Points
- `runTask` + `TASK_SPECS` are NEW (likely in `src/index.ts`, or a new module imported by it — no new dep).
- MODIFIED: the 11 handler heads delegate to `runTask`; tails unchanged. `Env` may gain optional
  `BATCH_*` fields later (Phase 6), not this phase.
- UNTOUCHED: `callModel`, `runAIWithMetrics`, `resolveModel`, auth/OAuth, and all 9 existing test files'
  assertions. NEW test file: `runtask.test.ts` (prompt + tier/maxTokens snapshots for all 11 kinds).
- Verify gate: `npx tsc --noEmit` clean + `npm test` (108 + new) green.
</code_context>

<deferred>
## Deferred Ideas

- Concurrency pool, per-task timeout (default 45000ms), per-call cap (default 50) — Phase 6.
- `code_assist_batch` registration, output schema, `structuredContent`, annotations, `error_type`
  surfacing, batch summary — Phase 7.
- True per-task cancellation (thread an AbortSignal into `env.AI.run`) — BATCH-F01, future milestone.

None of these are in Phase 5 scope — discussion stayed within the extraction boundary.
</deferred>

---

*Phase: 05-extract-shared-runtask-executor*
*Context gathered: 2026-06-26*
