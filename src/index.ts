import { OAuthProvider, type OAuthHelpers, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolInvocation, logToolError, logAuthEvent } from "./logger";
import { executeBatch, readBatchConfig } from "./batch";
import type { BatchTask, RunTask } from "./batch";

// --- Model tier config ---

type ModelTier = "fast" | "standard";

const ALLOWED_MODELS = [
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/moonshotai/kimi-k2.5",
] as const satisfies ReadonlyArray<keyof AiModels>;

type AllowedModel = (typeof ALLOWED_MODELS)[number];

function isAllowedModel(model: string): model is AllowedModel {
  return (ALLOWED_MODELS as readonly string[]).includes(model);
}

const DEFAULT_MODELS: Record<ModelTier, keyof AiModels> = {
  fast: "@cf/qwen/qwen3-30b-a3b-fp8",
  standard: "@cf/moonshotai/kimi-k2.5",
};

const AI_TIMEOUT_MS = 45_000;

// Byte cap for transformCode `code` input. Full-file rewrites >~8KB routinely
// exceed AI_TIMEOUT_MS on qwen3-30b. Callers should send scoped snippets
// (single function, single block) and splice results back in themselves.
const TRANSFORM_CODE_MAX_BYTES = 8_000;

// KV keys: config:model:fast, config:model:standard
// Set via Cloudflare dashboard KV editor to override defaults.

async function resolveModel(env: Env, tier: ModelTier): Promise<keyof AiModels> {
  const kvKey = `config:model:${tier}`;
  try {
    const override = await env.OAUTH_KV.get(kvKey);
    if (override !== null) {
      if (isAllowedModel(override)) return override;
      // Self-heal: invalid model in KV — delete it, fall back to default
      await env.OAUTH_KV.delete(kvKey);
    }
  } catch (err) {
    // KV degraded — silently fall back to default (D-07)
    console.warn(`[resolveModel] KV unavailable for key ${kvKey}:`, err instanceof Error ? err.message : "unknown");
  }
  return DEFAULT_MODELS[tier];
}

const SYSTEM_PROMPT = `You are a code generation engine. You receive precise instructions and optional context (API docs, existing code, etc.) already assembled by an orchestrating AI. Your job is to generate clean, correct, production-ready code only. Do not explain unless asked. Do not ask clarifying questions. Use the provided context as ground truth for APIs and patterns. Do not use thinking or reasoning tags - output the result directly.`;

const ROUTING_INFO = `# cf-code-assistant — Tool Routing Guide

## Philosophy
Claude (Sonnet/Opus) is the orchestrator — it handles research, context gathering, architecture decisions,
multi-file reasoning, and workflow commands (/gsd, etc.). This MCP server handles mechanical code tasks
where Claude's reasoning isn't needed, saving tokens and cost.

**Golden rule:** Claude gathers context FIRST (via Context7, Cloudflare MCP, file reads), then delegates
generation to this server with that context passed as a parameter.

## Tools

### generateCode(prompt, context?, language?, style?)
Main workhorse. Use for any new code generation from a clear spec.
Claude MUST pass gathered docs/API refs/existing code via the context param.

### reviewCode(code, criteria?)
Static analysis — bugs, style, performance, security. Returns structured markdown findings.
Use when Claude needs a second opinion on code quality.

### transformCode(code, instruction)
Mechanical transforms only: rename variables, convert patterns, reformat, add types, change casing, etc.
Not for logic changes — use generateCode for those.

### scaffoldTests(code, framework?)
Generates test files with happy path, edge cases, and error cases.
Default framework: vitest. Pass "jest", "mocha", etc. to override.

### quickTask(instruction)
Anything simple and self-contained that needs no file context.
Good for: regex patterns, one-off snippets, data format conversions, shell commands.

### explainCode(code, depth?)
Explain what code does. depth: "brief" (1-2 sentences), "detailed" (full walkthrough), "eli5" (analogy, no jargon).
Default: brief.

### generateDocs(code, style?)
Add documentation to code. style: "jsdoc", "tsdoc", or "inline" comments.
Default: tsdoc.

### generateTypes(code)
Infer and add TypeScript types to untyped or loosely-typed code.
Generates interfaces, type aliases, and generics from usage patterns.

### fixBug(code, error)
Fix a bug given the code and the error message or stack trace. Returns corrected code only.
Claude should pass the exact error output.

### generateCommitMessage(diff)
Generate a conventional commit message from a git diff.
Format: type(scope): description. Keeps first line under 72 chars.

### generateWorkerBoilerplate(description, bindings?)
Generate complete Cloudflare Worker boilerplate with Env interface, fetch handler, and wrangler.toml snippet.
Pass bindings as comma-separated string (e.g. "KV, R2, D1, AI").

### routingInfo()
This tool. Returns this guide. No AI call, no cost.

## What NOT to route here
- /gsd commands or workflow orchestration
- Research tasks (web search, Context7, Cloudflare docs)
- Architecture decisions or multi-file reasoning
- Tasks that require reading the codebase first
- Anything that needs MCP tool output fetched first (Claude fetches, then passes as context)
`;

interface Env {
  AI: Ai;
  OAUTH_KV: KVNamespace;
  MCP_SECRET: string;
  AUTH_RATE_LIMITER: RateLimit;
}

// --- Workers AI helper ---

interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

