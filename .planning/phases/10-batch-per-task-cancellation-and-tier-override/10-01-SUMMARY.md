---
phase: 10-batch-per-task-cancellation-and-tier-override
plan: "01"
subsystem: batch-engine
tags: [batch, abort-signal, tier-override, cancellation, workers-ai]
dependency_graph:
  requires: []
  provides: [real-abort-signal-into-env-ai-run, per-task-tier-override, runTask-opts-api]
  affects: [src/index.ts, src/batch.ts, tsconfig.json]
tech_stack:
  added: []
  patterns:
    - AbortSignal chaining (external → internal controller → env.AI.run AiOptions.signal)
    - Optional opts object pattern for runTask (tier + signal, both optional, backward-compatible)
key_files:
  created: []
  modified:
    - tsconfig.json
    - src/index.ts
    - src/batch.ts
decisions:
  - Tier-only per-task override (no raw model string at MCP boundary) — z.enum constrains to allowlist
  - External signal linked via addEventListener+once, not Promise.race — lets the existing timeout race remain unchanged
  - r.maxTokens preserved through tier override (tier changes model, not token budget)
  - worker-configuration.d.ts generated into worktree (gitignored) to unblock tsc gate
metrics:
  duration: "4m"
  completed: "2026-06-29"
  tasks_completed: 4
  files_changed: 3
  commits: 4
---

# Phase 10 Plan 01: Batch Per-Task Cancellation and Tier Override — Source Changes Summary

Real AbortSignal cancellation (BATCH-F01) and per-task tier override (BATCH-F03) wired through the batch fan-out path via `callModel` + `runTask` opts API, with a tsconfig pre-condition fix enabling `tsc --noEmit` as a production-code gate.

## What Was Built

### Task 1: tsconfig.json — exclude test dir from bare tsc
Added `"src/__tests__"` to the `exclude` array so `npx tsc --noEmit` becomes a meaningful production-code gate. Test files type-check under `@cloudflare/vitest-pool-workers` at `npm test` (which injects the correct Workers `Env`/`Request` types); bare `tsc` would raise 32 false-positive errors against them. This is a pre-existing tooling fix, not a Phase-10 behavior change.

**Regression safety:** No real type coverage lost. The test files were already broken under bare `tsc` (32 errors: `Property 'MCP_SECRET' is missing in type 'Env'`, Workers `Request<CfProperties>` mismatches) — they are only correctly typed at `npm test`. Excluding them makes the gate meaningful for the production sources that changed in Tasks 2–4.

### Task 2: BATCH-F01 — Real AbortSignal into env.AI.run
`callModel` gained a 5th parameter `externalSignal?: AbortSignal`. Inside, after the existing `AbortController`/`setTimeout` are created (unchanged), the external signal is linked to the internal controller:
- If `externalSignal?.aborted` is true at dispatch time: `controller.abort()` immediately
- Otherwise: `externalSignal?.addEventListener("abort", () => controller.abort(), { once: true })`

The `env.AI.run(model, body)` call now passes a 3rd argument `{ signal: controller.signal }` (AiOptions), so a timed-out batch task's subrequest is actually cancelled rather than orphaned. The existing `Promise.race([aiPromise, timeoutPromise])` and `finally { clearTimeout(timeoutId) }` are preserved exactly. `runAI` (not on batch path) is untouched.

`runAIWithMetrics` received a trailing optional `signal?: AbortSignal` and forwards it to `callModel`.

### Task 3: BATCH-F03 — runTask opts, BatchTaskInputSchema tier, BatchTask.tier
`runTask` signature changed to:
```typescript
runTask(env, kind, input, opts: { tier?: ModelTier; signal?: AbortSignal } = {})
```
Internally: `const tier = opts.tier ?? r.tier` — the kind's default tier is used when no override is given. `r.maxTokens` is always used (kind property, not model property — tier override does not change token budget). `opts.signal` is forwarded to `runAIWithMetrics`.

`BatchTaskInputSchema` gained: `tier: z.enum(["fast", "standard"]).optional()` — constrained to the existing tier allowlist at the MCP boundary; raw model strings are rejected.

`src/batch.ts`:
- Import: `import type { TaskKind, ModelTier } from "./index";`
- `BatchTask` interface: added `tier?: ModelTier`

### Task 4: Batch adapter and task mapping wiring
The `runBatch` adapter replaced `_signal` with `signal` and wires both F01 and F03 in one line:
```typescript
const adapter: RunTask = (batchTask, signal) =>
  runTask(env, batchTask.kind, batchTask.input, { tier: batchTask.tier, signal });
```
The task mapping now carries `tier: t.tier` alongside `id`/`kind`/`input`.

## Commits

| Task | Commit | Type | Description |
|------|--------|------|-------------|
| 1 | d5ec9d1 | chore | exclude src/__tests__ from tsconfig |
| 2 | ec1df53 | feat | BATCH-F01: externalSignal in callModel/runAIWithMetrics |
| 3 | 1d80052 | feat | BATCH-F03: runTask opts, BatchTaskInputSchema tier, BatchTask.tier |
| 4 | 3dc932d | feat | wire F01+F03 through batch adapter + task mapping |

## Verification Results

- `npx tsc --noEmit`: exits 0 (production gate clean) after each task
- `npm test`: 12 test files, 165 passed, 1 skipped — identical to baseline (all 12 suites pass)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] worker-configuration.d.ts missing in worktree**
- **Found during:** Task 1 (first `npx tsc --noEmit` run)
- **Issue:** The worktree had no `node_modules` and no `worker-configuration.d.ts` (it is gitignored — generated by `wrangler types`). Bare `tsc` failed with `Cannot find type definition file for './worker-configuration.d.ts'`.
- **Fix:** Copied the main-repo's existing `worker-configuration.d.ts` into the worktree root. The file is gitignored — it stays on disk for the worktree's tsc run but is not committed.
- **Files modified:** worker-configuration.d.ts (untracked, gitignored)
- **Commit:** N/A (gitignored file)

## Known Stubs

None. All changes are complete wiring — no placeholder values, no hardcoded stubs, no TODO paths.

## Threat Surface Scan

All changes are within the threat model documented in PLAN.md:

| Threat | Status |
|--------|--------|
| T-10-01: per-task tier injection | Mitigated — `z.enum(["fast","standard"])` constrains input; tier→resolveModel→ALLOWED_MODELS still governs actual model |
| T-10-02: orphaned AI.run subrequests on timeout | Mitigated — F01 IS the fix: `{ signal: controller.signal }` as 3rd arg to `env.AI.run` |
| T-10-03: batch fan-out amplification | Unchanged — BATCH_MAX_TASKS/BATCH_CONCURRENCY bounds unmodified |

No new external attack surface introduced. Single-task tool handlers are behavior-identical (no signal or tier passed through runAI or single-task call sites).

## Self-Check: PASSED

Files created/modified:
- tsconfig.json: FOUND (committed d5ec9d1)
- src/index.ts: FOUND (committed ec1df53, 1d80052, 3dc932d)
- src/batch.ts: FOUND (committed 1d80052)

Commits verified:
- d5ec9d1: chore(10-01): exclude src/__tests__ — FOUND
- ec1df53: feat(10-01): BATCH-F01 — FOUND
- 1d80052: feat(10-01): BATCH-F03 — FOUND
- 3dc932d: feat(10-01): wire F01+F03 — FOUND

Production type-check gate: npx tsc --noEmit exits 0
Test suite: 12/12 files passed, 165 tests green
