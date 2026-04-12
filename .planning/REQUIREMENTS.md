# Requirements: CF Code Assistant

**Defined:** 2026-04-12
**Core Value:** Reduce Claude API token costs on mechanical code tasks without sacrificing output quality

## v1 Requirements

Requirements for production-grade hardening. Each maps to roadmap phases.

### Error Handling & Reliability

- [ ] **HARD-01**: All AI calls wrapped with timeout handling and graceful degradation
- [ ] **HARD-02**: Rate limiting on auth PIN attempts (max 5 per minute per IP)
- [ ] **HARD-03**: Input validation on all tool inputs and auth form data
- [ ] **HARD-04**: Structured error responses for all failure modes (AI timeout, invalid input, rate limited)

### Security

- [ ] **SEC-01**: Eliminate `as any` type cast on dynamic model name — use proper type narrowing
- [ ] **SEC-02**: Cap input sizes on tool parameters (code, context, diff) to prevent abuse
- [ ] **SEC-03**: Validate model names from KV against an allowlist before calling Workers AI
- [ ] **SEC-04**: Sanitize error messages — never leak internal state or stack traces to clients

### Testing

- [ ] **TEST-01**: Unit tests for model resolution and self-healing fallback logic
- [ ] **TEST-02**: Unit tests for timing-safe comparison and auth flow
- [ ] **TEST-03**: Integration tests for tool handlers with mocked AI responses
- [ ] **TEST-04**: Tests for error paths (AI failure, invalid model, expired CSRF, rate limit)
- [ ] **TEST-05**: Test framework configured (vitest) with CI-ready scripts

### Observability

- [ ] **OBS-01**: Structured logging for tool invocations (tool name, tier, model, latency)
- [ ] **OBS-02**: Error logging with context (tool, input size, error type)
- [ ] **OBS-03**: Auth event logging (attempts, successes, failures, rate limit hits)

### Infrastructure

- [ ] **INFRA-01**: Git repository initialized with .gitignore and initial commit
- [ ] **INFRA-02**: SETUP.md updated with hardening changes and deployment instructions

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Extended Features

- **EXT-01**: Per-tool model override (allow specific tools to use specific models)
- **EXT-02**: Response caching for identical inputs (KV-backed, TTL-based)
- **EXT-03**: Usage metrics tool (token counts, call counts, cost estimates)
- **EXT-04**: Health check endpoint for monitoring

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-user support | Personal server, single owner |
| Admin UI | KV dashboard sufficient for 2 config keys |
| Streaming responses | Not needed for MCP tool outputs |
| Third-party OAuth | PIN auth sufficient for single user |
| Usage dashboard | Cloudflare dashboard provides natively |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| INFRA-01 | Phase 0 | Pending |
| INFRA-02 | Phase 0 | Pending |
| SEC-01 | Phase 1 | Pending |
| SEC-02 | Phase 1 | Pending |
| SEC-03 | Phase 1 | Pending |
| SEC-04 | Phase 1 | Pending |
| HARD-02 | Phase 1 | Pending |
| HARD-03 | Phase 1 | Pending |
| HARD-01 | Phase 2 | Pending |
| HARD-04 | Phase 2 | Pending |
| TEST-01 | Phase 3 | Pending |
| TEST-02 | Phase 3 | Pending |
| TEST-03 | Phase 3 | Pending |
| TEST-04 | Phase 3 | Pending |
| TEST-05 | Phase 3 | Pending |
| OBS-01 | Phase 4 | Pending |
| OBS-02 | Phase 4 | Pending |
| OBS-03 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 18 total
- Mapped to phases: 18
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-12*
*Last updated: 2026-04-12 — traceability updated after roadmap creation*
