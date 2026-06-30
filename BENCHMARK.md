# BENCHMARK: Does offloading to cf-code-assistant actually save tokens?

**Date:** 2026-06-29 · **Task:** generate TypeScript types for `.planning/bench/cart.js`
(6 exported functions, ~37 lines untyped). One representative mechanical task, measured four ways.

The question this answers: the project's founding claim is "reduce Claude token cost." That is only
true if the generated artifact reaches disk **without the orchestrating model (Opus/Sonnet)
re-emitting it**. This benchmark tests whether that holds.

---

## The token-economics model (why the mechanism matters)

The expensive resource is the **orchestrator's** tokens (Opus/Sonnet), where *output* costs ~5×
*input*. Workers AI (qwen/Kimi) and Haiku tokens are nearly free by comparison. So the only number
that matters is **how many Opus output/input tokens each approach spends**, per task where the
deliverable is a file on disk.

| Mode | What the orchestrator (Opus) pays | Cheap-tier cost | Re-emit tax? |
|------|-----------------------------------|-----------------|--------------|
| **(a) Inline Opus** | output(code) — emits the file body once | none | n/a (baseline) |
| **(b) Offload + manual splice** *(today's default)* | output(request inc. context) **+ input(result)** **+ output(file write)** | Workers AI gen | **YES — pays for the body twice** |
| **(c) Offload + `cf-write-results` hook** | output(request) + ~input(tiny summary) | Workers AI gen | **No** — hook writes file & replaces output |
| **(d) Haiku sub-agent writes file** | output(spawn prompt) + ~input(tiny confirmation) | Haiku gen | **No** — sub-agent writes its own file |

**Confirmed mechanism (Claude Code hooks docs):** an MCP tool result *always* enters the
orchestrator's context — there is no suppression. A PostToolUse hook is the only way to (1) write
the body to disk as a side effect and (2) shrink the model-facing output via
`hookSpecificOutput.updatedToolOutput`. Without that hook, **mode (b) is unavoidable** and offload
pays for the generated body up to three times.

---

## Live measurements (this session)

### (b) Offload + manual splice — live `generateTypes`
- **Worked. Quality: excellent.** Correct `Item` / `DiscountCode` / `Cart` interfaces, all six
  signatures typed. Output usable as-is.
- **But:** the full 37-line body (~450 tokens) returned into the orchestrator's context. To land it
  on disk the orchestrator must re-emit it (~450 output tokens). This is the re-emit tax, observed
  directly.

### (d) Haiku sub-agent writes file — hard numbers
- **23,241 Haiku tokens · 12.2 s · wrote 96 lines to disk · ~15 tokens returned to Opus context.**
- The generated body **never entered the orchestrator's context.** Opus paid only the spawn prompt
  (~120 output tokens) + a one-line confirmation (~15 input tokens). Quality: correct, with JSDoc.

### (c) Offload + hook — mechanism verified, end-to-end pending deploy
- The `cf-write-results` hook was unit-smoke-tested: given a synthetic batch result it wrote the safe
  file, rejected a `../` traversal, and emitted a compact `updatedToolOutput` summary. So the Opus
  cost collapses to output(request) + input(summary) — comparable to (d), with cheaper generation
  tokens (Workers AI < Haiku) and server-side batch concurrency.
- **Not exercised end-to-end** because the live endpoint has no `code_assist_batch` (see Findings).

### (a) Inline — baseline
- Opus emits the ~37-line body once. No round-trip, no cheap-tier cost. Fastest for a single small
  file; cost scales with output size and grows when the same model also does heavy reasoning.

---

## Decision-relevant findings (infrastructure)

1. **The v2.0 batch tool is not deployed.** The connected live server
   (`code-assist.russellkmoore.me`, surfaced as `mcp__claude_ai_code-assist__*`) exposes the 11
   single-task tools but **no `code_assist_batch`.** The entire v2.0 fan-out capability — the
   milestone just shipped in code — is unavailable to live sessions until redeployed.
2. **The `cf-code-assistant` MCP registration is broken** — its URL is still the template
   placeholder `https://cf-code-assistant.<your-subdomain>.workers.dev/mcp`.
3. **Server naming is inconsistent** (`cf-code-assistant` vs `codeassist` vs the `claude_ai_code-assist`
   the session actually uses), so the `cf-delegate` skill's `allowed-tools: mcp__cf-code-assistant__*`
   doesn't match the connected tools. (The new hook matcher is name-agnostic: `mcp__.*__code_assist_batch`.)

---

## Conclusions

1. **The re-emit tax is real and large.** Mode (b) — today's default path — makes the orchestrator
   pay for the generated body two-to-three times. For any file-deliverable task, **(b) can cost more
   than generating inline (a).** This is the core reason the project's value was unproven.
2. **Two fixes both eliminate the tax: the hook (c) and the Haiku sub-agent (d).** Both keep the
   expensive Opus cost to roughly "construct the request + read a one-line confirmation."
3. **For the me-first case, the Haiku sub-agent (d) is the simpler default.** It needs no deployment,
   no OAuth, no hook, no registration — and delivered correct output at 23k cheap tokens with ~15
   tokens hitting Opus. The MCP server's marginal edge over (d) is narrow: cheaper per-token
   generation and *server-side batch concurrency* — and it only materializes **once v2.0 is actually
   deployed** and the result→file hook is in place.

**Recommendation (see plan Step 4):** keep the MCP server for genuine large fan-out (N independent
files in one call, server-side concurrency) — but that requires **redeploying v2.0** and using the
`write:`-id + hook path. For everyday one-off mechanical generation, prefer a Haiku sub-agent. Either
way, **never use mode (b)** (offload then hand-splice) — it is the worst of both worlds.

---

## Reproducible protocol (exact Opus tokens, fresh sessions)

In-session self-measurement of Opus tokens is imprecise. To get exact numbers, run each mode in its
own fresh Claude Code session and read `/cost` (or the session report) immediately after:

1. **(a)** "Generate TS types for `.planning/bench/cart.js` and write them to `cart.a.ts`." → `/cost`
2. **(b)** Same, but: "use the code-assist `generateTypes` tool, then write the result to `cart.b.ts`." → `/cost`
3. **(c)** Same, via `code_assist_batch` with one task `id: "write:.planning/bench/cart.c.ts"`,
   the `cf-write-results` hook enabled (requires deployed v2.0). → `/cost`
4. **(d)** "Spawn a haiku sub-agent to generate the types and write `cart.d.ts` directly; return only a confirmation." → `/cost`

Compare the **output-token** line across modes. Expectation: (b) ≫ (a) ≈ (c) ≈ (d) on Opus output;
(c)/(d) shift generation cost to a cheap tier. Record the four numbers here to close the loop.
