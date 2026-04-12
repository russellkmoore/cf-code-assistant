---
phase: 01-security-hardening
plan: 02
subsystem: model-routing
tags: [type-safety, allowlist, sec-01, sec-03, workers-ai]
dependency_graph:
  requires: []
  provides: [type-safe-model-routing, allowlist-validation]
  affects: [src/index.ts]
tech_stack:
  added: []
  patterns: [satisfies-type-guard, keyof-AiModels, allowlist-validation]
key_files:
  created: []
  modified:
    - src/index.ts
decisions:
  - "Used `as const satisfies ReadonlyArray<keyof AiModels>` for compile-time validation of allowlist entries against generated AiModels interface — not a cast, a real constraint"
  - "Removed runAI try/catch: resolveModel now owns invalid-model recovery via allowlist, making runtime retry logic redundant and removing an error-exposure code path"
metrics:
  duration: "~5 minutes"
  completed: "2026-04-12T23:42:12Z"
  tasks_completed: 2
  files_modified: 1
---

# Phase 01 Plan 02: Type-Safe Model Routing Summary

Type-safe allowlist-validated model routing replacing `as any` cast and runtime model-error detection with compile-time enforcement via `keyof AiModels` and `isAllowedModel()` type guard.

## What Was Built

Two targeted changes to `src/index.ts`:

**Task 1 — Allowlist and type guard (commit 0078510)**
- `ALLOWED_MODELS` const array with `as const satisfies ReadonlyArray<keyof AiModels>` — compile-time proof that every listed model exists in the Workers AI type registry
- `AllowedModel` type alias derived from the array
- `isAllowedModel(model: string): model is AllowedModel` type guard for runtime validation
- `DEFAULT_MODELS` re-typed as `Record<ModelTier, keyof AiModels>` (was `string`)
- `resolveModel` rewritten to validate KV overrides against allowlist; invalid entries deleted from KV and default returned (self-healing preserved)

**Task 2 — callModel and runAI simplification (commit fdfce66)**
- `callModel` `model` param changed from `string` to `keyof AiModels`
- `as any` cast removed from `env.AI.run()` call
- `eslint-disable-next-line @typescript-eslint/no-explicit-any` comment removed
- `runAI` simplified from 15 lines with try/catch to 2 lines — `resolveModel` now owns recovery, making the `isModelError` runtime detection path unnecessary

## Verification

- `npx tsc --noEmit` exits 0 (zero errors)
- `grep -c "as any" src/index.ts` returns 0
- `grep -c "eslint-disable" src/index.ts` returns 0
- `grep "keyof AiModels" src/index.ts` shows 4 occurrences (ALLOWED_MODELS satisfies, DEFAULT_MODELS, resolveModel return, callModel param)
- `isAllowedModel` present and used in resolveModel
- Self-healing: `await env.OAUTH_KV.delete(kvKey)` inside resolveModel on invalid model

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 0078510 | feat(01-02): add ALLOWED_MODELS allowlist and isAllowedModel type guard |
| 2 | fdfce66 | feat(01-02): type-narrow callModel and simplify runAI error handling |

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None — changes are internal to existing trust boundaries. No new network endpoints, auth paths, or schema changes introduced.

## Self-Check: PASSED

- [x] `src/index.ts` modified and verified via `npx tsc --noEmit`
- [x] Commit `0078510` exists (Task 1)
- [x] Commit `fdfce66` exists (Task 2)
- [x] Zero `as any` casts in `src/index.ts`
- [x] Zero `eslint-disable` comments in `src/index.ts`
- [x] `isAllowedModel` type guard present
- [x] `ALLOWED_MODELS` allowlist present with `satisfies ReadonlyArray<keyof AiModels>`
- [x] `resolveModel` returns `Promise<keyof AiModels>`
- [x] `callModel` accepts `model: keyof AiModels`
- [x] Self-healing (KV delete on invalid model) preserved in `resolveModel`
