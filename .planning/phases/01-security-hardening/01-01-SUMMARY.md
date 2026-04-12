---
phase: 01-security-hardening
plan: 01
subsystem: test-infrastructure
tags: [vitest, cloudflare-workers, test-stubs, ci]
dependency_graph:
  requires: []
  provides: [test-runner, test-stubs-sec-01, test-stubs-sec-02, test-stubs-sec-03, test-stubs-sec-04, test-stubs-hard-02, test-stubs-hard-03]
  affects: [01-02, 01-03, 01-04]
tech_stack:
  added: [vitest@4.1.4, "@cloudflare/vitest-pool-workers@0.14.3"]
  patterns: [cloudflarePool-runner, remoteBindings-false, mts-config-extension]
key_files:
  created:
    - vitest.config.mts
    - src/__tests__/model-routing.test.ts
    - src/__tests__/input-validation.test.ts
    - src/__tests__/rate-limiting.test.ts
    - src/__tests__/error-sanitization.test.ts
  modified:
    - package.json
    - package-lock.json
decisions:
  - Use vitest.config.mts (not .ts) because @cloudflare/vitest-pool-workers is ESM-only and .mts forces ESM interpretation during Vite config loading
  - Set remoteBindings:false in cloudflarePool options to prevent wrangler from attempting remote proxy (which requires auth) when KV namespace ID is a placeholder
  - Use cloudflarePool() API (not deprecated defineWorkersConfig) — v4 of @cloudflare/vitest-pool-workers removed defineWorkersConfig and the /config subpath export
metrics:
  duration: 4m
  completed_date: "2026-04-12"
  tasks_completed: 2
  tasks_total: 2
  files_created: 5
  files_modified: 2
---

# Phase 1 Plan 01: Test Infrastructure Setup Summary

Vitest 4.x configured with Cloudflare Workers pool and 4 test stub files covering all 6 Phase 1 security requirements, with `npm test` exiting 0 and reporting 28 todo tests.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Install vitest and configure for Cloudflare Workers | 4ceae9d | package.json, package-lock.json, vitest.config.mts |
| 2 | Create test stub files for all Phase 1 requirements | d903cda | src/__tests__/model-routing.test.ts, src/__tests__/input-validation.test.ts, src/__tests__/rate-limiting.test.ts, src/__tests__/error-sanitization.test.ts |

## Verification

- `npx vitest --version` → `vitest/4.1.4`
- `npm test` exits 0
- 28 todo tests discovered across 4 files
- All 6 phase requirements covered: SEC-01, SEC-02, SEC-03, SEC-04, HARD-02, HARD-03

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] vitest-pool-workers v4 removed defineWorkersConfig and /config subpath**
- **Found during:** Task 1 verification
- **Issue:** Plan specified `import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config"` but v4 of the package removed both the `/config` subpath export and the `defineWorkersConfig` function entirely
- **Fix:** Replaced with `import { cloudflarePool } from "@cloudflare/vitest-pool-workers"` and used `pool: cloudflarePool({...})` in the standard `defineConfig` from vitest
- **Files modified:** vitest.config.mts
- **Commit:** 4ceae9d

**2. [Rule 3 - Blocking] vitest.config.ts fails to load ESM-only package**
- **Found during:** Task 1 verification
- **Issue:** `@cloudflare/vitest-pool-workers` is ESM-only; Vite tried to `require()` it from a `.ts` config file in a CJS project (no `"type": "module"` in package.json), causing a build error
- **Fix:** Renamed `vitest.config.ts` to `vitest.config.mts` — the `.mts` extension forces ESM interpretation regardless of package.json `type` field
- **Files modified:** vitest.config.mts (renamed from .ts)
- **Commit:** 4ceae9d

**3. [Rule 3 - Blocking] Placeholder KV namespace ID triggered wrangler remote proxy auth gate**
- **Found during:** Task 2 verification
- **Issue:** wrangler.toml has `id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"` which caused wrangler to attempt a remote proxy session, failing with "You must be logged in to use wrangler dev in remote mode"
- **Fix:** Added `remoteBindings: false` to `cloudflarePool` options so tests run fully locally via Miniflare, bypassing the remote proxy entirely
- **Files modified:** vitest.config.mts
- **Commit:** d903cda

## Known Stubs

All 28 tests are intentional stubs (it.todo) — this is the plan's stated goal. No unintentional stubs exist.

| File | Stub Count | Requirement |
|------|-----------|-------------|
| src/__tests__/model-routing.test.ts | 7 | SEC-01, SEC-03 |
| src/__tests__/input-validation.test.ts | 12 | SEC-02, HARD-03 |
| src/__tests__/rate-limiting.test.ts | 4 | HARD-02 |
| src/__tests__/error-sanitization.test.ts | 5 | SEC-04 |

These stubs will be implemented in Phase 3 (test infrastructure) after Phase 1 security hardening plans (01-02 through 01-04) add the actual implementations.

## Threat Flags

None — this plan creates test infrastructure only. No new trust boundaries, network endpoints, or auth paths introduced.

## Self-Check: PASSED

Files exist:
- vitest.config.mts: FOUND
- src/__tests__/model-routing.test.ts: FOUND
- src/__tests__/input-validation.test.ts: FOUND
- src/__tests__/rate-limiting.test.ts: FOUND
- src/__tests__/error-sanitization.test.ts: FOUND

Commits exist:
- 4ceae9d: FOUND (chore(01-01): install vitest and configure Cloudflare Workers pool)
- d903cda: FOUND (test(01-01): add test stub files for all Phase 1 security requirements)
