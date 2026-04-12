# Workers AI Error Handling Research

**Model under investigation:** `@cf/qwen/qwen3-30b-a3b-fp8`
**Researched:** 2026-04-12
**Overall confidence:** MEDIUM (error object shape is community-derived; official docs are incomplete on this topic)

---

## 1. What Errors Does `env.AI.run()` Throw?

Workers AI errors surface as thrown JavaScript `Error` objects. The error class name is `InferenceUpstreamError` (which wraps an internal `AiError`). The `message` property encodes both the internal numeric code and a human-readable description.

### Complete Error Code Reference

Source: [Cloudflare Workers AI Errors docs](https://developers.cloudflare.com/workers-ai/platform/errors/)

| Internal Code | HTTP Status | Name | Message Pattern | Retryable? |
|---------------|-------------|------|-----------------|------------|
| 3003 | 400 | Incomplete request | `Request is missing headers or body: {what}` | No — fix request |
| 3006 | 413 | Request too large | Payload exceeds limits | No — reduce input |
| 3007 | 408 | Timeout | `Request timeout` | Yes — retry with backoff |
| 3008 | 408 | Aborted | `Request was aborted` | Yes — retry once |
| 3023 | 403 | Account blocked | Service unavailable for account | No — contact support |
| 3036 | 429 | Quota exceeded | `You have used up your daily free allocation of 10,000 neurons` | No — upgrade plan or wait for 00:00 UTC reset |
| 3039 | 400 | Finetune missing files | `Finetune is missing required files` | No — fix config |
| 3040 | 429 | Out of capacity | `Capacity temporarily exceeded, please try again` | Yes — retry with backoff |
| 3041 | 403 | Account not allowed | Access denied to requested model | No — check account permissions |
| 3042 | 404 | Invalid model ID | `The model name is invalid` | No — fix model name |
| 3043 | 500 | Internal error | `Internal server error` | Yes — retry |
| 5004 | 400 | Invalid data | `Invalid data type for base64 input: {type}` | No — fix input |
| 5005 | 405 | LoRa unsupported | `The model does not support LoRa inference` | No — remove LoRa |
| 5007 | 400 | No such model | `No such model {model} or task` | No — fix model name |
| 5016 | 403 | Model agreement | `User has not agreed to Llama3.2 model terms` | No — accept terms |
| 5018 | 403 | Account not allowed | Account cannot access this model | No — check permissions |
| 5019 | 405 | Deprecated SDK | `Request trying to use deprecated SDK version` | No — update SDK |
| 10000 | 401 | Auth error (local dev) | `Authentication error when running locally` | No — fix wrangler auth |

**Also observed in the wild (community reports):**
- `InferenceUpstreamError: undefined: undefined` — intermittent service degradation, treat as 3040-class (retry)
- `InferenceUpstreamError: ERROR 3001: Unknown internal error` — transient, retry


---

## 2. Error Object Shape

Official documentation does not publish a TypeScript interface. The following is derived from community reports and `wrangler tail` output. **Confidence: LOW for exact shape, MEDIUM for message pattern.**

```typescript
// What the thrown error looks like in a catch block
// error.name    === "InferenceUpstreamError"
// error.message === "3040: Capacity temporarily exceeded, please try again"
//               OR "ERROR 3040: Capacity temporarily exceeded, please try again"
//               OR "AiError: 3040: Capacity temporarily exceeded, please try again"
//
// The message format is inconsistent across error codes — always parse with includes()
// rather than exact match or split(':')[0].

interface WorkersAIError extends Error {
  name: "InferenceUpstreamError";
  message: string;  // contains numeric code + description
  stack?: string;
  // No documented .httpCode, .internalCode, or .cause properties on the thrown object
  // Those exist on the internal AiError class but are not reliably exposed
}
```

### Extracting the Error Code

```typescript
function extractAiErrorCode(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  // Matches "3040:" or "ERROR 3040:" or "AiError: 3040:"
  const match = err.message.match(/\b(\d{4})\b/);
  return match ? parseInt(match[1], 10) : null;
}

function isAiError(err: unknown): err is Error {
  return err instanceof Error && err.name === "InferenceUpstreamError";
}
```

---

## 3. Retry and Fallback Patterns

### Error Classification

```typescript
// Categorize errors by their retry behavior
function classifyAiError(err: unknown): "retry" | "fatal" | "quota" | "unknown" {
  if (!isAiError(err)) return "unknown";

  const code = extractAiErrorCode(err);
  const msg = (err as Error).message;

  // Transient — retry with backoff
  if (code === 3007 || code === 3008 || code === 3040 || code === 3043) return "retry";
  // Also catch undefined:undefined intermittent errors
  if (msg.includes("undefined: undefined") || msg.includes("internal error")) return "retry";

  // Quota — do not retry, fail immediately
  if (code === 3036) return "quota";

  // Fatal — bad request, wrong model name, auth, permissions
  if ([3003, 3006, 3023, 3039, 3041, 3042, 5004, 5005, 5007, 5016, 5018, 5019, 10000].includes(code ?? -1)) return "fatal";

  // Unknown — default to retry once
  return "retry";
}
```

### Exponential Backoff with Jitter

```typescript
interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
};

async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = DEFAULT_RETRY,
): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const kind = classifyAiError(err);

      if (kind === "fatal" || kind === "quota") throw err;

      if (attempt < opts.maxAttempts) {
        // Exponential backoff with full jitter
        const base = Math.min(opts.baseDelayMs * 2 ** (attempt - 1), opts.maxDelayMs);
        const delay = Math.random() * base;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastErr;
}
```

### Drop-in Replacement for `callModel`

```typescript
async function callModelWithRetry(
  env: Env,
  model: string,
  userPrompt: string,
  maxTokens: number,
): Promise<string> {
  return withRetry(async () => {
    const response = await env.AI.run(model as any, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
    });

    const result = response as { response?: string };
    if (!result.response) {
      // Malformed but non-throwing response — surface as error for retry logic
      throw Object.assign(new Error("Empty response from Workers AI"), {
        name: "InferenceUpstreamError",
      });
    }
    return result.response;
  });
}
```

### MCP-Safe Error Wrapping

MCP tool handlers must never let raw AI errors escape — the MCP SDK surfaces them as opaque tool errors to the client. Wrap at the tool boundary:

```typescript
function toMcpError(err: unknown): { content: [{ type: "text"; text: string }]; isError: true } {
  const code = extractAiErrorCode(err);
  const kind = classifyAiError(err);

  let userMessage: string;
  if (code === 3036) {
    userMessage = "Workers AI daily quota exhausted (10,000 neurons free tier). Resets at 00:00 UTC.";
  } else if (code === 3040) {
    userMessage = "Workers AI is temporarily over capacity. Retries were exhausted — try again in a few seconds.";
  } else if (code === 3007) {
    userMessage = "Workers AI request timed out. The model may be under load.";
  } else if (kind === "fatal") {
    userMessage = `Workers AI configuration error (code ${code}): ${err instanceof Error ? err.message : String(err)}`;
  } else {
    userMessage = `Workers AI error: ${err instanceof Error ? err.message : String(err)}`;
  }

  return {
    content: [{ type: "text", text: userMessage }],
    isError: true,
  };
}

// Usage inside a tool handler:
async ({ prompt, context }) => {
  try {
    const result = await runAI(env, "standard", prompt, 8192);
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    return toMcpError(err);
  }
};
```

---

## 4. qwen3-30b-a3b-fp8 Specific Findings

Source: [Cloudflare model page](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/), [Qwen3 HuggingFace card](https://huggingface.co/Qwen/Qwen3-30B-A3B), [April 2026 changelog](https://developers.cloudflare.com/changelog/post/2026-04-09-new-workers-ai-models/)

### Model Facts

| Property | Value |
|----------|-------|
| Model ID | `@cf/qwen/qwen3-30b-a3b-fp8` |
| Architecture | Mixture-of-Experts (30B total, 3B active per forward pass) |
| Context window | 32,768 tokens |
| Default `max_tokens` | 2,000 |
| Default `max_tokens` (batch) | 256 |
| Function calling | Supported |
| Reasoning/thinking | Supported (see below) |
| Added to Cloudflare | 2026-04-09 |
| Input pricing | $0.051 / million tokens |
| Output pricing | $0.34 / million tokens |

### Thinking Mode (IMPORTANT for this project)

Qwen3 models have a **thinking mode** that produces `<think>...</think>` blocks before the final response. The upstream Qwen3 model enables thinking by default (`enable_thinking=True`). **What Cloudflare Workers AI exposes of this flag is not documented** — confidence LOW.

**Known behavior from the base model:**
- Thinking mode requires `temperature=0.6, top_p=0.95, top_k=20` (do NOT use 0 temperature — causes endless repetition)
- Non-thinking mode: `temperature=0.7, top_p=0.8, top_k=20`
- Soft switch: prefix prompt with `/no_think` to suppress reasoning output without changing model config

**Implication for this MCP server:** The system prompt already says "Do not use thinking or reasoning tags - output the result directly." Adding `/no_think` at the start of user messages is the most reliable way to suppress `<think>` blocks if they appear in output. If the model returns thinking tags in the response, strip them:

```typescript
function stripThinkingBlocks(text: string): string {
  // Remove <think>...</think> blocks (including multiline)
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
```

### Context Window Overflow

The model has a 32,768 token context window. When the combined (system prompt + user prompt + `max_tokens`) exceeds this:

- **Expected behavior:** Cloudflare returns error code **3006** (HTTP 413, "Request too large")
- **Important math:** `max_tokens` is output reservation. If you set `max_tokens=8192` and pass 25,000 tokens of input, you will hit the 32,768 limit.
- **Current code risk:** Several tools pass `max_tokens=8192`. Large `context` parameters in `generateCode` could push total tokens over limit.

```typescript
// Rough token estimation (1 token ≈ 4 chars for English code)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function checkContextLimit(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  contextWindow = 32768,
): void {
  const inputTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt);
  if (inputTokens + maxTokens > contextWindow) {
    throw new RangeError(
      `Prompt too large: ~${inputTokens} input tokens + ${maxTokens} max_tokens = ` +
      `${inputTokens + maxTokens}, exceeds ${contextWindow} context window`,
    );
  }
}
```

---

## 5. Timeout Values

### Workers Runtime Limits

| Plan | CPU Time Limit | Wall Time |
|------|---------------|-----------|
| Free | 10ms | No limit (while connected) |
| Paid | 30s default, up to 5 min | No limit (while connected) |

Source: [Workers Platform Limits](https://developers.cloudflare.com/workers/platform/limits/)

**Key distinction:** Workers AI inference is network I/O, not CPU time. The model runs on Cloudflare's GPU fleet, not in your Worker's CPU budget. The Worker is essentially awaiting a fetch during inference. This means:

- CPU time during `env.AI.run()` is near-zero (just awaiting)
- Wall time applies — but there is no documented limit on how long Workers AI inference can take
- In practice, large generations (8192 tokens) on a 30B model can take 30-90 seconds

### Observed Timeouts

- Error 3007 ("Request timeout") comes from the Workers AI backend, not the Workers runtime
- Streaming (`stream: true`) resets the timeout clock on each token — use streaming for long generations to avoid 3007
- AI Gateway `requestTimeout` header: configurable in milliseconds, measured from first byte of response

### Recommendations

```typescript
// For long generations (code generation, large transforms)
// Use lower max_tokens OR use streaming to avoid backend timeout
const SAFE_MAX_TOKENS: Record<string, number> = {
  // For ~30s budget: qwen3-30b-a3b-fp8 generates ~50-80 tokens/sec
  // 4096 tokens / 60 tok/s ≈ 68 seconds — may hit 3007 under load
  // Stay conservative:
  short: 2048,   // explainCode brief, quickTask, commitMessage
  medium: 4096,  // reviewCode, explainCode detailed, scaffoldTests small
  long: 6144,    // generateCode, transformCode, generateDocs (risky — monitor)
  // Avoid 8192 for non-streaming until timeout behavior is profiled
};
```

---

## 6. Rate Limits

Source: [Workers AI Limits](https://developers.cloudflare.com/workers-ai/platform/limits/)

| Task Type | Rate Limit |
|-----------|------------|
| Text Generation (default) | 300 requests/minute |
| Text Generation (model-specific) | 150–1500 RPM (varies) |

When rate limit is hit, error 3040 is returned (same as capacity exceeded). The distinction between rate-limit-429 and capacity-429 is not exposed in the error object — treat both as "retry with backoff."

**Daily neuron quota:** 10,000 neurons/day free tier → error 3036. Resets at 00:00 UTC. No retry will help until reset.

---

## 7. MCP-Specific Concerns

### IoContext Timeout During Initialization

Source: [GitHub issue #640, cloudflare/agents](https://github.com/cloudflare/agents/issues/640)

**Problem:** When using `McpAgent` with Durable Objects, the IoContext can timeout during the MCP handshake before any tool is called. Manifests as: "IoContext timed out due to inactivity, waitUntil tasks were cancelled without completing."

**Mitigation:** This project correctly uses `createMcpHandler` (stateless) rather than `McpAgent` class, which avoids this issue entirely.

### Streaming vs Blocking in MCP

MCP tool results must be complete before returning — MCP does not support streaming responses to the client mid-tool. This means:
- Cannot use `stream: true` to avoid 3007 timeouts from within a tool handler
- For tools that pass `max_tokens=8192`, there is genuine timeout risk
- Consider lowering `max_tokens` for tools where the caller likely won't use 8192 tokens of output

---

## 8. Recommended `runAI` Replacement

The current `runAI` in `src/index.ts` only retries on model-not-found (KV override). It should also retry on transient errors:

```typescript
async function runAI(
  env: Env,
  tier: ModelTier,
  userPrompt: string,
  maxTokens = 4096,
): Promise<string> {
  const model = await resolveModel(env, tier);

  const invoke = async (m: string) => {
    const response = await env.AI.run(m as any, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
    });
    const result = response as { response?: string };
    // Defensive: some malformed responses return empty string
    return result.response ?? JSON.stringify(response);
  };

  try {
    return await withRetry(() => invoke(model));
  } catch (err) {
    // KV config mismatch: bad model name override — clear and retry default
    const code = extractAiErrorCode(err);
    if (
      (code === 3042 || code === 5007) &&
      model !== DEFAULT_MODELS[tier]
    ) {
      await env.OAUTH_KV.delete(`config:model:${tier}`);
      return await withRetry(() => invoke(DEFAULT_MODELS[tier]));
    }
    throw err;
  }
}
```

---

## Confidence Assessment

| Area | Confidence | Reason |
|------|------------|--------|
| Error codes + HTTP status | HIGH | Official Cloudflare docs |
| Error message patterns | MEDIUM | Community + docs, but format inconsistent |
| Error object shape (.name, .message) | MEDIUM | Community-confirmed, not officially typed |
| Retry classification logic | MEDIUM | Derived from docs + community guidance |
| qwen3-30b model specs | HIGH | Official Cloudflare model page |
| Thinking mode on Cloudflare | LOW | Upstream HuggingFace docs only; CF does not document this parameter |
| Timeout values (Workers runtime) | HIGH | Official limits docs |
| AI Gateway retry config | HIGH | Official AI Gateway docs |
| Rate limits (RPM) | MEDIUM | Official limits page, but per-model limits not fully published |

---

## Sources

- [Workers AI Errors Reference](https://developers.cloudflare.com/workers-ai/platform/errors/)
- [Workers AI Limits](https://developers.cloudflare.com/workers-ai/platform/limits/)
- [Workers AI Platform Limits (Workers runtime)](https://developers.cloudflare.com/workers/platform/limits/)
- [qwen3-30b-a3b-fp8 Model Page](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/)
- [Qwen3-30B-A3B HuggingFace Model Card](https://huggingface.co/Qwen/Qwen3-30B-A3B)
- [AI Gateway Request Handling (retries + timeouts)](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/)
- [AI Gateway Request Timeout/Retry Changelog](https://developers.cloudflare.com/changelog/post/2025-02-05-aig-request-handling/)
- [Context Windows Changelog](https://developers.cloudflare.com/changelog/post/2025-02-24-context-windows/)
- [New Workers AI Models Changelog (April 2026)](https://developers.cloudflare.com/changelog/post/2026-04-09-new-workers-ai-models/)
- [CPU Limits Increase Changelog (March 2025)](https://developers.cloudflare.com/changelog/post/2025-03-25-higher-cpu-limits/)
- [IoContext Timeout MCP Issue](https://github.com/cloudflare/agents/issues/640)
- [Workers AI Error 3040 Community Thread](https://community.cloudflare.com/t/workers-ai-error-3040-capacity-temporarily-exceeded/806672)
