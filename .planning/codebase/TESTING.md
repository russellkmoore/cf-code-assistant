# Testing Patterns

**Analysis Date:** 2026-04-12

## Test Framework

**Runner:**
- Not detected - No test framework configured or installed
- No jest, vitest, mocha, or other test runners in dependencies

**Assertion Library:**
- Not detected - No assertion library present

**Run Commands:**
- No test scripts defined in `package.json`
- Scripts available: `npm run dev` (wrangler dev), `npm run deploy`, `npm run types`

## Test File Organization

**Location:**
- No test files present in codebase
- No `.test.ts`, `.spec.ts`, or `__tests__` directories found

**Naming:**
- Not applicable (no tests exist)

**Structure:**
- Not applicable (no tests exist)

## Testing Status

**Current State:**
- Zero test coverage observed
- No unit tests
- No integration tests
- No end-to-end tests

**Gap Analysis:**
The following areas lack test coverage:

**Critical Untested Functions:**
- `resolveModel()` - KV lookup with fallback logic (lines 18-22 in `src/index.ts`)
  - Should test: normal KV hit, KV miss, edge cases with tier parameter
  - Risk: Configuration errors could silently use wrong models

- `runAI()` - Error recovery and retry logic (lines 115-134 in `src/index.ts`)
  - Should test: success path, model error detection, retry with default, non-recoverable errors
  - Risk: Model configuration issues could cause cascading failures

- Tool handlers (lines 144-399 in `src/index.ts`)
  - Each tool has async handler: `generateCode`, `reviewCode`, `transformCode`, `scaffoldTests`, `quickTask`, `explainCode`, `generateDocs`, `generateTypes`, `fixBug`, `generateCommitMessage`, `generateWorkerBoilerplate`
  - Should test: prompt construction, AI call invocation, response formatting
  - Risk: Malformed prompts could cause generation failures; missing context handling

- Auth handler (lines 406-451 in `src/index.ts`)
  - `fetch()` handler: GET /authorize, POST /authorize, 404 fallback
  - Should test: CSRF token generation/validation, secret verification, form parsing, redirect handling
  - Risk: CSRF bypass, timing attacks on secret comparison, session fixation

- `timingSafeEqual()` - Constant-time string comparison (lines 454-460 in `src/index.ts`)
  - Should test: equal strings, different lengths, byte-level equality
  - Risk: Timing-based attacks on secret validation if not constant-time

- `loginPage()` - HTML template rendering (lines 462-491 in `src/index.ts`)
  - Should test: CSRF token injection, HTML escaping, malicious token handling
  - Risk: XSS vulnerabilities if CSRF token not properly escaped

## Recommended Testing Approach

**Test Framework Selection:**
- Vitest recommended for TypeScript/Worker environment
  - Zero config with TypeScript support
  - Fast unit testing with async/await support
  - Compatible with Node compatibility layer in Workers

**Async Testing Pattern (when tests are added):**
Should follow this pattern based on function signatures:
```typescript
// Example pattern for async functions
describe('runAI', () => {
  it('should retry with default model on model error', async () => {
    // Setup: mock env.AI.run to throw model error
    // Execute: call runAI with non-default model
    // Assert: verify OAUTH_KV.delete called, then callModel called with DEFAULT_MODELS
  });
});
```

**Mock Strategy:**
- Mock `env.AI.run()` for unit tests (Cloudflare Workers AI integration)
- Mock `env.OAUTH_KV` operations (get/put/delete)
- Mock `OAuthHelpers` for authorization flow
- Consider integration tests against real KV namespace in staging

## What to Test

**Highest Priority (Security & Correctness):**
1. `timingSafeEqual()` - Timing attack prevention
2. Auth handler CSRF validation - Token generation, storage, verification
3. `runAI()` error recovery - Model config fallback behavior
4. Secret verification - Password comparison in authorization

**Medium Priority (Business Logic):**
5. All tool handlers - Prompt construction, AI invocation, response formatting
6. Model tier resolution - Fast vs standard selection
7. KV-based configuration - Config retrieval and defaults

**Lower Priority (Helper Functions):**
8. `loginPage()` - HTML generation with token injection
9. `callModel()` - Response parsing and error propagation

## Coverage Goals

**Recommendations:**
- Minimum 80% coverage for auth handler (security critical)
- Minimum 70% coverage for AI functions (core business logic)
- Minimum 90% coverage for `timingSafeEqual()` (all paths)

## Error Testing Pattern (when tests are added)

Based on existing error handling at lines 120-132, tests should validate:
```typescript
// Error detection pattern observed
const isModelError = 
  err instanceof Error &&
  (err.message.includes("Unknown model") ||
   err.message.includes("not found") ||
   err.message.includes("invalid model"));
```

Tests should:
- Throw errors with these specific messages
- Verify fallback behavior triggers
- Verify error re-throw for non-model errors
- Test boundary: when model equals DEFAULT_MODELS[tier]

## Fixtures and Factories (recommendations for future tests)

**Test Data Locations (when created):**
- `src/__tests__/fixtures/` - Mock env, auth request, KV data
- `src/__tests__/factories/` - Factory functions for Env, Request objects

**Example fixtures needed:**
```typescript
// Mock Env with all bindings
const mockEnv: Env = {
  AI: { run: jest.fn() },
  OAUTH_KV: { get: jest.fn(), put: jest.fn(), delete: jest.fn() },
  MCP_SECRET: "test-secret"
};

// Mock CloudFlare Request/Response
// Mock OAuthHelpers
```

## Observability for Testing

**Current observability setup:**
- `[observability] enabled = true` in `wrangler.toml`
- Cloudflare Workers logging available
- No structured test reporting configured

**For future testing:**
- Can use Cloudflare Workers logs for integration test debugging
- No local test coverage reporting tools present

---

*Testing analysis: 2026-04-12*
