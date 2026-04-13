# CF Code Assistant

## What This Is

A Cloudflare Workers MCP server that offloads mechanical code generation tasks from Claude (Sonnet/Opus) to @cf/qwen/qwen3-30b-a3b-fp8 via Workers AI. Claude remains the orchestrator — handling research, context gathering, architecture decisions, and workflow commands. This server handles the generation after Claude has assembled the context. Protected by OAuth 2.1 with a self-contained PIN-based auth flow.

## Core Value

Reduce Claude API token costs on mechanical code tasks without sacrificing output quality — every tool call that doesn't need Claude's reasoning saves tokens.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

- ✓ **TOOL-01**: 12 MCP tools registered and functional (generateCode, reviewCode, transformCode, scaffoldTests, quickTask, explainCode, generateDocs, generateTypes, fixBug, generateCommitMessage, generateWorkerBoilerplate, routingInfo) — built this session
- ✓ **AUTH-01**: OAuth 2.1 authorization with PIN-based self-contained auth flow — built this session
- ✓ **MODEL-01**: Two-tier model routing (fast/standard) with KV-backed config — built this session
- ✓ **MODEL-02**: Self-healing model config (auto-revert to default on invalid model) — built this session
- ✓ **INFRA-01**: Workers AI binding, KV namespace for OAuth/config, observability enabled — built this session

### Active

<!-- Current scope. Building toward these. -->

- ✓ **HARD-01**: Graceful error handling on all AI calls — timeouts, malformed responses, rate limits — Validated in Phase 2: Error Handling & Reliability
- ✓ **HARD-02**: Rate limiting on auth PIN attempts to prevent brute force — Validated in Phase 1: Security Hardening
- ✓ **HARD-03**: Input validation and sanitization on all tool inputs and auth form data — Validated in Phase 1: Security Hardening
- ✓ **HARD-04**: Structured error responses for all failure modes — Validated in Phase 2: Error Handling & Reliability
- [ ] **TEST-01**: Unit tests for model resolution and self-healing fallback logic
- [ ] **TEST-02**: Unit tests for timing-safe comparison and auth flow
- [ ] **TEST-03**: Integration tests for tool handlers (mock AI responses)
- [ ] **TEST-04**: Test coverage for error paths (AI failure, invalid model, expired CSRF)
- ✓ **SEC-01**: Type safety cleanup — eliminate `as any` cast on dynamic model routing — Validated in Phase 1: Security Hardening
- ✓ **SEC-02**: Validate tool input sizes to prevent abuse (cap code/context length) — Validated in Phase 1: Security Hardening
- [ ] **OBS-01**: Request/response logging with tool name, tier, model used, latency
- [ ] **INFRA-02**: Git repository initialized with proper .gitignore and initial commit

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- Multi-user support — this is a personal server, single-owner only
- Admin UI — KV dashboard is sufficient for model config changes
- Streaming responses — not needed for MCP tool outputs
- Third-party OAuth providers — PIN auth is simpler and sufficient for single user
- Usage analytics dashboard — Cloudflare dashboard provides this natively

## Context

- Brownfield project built in a single session, now being formalized
- Codebase mapped in `.planning/codebase/` — 7 documents covering stack, architecture, conventions, testing, integrations, structure, and concerns
- CONCERNS.md identified 9 areas of concern: type safety, error handling, auth gaps, logging, test coverage, dependency risks, fragile areas, scaling limits, config gaps
- Phase 1 complete — security hardening shipped (type safety, input validation, rate limiting, error sanitization)
- Phase 2 complete — error handling & reliability shipped (AI timeout, KV fallback, structured MCP errors, auth error pages)
- Test stubs in place (28 todos) — will be filled in Phase 3
- Workers AI model ecosystem changes frequently — dynamic model config via KV is key to staying current

## Constraints

- **Runtime**: Cloudflare Workers (V8 isolate, no Node.js APIs beyond nodejs_compat)
- **Auth**: Must use MCP-standard OAuth 2.1 (Claude Code expects this)
- **Cost**: Workers AI usage charges even in dev — tests should mock AI calls
- **Model**: @cf/qwen/qwen3-30b-a3b-fp8 as default, configurable via KV
- **State**: Stateless MCP server (createMcpHandler, no Durable Objects)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Stateless MCP (createMcpHandler) over McpAgent | No per-session state needed, simpler deployment | ✓ Good |
| Self-contained PIN auth over third-party OAuth | Single user, minimal setup, no external IdP dependency | ✓ Good |
| Two-tier model routing (fast/standard) | Cost optimization without per-tool complexity | — Pending |
| KV for model config | Hot-swap models without redeploy | — Pending |
| Self-healing model fallback | Prevent misconfigured KV from breaking all tools | — Pending |
| Reuse OAUTH_KV for model config | Avoid creating a second KV namespace for 2 keys | ✓ Good |

---
*Last updated: 2026-04-12 after Phase 2: Error Handling & Reliability completion*
