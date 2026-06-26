# Phase 8: Verify End-to-End - Discussion Log

> **Audit trail only.** Not consumed by downstream agents (researcher, planner, executor).
> Decisions captured in 08-CONTEXT.md — this log preserves how they were reached.

**Date:** 2026-06-26
**Phase:** 08-verify-end-to-end
**Mode:** discuss
**Areas offered:** "Clean build" definition · Forcing the timeout task · Inspector target & failing task · Phase artifact & evidence
**Areas selected:** "Clean build" definition · Phase artifact & evidence

---

## Pre-discussion finding

ROADMAP §Phase 8 SC#1 names `npm run build`, but `package.json` has **no `build` script**
(only `dev`, `deploy`, `types`, `test`, `test:coverage`). Surfaced upfront as the snag driving
the "Clean build" area.

---

## Area: "Clean build" definition

**Q1 — What satisfies the 'clean build' criterion?**
- Options: add `build` = tsc + dry-run / add `build` = tsc only / **no script, map to tsc + test**
- **Selected:** No script; map to `npx tsc --noEmit` + `npm test`. Keeps `package.json` untouched,
  consistent with the "build untouched" criterion. → D-01

**Q2 — Also run a one-off `wrangler deploy --dry-run` bundle check?**
- Options: yes, one-off dry-run / **no, tsc + test only**
- **Selected:** No. Build gate is exactly tsc + test — offline, no wrangler. → D-01a

---

## Area: Phase artifact & evidence

**Q1 — Proof model for 'demonstrated via MCP Inspector'?**
- Options: automated e2e + Inspector UAT / Inspector-only manual UAT / **automated e2e test only**
- **Selected:** Automated in-process e2e through the real `createMcpServer`; Inspector optional/
  skipped. Recorded the SC#2/#3 reframing (Inspector wording met by the automated drive). → D-02 / D-02a

**Q2 — Force the timeout task deterministically?**
- Options: tiny timeout + delayed mock / tiny timeout + never-resolving mock / **keep 45s default,
  real wait**
- **Selected:** Keep 45s default, real wait. → flagged consequences (see Q3).

**Q2-followup (diagnostic) — reconcile real-wait with the fast suite + the 45s-vs-45s race**
- Claude flagged: (1) a real wait puts ~45s into `npm test` (today ~2.3s, flakiness risk);
  (2) at 45s vs 45s, batch `withTimeout` vs `callModel`'s inner abort is a race → demonstrated
  path is nondeterministic.
- Options: **separate opt-in/manual e2e (real wait, out of npm test)** / in default suite, accept
  45s + race / reconsider shorter batch timeout
- **Selected:** Separate opt-in real-wait e2e, `skip`-by-default, out of `npm test`. Default suite
  stays fast/green; the real-wait test is the Inspector replacement. → D-04

**Q3 — 'Deliberately failing' (non-timeout) task type?**
- Options: **validation error (oversized/invalid input)** / ai error (mock throws) / both
- **Selected:** Validation error — oversized `transformCode` input (>8KB) → `ValidationError` →
  `error_type:'validation'`. Deterministic, exercises the real per-kind validation seam. → D-03

**Q4 — Does the FAST committed e2e include a deterministic timeout entry?**
- Options: **yes — ok + validation-fail + deterministic timeout** / no — ok + validation-fail only
- **Selected:** Yes. Committed fast e2e uses a tiny `BATCH_TASK_TIMEOUT_MS` override + delayed
  mock so it proves all three statuses in one order-preserving batch. → D-03 / D-03a / D-03b

**Q5 — Opt-in real-wait e2e: real Workers AI or 45s-hanging mock?**
- Options: **45s-hanging mock (offline, free)** / real Workers AI (charges)
- **Selected:** 45s-hanging mock — batch `withTimeout` and `callModel`'s inner abort race as in
  production, no charges, reproducible. Assert loosely on the timeout entry (race expected). → D-04a / D-04b

---

## Scope creep redirected

None. Discussion stayed within the verification boundary.

## Deferred ideas captured

- Actual MCP Inspector run + real-AI end-to-end (optional human confirmation; not required to pass)
- Per-task model observability (logged once per batch as `model:"mixed"`)
- BATCH-F01 true per-task cancellation
- PROJECT.md stale `60000ms` vs real `45000ms` — docs-pass fix, out of scope

## Claude's discretion (delegated)

- New-test file organization (one file with a `describe.skip` block, or two files)
- Exact ok/validation kinds, oversized payload, and the small timeout/delay pair for D-03
- Wording of the "how to run the opt-in real-wait e2e" note