async function callModel(
  env: Env,
  model: keyof AiModels,
  userPrompt: string,
  maxTokens: number,
  externalSignal?: AbortSignal,
): Promise<{ text: string; usage?: TokenUsage }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  // Link external signal (batch per-task timeout) to the internal controller.
  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    // Synchronous check: if abort already fired before this constructor ran,
    // the "abort" event will never re-fire for late-added listeners (Web spec).
    // Reject immediately to avoid a permanently-pending promise.
    if (controller.signal.aborted) {
      reject(new Error("AI_TIMEOUT"));
      return;
    }
    controller.signal.addEventListener("abort", () => {
      reject(new Error("AI_TIMEOUT"));
    }, { once: true });
  });

  try {
    const aiPromise = env.AI.run(model, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
    }, { signal: controller.signal });

    const response = await Promise.race([aiPromise, timeoutPromise]);
    const result = response as {
      response?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    // OpenAI-style response (qwen3, kimi, llama, etc.) → choices[0].message.content
    // Legacy Workers AI response → response
    const text = result.choices?.[0]?.message?.content ?? result.response;
    // OpenAI-style `usage` is present on qwen/kimi; legacy models may omit it.
    const usage: TokenUsage | undefined = result.usage
      ? {
          prompt_tokens: result.usage.prompt_tokens ?? 0,
          completion_tokens: result.usage.completion_tokens ?? 0,
          total_tokens:
            result.usage.total_tokens ??
            (result.usage.prompt_tokens ?? 0) + (result.usage.completion_tokens ?? 0),
        }
      : undefined;
    return { text: text?.trim() ?? JSON.stringify(response), usage };
  } finally {
    clearTimeout(timeoutId);
  }
}

interface AIResult {
  text: string;
  model: string;
  latency_ms: number;
  usage?: TokenUsage;
}

async function runAIWithMetrics(env: Env, tier: ModelTier, userPrompt: string, maxTokens = 4096, signal?: AbortSignal): Promise<AIResult> {
  const model = await resolveModel(env, tier);
  const start = Date.now();
  const { text, usage } = await callModel(env, model, userPrompt, maxTokens, signal);
  const latency_ms = Date.now() - start;
  return { text, model: model as string, latency_ms, usage };
}

/** Spread helper: adds token fields to a log entry only when the model reported usage. */
function usageLogFields(r: AIResult): Pick<TokenUsage, "prompt_tokens" | "completion_tokens" | "total_tokens"> | Record<string, never> {
  if (!r.usage) return {};
  return {
    prompt_tokens: r.usage.prompt_tokens,
    completion_tokens: r.usage.completion_tokens,
    total_tokens: r.usage.total_tokens,
  };
}

async function runAI(env: Env, tier: ModelTier, userPrompt: string, maxTokens = 4096): Promise<string> {
  const result = await runAIWithMetrics(env, tier, userPrompt, maxTokens);
  return result.text;
}

// --- Error helpers ---

type ErrorCode = "AI_TIMEOUT" | "AI_ERROR" | "INTERNAL_ERROR";

function makeToolError(code: ErrorCode, toolName: string) {
  const messages: Record<ErrorCode, string> = {
    AI_TIMEOUT: `[ERROR: AI_TIMEOUT] The AI model did not respond within ${AI_TIMEOUT_MS / 1000} seconds for tool ${toolName}. Please retry.`,
    AI_ERROR: `[ERROR: AI_ERROR] The AI model returned an error for tool ${toolName}. The service may be temporarily degraded.`,
    INTERNAL_ERROR: `[ERROR: INTERNAL_ERROR] An internal error occurred in tool ${toolName}. Please retry.`,
  };
  return {
    content: [{ type: "text" as const, text: messages[code] }],
    isError: true as const,
  };
}

// --- Task dispatch (runTask executor) ---

type TaskKind =
  | "generateCode"
  | "reviewCode"
  | "transformCode"
  | "scaffoldTests"
  | "quickTask"
  | "explainCode"
  | "generateDocs"
  | "generateTypes"
  | "fixBug"
  | "generateCommitMessage"
  | "generateWorkerBoilerplate";

interface TaskSpec {
  /** Pure: resolve tier + maxTokens from input. Constant kinds ignore input. */
  resolve(input: Record<string, unknown>): { tier: ModelTier; maxTokens: number };
  /** Pure: build the exact prompt string. Byte-identical to the current inline build. */
  buildPrompt(input: Record<string, unknown>): string;
  /** Optional pre-AI guard. Throws a typed ValidationError (e.g. transformCode 8KB cap). */
  validate?(input: Record<string, unknown>): void;
}

class ValidationError extends Error {
  constructor(msg: string, readonly meta?: Record<string, unknown>) {
    super(msg);
    this.name = "ValidationError";
  }
}

