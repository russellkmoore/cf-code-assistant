---
phase: 03
slug: test-infrastructure
status: verified
threats_open: 0
asvs_level: 1
created: 2026-04-12
---

# Phase 03 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| test-to-production | Named exports and authHandler export added for testing must not change runtime behavior | Function references (no secrets) |
| mock-to-real | Mock KV/RateLimiter behavior must match real Cloudflare binding semantics | Test data only |
| tool-input-to-handler | Zod schemas validate input before handler logic; tests verify this boundary | User-supplied strings |
| mock-AI-to-handler | Mocked AI responses exercise handler error paths without real inference | Synthetic responses |

---

## Threat Register

| Threat ID | Category | Component | Disposition | Mitigation | Status |
|-----------|----------|-----------|-------------|------------|--------|
| T-03-01 | Information Disclosure | Named exports in index.ts | accept | Exports expose function signatures only; worker is deployed as a bundle with tree-shaking. No secrets exposed. | closed |
| T-03-02 | Tampering | Mock factories in helpers.ts | accept | Test-only file in __tests__/ directory, never imported by production code, excluded from worker bundle by wrangler. | closed |
| T-03-03 | Information Disclosure | authHandler export | accept | authHandler is already the default handler's delegate; exporting it does not expose new attack surface. | closed |
| T-03-04 | Spoofing | Mock rate limiter in tests | accept | Test-only concern. Mocks verify branching logic, not binding enforcement. Real rate limiting provided by Cloudflare runtime. | closed |
| T-03-05 | Denial of Service | Input validation bypass | mitigate | Tests verify zod .max() constraints reject oversized inputs at each tool's entry point. 23 input validation tests confirm all boundaries enforced. | closed |
| T-03-06 | Tampering | McpServer internal access in tests | accept | Accessing _registeredTools is test-only. If internals change, tests break loudly. No production impact. SDK fragility warning added per WR-03 fix. | closed |

*Status: open · closed*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-01 | T-03-01 | Named exports only expose function references already accessible at runtime; tree-shaken in production bundle | Claude (gsd-security-auditor) | 2026-04-12 |
| AR-02 | T-03-02 | helpers.ts is in __tests__/ and excluded from wrangler bundle; cannot reach production | Claude (gsd-security-auditor) | 2026-04-12 |
| AR-03 | T-03-03 | authHandler already delegated from default export; no new attack surface from named export | Claude (gsd-security-auditor) | 2026-04-12 |
| AR-04 | T-03-04 | Mock rate limiter is test-only; real enforcement is Cloudflare runtime binding | Claude (gsd-security-auditor) | 2026-04-12 |
| AR-05 | T-03-06 | SDK internal access is test-only; breaks loudly on SDK changes (desired behavior) | Claude (gsd-security-auditor) | 2026-04-12 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-04-12 | 6 | 6 | 0 | Claude (gsd-security-auditor) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-04-12
