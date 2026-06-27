# Phase 08 Deferred Items

## Pre-existing tsc --noEmit Env type conflict

**Discovered:** Task 3 build gate (Phase 08-01)
**Category:** TypeScript type-checking

### Issue

`npx tsc --noEmit` fails across all test files with two error categories:

1. `Argument of type 'Env' is not assignable to parameter of type 'Env'`
   - Root cause: `worker-configuration.d.ts` declares `Cloudflare.Env` without `MCP_SECRET`
     (wrangler secrets are not surfaced in generated types), while `src/index.ts` has a private
     `interface Env` that includes `MCP_SECRET`. Tests use `createMockEnv()` from helpers.ts which
     returns the full Env including MCP_SECRET. The two ambient Env types conflict.

2. `Request<CfProperties<unknown>>` not assignable to `Request<IncomingRequestCfProperties<unknown>>`
   - Root cause: `new Request(...)` in test files creates a `Request<CfProperties>` but some
     function signatures expect `Request<IncomingRequestCfProperties>`.

### Affected files (pre-existing — all committed before Phase 08)

- src/__tests__/auth-flow.test.ts
- src/__tests__/batch-tool.test.ts
- src/__tests__/model-routing.test.ts
- src/__tests__/observability.test.ts
- src/__tests__/rate-limiting.test.ts
- src/__tests__/runtask.test.ts
- src/__tests__/tool-handlers.test.ts
- src/__tests__/input-validation.test.ts
- src/__tests__/batch-e2e.test.ts (Phase 08 addition — same pattern)

### Fix options

A. Export `Env` from `src/index.ts` and import it in test helpers instead of relying on global
   ambient type. Tests would import `Env` explicitly.
B. Add a `src/__tests__/env-types.d.ts` module augmentation that extends `Cloudflare.Env` with
   `MCP_SECRET: string`.
C. Add a `tsconfig.test.json` that excludes the conflicting type definitions for test files.

### Impact

None on runtime behavior — vitest Workers pool resolves types correctly in its own context.
Tests pass. Only affects IDE type hints and `tsc --noEmit` static analysis.

### Recommended fix

Option A (export `Env` from src/index.ts and import it in helpers.ts) is cleanest but requires
modifying source. Option B (module augmentation) is non-invasive. Defer to a maintenance pass.
