# Phase 5: Extract Shared `runTask` Executor - Discussion Log

> **Audit trail only.** Not consumed by downstream agents — decisions live in 05-CONTEXT.md.

**Date:** 2026-06-26
**Phase:** 05-extract-shared-runtask-executor
**Mode:** discuss (default)
**Areas discussed:** runTask boundary, Per-kind validation timing, Prompt-snapshot coverage, Special-case placement

## Questions & Selections

### runTask boundary
- **Options:** Full executor (builds prompt AND calls runAIWithMetrics, returns AIResult) / Spec-prompt-builder only (handlers keep their own runAIWithMetrics call)
- **Selected:** Full executor
- **Note:** One source of truth for prompt+tier+maxTokens AND the AI call; batch reuses it directly. Logging + makeToolError stay in each handler tail.

### Per-kind validation timing
- **Options:** Defer to Phase 7 / Build into runTask now
- **Selected:** Build into runTask now (Phase 5)
- **Note:** Reuse the exact Zod caps from each tool's inputSchema. Redundant-but-harmless for the single-task path (boundary Zod catches first); makes runTask batch-ready so Phase 7 can downgrade a bad task to status:'error'.

### Prompt-snapshot coverage
- **Options:** All 11 kinds / Representative subset (4 with special logic)
- **Selected:** All 11 kinds
- **Note:** Byte-equality buildPrompt + resolved tier/maxTokens per kind. Only guard against prompt drift the AI-mocked suite can't see.

### Special-case placement
- **Options:** In TASK_SPECS / Keep in handlers
- **Selected:** In TASK_SPECS
- **Note:** explainCode depth→tier/maxTokens resolver and transformCode 8KB cap travel with the kind so batch inherits them.

## Claude's Discretion (captured, not asked)
- Error-mapping seam: runTask throws typed errors (validation | timeout | ai_error); Phase 5 handler tails map them to today's exact responses (notably transformCode's over-cap error) so the 108 tests stay green. Flagged as the highest-risk seam in CONTEXT.md (D-05).

## Deferred Ideas
- Concurrency pool / timeout / cap (Phase 6); batch tool registration + error_type surfacing (Phase 7); true per-task cancellation via AbortSignal into env.AI.run (BATCH-F01, future).

## Scope Creep
- None — discussion stayed within the extraction boundary.
