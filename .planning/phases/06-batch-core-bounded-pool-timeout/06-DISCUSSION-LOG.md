# Phase 6: Batch Core + Bounded Pool + Timeout - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-26
**Phase:** 06-batch-core-bounded-pool-timeout
**Areas discussed:** Timeout default + layering, Env→config boundary, Engine shape, Module location

---

## Timeout default + layering

| Option | Description | Selected |
|--------|-------------|----------|
| 45000ms (= AI_TIMEOUT_MS) | Roadmap-authoritative; batch wall-clock aligns with callModel's inner abort; withTimeout primarily guards promises hanging past the inner abort. Reference's 60000 is a placeholder; PROJECT.md blurb is stale. | ✓ |
| 60000ms (above inner abort) | Inner 45s abort always wins for real AI calls; cleaner layering but contradicts the roadmap success criterion (would need ROADMAP+REQUIREMENTS edits). | |

**User's choice:** 45000ms (= AI_TIMEOUT_MS)
**Notes:** Resolves the conflict between ROADMAP/REQUIREMENTS (45000) and the reference batch.ts / PROJECT.md blurb (60000). PROJECT.md's 60000 noted as stale → deferred docs fix, out of this phase's scope.

---

## Env→config boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Include readBatchConfig in Phase 6 | Ship readBatchConfig(env)→BatchConfig with the engine; executeBatch(tasks, cfg, runTask) stays pure/env-free; reader testable with a plain object; defaults live with the engine. | ✓ |
| Defer reader to Phase 7 | Phase 6 ships only executeBatch + the BatchConfig interface; env parser lands at registration. | |

**User's choice:** Include readBatchConfig in Phase 6
**Notes:** executeBatch remains pure either way; the env-reading adapter ships now because the defaults (6/50/45000) are engine concerns.

---

## Engine shape

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal / generic + signal-aware port | executeBatch emits index-keyed {index, status, result|error}, agnostic of id/kind; Phase 7 layers id/kind/latency_ms/error_type. | |
| Concrete-typed now | executeBatch typed to BatchTask, reads task.id/task.kind, emits the fuller {id,index,kind,status,result|error} envelope this phase. | ✓ |

**User's choice:** Concrete-typed now
**Notes:** Ripple — pulls the BatchTask shape (mirroring the 11 TaskKind values) into Phase 6. Boundary made explicit in CONTEXT D-03a: Phase 6 stops at {id,index,kind,status,result|error}; Phase 7 enriches with latency_ms, error_type, the Zod output contract, and summary.failedIds.

---

## Module location

| Option | Description | Selected |
|--------|-------------|----------|
| New src/batch.ts module | Importable, env-free; unit tests import the engine directly without createMcpServer; matches reference layout; no new dep. | ✓ |
| Inline in src/index.ts | Fewer files but couples the pure engine to the ~600-line server file. | |

**User's choice:** New src/batch.ts module

---

## Claude's Discretion

- Exact over-cap and timeout error message wording (must be actionable; over-cap mentions splitting / BATCH_MAX_TASKS rationale).
- Internal naming (BatchTask, BatchConfig, RunTask, TaskResult union) and whether result types are hand-written TS or derived.
- Whether Phase 6 types are plain TS vs Zod (Zod is a Phase 7 concern) — provided the engine stays env-free and import-clean.
- Test file organization under src/__tests__/ (e.g. batch.test.ts).

## Deferred Ideas

- Phase 7: code_assist_batch registration, Zod in/out schemas, structuredContent + text summary, latency_ms + error_type, summary.failedIds, MCP annotations.
- BATCH-F01 (future milestone): true per-task cancellation threaded into env.AI.run (Phase 6 keeps the signal arg but abort is best-effort).
- PROJECT.md "Target features" blurb says 60000ms per-task timeout — stale vs ROADMAP/REQUIREMENTS (45000); correct in a docs pass.
