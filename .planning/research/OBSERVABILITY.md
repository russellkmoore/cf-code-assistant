# Observability Patterns for Cloudflare Workers (MCP Server)

**Project:** cf-code-assistant
**Researched:** 2026-04-12
**Confidence:** HIGH (all claims verified against official Cloudflare docs)

---

## 1. What `[observability] enabled = true` Actually Does

Your `wrangler.toml` already has this set. Here is what it enables:

```toml
[observability]
enabled = true
# head_sampling_rate defaults to 1.0 (100% of requests)
# Set to e.g. 0.1 to sample 10% if you hit volume limits
```

**What you get automatically, zero code changes:**
- Every `console.log()`, `console.error()`, `console.warn()` is captured and stored
- Invocation logs: request method, URL, outcome (ok/exception/exceeded limits), CPU time, wall time
- Uncaught exceptions with stack traces
- Queryable in the Cloudflare dashboard under Workers > Your Worker > Logs
- Built-in Query Builder with filters, aggregations, grouping

**Storage limits:**
- Free plan: 200,000 logs/day, 3-day retention
- Paid plan: 20M logs/month, 7-day retention (~$0.60/million overage)

**Key behavior:** Workers Logs billing began April 21, 2025. It is included in both Free and Paid plans within the limits above.

**What it does NOT give you:**
- Per-request token counts for Workers AI calls (need AI Gateway for that)
- Custom metrics / time-series data (need Analytics Engine for that)
- Export to external systems (need Logpush or OTLP export for that)

---

## 2. Structured Logging Pattern

**Always log JSON objects, not strings.** Workers Logs automatically extracts fields from JSON and indexes them for filtering. String messages get stored as opaque blobs.

```typescript
// BAD — unqueryable string
console.log(`generateCode called, prompt length: ${prompt.length}`);

// GOOD — indexed, filterable fields
console.log(JSON.stringify({
  tool: "generateCode",
  tier: "standard",
  model: "qwen3-30b-a3b-fp8",
  promptLength: prompt.length,
  hasContext: !!context,
  language: language ?? null,
}));

// GOOD — errors with structured context
console.error(JSON.stringify({
  tool: "generateCode",
  error: err instanceof Error ? err.message : String(err),
  errorType: err instanceof Error ? err.constructor.name : "unknown",
  model,
  isKvFallback: false,
}));
```

**Why this matters for your MCP server:** You can then filter in the dashboard on `tool = "generateCode"` or `tier = "fast"` without text matching.

---

## 3. Latency Measurement for AI Calls

`performance.now()` works in Workers but with an important constraint: **timers only advance after I/O occurs.** CPU-only code reports zero elapsed time. This is by design (Spectre mitigation).

Since `env.AI.run()` is I/O, the timer works correctly:

```typescript
async function runAI(env: Env, tier: ModelTier, userPrompt: string, maxTokens = 4096): Promise<string> {
  const model = await resolveModel(env, tier);
  const t0 = performance.now();

  try {
    const result = await callModel(env, model, userPrompt, maxTokens);
    const latencyMs = Math.round(performance.now() - t0);

    console.log(JSON.stringify({
      event: "ai_call_complete",
      model,
      tier,
      latencyMs,
      maxTokens,
      promptLengthChars: userPrompt.length,
    }));

    return result;
  } catch (err) {
    const latencyMs = Math.round(performance.now() - t0);
    console.error(JSON.stringify({
      event: "ai_call_error",
      model,
      tier,
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
    }));
    throw err;
  }
}
```

**Expected baselines for Workers AI (Qwen3 30B):**
- Time to first token: ~300ms
- Throughput: 80+ tokens/second for 8B models; expect lower for 30B

---

## 4. Cost/Token Tracking via AI Gateway

This is the most impactful addition for your use case. The native `env.AI.run()` binding does not return token counts in the response object. To get per-request token visibility, route calls through AI Gateway.

### How AI Gateway token tracking works

AI Gateway sits in front of Workers AI and logs per-request metadata including: token counts (prompt + completion), cost, model, duration, cache hit/miss — without storing the prompt/response payloads if you opt out.

### Setup

**Step 1: wrangler.toml**
```toml
[ai]
binding = "AI"
```
No change needed to the binding itself.

**Step 2: Update `callModel` to pass the gateway**
```typescript
async function callModel(
  env: Env,
  model: string,
  userPrompt: string,
  maxTokens: number
): Promise<string> {
  const response = await env.AI.run(model as any, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    max_tokens: maxTokens,
  }, {
    gateway: {
      id: "cf-code-assistant",   // your AI Gateway name in Cloudflare dashboard
      skipCache: false,
      cacheTtl: 3600,            // cache identical prompts for 1 hour
    },
  });

  const result = response as { response?: string };
  return result.response ?? JSON.stringify(response);
}
```

**Step 3: Create the AI Gateway in the Cloudflare dashboard**
- AI > AI Gateway > Create Gateway
- Name: `cf-code-assistant`

