# Milestone Brief: Concurrent batch fan-out for code-assist MCP

> Paste this into a Claude Code session **inside the code-assist MCP repo**, then run
> `/gsd:new-milestone` (or `/gsd:new-project` if this repo has no `.planning/` yet) and
> hand it this brief as the milestone intent. This is a decisions-and-intent brief, not a
> step script — let GSD run its own discuss → plan → execute → verify loop. A reference
> implementation (`batch.ts`) is attached; treat it as a design to adapt to the real
> handler signatures in this repo, not as a file to copy verbatim.

## Goal

Add a single new MCP tool, `code_assist_batch`, that runs many **bounded** code-assist
tasks concurrently in one call, so a GSD executor can fan out independent leaf work
(test generation, scaffolding, mechanical transforms) to Qwen on Workers AI instead of
issuing N sequential tool calls or generating inline on an expensive model.

Success = an agent can hand the tool an array of tasks and get back an order-preserving,
per-task-tagged result array, with one slow or failing task never stalling or aborting
the rest.

## Why (context for planning)

This MCP already exposes single-task tools (generate-tests, scaffold, transform, etc.)
that route bounded work to Qwen via Workers AI. The single-task shape is the bottleneck
for parallel work. Adding internal fan-out turns "K parallel Claude executors" into
"K executors x an N-wide cheap batch each," with Claude staying thin (orchestrate +
validate) rather than generating code inline.

## Hard decisions (already made — do not re-litigate in discuss)

1. **Reuse, don't reimplement.** The batch tool MUST call this repo's existing per-kind
   task executor. Do not duplicate the Workers AI / Qwen invocation. Find the function(s)
   the current single-task tools call and inject them as the `runTask` dependency. If the
   current code inlines the AI call inside each tool handler, the first execute phase is a
   small refactor to extract a reusable `runTask(kind, input, signal)` — keep that refactor
   behavior-preserving and covered by the existing tests.

2. **Bounded concurrency, never unbounded.** Use a fixed-size worker pool, default **6**
   in flight, read from env `BATCH_CONCURRENCY`. No naive `Promise.all` over all tasks.

3. **Per-call task cap, default 50** (env `BATCH_MAX_TASKS`). Rationale: each Workers AI
   call is one subrequest; Workers allows 50 subrequests/request on free, 1000 on paid.
   50 is safe on any plan. Over-limit batches fail fast with an actionable error.

4. **Per-task timeout, default 60000ms** (env `BATCH_TASK_TIMEOUT_MS`), enforced even if
   the underlying executor ignores the AbortSignal (race + best-effort abort).

5. **Partial-results contract.** Each task returns independently as
   `{id, index, kind, status:'ok', result}` or `{id, index, kind, status:'error', error}`.
   A failing task is a result entry, not a thrown batch. Order preserved by index.

6. **MCP conventions.** Zod input + output schemas; return `structuredContent` plus a
   short text summary; set tool annotations (readOnlyHint:false, destructiveHint:false,
   idempotentHint:false, openWorldHint:true); actionable error messages.

7. **Leave the single-task tools in place.** Singletons stay — a batch round-trip isn't
   worth it for one trivial task.

## Out of scope (do NOT touch)

- The GSD plugin itself (`~/.claude/plugins/...`). No edits there.
- Auth / routing / model selection to Workers AI beyond what `runTask` already does.
- Any new external dependency if a ~25-line inline pool suffices (prefer zero new deps;
  `p-limit` is acceptable only if the repo already uses it).
- Model-tier config and the CLAUDE.md usage convention — those are separate follow-on
  work outside this repo, not part of this milestone.

## Suggested phase shape (GSD will refine)

- **Phase 1 — Extract/confirm `runTask`.** Ensure there's one reusable, signal-aware
  per-kind executor the single-task tools and the batch tool both use. Behavior-preserving;
  existing tests stay green.
- **Phase 2 — Batch core + pool.** `executeBatch()`, the concurrency pool, and the timeout
  wrapper, as pure importable functions with unit tests (concurrency cap respected, partial
  failures isolated, order preserved, over-limit rejected, timeout fires).
- **Phase 3 — Register the tool.** Wire `code_assist_batch` into the server with the Zod
  schemas, structuredContent, and annotations.
- **Phase 4 — Verify end-to-end.** Build clean; exercise via MCP Inspector
  (`npx @modelcontextprotocol/inspector`) with a mixed batch including a deliberately
  failing task and a deliberately slow one; confirm partial results and the timeout path.

## Verification targets (for the verify phase)

- `npm run build` (or the repo's build) passes with no type errors.
- Unit tests cover: concurrency never exceeds the cap; one task throwing yields a single
  `status:'error'` entry while siblings still return `ok`; results are index-ordered;
  `tasks.length > maxTasks` rejects with the actionable message; a task exceeding the
  timeout returns `status:'error'` without hanging the batch.
- Inspector run shows a real mixed-result batch (some ok, one error, one timeout).
- No changes outside this repo; single-task tools still pass their existing tests.

## Reference implementation

`batch.ts` (attached) is a complete, conventions-correct design: env config reader,
order-preserving worker pool, race-based timeout, `executeBatch`, and `registerBatchTool`.
Adapt names and the `runTask` switch to this repo's actual kinds and handler signatures.
The bottom `WIRING` block shows the one integration point to fill.

## Open questions to resolve in discuss (answer from the actual code)

- Where does the current single-task path call Workers AI, and can it be extracted into a
  signal-aware `runTask` without changing existing behavior?
- Do the existing handlers already accept an AbortSignal, or should the timeout rely purely
  on the race (executor ignores the signal)?
- What is the exact set of `kind` values to support, matched to the existing tools?
- Test runner / build commands in use (vitest? wrangler build?) so verification probes are real.
