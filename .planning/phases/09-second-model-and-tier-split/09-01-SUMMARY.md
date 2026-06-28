---
phase: 09-second-model-and-tier-split
plan: 01
subsystem: model-routing
tags: [model-routing, tier-split, kimi, allowlist, test]
dependency_graph:
  requires: []
  provides: [standard-tier-kimi-model, ALLOWED_MODELS-kimi-k2.5, model-routing-tests-tier-divergence]
  affects: [src/index.ts, src/__tests__/model-routing.test.ts, src/__tests__/runtask.test.ts, CLAUDE.md, README.md]
tech_stack:
  added: []
  patterns: [two-tier-model-routing, allowlist-satisfies-keyof-AiModels, constant-reference-test-assertions]
key_files:
  created: []
  modified:
    - src/index.ts
    - src/__tests__/model-routing.test.ts
    - src/__tests__/runtask.test.ts
    - CLAUDE.md
    - README.md
decisions:
  - "Used @cf/moonshotai/kimi-k2.5 (fallback): kimi-k2.7-code absent from regenerated AiModels interface"
  - "Rule 1 auto-fix: runtask.test.ts line 302 hardcoded qwen3 model string for standard-tier kind; updated to DEFAULT_MODELS.standard constant reference"
metrics:
  duration: ~15 minutes
  completed: 2026-06-28T06:13:32Z
  tasks_completed: 3
  files_modified: 5
---

# Phase 9 Plan 01: Second Model and Tier Split Summary

**One-liner:** Two-tier model routing made real — `fast` stays qwen3-30b, `standard` now resolves to Kimi-k2.5 coding model, with allowlist and KV self-healing preserved.

## What Was Built

Pointed the dormant `standard` tier at `@cf/moonshotai/kimi-k2.5`, making the two-tier abstraction deliver differentiated models. The `fast` tier remains `@cf/qwen/qwen3-30b-a3b-fp8`. Both are in `ALLOWED_MODELS` with the `as const satisfies ReadonlyArray<keyof AiModels>` compile-time proof intact.

## Task Outcomes

| Task | Name | Commit | Key Changes |
|------|------|--------|-------------|
| 1 | Types gate + ALLOWED_MODELS + DEFAULT_MODELS | 870a4dc | Added `@cf/moonshotai/kimi-k2.5` to ALLOWED_MODELS; changed DEFAULT_MODELS.standard; ran `npm run types` |
| 2 | New model-routing test cases | 7dcc208 | 3 new cases in model-routing.test.ts; Rule 1 fix in runtask.test.ts |
| 3 | Model Tiers docs update | 9f14895 | CLAUDE.md standard row; README.md Tiers sentence + diagram label |

## Kimi ID Decision

- **Ran:** `npm run types` (wrangler types) to regenerate `worker-configuration.d.ts`
- **Checked:** `@cf/moonshotai/kimi-k2.7-code` — **absent** from the regenerated `AiModels` interface
- **Chosen:** `@cf/moonshotai/kimi-k2.5` — confirmed present as a key of `AiModels` in the generated types
- **Rationale:** The `as const satisfies ReadonlyArray<keyof AiModels>` constraint is the compile-time proof; any non-existent id would cause a type error

## Behavior-Preservation Invariant

- Tier names (`"fast"` / `"standard"`) unchanged
- KV override keys (`config:model:fast` / `config:model:standard`) unchanged
- `resolveModel`, `isAllowedModel`, `TASK_SPECS`, all handlers, all prompts: untouched
- KV self-heal path (delete-invalid-and-fall-back) structurally intact — confirmed by existing self-heal test (unchanged) passing

## Test Results

- **Full suite:** 165 passed, 1 skipped (pre-existing), 0 failed
- **New cases in model-routing.test.ts:** 3 added (isAllowedModel standard, resolveModel standard diverges from fast, resolveModel fast unchanged) — all green
- **runtask.test.ts and observability.test.ts:** pass with no assertion changes (they assert tier names, not models)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed hardcoded model string assertion in runtask.test.ts**

- **Found during:** Task 2 (full suite run after adding new model-routing cases)
- **Issue:** `runtask.test.ts:302` asserted `result.model === "@cf/qwen/qwen3-30b-a3b-fp8"` for `generateCode` (a standard-tier kind). Once `DEFAULT_MODELS.standard` changed to kimi-k2.5, this assertion failed.
- **Fix:** Added `DEFAULT_MODELS` to the import from `../index`; changed line 302 to `expect(result.model).toBe(DEFAULT_MODELS.standard)` — matching the constant-reference style used throughout model-routing.test.ts.
- **Files modified:** `src/__tests__/runtask.test.ts`
- **Commit:** 7dcc208

### TypeScript Error Baseline Note

`npx tsc --noEmit` produces 30 pre-existing errors in the main repo and 32 in the worktree. The 2 additional are the same `Env` type mismatch (wrangler-generated Env vs mock Env) that affects ALL `createMockEnv()` call sites — the 2 new test functions I added each generate one instance of the same error. This is a pre-existing environment-level type issue, not introduced by this plan. Vitest runs successfully regardless.

## Known Stubs

None. All wiring is real: `DEFAULT_MODELS.standard` resolves to the real Kimi model id at runtime via `resolveModel`.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes. The only security-relevant change (expanding `ALLOWED_MODELS`) is guarded by the existing `isAllowedModel` gate on KV overrides — T-09-01 and T-09-02 mitigations confirmed intact.

## Self-Check: PASSED

- `src/index.ts` — FOUND: ALLOWED_MODELS contains both qwen3 and kimi-k2.5; DEFAULT_MODELS.standard = kimi-k2.5
- `src/__tests__/model-routing.test.ts` — FOUND: 3 new cases referencing DEFAULT_MODELS constants
- `src/__tests__/runtask.test.ts` — FOUND: DEFAULT_MODELS import added; line 302 uses DEFAULT_MODELS.standard
- `CLAUDE.md` — FOUND: standard row Default = @cf/moonshotai/kimi-k2.5
- `README.md` — FOUND: Tiers sentence and diagram label updated with kimi-k2.5
- Commits 870a4dc, 7dcc208, 9f14895 — FOUND in git log
- `npm test` — 165 passed, 1 skipped, 0 failed