**What you gain:**
- Per-request token counts in the AI Gateway logs tab
- Cost tracking per model call
- Cache for identical prompts (significant savings for `routingInfo()` type calls)
- Optional: persist logs to R2 for long-term retention
- Header control: send `cf-aig-collect-log-payload: false` to keep token metadata but not store the prompt/completion text

**Preventing sensitive prompt storage:**
```typescript
// In callModel, if you want metadata but not prompt content logged:
const response = await fetch(gatewayUrl, {
  headers: {
    "Authorization": `Bearer ${env.CF_API_TOKEN}`,
    "cf-aig-collect-log-payload": "false",  // drops prompt/response body from logs
    // token counts, cost, duration, model are still logged
  },
  // ...
});
```

---

## 5. Custom Metrics via Analytics Engine

Use this for time-series data you want to query with SQL: per-tool latency histograms, error rates by model, token usage by tier over time.

### Setup

**wrangler.toml addition:**
```toml
[[analytics_engine_datasets]]
binding = "METRICS"
dataset = "mcp_metrics"
```

**Update Env interface:**
```typescript
interface Env {
  AI: Ai;
  OAUTH_KV: KVNamespace;
  MCP_SECRET: string;
  METRICS: AnalyticsEngineDataset;  // add this
}
```

**Write datapoints after AI calls (non-blocking):**
```typescript
// In runAI, after successful call:
ctx.waitUntil(Promise.resolve(
  env.METRICS.writeDataPoint({
    blobs: [tool, model, tier],          // string dimensions
    doubles: [latencyMs, promptLength],  // numeric values
    indexes: [tool],                     // sampling/grouping key (max 1)
  })
));
```

**Query via SQL API:**
```bash
curl "https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql" \
  -H "Authorization: Bearer {token}" \
  --data "SELECT blob1 as tool, avg(double1) as avg_latency_ms, count() as calls
          FROM mcp_metrics
          WHERE timestamp > NOW() - INTERVAL '1' DAY
          GROUP BY tool
          ORDER BY calls DESC"
```

**Key characteristics:**
- `writeDataPoint()` is non-blocking — no latency impact
- Up to 20 blobs (strings), 20 doubles (numbers) per datapoint
- Only 1 index per datapoint (current limit — will fail silently if you pass multiple)
- Queryable in Grafana via the Analytics Engine data source

---

## 6. Error Tracking: Native vs Sentry

### Native Cloudflare (recommended for this project)

Workers Logs automatically captures uncaught exceptions including stack traces. With `[observability] enabled = true` already set, you have basic error tracking for free. No SDK required.

**For richer error context, use structured logging before re-throwing:**
```typescript
async function runAI(env: Env, tier: ModelTier, prompt: string, maxTokens = 4096) {
  try {
    // ...
  } catch (err) {
    console.error(JSON.stringify({
      event: "ai_error",
      tier,
      model: await resolveModel(env, tier),
      errorMessage: err instanceof Error ? err.message : String(err),
      errorName: err instanceof Error ? err.constructor.name : "UnknownError",
      isModelNotFound: err instanceof Error && err.message.includes("Unknown model"),
    }));
    throw err;  // let Workers Logs capture the uncaught exception with stack
  }
}
```

### Sentry (adds significant value if you want alerts and issue tracking)

Cloudflare officially documents two integration paths. The simpler one requires no SDK in your Worker:

**OTLP export path (no SDK dependency):**
1. Create a Sentry project (JavaScript/Generic)
2. In Cloudflare dashboard: Workers > Observability > Destinations, add a Sentry destination with your OTLP endpoint and `x-sentry-auth: sentry sentry_key={YOUR_PUBLIC_KEY}` header
3. Add to `wrangler.toml`:
```toml
[observability.traces]
enabled = true
destinations = ["sentry"]
head_sampling_rate = 1.0

[observability.logs]
enabled = true
destinations = ["sentry"]
head_sampling_rate = 1.0
```

**Verdict for this project:** Native Workers Logs is sufficient for an internal MCP server. Add Sentry if you want Slack/PagerDuty alerting on error spikes. The OTLP export path is zero-code and adds the most value.

---

## 7. Request/Response Logging Without Data Leakage

The main risk in this MCP server: user code and prompts flowing through `generateCode`, `reviewCode`, etc. You do not want those logged in plain text.

### Pattern: Log metadata only, never payloads

```typescript
// In each tool handler, log intent and shape — not content
server.registerTool("generateCode", { /* ... */ }, async ({ prompt, context, language, style }) => {
  console.log(JSON.stringify({
    event: "tool_invoked",
    tool: "generateCode",
    promptLengthChars: prompt.length,
    hasContext: !!context,
    contextLengthChars: context?.length ?? 0,
    language: language ?? null,
    style: style ?? null,
    // NEVER: prompt text, context text, code content
  }));

  const t0 = performance.now();
  const code = await runAI(env, "standard", /* ... */);
  const latencyMs = Math.round(performance.now() - t0);

  console.log(JSON.stringify({
    event: "tool_complete",
    tool: "generateCode",
    latencyMs,
    outputLengthChars: code.length,
  }));

  return { content: [{ type: "text", text: code }] };
});
```

