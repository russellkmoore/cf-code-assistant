# Architecture notes: leveraging Cloudflare for cheap, off-context code generation

> Forward-looking thinking doc. Nothing here is scheduled — it's the map of where this *could* go,
> with honest "when to reach for it" triggers. Build decisions still gate on the `NEXT.md` trial.

## Scope decision & design principle (2026-06-30)

**This tool is written entirely for Claude as a code assistant. Simplicity is a primary goal.**

Decision: **stick with the pure MCP route.** It already solves the consumption problem — the cheap
model generates the file content and the `cf-write-results` hook lands it on disk, so neither
ingestion nor re-emit bloats Claude's context. The direct-API / bearer-proxy / **ephemeral-minted-token**
channel and the sandbox/farm directions below are **deferred, not planned** — they only earn their
place once the consumer is *not Claude* (a sandbox, an external script) or artifacts outgrow the MCP
response. Liked conceptually, out of scope for *this* tool; revisit as a future phase or a separate
project.

Use this as the filter for everything below: **if an idea adds surface area without serving
Claude-as-code-assistant simplicity, it waits.**

## The core principle

**Claude's context is for decisions, not data.** Claude should orchestrate over *references/handles*;
the actual bytes (generated code, intermediate artifacts) should route *around* its expensive context —
between cheap compute (Workers AI) and storage (disk / R2 / a sandbox). Every pattern below is a way
to push more of the *data plane* off Claude while keeping the *control plane* (decisions) with it.

## The data-plane spectrum

| Level | What flows through Claude | Where the bytes live | Status |
|-------|---------------------------|----------------------|--------|
| 0. naive splice | the whole artifact, twice (in + re-emit) | Claude's context | the old anti-pattern |
| 1. **write-hook (now)** | a one-line summary | local disk, written by `cf-write-results` | ✅ **we are here** |
| 2. capability/handle | a presigned URL / key | R2, fetched locally by handle | edge — for large artifacts |
| 3. server-side pipeline | a *plan* in, *handles* out | a sandbox/R2 holds all intermediate state | frontier — multi-step only |

Level 1 already captures the main win (generation off the expensive output channel). Level 2 matters
only when artifacts get big enough you don't want them transiting the MCP response. Level 3 is the
real frontier and only pays off when work becomes *multi-step generation chains*.

## Two layers, not competing options

Resolve the "is X another way to get the model?" confusion by separating layers:

| Layer | Question | Options |
|-------|----------|---------|
| **Channel** (Claude → our infra) | how does Claude reach us? | MCP tool · bearer-proxy route · direct REST |
| **Middleware** (our infra → model) | how do we reach the model? | Workers AI binding (direct) · **AI Gateway** (proxied) |

They compose freely (e.g. MCP channel + AI Gateway middleware). MCP's edge: auth is session-wide and
free to subagents. The bearer-proxy's edge: non-Claude consumers. AI Gateway's edge: caching/cost/fallback.

## Cloudflare capability map — what else we could leverage

Grouped by the problem each solves for *this* project. "Trigger" = the pain that justifies adopting it.

### Improve generation QUALITY server-side  ← the highest-leverage new idea
| Capability | What it is (2026) | For us | Trigger to adopt |
|---|---|---|---|
| **Sandbox SDK / Containers** (GA Apr 2026) | isolated Linux env with `exec`, file ops, code interpreter (py/js/ts), git, preview URLs | **Server-side quality gate:** generate → run `tsc`/tests/lint in a sandbox → only return code that compiles (or auto-fix and re-check). A Haiku sub-agent can't compile-check its own output cheaply; a Worker+sandbox can. Directly attacks the `export`/edge-case wobble. | The trial shows quality is the blocker and richer context / tier swap don't fix it |
| **Structured outputs** (K2.7 supports JSON schema) | constrain model output to a schema | deterministic shape (no missing `export`) without a sandbox | cheap first thing to try if shape wobbles |

### Give the cheap model CONTEXT it lacks (it has no MCP access)
| Capability | What it is | For us | Trigger |
|---|---|---|---|
| **Vectorize** | vector DB (10M vectors, topK 50) | index the codebase/docs once; the Worker retrieves relevant context to feed qwen/kimi — instead of Claude shoveling context every call | quality issues trace to missing context, and you call repeatedly over the same codebase |
| **AutoRAG** | managed RAG: drop docs in R2 → embeddings/index/retrieval/gen via API | turnkey version of the above; zero RAG plumbing | same, but you want it managed |

### Keep bytes off Claude (data plane)
| Capability | What it is | For us | Trigger |
|---|---|---|---|
| **R2** | object storage + presigned URLs | Level-2 sink: Worker stashes large artifacts, returns a handle; a local hook fetches direct to disk | artifacts large enough you don't want them in the MCP response |

### Scale / orchestrate server-side
| Capability | What it is | For us | Trigger |
|---|---|---|---|
| **Workflows** | durable multi-step execution: retries, state persistence, ≤1024 steps, mins–weeks | Level-3 engine: chain generate → validate → fix → assemble entirely server-side, resumable; Claude submits a plan and collects handles | work becomes real multi-step pipelines, not flat fan-out |
| **Queues** | async job queue | fan-out beyond the 50-subrequest/req cap; decouple submit from run | batches regularly exceed ~50 tasks or need async |
| **Durable Objects** | per-entity stateful coordination | pipeline state, rate-limit/budget coordination, agent memory | you need cross-call coordination or a budget governor |

### Measure / observe
| Capability | What it is | For us | Trigger |
|---|---|---|---|
| **AI Gateway** | proxy: caching, cost/token dashboard, rate-limit, retries/fallback | one-line `baseURL` swap → free caching of repeated prompts + a spend dashboard across the fan-out | a runaway batch blows budget, or you want cache hits on templated prompts |
| **D1** | serverless SQLite | a real ledger: token/cost per call, eval results (auto-fill the trial table), prompt→result dedup cache | you want durable history/analytics beyond `wrangler tail` |
| **Logpush** | ship logs to R2/external | persist the structured `tool_invocation` logs for later analysis | you outgrow live tailing |

## Highest-leverage next ideas (honest prioritization)

1. **Sandbox quality gate** — the one that could *flip* the keep-vs-Haiku decision. "generate →
   `tsc --noEmit` in a sandbox → return only if it compiles, else one auto-fix pass." This is a
   capability a local Haiku sub-agent simply can't offer server-side. Strongest reason the MCP path
   could decisively win. Consider *if and only if* the trial fingers quality as the blocker.
2. **AI Gateway** — near-zero-diff add for caching + a cost dashboard. The day you want to *see*
   spend or stop paying for repeated prompts.
3. **D1 ledger** — turn the token logging into queryable history that could auto-populate the trial's
   results table.

## What to ignore for now

- **Vectorize/AutoRAG, Workflows, Queues, Durable Objects, full code-mode (Level 3):** all real and
  powerful, but they serve workloads (multi-step pipelines, repeated same-codebase retrieval, >50-task
  async fan-out, cross-call coordination) that this project *does not yet have*. Building them now is a
  spaceship to cross the street.
- The trigger for every row above is a *specific pain*. No pain → no build. The `NEXT.md` trial is
  what surfaces which pain (if any) is real.

---
*Captured 2026-06-30. Grounded in current Cloudflare docs (Containers/Sandbox GA Apr 2026, Workflows,
Vectorize 10M/topK-50, AutoRAG, AI Gateway). Revisit when the trial verdict + a concrete pain point land.*