const TASK_SPECS: Record<TaskKind, TaskSpec> = {
  generateCode: {
    resolve: () => ({ tier: "standard", maxTokens: 8192 }),
    buildPrompt: (input) => {
      const { prompt, context, language, style } = input as { prompt: string; context?: string; language?: string; style?: string };
      const parts: string[] = [];
      if (language) parts.push(`Language: ${language}`);
      if (style) parts.push(`Style: ${style}`);
      if (context) parts.push(`Context:\n${context}`);
      parts.push(`Task:\n${prompt}`);
      return parts.join("\n\n");
    },
  },
  reviewCode: {
    resolve: () => ({ tier: "standard", maxTokens: 4096 }),
    buildPrompt: (input) => {
      const { code, criteria } = input as { code: string; criteria?: string };
      return [
        "Review the following code and return structured findings as a markdown list.",
        "Categories: Bugs, Style, Performance, Security, Suggestions.",
        "Only include categories where you find issues.",
        criteria ? `Focus on: ${criteria}` : "",
        `\`\`\`\n${code}\n\`\`\``,
      ]
        .filter(Boolean)
        .join("\n\n");
    },
  },
  transformCode: {
    resolve: () => ({ tier: "standard", maxTokens: 8192 }),
    buildPrompt: (input) => {
      const { code, instruction } = input as { code: string; instruction: string };
      return [
        `Apply the following transformation to this code. Return only the transformed code.`,
        `Transformation: ${instruction}`,
        `\`\`\`\n${code}\n\`\`\``,
      ].join("\n\n");
    },
    validate: (input) => {
      const { code } = input as { code: string };
      const codeBytes = new TextEncoder().encode(code).byteLength;
      if (codeBytes > TRANSFORM_CODE_MAX_BYTES) {
        throw new ValidationError("INPUT_TOO_LARGE", { codeBytes });
      }
    },
  },
  scaffoldTests: {
    resolve: () => ({ tier: "standard", maxTokens: 8192 }),
    buildPrompt: (input) => {
      const { code, framework } = input as { code: string; framework?: string };
      const fw = framework ?? "vitest";
      return [
        `Generate comprehensive test scaffolding using ${fw} for the following code.`,
        `Include happy path, edge cases, and error cases. Return only test code.`,
        `\`\`\`\n${code}\n\`\`\``,
      ].join("\n\n");
    },
  },
  quickTask: {
    resolve: () => ({ tier: "fast", maxTokens: 4096 }),
    buildPrompt: (input) => {
      const { instruction } = input as { instruction: string };
      return instruction;
    },
  },
  explainCode: {
    resolve: (input) => {
      const { depth } = input as { depth?: string };
      const level = depth ?? "brief";
      return level === "detailed"
        ? { tier: "standard", maxTokens: 4096 }
        : { tier: "fast", maxTokens: 2048 };
    },
    buildPrompt: (input) => {
      const { code, depth } = input as { code: string; depth?: string };
      const level = depth ?? "brief";
      const depthInstructions: Record<string, string> = {
        brief: "Explain in 1-2 concise sentences what this code does.",
        detailed: "Provide a detailed walkthrough of this code: purpose, control flow, key decisions, and any notable patterns.",
        eli5: "Explain this code like I'm 5 years old, using a simple real-world analogy. No jargon.",
      };
      return [
        depthInstructions[level],
        `\`\`\`\n${code}\n\`\`\``,
      ].join("\n\n");
    },
  },
  generateDocs: {
    resolve: () => ({ tier: "standard", maxTokens: 8192 }),
    buildPrompt: (input) => {
      const { code, style } = input as { code: string; style?: string };
      const docStyle = style ?? "tsdoc";
      const styleInstructions: Record<string, string> = {
        jsdoc: "Add JSDoc comments (/** */) to all exported functions, classes, and interfaces. Include @param, @returns, and @example where appropriate.",
        tsdoc: "Add TSDoc comments (/** */) to all exported functions, classes, and interfaces. Include @param, @returns, @remarks, and @example where appropriate. Use TSDoc-specific tags.",
        inline: "Add concise inline comments (// ) above non-obvious logic. Do not comment self-evident code. Focus on why, not what.",
      };
      return [
        `${styleInstructions[docStyle]} Return the full code with documentation added.`,
        `\`\`\`\n${code}\n\`\`\``,
      ].join("\n\n");
    },
  },
  generateTypes: {
    resolve: () => ({ tier: "standard", maxTokens: 8192 }),
    buildPrompt: (input) => {
      const { code } = input as { code: string };
      return [
        "Generate TypeScript type definitions for this code. Infer interfaces, type aliases, and generics from usage patterns. Return only the typed version of the code.",
        `\`\`\`\n${code}\n\`\`\``,
      ].join("\n\n");
    },
  },
  fixBug: {
    resolve: () => ({ tier: "standard", maxTokens: 8192 }),
    buildPrompt: (input) => {
      const { code, error } = input as { code: string; error: string };
      return [
        "Fix the bug in this code. Return only the corrected code.",
        `Error:\n${error}`,
        `\`\`\`\n${code}\n\`\`\``,
      ].join("\n\n");
    },
  },
  generateCommitMessage: {
    resolve: () => ({ tier: "fast", maxTokens: 1024 }),
    buildPrompt: (input) => {
      const { diff } = input as { diff: string };
      return [
        "Generate a concise git commit message for this diff using conventional commits format (feat/fix/refactor/docs/test/chore).",
        "Format: type(scope): description",
        "Keep the first line under 72 characters. Add a blank line and body only if the change is non-trivial.",
        "Return only the commit message, nothing else.",
        `\`\`\`diff\n${diff}\n\`\`\``,
      ].join("\n\n");
    },
  },
  generateWorkerBoilerplate: {
    resolve: () => ({ tier: "standard", maxTokens: 8192 }),
    buildPrompt: (input) => {
      const { description, bindings } = input as { description: string; bindings?: string };
      const parts = [
        "Generate a complete Cloudflare Worker in TypeScript with proper Env interface, fetch handler, and error handling.",
        `Purpose: ${description}`,
      ];
      if (bindings) parts.push(`Bindings to include in the Env interface: ${bindings}`);
      parts.push("Include the wrangler.toml snippet as a comment at the top. Return only the code.");
      return parts.join("\n\n");
    },
  },
};

