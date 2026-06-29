# Milestones

## v2.0 Concurrent Batch Fan-out (Shipped: 2026-06-29)

**Phases completed:** 6 phases (5–10), 9 plans, 16 tasks
**Delivered:** A single `code_assist_batch` MCP tool that fans out many bounded code-assist tasks to Workers AI concurrently — reusing the existing per-kind executor, with bounded concurrency, per-task timeout + real cancellation, a per-call cap, per-task tier override, and an order-preserving partial-results contract.

**Key accomplishments:**

- **Shared `runTask` executor** (Phase 5) — lifted the prompt-build head of 11 AI-backed handlers into one `TASK_SPECS` dispatch map (single source of truth for prompt/tier/maxTokens), guarded by a new byte-equality prompt-snapshot test the AI-mocked suite is structurally blind to. Behavior-preserving.
- **Pure batch engine** (Phase 6) — env-free `src/batch.ts` (`executeBatch`/`mapWithConcurrency`/`withTimeout`/`readBatchConfig`): bounded worker-cursor pool (default 6), per-call cap (default 50, fast-reject), per-task timeout (settle-once, no late-settle double-resolve), order-preserving + failure-isolated. Zero new runtime dependencies.
- **`code_assist_batch` tool** (Phase 7) — the repo's first structured-output tool: Zod input + output schemas, `structuredContent` + text summary, per-task contract `{id,index,kind,status,...}` with `error_type ∈ {timeout|validation|ai_error}`, and the four MCP annotations. Inherits the existing OAuth gate.
- **End-to-end verification** (Phase 8) — mixed 3-task batch (ok + validation-fail + deterministic timeout) proven order-preserving through the real `createMcpServer`, plus an opt-in 45s real-wait race block.
- **Two-tier model split made real** (Phase 9) — `fast` stays qwen3-30b; `standard` now resolves to the Kimi-k2.5 coding model, with the allowlist and KV self-healing preserved. Enables per-task tier override.
- **Real cancellation + per-task tier override** (Phase 10) — resolved the two deferred batch requirements: a real `AbortSignal` threaded into `env.AI.run` (a timed-out task truly cancels its subrequest instead of best-effort racing), and a tier-only (`fast`/`standard`) per-task override routed through the existing allowlist/KV abstraction — no raw model strings at the MCP boundary.

**Stats:** ~173 tests green · verification 12/12 · src/index.ts +524, new src/batch.ts (153 lines) · ~4-day build (2026-06-26 → 2026-06-29).

**Requirements:** 13/13 v2.0 requirements validated (BATCH-01…10 + MODEL-03 + BATCH-F01/F03). Deferred: BATCH-F02 (internal per-task retry with backoff) — callers re-issue failures today.

---
