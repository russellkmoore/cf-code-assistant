---
phase: 03-test-infrastructure
fixed_at: 2026-04-12T00:00:00Z
review_path: .planning/phases/03-test-infrastructure/03-REVIEW.md
iteration: 1
findings_in_scope: 5
fixed: 5
skipped: 0
status: all_fixed
---

# Phase 3: Code Review Fix Report

**Fixed at:** 2026-04-12T00:00:00Z
**Source review:** .planning/phases/03-test-infrastructure/03-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 5
- Fixed: 5
- Skipped: 0

## Fixed Issues

### CR-01 + CR-02: XSS in errorPage and loginPage via unsanitized HTML interpolation

**Files modified:** `src/index.ts`
**Commit:** a0cf09e
**Applied fix:** Added `escapeHtml()` utility function that escapes `&`, `<`, `>`, `"`, and `'`. Applied it to `heading` and `message` interpolations in `errorPage()`, and to `csrfToken` in `loginPage()` (via a `safeToken` local variable). Both critical XSS vectors are now neutralized with defense-in-depth escaping.

### WR-01: test:coverage script does not reference vitest.coverage.config.mts

**Files modified:** `package.json`
**Commit:** cc2389b
**Applied fix:** Added `--config vitest.coverage.config.mts` to the `test:coverage` script so it uses the node pool configuration instead of the cloudflare pool (which crashes with Istanbul instrumentation).

### WR-02: Vacuous test in error-sanitization -- tests a constant, not behavior

**Files modified:** `src/__tests__/error-sanitization.test.ts`
**Commit:** d82b101
**Applied fix:** Removed the vacuous test that asserted a local string constant did not contain the secret. Replaced with a comment explaining the removal and pointing to the proper integration test in `auth-flow.test.ts`.

### WR-03: Tests access private SDK internals via _registeredTools

**Files modified:** `src/__tests__/tool-handlers.test.ts`, `src/__tests__/input-validation.test.ts`
**Commit:** 0a0ccaf
**Applied fix:** Added WARNING comments to both `getToolHandler()` and `getToolSchema()` helper functions documenting the SDK internals dependency and providing guidance for what to check if the SDK changes its internal structure.

---

_Fixed: 2026-04-12T00:00:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
