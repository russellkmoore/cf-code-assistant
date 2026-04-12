# Roadmap: CF Code Assistant

## Overview

The codebase was built in a single session and ships the core value — offloading mechanical code generation from Claude to Workers AI. This roadmap hardens it for production: start with a clean git baseline, eliminate the security attack surface, make error handling explicit, establish test coverage for every critical path, and add structured observability. Each phase leaves the server more reliable and trustworthy than the last.

## Phases

**Phase Numbering:**
- Integer phases (0, 1, 2, ...): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 0: Repository Foundation** - Initialize git with .gitignore and capture the current codebase as baseline
- [ ] **Phase 1: Security Hardening** - Eliminate type-safety holes, validate all inputs, cap sizes, protect auth from brute force
- [ ] **Phase 2: Error Handling & Reliability** - Wrap all AI calls with timeouts and structured error responses
- [ ] **Phase 3: Test Infrastructure** - Configure vitest, mock AI calls, cover all critical paths with unit and integration tests
- [ ] **Phase 4: Observability** - Add structured logging for tool invocations, errors, and auth events

## Phase Details

### Phase 0: Repository Foundation
**Goal**: The codebase is version-controlled with a clean baseline commit and up-to-date setup documentation
**Depends on**: Nothing (first phase)
**Requirements**: INFRA-01, INFRA-02
**Success Criteria** (what must be TRUE):
  1. `git log` shows an initial commit containing all current source files
  2. `.gitignore` excludes node_modules, .dev.vars, wrangler secrets, and build artifacts
  3. SETUP.md reflects the current deployment steps including hardening changes planned in subsequent phases
  4. A developer can clone the repo and follow SETUP.md to deploy without ambiguity
**Plans**: TBD

### Phase 1: Security Hardening
**Goal**: The server rejects malformed inputs, validates model names, protects auth from brute force, and uses type-safe model routing
**Depends on**: Phase 0
**Requirements**: SEC-01, SEC-02, SEC-03, SEC-04, HARD-02, HARD-03
**Success Criteria** (what must be TRUE):
  1. The `as any` cast on Workers AI model routing is replaced with type-safe narrowing — TypeScript strict mode passes clean
  2. Tool inputs with oversized code or context payloads are rejected with a 400 before reaching Workers AI
  3. Model names read from KV are validated against an allowlist — an unrecognized model name never reaches `ai.run()`
  4. More than 5 PIN attempts within 60 seconds from the same IP returns 429 without processing the attempt
  5. Error responses to clients never include stack traces, internal state, or KV contents

**Plans:** 4 plans

- [x] 01-01-PLAN.md — Test infrastructure setup (vitest + Workers pool + test stubs)
- [x] 01-02-PLAN.md — Type-safe model routing and allowlist validation (SEC-01, SEC-03)
- [ ] 01-03-PLAN.md — Input size caps and auth form validation (SEC-02, HARD-03)
- [ ] 01-04-PLAN.md — Rate limiting and error sanitization (HARD-02, SEC-04)

### Phase 2: Error Handling & Reliability
**Goal**: All AI calls handle timeouts and failures gracefully, and every failure mode returns a structured error response
**Depends on**: Phase 1
**Requirements**: HARD-01, HARD-04
**Success Criteria** (what must be TRUE):
  1. A Workers AI timeout or 5xx response causes the tool to return a descriptive error message to Claude rather than crashing the worker
  2. Auth form parsing failures (malformed POST body, invalid JSON in KV) return 400 with a user-readable message instead of an unhandled 500
  3. `oauthHelpers.parseAuthRequest()` and `completeAuthorization()` failures are caught and return appropriate HTTP error responses
  4. The KV-based model fallback handles secondary KV failures without entering an infinite retry loop
**Plans**: TBD

### Phase 3: Test Infrastructure
**Goal**: Every critical path — model resolution, auth flow, tool handlers, and error paths — is covered by automated tests that mock AI calls
**Depends on**: Phase 2
**Requirements**: TEST-01, TEST-02, TEST-03, TEST-04, TEST-05
**Success Criteria** (what must be TRUE):
  1. `npm test` runs without errors and produces a coverage report — no real Workers AI calls are made
  2. Unit tests verify model resolution selects the correct tier and falls back to defaults when KV returns an invalid model
  3. Unit tests verify timing-safe comparison rejects wrong secrets and accepts correct ones
  4. Integration tests exercise the full auth flow: CSRF token creation, PIN submission, token exchange
  5. Tests for error paths cover AI timeout, invalid model name, expired CSRF token, and rate limit enforcement
**Plans**: TBD

### Phase 4: Observability
**Goal**: Tool invocations, auth events, and errors are all logged with structured context visible in Cloudflare dashboard
**Depends on**: Phase 3
**Requirements**: OBS-01, OBS-02, OBS-03
**Success Criteria** (what must be TRUE):
  1. Every tool invocation produces a log entry containing tool name, model tier, model used, and latency in milliseconds
  2. Every error produces a log entry containing the tool name, input size, and error type — no stack traces or secrets in log output
  3. Auth events (attempt, success, failure, rate limit hit) each produce a distinct structured log entry
  4. Cloudflare Workers tail logs show all three log categories without additional configuration
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 0 → 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 0. Repository Foundation | 0/TBD | Not started | - |
| 1. Security Hardening | 0/4 | Planned | - |
| 2. Error Handling & Reliability | 0/TBD | Not started | - |
| 3. Test Infrastructure | 0/TBD | Not started | - |
| 4. Observability | 0/TBD | Not started | - |
