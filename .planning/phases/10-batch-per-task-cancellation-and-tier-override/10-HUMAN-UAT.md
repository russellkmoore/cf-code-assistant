---
status: resolved
phase: 10-batch-per-task-cancellation-and-tier-override
source: [10-VERIFICATION.md]
started: "2026-06-29T19:02:34Z"
updated: "2026-06-29T19:30:00Z"
---

## Current Test

[none — resolved by code]

## Tests

### 1. Pre-aborted signal edge case does not cause callModel to hang in a real Workers AI environment
expected: When a batch task's per-task timeout fires and the resulting already-aborted AbortSignal reaches callModel, the function rejects promptly (returning `{status:"error", error_type:"timeout"}` for that task) rather than hanging indefinitely waiting for env.AI.run to settle.
repro: Submit a batch with more tasks than the concurrency limit (e.g. 7 tasks with default concurrency 6) and a very short `BATCH_TASK_TIMEOUT_MS` (e.g. 1ms). The queued 7th task's timeout fires before callModel starts, so the signal arrives already-aborted when its slot opens.
why_human: CR-01 (code review) — controller.abort() is called at src/index.ts:145 before timeoutPromise is constructed at :150. The Web AbortSignal spec does not retroactively fire abort events for late-added listeners, so timeoutPromise may never settle. Test coverage passes only because the mock AI explicitly checks signal?.aborted; real env.AI.run behavior on a pre-aborted signal is undocumented. Requires a real Workers AI invocation (or authoritative runtime docs) to confirm.
result: passed — resolved by code (commit 28a7c09). A synchronous `if (controller.signal.aborted) { reject(...); return; }` guard now runs at the top of the timeoutPromise constructor (src/index.ts:154-157), before any addEventListener. The pre-aborted signal settles timeoutPromise synchronously, so Promise.race resolves to rejection regardless of env.AI.run's behavior — the hang is structurally eliminated. Re-verification (10-VERIFICATION.md) confirmed status=passed, 12/12. No live Workers AI test required.

## Summary

total: 1
passed: 1
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps
