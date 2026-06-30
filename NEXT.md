# NEXT: Verify once, trial for 2 weeks, then keep-or-retire

**Status as of 2026-06-29:** v2.0 is deployed (version `97b44c8f`, batch + token accounting live on
both `cf-code-assistant.russellkmoore.workers.dev/mcp` and `code-assist.russellkmoore.me/mcp`). The
re-emit-free path is wired client-side (the `cf-write-results` PostToolUse hook + `cf-delegate`
write-to-disk mode). Engineering is effectively done. **The open question is adoption, not features.**

See `BENCHMARK.md` for the evidence behind this plan.

## Do NOT build more right now

Adding features (BATCH-F02 retry, more tools) polishes a tool whose marginal value over a plain
Haiku sub-agent is thin. That is the "ineffective project" trap. Resist it until the trial below
proves the server earns its keep.

## Step 1 — One end-to-end verification (fresh Claude Code session)

The current session can't test this (MCP tool lists load at connect time; the batch tool + hook
weren't present then). In a **new** session:

1. Ask: "Use `code_assist_batch` to generate types for `.planning/bench/cart.js`, task id
   `write:.planning/bench/cart.c.ts`."
2. Confirm all three:
   - the file appears on disk,
   - the model-facing tool output is the one-line hook summary (not the code body),
   - `npx wrangler tail` shows `prompt_tokens` / `completion_tokens` per call.

If that passes, the whole token-saving mechanism works.

## Step 2 — Two-week usage trial (let behavior decide)

Use it on real work. The honest decision rule:

- **Keep the MCP server** if you actually fire batch fan-outs (many files in one call) OR call it
  from outside Claude Code (Desktop / scripts / other machines) — that cross-client reach is its one
  real moat.
- **Retire it** if you keep reaching for a Haiku sub-agent instead (`Task` tool, `model: haiku`,
  writes files directly). For in-Claude-Code one-off generation, the sub-agent matches the token
  savings with zero infrastructure.

Never use the offload-then-hand-splice path (call a tool, get code back, write it yourself) — it
pays for the body two-to-three times. See `BENCHMARK.md`.

## Decision checkpoint: ~2026-07-13

Write the verdict here after the trial: KEEP (and why) or RETIRE (and what replaced it).

- Verdict:
- Evidence (what you actually used it for):