async function runTask(env: Env, kind: TaskKind, input: Record<string, unknown>, opts: { tier?: ModelTier; signal?: AbortSignal } = {}): Promise<AIResult> {
  const spec = TASK_SPECS[kind];
  spec.validate?.(input);
  const r = spec.resolve(input);
  const tier = opts.tier ?? r.tier;
  // maxTokens always comes from the kind's spec — the caller is responsible for
  // not overriding high-maxTokens kinds (8192) onto the fast tier, which may
  // cause a Workers AI 400 or silent truncation (see BatchTaskInputSchema.tier desc).
  return runAIWithMetrics(env, tier, spec.buildPrompt(input), r.maxTokens, opts.signal);
}

// --- Batch schemas and helpers ---

const BatchTaskInputSchema = z.object({
  id: z.string().optional().describe("Caller-assigned task ID (defaults to index string if omitted)"),
  kind: z.enum([
    "generateCode",
    "reviewCode",
    "transformCode",
    "scaffoldTests",
    "quickTask",
    "explainCode",
    "generateDocs",
    "generateTypes",
    "fixBug",
    "generateCommitMessage",
    "generateWorkerBoilerplate",
  ] as const).describe("Which code-assist tool to invoke"),
  input: z.record(z.string(), z.unknown()).describe(
    "Task-specific parameters. Validated per kind inside runTask, not at the batch boundary."
  ),
  tier: z.enum(["fast", "standard"]).optional().describe(
    "Override the model tier for this task (defaults to the kind's tier). " +
    "Caller responsibility: ensure the overridden tier's model supports the kind's maxTokens. " +
    "High-maxTokens kinds (generateCode, scaffoldTests, fixBug, generateWorkerBoilerplate: 8192) " +
    "sent to the fast tier may cause a Workers AI 400 or silent truncation. " +
    "Prefer overriding only low-maxTokens kinds (quickTask, explainCode: 2048-4096) to the fast tier."
  ),
});

const TaskResultOkSchema = z.object({
  id: z.string(),
  index: z.number().int(),
  kind: z.string(),
  status: z.literal("ok"),
  result: z.unknown(),
  latency_ms: z.number(),
});

const TaskResultErrorSchema = z.object({
  id: z.string(),
  index: z.number().int(),
  kind: z.string(),
  status: z.literal("error"),
  error: z.string(),
  error_type: z.enum(["timeout", "validation", "ai_error"] as const),
  latency_ms: z.number(),
});

const BatchOutputSchema = z.object({
  total: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  failedIds: z.array(z.string()),
  results: z.array(z.discriminatedUnion("status", [TaskResultOkSchema, TaskResultErrorSchema])),
  summary: z.string(),
});

function deriveErrorType(errMsg: string): "timeout" | "validation" | "ai_error" {
  const msg = errMsg.toLowerCase();
  if (msg.includes("timeout") || msg.includes("ai_timeout")) return "timeout";
  if (msg.includes("input_too_large") || msg.includes("validationerror")) return "validation";
  return "ai_error";
}

// --- MCP Server factory ---