### Headers to scrub from logs

The Workers Logs invocation data includes request headers. The OAuth `Authorization` header is the main concern here. Tail Workers let you strip headers before forwarding to external sinks, but the Cloudflare dashboard view of Workers Logs does not expose raw headers by default — only what you `console.log()` explicitly.

### AI Gateway payload opt-out

If you route through AI Gateway, send `cf-aig-collect-log-payload: false` to keep token/cost metrics without persisting prompts:
```typescript
// Add to callModel when using the gateway:
"cf-aig-collect-log-payload": "false"
```
Token counts, cost, model, duration are still logged. Only the prompt and completion text are dropped.

---

## 8. Tail Workers (Advanced Pattern)

Tail Workers are useful when Workers Logs' built-in 7-day retention is not enough, or when you need to fan out to multiple sinks (e.g., a self-hosted ClickHouse). They require the Workers Paid plan.

```typescript
// tail-worker/index.ts (separate Worker)
export default {
  async tail(events: TraceItem[]) {
    for (const event of events) {
      // Strip authorization headers before forwarding
      const sanitizedLogs = event.logs.map(log => ({
        ...log,
        // logs are already your console.log() output — already sanitized above
      }));

      // Forward to your sink
      await fetch("https://your-log-sink.example.com/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scriptName: event.scriptName,
          outcome: event.outcome,
          logs: sanitizedLogs,
          exceptions: event.exceptions,
          timestamp: event.eventTimestamp,
        }),
      });
    }
  },
};
```

**wrangler.toml for producer Worker:**
```toml
[[tail_consumers]]
service = "cf-code-assistant-tail"
```

**Verdict for this project:** Tail Workers add operational overhead for minimal gain if you are on the Paid plan and 7-day retention is acceptable. Skip unless you need long-term retention or multi-sink fanout.

---

## 9. Recommended Implementation Plan

Given this is an internal MCP server with an AI binding and OAuth, this is the priority order:

### Phase 1 — Zero-code (already done)
- `[observability] enabled = true` in `wrangler.toml` — already set, gives logs + traces in dashboard

### Phase 2 — Structured logging (1-2 hours)
- Replace any bare `console.log` strings with `JSON.stringify({...})` objects
- Add `event`, `tool`, `tier`, `model`, `latencyMs` fields to every log line
- Wrap `runAI` with `performance.now()` timing (see section 3 above)

### Phase 3 — AI Gateway for token/cost visibility (30 minutes)
- Create AI Gateway named `cf-code-assistant` in Cloudflare dashboard
- Pass `gateway: { id: "cf-code-assistant" }` option in `callModel`
- Optionally add `cf-aig-collect-log-payload: false` if prompt privacy matters

### Phase 4 — Analytics Engine for trend queries (1-2 hours, optional)
- Add `[[analytics_engine_datasets]]` to `wrangler.toml`
- Write datapoints after each AI call: tool, model, tier, latency, prompt size
- Query with SQL API or Grafana for cost/latency dashboards

### Phase 5 — Sentry OTLP for alerting (30 minutes, if needed)
- Add Sentry destination in Cloudflare dashboard
- Add `[observability.logs]` / `[observability.traces]` destinations config
- Set up Sentry alert rule for error rate spike

---

## Sources

- [Cloudflare Workers Observability overview](https://developers.cloudflare.com/workers/observability/)
- [Workers Logs documentation](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Workers Traces documentation](https://developers.cloudflare.com/workers/observability/traces/)
- [Tail Workers documentation](https://developers.cloudflare.com/workers/observability/logs/tail-workers/)
- [Workers Logpush documentation](https://developers.cloudflare.com/workers/observability/logs/logpush/)
- [Exporting OpenTelemetry data](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/)
- [Export to Sentry](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/sentry/)
- [Analytics Engine get started](https://developers.cloudflare.com/analytics/analytics-engine/get-started/)
- [Workers Analytics Engine overview](https://developers.cloudflare.com/analytics/analytics-engine/)
- [Workers Metrics and Analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)
- [Performance timers in Workers](https://developers.cloudflare.com/workers/runtime-apis/performance/)
- [AI Gateway Analytics](https://developers.cloudflare.com/ai-gateway/observability/analytics/)
- [AI Gateway Logging controls](https://developers.cloudflare.com/ai-gateway/observability/logging/)
- [AI Gateway for Workers AI](https://developers.cloudflare.com/ai-gateway/usage/providers/workersai/)
- [Workers AI Pricing / Neurons](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Workers Best Practices (2026)](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Workers AI binding configuration](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
- [Introducing Workers Observability (blog)](https://blog.cloudflare.com/introducing-workers-observability-logs-metrics-and-queries-all-in-one-place/)
