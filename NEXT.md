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

## Step 1 — One end-to-end verification — ✅ DONE 2026-06-30

Verified live: `code_assist_batch` is served by the connector; a `write:<path>` task is written to
disk by the `cf-write-results` hook (markdown fences stripped) and the tool result is replaced with a
one-line summary — the generated body never re-enters Claude's context, no manual `Write`. Two hook
bugs were fixed during verification (input field is `tool_response` JSON-string, not
`tool_result.structuredContent`; `updatedToolOutput` is a plain string — honored in this build).
Server token logging confirmed in `wrangler tail`. **The re-emit-free mechanism works.** Remaining
work is the trial below (mechanism proven; the question is value-vs-Haiku-subagent).

### (original verification steps, for reference)

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

## How to decide scientifically (not by vibes)

The trap is deciding by gut after the fact. Pre-register the hypothesis, metrics, and thresholds
*now*, measure objectively, and let the rule decide. With a solo dev's volume this is
"decision-grade evidence," not p-values — the goal is a clear directional signal against a line you
committed to in advance.

### 1. The hypothesis (falsifiable)
> For real mechanical code-gen tasks, the cf-code-assistant **batch + write-hook** path produces an
> accepted result at materially lower cost and/or time than the simplest alternative (a Haiku
> sub-agent that writes the file), without a quality regression — and I actually reach for it.

If that's false, RETIRE (or keep only for the cross-client niche).

### 2. The arms to compare (drop the known-loser)
- **(d) Haiku sub-agent** — the honest baseline / best alternative (`Task`, `model: haiku`, writes file).
- **(c) MCP batch + write-hook** — the thing under test.
- *(skip (a) inline and (b) offload-then-splice — (b) is already proven worst; (a) is only a sanity floor.)*

The real discriminators will NOT be Opus tokens (both (c) and (d) are re-emit-free, so they ~tie
there). Expect the difference to show in **quality, wall-clock on multi-file fan-out, and adoption.**
Measure all of them.

### 3. Metrics (per task)
- **Primary — quality:** accepted as-is? minor edit? major rework / unusable? (3-point scale). A
  cheaper wrong answer is worthless, so this gates everything.
- **Cost:** Opus output+input tokens (the $ driver) via `/cost` in a fresh session; cheap-tier
  tokens via `wrangler tail` (MCP) or the agent's reported `subagent_tokens` (Haiku).
- **Wall-clock:** seconds to result. This is where batch's server-side concurrency should win on
  big fan-outs — or fail to.
- **Adoption (the silent killer):** did you invoke it *unprompted*, or did you have to force
  yourself? Tally eligible tasks vs. tasks you actually used it on.

### 4. Controls (so the numbers mean something)
- One task per **fresh** session (no context contamination); read `/cost` immediately after.
- Give both arms the **same gathered context** — don't let one win by better inputs.
- Use **real tasks from actual work**, stratified by type (test scaffolding, type gen, transforms,
  boilerplate). Aim for ~8–12 tasks; counterbalance which arm you run first.
- Log every run in the table below the moment it happens — not from memory at the end.

### Capture mechanics (how to get each number)

The session transcripts (`~/.claude/projects/<proj>/<session>.jsonl`) record exact per-turn token
usage, every tool call, and timestamps — use them, not gut feel. Workflow per task:

1. **Fresh session, one task only.** Do the single task, then end the session.
2. **Run the capture script:** `.planning/bench/measure-session.sh` (defaults to the newest
   transcript for this repo). It prints: output/input tokens by model, the tool-call tally
   (adoption), summed `subagent_tokens`, and wall-clock.
   - **Opus output tokens** = the headline cost number (the $ driver, directly comparable across arms).
   - **Tool tally** = which arm you actually used (adoption).
3. **MCP cheap-tier tokens:** not in the transcript (they run on Cloudflare). In a side terminal
   during the task: `npx wrangler tail --format pretty` and read the `prompt_tokens`/`completion_tokens`
   on the `tool_invocation` line.