function createMcpServer(env: Env) {
  const server = new McpServer({
    name: "cf-code-assistant",
    version: "1.0.0",
  });

  server.registerTool(
    "generateCode",
    {
      description: "Generate production-ready code from a prompt. Claude should pass any gathered context (docs, API refs, existing code) via the context parameter.",
      inputSchema: {
        prompt: z.string().max(20_000).trim().describe("What code to generate"),
        context: z.string().max(50_000).trim().optional().describe("Relevant docs, API references, or existing code gathered by Claude"),
        language: z.string().max(100).trim().optional().describe("Target language (e.g. typescript, python, rust)"),
        style: z.string().max(100).trim().optional().describe("Style guidance (e.g. functional, class-based, minimal)"),
      },
    },
    async ({ prompt, context, language, style }) => {
      try {
        const result = await runTask(env, "generateCode", { prompt, context, language, style });
        logToolInvocation({ tool: "generateCode", tier: "standard", model: result.model, latency_ms: result.latency_ms, ...usageLogFields(result) });
        return { content: [{ type: "text", text: result.text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        const errorType = msg === "AI_TIMEOUT" ? "AI_TIMEOUT" : "AI_ERROR";
        const inputSize = new TextEncoder().encode(prompt + (context ?? "")).byteLength;
        logToolError({ tool: "generateCode", error_type: errorType, input_size_bytes: inputSize });
        return makeToolError(errorType as ErrorCode, "generateCode");
      }
    },
  );

  server.registerTool(
    "reviewCode",
    {
      description: "Review code for bugs, style issues, and potential problems. Returns structured findings.",
      inputSchema: {
        code: z.string().max(100_000).trim().describe("The code to review"),
        criteria: z.string().max(2_000).trim().optional().describe("Specific review criteria (e.g. security, performance, readability)"),
      },
    },
    async ({ code, criteria }) => {
      try {
        const result = await runTask(env, "reviewCode", { code, criteria });
        logToolInvocation({ tool: "reviewCode", tier: "standard", model: result.model, latency_ms: result.latency_ms, ...usageLogFields(result) });
        return { content: [{ type: "text", text: result.text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        const errorType = msg === "AI_TIMEOUT" ? "AI_TIMEOUT" : "AI_ERROR";
        const inputSize = new TextEncoder().encode(code).byteLength;
        logToolError({ tool: "reviewCode", error_type: errorType, input_size_bytes: inputSize });
        return makeToolError(errorType as ErrorCode, "reviewCode");
      }
    },
  );

  server.registerTool(
    "transformCode",
    {
      description: "Apply mechanical transformations to code: rename, reformat, convert patterns, add types, etc. Scoped snippets only — input code is capped at 8KB. For larger files, send a single function or block and splice the result back yourself.",
      inputSchema: {
        code: z.string().max(100_000).trim().describe("The code to transform"),
        instruction: z.string().max(10_000).trim().describe("What transformation to apply"),
      },
    },
    async ({ code, instruction }) => {
      try {
        const result = await runTask(env, "transformCode", { code, instruction });
        logToolInvocation({ tool: "transformCode", tier: "standard", model: result.model, latency_ms: result.latency_ms, ...usageLogFields(result) });
        return { content: [{ type: "text", text: result.text }] };
      } catch (err) {
        if (err instanceof ValidationError) {
          const codeBytes = (err.meta?.codeBytes as number) ?? new TextEncoder().encode(code).byteLength;
          logToolError({ tool: "transformCode", error_type: "AI_ERROR", input_size_bytes: codeBytes });
          return {
            content: [{
              type: "text" as const,
              text: `[ERROR: INPUT_TOO_LARGE] transformCode received ${codeBytes} bytes; cap is ${TRANSFORM_CODE_MAX_BYTES}. Full-file rewrites at this size routinely exceed the ${AI_TIMEOUT_MS / 1000}s model timeout. Scope the transformation to a single function or block and splice the result back yourself.`,
            }],
            isError: true as const,
          };
        }
        const msg = err instanceof Error ? err.message : "";
        const errorType = msg === "AI_TIMEOUT" ? "AI_TIMEOUT" : "AI_ERROR";
        const codeBytes = new TextEncoder().encode(code).byteLength;
        logToolError({ tool: "transformCode", error_type: errorType, input_size_bytes: codeBytes });
        return makeToolError(errorType as ErrorCode, "transformCode");
      }
    },
  );

  server.registerTool(
    "scaffoldTests",
    {
      description: "Generate test scaffolding for a given code block.",
      inputSchema: {
        code: z.string().max(100_000).trim().describe("The code to generate tests for"),
        framework: z.string().max(100).trim().optional().describe("Test framework (default: vitest)"),
      },
    },
    async ({ code, framework }) => {
      try {
        const result = await runTask(env, "scaffoldTests", { code, framework });
        logToolInvocation({ tool: "scaffoldTests", tier: "standard", model: result.model, latency_ms: result.latency_ms, ...usageLogFields(result) });
        return { content: [{ type: "text", text: result.text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        const errorType = msg === "AI_TIMEOUT" ? "AI_TIMEOUT" : "AI_ERROR";
        const inputSize = new TextEncoder().encode(code).byteLength;
        logToolError({ tool: "scaffoldTests", error_type: errorType, input_size_bytes: inputSize });
        return makeToolError(errorType as ErrorCode, "scaffoldTests");
      }
    },
  );

  server.registerTool(
    "quickTask",
    {
      description: "Handle simple, self-contained tasks that don't need file context. Good for: regex, one-off snippets, data transforms, format conversions.",
      inputSchema: {
        instruction: z.string().max(10_000).trim().describe("What to do"),
      },
    },
    async ({ instruction }) => {
      try {
        const result = await runTask(env, "quickTask", { instruction });
        logToolInvocation({ tool: "quickTask", tier: "fast", model: result.model, latency_ms: result.latency_ms, ...usageLogFields(result) });
        return { content: [{ type: "text", text: result.text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        const errorType = msg === "AI_TIMEOUT" ? "AI_TIMEOUT" : "AI_ERROR";
        const inputSize = new TextEncoder().encode(instruction).byteLength;
        logToolError({ tool: "quickTask", error_type: errorType, input_size_bytes: inputSize });
        return makeToolError(errorType as ErrorCode, "quickTask");
      }
    },
  );

  server.registerTool(
    "explainCode",
    {
      description: "Explain what code does. Depth controls verbosity: brief (1-2 sentences), detailed (full walkthrough), eli5 (non-technical analogy).",
      inputSchema: {
        code: z.string().max(100_000).trim().describe("The code to explain"),
        depth: z.enum(["brief", "detailed", "eli5"]).optional().describe("Explanation depth (default: brief)"),
      },
    },
    async ({ code, depth }) => {
      try {
        const result = await runTask(env, "explainCode", { code, depth });
        const tier: ModelTier = depth === "detailed" ? "standard" : "fast";
        logToolInvocation({ tool: "explainCode", tier, model: result.model, latency_ms: result.latency_ms, ...usageLogFields(result) });
        return { content: [{ type: "text", text: result.text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        const errorType = msg === "AI_TIMEOUT" ? "AI_TIMEOUT" : "AI_ERROR";
        const inputSize = new TextEncoder().encode(code).byteLength;
        logToolError({ tool: "explainCode", error_type: errorType, input_size_bytes: inputSize });
        return makeToolError(errorType as ErrorCode, "explainCode");
      }
    },
  );

  server.registerTool(
    "generateDocs",
    {
      description: "Generate documentation for code. Supports JSDoc, TSDoc, and inline comment styles.",
      inputSchema: {
        code: z.string().max(100_000).trim().describe("The code to document"),
        style: z.enum(["jsdoc", "tsdoc", "inline"]).optional().describe("Documentation style (default: tsdoc)"),
      },
    },
    async ({ code, style }) => {
      try {
        const result = await runTask(env, "generateDocs", { code, style });
        logToolInvocation({ tool: "generateDocs", tier: "standard", model: result.model, latency_ms: result.latency_ms, ...usageLogFields(result) });
        return { content: [{ type: "text", text: result.text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        const errorType = msg === "AI_TIMEOUT" ? "AI_TIMEOUT" : "AI_ERROR";
        const inputSize = new TextEncoder().encode(code).byteLength;
        logToolError({ tool: "generateDocs", error_type: errorType, input_size_bytes: inputSize });
        return makeToolError(errorType as ErrorCode, "generateDocs");
      }
    },
  );

  server.registerTool(
    "generateTypes",
    {
      description: "Generate TypeScript type definitions for untyped or loosely-typed code. Infers interfaces, type aliases, and generics.",
      inputSchema: {
        code: z.string().max(100_000).trim().describe("The code to generate types for"),
      },
    },
    async ({ code }) => {
      try {
        const result = await runTask(env, "generateTypes", { code });
        logToolInvocation({ tool: "generateTypes", tier: "standard", model: result.model, latency_ms: result.latency_ms, ...usageLogFields(result) });
        return { content: [{ type: "text", text: result.text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        const errorType = msg === "AI_TIMEOUT" ? "AI_TIMEOUT" : "AI_ERROR";
        const inputSize = new TextEncoder().encode(code).byteLength;
        logToolError({ tool: "generateTypes", error_type: errorType, input_size_bytes: inputSize });
        return makeToolError(errorType as ErrorCode, "generateTypes");
      }
    },
  );

  server.registerTool(
    "fixBug",
    {
      description: "Fix a bug given the code and the error message or description. Returns corrected code only.",
      inputSchema: {
        code: z.string().max(100_000).trim().describe("The buggy code"),
        error: z.string().max(10_000).trim().describe("The error message, stack trace, or description of the bug"),
      },
    },
    async ({ code, error }) => {
      try {
        const result = await runTask(env, "fixBug", { code, error });
        logToolInvocation({ tool: "fixBug", tier: "standard", model: result.model, latency_ms: result.latency_ms, ...usageLogFields(result) });
        return { content: [{ type: "text", text: result.text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        const errorType = msg === "AI_TIMEOUT" ? "AI_TIMEOUT" : "AI_ERROR";
        const inputSize = new TextEncoder().encode(code + error).byteLength;
        logToolError({ tool: "fixBug", error_type: errorType, input_size_bytes: inputSize });
        return makeToolError(errorType as ErrorCode, "fixBug");
      }
    },
  );

  server.registerTool(
    "generateCommitMessage",
    {
      description: "Generate a concise, conventional commit message from a git diff.",
      inputSchema: {
        diff: z.string().max(50_000).trim().describe("The git diff to summarize"),
      },
    },
    async ({ diff }) => {
      try {
        const result = await runTask(env, "generateCommitMessage", { diff });
        logToolInvocation({ tool: "generateCommitMessage", tier: "fast", model: result.model, latency_ms: result.latency_ms, ...usageLogFields(result) });
        return { content: [{ type: "text", text: result.text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        const errorType = msg === "AI_TIMEOUT" ? "AI_TIMEOUT" : "AI_ERROR";
        const inputSize = new TextEncoder().encode(diff).byteLength;
        logToolError({ tool: "generateCommitMessage", error_type: errorType, input_size_bytes: inputSize });
        return makeToolError(errorType as ErrorCode, "generateCommitMessage");
      }
    },
  );

  server.registerTool(
    "generateWorkerBoilerplate",
    {
      description: "Generate Cloudflare Worker boilerplate from a description. Optionally specify bindings (KV, R2, D1, AI, Durable Objects, etc.).",
      inputSchema: {
        description: z.string().max(10_000).trim().describe("What the Worker should do"),
        bindings: z.string().max(500).trim().optional().describe("Comma-separated list of bindings needed (e.g. 'KV, R2, D1, AI')"),
      },
    },
    async ({ description, bindings }) => {
      try {
        const result = await runTask(env, "generateWorkerBoilerplate", { description, bindings });
        logToolInvocation({ tool: "generateWorkerBoilerplate", tier: "standard", model: result.model, latency_ms: result.latency_ms, ...usageLogFields(result) });
        return { content: [{ type: "text", text: result.text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        const errorType = msg === "AI_TIMEOUT" ? "AI_TIMEOUT" : "AI_ERROR";
        const inputSize = new TextEncoder().encode(description).byteLength;
        logToolError({ tool: "generateWorkerBoilerplate", error_type: errorType, input_size_bytes: inputSize });
        return makeToolError(errorType as ErrorCode, "generateWorkerBoilerplate");
      }
    },
  );

  server.registerTool(
    "routingInfo",
    {
      description: "Returns a plain-text guide describing every tool, when to use it, and the routing philosophy. No AI call — static response.",
      inputSchema: {},
    },
    async () => {
      return {
        content: [{
          type: "text",
          text: ROUTING_INFO,
        }],
      };
    },
  );

  // --- Batch enrichment wrapper (closes over env) ---
  async function runBatch(rawTasks: z.infer<typeof BatchTaskInputSchema>[]) {
    const cfg = readBatchConfig(env as unknown as Record<string, string | undefined>);

    // Adapter: wrap real runTask; returns AIResult so handler can extract latency_ms.
    // Wires both F01 (signal from withTimeout) and F03 (per-task tier override) in one line.
    const adapter: RunTask = (batchTask, signal) =>
      runTask(env, batchTask.kind, batchTask.input, { tier: batchTask.tier, signal });

    const tasks: BatchTask[] = rawTasks.map((t, i) => ({
      id: t.id ?? String(i),
      kind: t.kind,
      input: t.input,
      tier: t.tier,
    }));

    const raw = await executeBatch(tasks, cfg, adapter);

    // Enrich results: extract latency_ms and simplify result on ok path;
    // derive error_type and approximate latency_ms on error path.
    // Aggregate Workers AI token usage across ok tasks that reported it (cheap-side
    // cost meter for the whole batch). Stays out of the output contract — telemetry only.
    let batchUsage: TokenUsage | undefined;
    const results = raw.results.map((entry) => {
      if (entry.status === "ok") {
        const aiResult = entry.result as AIResult;
        if (aiResult.usage) {
          batchUsage ??= { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
          batchUsage.prompt_tokens += aiResult.usage.prompt_tokens;
          batchUsage.completion_tokens += aiResult.usage.completion_tokens;
          batchUsage.total_tokens += aiResult.usage.total_tokens;
        }
        return {
          id: entry.id,
          index: entry.index,
          kind: entry.kind,
          status: "ok" as const,
          result: aiResult.text,
          latency_ms: aiResult.latency_ms,
        };
      } else {
        const timeoutMatch = entry.error.match(/exceeded (\d+)ms timeout/);
        // When callModel's internal timer fires first it rejects with "AI_TIMEOUT"
        // (no ms in the message), so the regex won't match. Fall back to the
        // configured task timeout to keep latency telemetry meaningful.
        const latency_ms = timeoutMatch
          ? parseInt(timeoutMatch[1], 10)
          : entry.error.toUpperCase().includes("AI_TIMEOUT")
            ? cfg.taskTimeoutMs
            : 0;
        return {
          id: entry.id,
          index: entry.index,
          kind: entry.kind,
          status: "error" as const,
          error: entry.error,
          error_type: deriveErrorType(entry.error),
          latency_ms,
        };
      }
    });

    const failedIds = results
      .filter((r) => r.status === "error")
      .map((r) => r.id);

    const summary =
      failedIds.length === 0
        ? `${raw.succeeded}/${raw.total} tasks succeeded.`
        : `${raw.succeeded}/${raw.total} tasks succeeded. ${raw.failed} failed: ${failedIds.join(", ")}.`;

    logToolInvocation({
      tool: "code_assist_batch",
      tier: "standard",
      model: "mixed",
      latency_ms: 0,
      ...(batchUsage ?? {}),
    });

    return { total: raw.total, succeeded: raw.succeeded, failed: raw.failed, failedIds, results, summary };
  }

  server.registerTool(
    "code_assist_batch",
    {
      description:
        "Run multiple code-assist tasks concurrently in a single call. Each task specifies a kind (one of the 11 single-task tools) and a kind-specific input object. Returns an order-preserving partial-results array: each task independently succeeds or fails without affecting its siblings. Use this to fan out independent leaf work (test generation, scaffolding, mechanical transforms) to reduce sequential round-trips.",
      inputSchema: {
        tasks: z
          .array(BatchTaskInputSchema)
          .min(1)
          .max(50)
          .describe(
            "Array of tasks to run concurrently (1–50). Each task has a kind and kind-specific input. Tasks are isolated: one failure does not abort others."
          ),
      },
      outputSchema: BatchOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ tasks }) => {
      try {
        const structured = await runBatch(tasks);
        return {
          content: [{ type: "text", text: structured.summary }],
          structuredContent: structured,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        logToolError({ tool: "code_assist_batch", error_type: "AI_ERROR", input_size_bytes: 0 });
        // over-cap and unexpected throws: isError:true skips outputSchema validation
        void msg;
        return makeToolError("INTERNAL_ERROR", "code_assist_batch");
      }
    },
  );

  return server;
}

// --- Auth handler (self-contained, PIN-based) ---

const authHandler: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const oauthHelpers = (env as unknown as { OAUTH_PROVIDER: OAuthHelpers }).OAUTH_PROVIDER;

    if (url.pathname === "/authorize") {
      if (request.method === "GET") {
        try {
          const authRequest = await oauthHelpers.parseAuthRequest(request);
          const csrfToken = crypto.randomUUID();
          await env.OAUTH_KV.put(`csrf:${csrfToken}`, JSON.stringify(authRequest), { expirationTtl: 300 });

          return new Response(loginPage(csrfToken), {
            headers: { "Content-Type": "text/html" },
          });
        } catch (err) {
          logAuthEvent({ event: "failure", ip: request.headers.get("CF-Connecting-IP") ?? "unknown", detail: "auth_init_failed" });
          return new Response(
            errorPage("Authorization Error", "Failed to initialize the authorization flow. Please try again."),
            {
              status: 500,
              headers: { "Content-Type": "text/html" },
            },
          );
        }
      }

      if (request.method === "POST") {
        const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
        const { success } = await env.AUTH_RATE_LIMITER.limit({ key: ip });
        if (!success) {
          logAuthEvent({ event: "rate_limit", ip });
          return new Response("Too many attempts. Try again later.", { status: 429 });
        }

        logAuthEvent({ event: "attempt", ip });

        const formData = await request.formData();
        const secret = formData.get("secret");
        const csrfToken = formData.get("csrf");

        if (typeof secret !== "string" || !secret.trim() || typeof csrfToken !== "string" || !csrfToken.trim()) {
          logAuthEvent({ event: "failure", ip, detail: "invalid_form_data" });
          return new Response("Invalid form data.", { status: 400 });
        }

        if (secret.length > 256 || csrfToken.length > 256) {
          logAuthEvent({ event: "failure", ip, detail: "input_too_long" });
          return new Response("Invalid form data.", { status: 400 });
        }

        const stored = await env.OAUTH_KV.get(`csrf:${csrfToken}`);
        if (!stored) {
          logAuthEvent({ event: "failure", ip, detail: "csrf_expired" });
          return new Response("Session expired. Please try again.", { status: 400 });
        }
        await env.OAUTH_KV.delete(`csrf:${csrfToken}`);

        if (!secret || !timingSafeEqual(secret, env.MCP_SECRET)) {
          logAuthEvent({ event: "failure", ip, detail: "wrong_pin" });
          return new Response("Invalid secret.", { status: 403 });
        }

        let authRequest: AuthRequest;
        try {
          authRequest = JSON.parse(stored) as AuthRequest;
        } catch {
          logAuthEvent({ event: "failure", ip, detail: "invalid_csrf_payload" });
          return new Response("Authorization failed.", { status: 400 });
        }

        let redirectTo: string;
        try {
          const result = await oauthHelpers.completeAuthorization({
            request: authRequest,
            userId: "owner",
            metadata: { label: "claude-code" },
            scope: authRequest.scope,
            props: { userId: "owner" },
          });
          redirectTo = result.redirectTo;
        } catch {
          logAuthEvent({ event: "failure", ip, detail: "authorization_completion_failed" });
          return new Response("Authorization failed.", { status: 400 });
        }

        logAuthEvent({ event: "success", ip });
        return Response.redirect(redirectTo, 302);
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  const maxLen = Math.max(bufA.byteLength, bufB.byteLength);
  if (maxLen === 0) return true;
  // Pad both buffers to equal length so comparison time is constant
  const paddedA = new Uint8Array(maxLen);
  const paddedB = new Uint8Array(maxLen);
  paddedA.set(bufA);
  paddedB.set(bufB);
  // timingSafeEqual requires equal-length buffers — now guaranteed
  const equal = crypto.subtle.timingSafeEqual(paddedA, paddedB);
  // Even if byte comparison passes, lengths must also match for true equality
  return equal && bufA.byteLength === bufB.byteLength;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function errorPage(heading: string, message: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CF Code Assistant — Error</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #e5e5e5; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 2rem; max-width: 400px; width: 100%; }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; color: #f97316; }
    p { color: #999; font-size: 0.875rem; margin: 0 0 1.5rem; }
    a { color: #f97316; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(message)}</p>
    <p><a href="/authorize">Try again</a></p>
  </div>
</body>
</html>`;
}

function loginPage(csrfToken: string): string {
  const safeToken = escapeHtml(csrfToken);
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CF Code Assistant — Authorize</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #e5e5e5; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 2rem; max-width: 400px; width: 100%; }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    p { color: #999; font-size: 0.875rem; margin: 0 0 1.5rem; }
    input[type="password"] { width: 100%; padding: 0.75rem; border: 1px solid #333; border-radius: 8px; background: #0a0a0a; color: #e5e5e5; font-size: 1rem; box-sizing: border-box; }
    button { width: 100%; padding: 0.75rem; border: none; border-radius: 8px; background: #f97316; color: #fff; font-size: 1rem; font-weight: 600; cursor: pointer; margin-top: 1rem; }
    button:hover { background: #ea580c; }
  </style>
</head>
<body>
  <div class="card">
    <h1>CF Code Assistant</h1>
    <p>Enter your secret to authorize this MCP client.</p>
    <form method="POST" action="/authorize">
      <input type="hidden" name="csrf" value="${safeToken}">
      <input type="password" name="secret" placeholder="MCP Secret" required autofocus>
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`;
}

// --- Test exports (named exports for unit testing) ---
export { resolveModel, isAllowedModel, timingSafeEqual, callModel, makeToolError, createMcpServer, authHandler, runAIWithMetrics, ALLOWED_MODELS, DEFAULT_MODELS, runTask, TASK_SPECS, ValidationError, BatchOutputSchema, deriveErrorType, BatchTaskInputSchema };
export type { ModelTier, ErrorCode, AIResult, TaskKind };

// --- Wire it all up ---

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: {
    fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
      const server = createMcpServer(env);
      return createMcpHandler(server)(request, env, ctx);
    },
  },
  defaultHandler: authHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  accessTokenTTL: 31536000, // 1 year
});