4. **Haiku cheap-tier tokens:** the `subagent_tokens` figure in the Agent result when it completes
   (cheap; not decision-critical — the Opus main-loop is what matters).
5. **Quality:** objective proxy — does `npx tsc --noEmit` / the test suite pass on the output, and how
   many lines did you edit before accepting it? (`git diff --stat` after acceptance). Record asis/minor/major.
6. **Adoption:** the tool tally per session; at trial end, scan the period's transcripts for
   `code_assist_batch` vs `Task`(haiku) frequency.

`/cost` is a quick fallback for a rough $/session, but the script gives the precise, comparable numbers.

### 5. Pre-registered decision rule (commit before running)
**KEEP** only if ALL hold across the trial:
- quality of (c) is **non-inferior** to (d) (no worse on the 3-point scale on ≥80% of tasks), AND
- (c) wins on at least one of {wall-clock on ≥5-file fan-outs, total $ } by a margin you'd notice
  (pick the line now, e.g. **≥30%** faster on fan-outs **or** ≥50% cheaper $/task), AND
- **adoption ≥ 50%** of eligible tasks (if you don't reach for it, it's dead regardless of metrics).

**Quality remediation before RETIRE:** if quality is the *only* failing criterion, try these before
concluding — they're levers a one-off Haiku sub-agent doesn't centralize: (a) pass richer `context`;
(b) for `fast`-tier kinds, override the task `tier` to `standard` (Kimi); (c) hot-swap the standard
model via KV `config:model:standard` to a stronger coding model (no redeploy, self-healing). Note:
`standard`-tier kinds (generateTypes/generateCode/scaffoldTests/fixBug/…) are *already* Kimi-k2.5, so
the real quality bar there is **Kimi-k2.5 vs Haiku 4.5** — watch for dropped `export`s / edge cases.

**Otherwise RETIRE** — except keep it solely if you hit the **cross-client need** (called it from
Claude Desktop / a script / another machine) at least once for real. That niche is binary: you
either needed it or you didn't.

### Pre-trial observations (not controlled runs — context only)

- **2026-06-30 — K2.7 Code confirmed live.** `wrangler tail` shows standard tier resolving to
  `@cf/moonshotai/kimi-k2.7-code` (latency ~18s, 367 prompt / 537 completion tokens).
- **Quality tic to watch:** on the `generateTypes` cart.js fixture, K2.7 Code typed all six functions
  correctly and `export`ed them, but declared the supporting interfaces **without `export`**
  (intermittent across runs/models — same as the earlier batch run). A types file may need a one-line
  edit to export interfaces. Candidate fix if it persists: use K2.7's structured-output (JSON schema)
  mode — a server change, post-trial.

### 6. Results log (fill as you go)

| Date | Task (type) | Arm | Quality (asis/minor/major) | Opus out tok | cheap tok | wall-clock s | Used unprompted? |
|------|-------------|-----|----------------------------|--------------|-----------|--------------|------------------|
|      |             |     |                            |              |           |              |                  |

## If KEEP → package as a Claude Code plugin

Only after the rule says KEEP. The pieces are currently hand-wired and scattered across `~/.claude/`
(MCP registration in `.claude.json`, the `cf-write-results` hook + `settings.json`, the `cf-delegate`
skill, the routing doc) — which is what produced the placeholder-URL and name-mismatch bugs. A plugin
bundles all four into one installable, consistent, shareable unit and is the natural "productionize"
step:
- declare the MCP server (fixes the registration drift),
- ship the `cf-delegate` skill,
- ship the `cf-write-results` hook,
- ship the condensed routing rule.

Also worth doing then (client-agnostic): embed the `write:<path>` convention into the
`code_assist_batch` tool *description* on the server so any MCP client discovers it, not just yours.

If RETIRE: skip the plugin entirely; document what replaced it (likely a Haiku-sub-agent skill).

## Decision checkpoint: ~2026-07-13

Write the verdict here after the trial: KEEP (and why) or RETIRE (and what replaced it).

- Verdict:
- Evidence (what you actually used it for):
