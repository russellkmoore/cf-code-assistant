import { OAuthProvider, type OAuthHelpers, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// --- Model tier config ---

type ModelTier = "fast" | "standard";

const ALLOWED_MODELS = [
  "@cf/qwen/qwen3-30b-a3b-fp8",
] as const satisfies ReadonlyArray<keyof AiModels>;

type AllowedModel = (typeof ALLOWED_MODELS)[number];

function isAllowedModel(model: string): model is AllowedModel {
  return (ALLOWED_MODELS as readonly string[]).includes(model);
}

const DEFAULT_MODELS: Record<ModelTier, keyof AiModels> = {
  fast: "@cf/qwen/qwen3-30b-a3b-fp8",
  standard: "@cf/qwen/qwen3-30b-a3b-fp8",
};

const AI_TIMEOUT_MS = 30_000;

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

async function callModel(
  env: Env,
  model: keyof AiModels,
  userPrompt: string,
  maxTokens: number,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  const timeoutPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => {
      reject(new Error("AI_TIMEOUT"));
    });
  });

  try {
    const aiPromise = env.AI.run(model, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
    });

    const response = await Promise.race([aiPromise, timeoutPromise]);
    const result = response as { response?: string };
    return result.response ?? JSON.stringify(response);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runAI(env: Env, tier: ModelTier, userPrompt: string, maxTokens = 4096): Promise<string> {
  const model = await resolveModel(env, tier);
  return callModel(env, model, userPrompt, maxTokens);
}

// --- Error helpers ---

type ErrorCode = "AI_TIMEOUT" | "AI_ERROR" | "INTERNAL_ERROR";

function makeToolError(code: ErrorCode, toolName: string) {
  const messages: Record<ErrorCode, string> = {
    AI_TIMEOUT: `[ERROR: AI_TIMEOUT] The AI model did not respond within 30 seconds for tool ${toolName}. Please retry.`,
    AI_ERROR: `[ERROR: AI_ERROR] The AI model returned an error for tool ${toolName}. The service may be temporarily degraded.`,
    INTERNAL_ERROR: `[ERROR: INTERNAL_ERROR] An internal error occurred in tool ${toolName}. Please retry.`,
  };
  return {
    content: [{ type: "text" as const, text: messages[code] }],
    isError: true as const,
  };
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
        const parts: string[] = [];
        if (language) parts.push(`Language: ${language}`);
        if (style) parts.push(`Style: ${style}`);
        if (context) parts.push(`Context:\n${context}`);
        parts.push(`Task:\n${prompt}`);

        const code = await runAI(env, "standard", parts.join("\n\n"), 8192);
        return { content: [{ type: "text", text: code }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg === "AI_TIMEOUT") {
          console.error("Tool error [generateCode]: AI_TIMEOUT");
          return makeToolError("AI_TIMEOUT", "generateCode");
        }
        console.error("Tool error [generateCode]:", msg || "unknown");
        return makeToolError("AI_ERROR", "generateCode");
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
        const prompt = [
          "Review the following code and return structured findings as a markdown list.",
          "Categories: Bugs, Style, Performance, Security, Suggestions.",
          "Only include categories where you find issues.",
          criteria ? `Focus on: ${criteria}` : "",
          `\`\`\`\n${code}\n\`\`\``,
        ]
          .filter(Boolean)
          .join("\n\n");

        const review = await runAI(env, "standard", prompt, 4096);
        return { content: [{ type: "text", text: review }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg === "AI_TIMEOUT") {
          console.error("Tool error [reviewCode]: AI_TIMEOUT");
          return makeToolError("AI_TIMEOUT", "reviewCode");
        }
        console.error("Tool error [reviewCode]:", msg || "unknown");
        return makeToolError("AI_ERROR", "reviewCode");
      }
    },
  );

  server.registerTool(
    "transformCode",
    {
      description: "Apply mechanical transformations to code: rename, reformat, convert patterns, add types, etc.",
      inputSchema: {
        code: z.string().max(100_000).trim().describe("The code to transform"),
        instruction: z.string().max(10_000).trim().describe("What transformation to apply"),
      },
    },
    async ({ code, instruction }) => {
      try {
        const prompt = [
          `Apply the following transformation to this code. Return only the transformed code.`,
          `Transformation: ${instruction}`,
          `\`\`\`\n${code}\n\`\`\``,
        ].join("\n\n");

        const transformed = await runAI(env, "standard", prompt, 8192);
        return { content: [{ type: "text", text: transformed }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg === "AI_TIMEOUT") {
          console.error("Tool error [transformCode]: AI_TIMEOUT");
          return makeToolError("AI_TIMEOUT", "transformCode");
        }
        console.error("Tool error [transformCode]:", msg || "unknown");
        return makeToolError("AI_ERROR", "transformCode");
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
        const fw = framework ?? "vitest";
        const prompt = [
          `Generate comprehensive test scaffolding using ${fw} for the following code.`,
          `Include happy path, edge cases, and error cases. Return only test code.`,
          `\`\`\`\n${code}\n\`\`\``,
        ].join("\n\n");

        const tests = await runAI(env, "standard", prompt, 8192);
        return { content: [{ type: "text", text: tests }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg === "AI_TIMEOUT") {
          console.error("Tool error [scaffoldTests]: AI_TIMEOUT");
          return makeToolError("AI_TIMEOUT", "scaffoldTests");
        }
        console.error("Tool error [scaffoldTests]:", msg || "unknown");
        return makeToolError("AI_ERROR", "scaffoldTests");
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
        const result = await runAI(env, "fast", instruction, 4096);
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg === "AI_TIMEOUT") {
          console.error("Tool error [quickTask]: AI_TIMEOUT");
          return makeToolError("AI_TIMEOUT", "quickTask");
        }
        console.error("Tool error [quickTask]:", msg || "unknown");
        return makeToolError("AI_ERROR", "quickTask");
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
        const level = depth ?? "brief";
        const depthInstructions: Record<string, string> = {
          brief: "Explain in 1-2 concise sentences what this code does.",
          detailed: "Provide a detailed walkthrough of this code: purpose, control flow, key decisions, and any notable patterns.",
          eli5: "Explain this code like I'm 5 years old, using a simple real-world analogy. No jargon.",
        };
        const prompt = [
          depthInstructions[level],
          `\`\`\`\n${code}\n\`\`\``,
        ].join("\n\n");

        const explanation = await runAI(env, level === "detailed" ? "standard" : "fast", prompt, level === "detailed" ? 4096 : 2048);
        return { content: [{ type: "text", text: explanation }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg === "AI_TIMEOUT") {
          console.error("Tool error [explainCode]: AI_TIMEOUT");
          return makeToolError("AI_TIMEOUT", "explainCode");
        }
        console.error("Tool error [explainCode]:", msg || "unknown");
        return makeToolError("AI_ERROR", "explainCode");
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
        const docStyle = style ?? "tsdoc";
        const styleInstructions: Record<string, string> = {
          jsdoc: "Add JSDoc comments (/** */) to all exported functions, classes, and interfaces. Include @param, @returns, and @example where appropriate.",
          tsdoc: "Add TSDoc comments (/** */) to all exported functions, classes, and interfaces. Include @param, @returns, @remarks, and @example where appropriate. Use TSDoc-specific tags.",
          inline: "Add concise inline comments (// ) above non-obvious logic. Do not comment self-evident code. Focus on why, not what.",
        };
        const prompt = [
          `${styleInstructions[docStyle]} Return the full code with documentation added.`,
          `\`\`\`\n${code}\n\`\`\``,
        ].join("\n\n");

        const documented = await runAI(env, "standard", prompt, 8192);
        return { content: [{ type: "text", text: documented }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg === "AI_TIMEOUT") {
          console.error("Tool error [generateDocs]: AI_TIMEOUT");
          return makeToolError("AI_TIMEOUT", "generateDocs");
        }
        console.error("Tool error [generateDocs]:", msg || "unknown");
        return makeToolError("AI_ERROR", "generateDocs");
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
        const prompt = [
          "Generate TypeScript type definitions for this code. Infer interfaces, type aliases, and generics from usage patterns. Return only the typed version of the code.",
          `\`\`\`\n${code}\n\`\`\``,
        ].join("\n\n");

        const typed = await runAI(env, "standard", prompt, 8192);
        return { content: [{ type: "text", text: typed }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg === "AI_TIMEOUT") {
          console.error("Tool error [generateTypes]: AI_TIMEOUT");
          return makeToolError("AI_TIMEOUT", "generateTypes");
        }
        console.error("Tool error [generateTypes]:", msg || "unknown");
        return makeToolError("AI_ERROR", "generateTypes");
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
        const prompt = [
          "Fix the bug in this code. Return only the corrected code.",
          `Error:\n${error}`,
          `\`\`\`\n${code}\n\`\`\``,
        ].join("\n\n");

        const fixed = await runAI(env, "standard", prompt, 8192);
        return { content: [{ type: "text", text: fixed }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg === "AI_TIMEOUT") {
          console.error("Tool error [fixBug]: AI_TIMEOUT");
          return makeToolError("AI_TIMEOUT", "fixBug");
        }
        console.error("Tool error [fixBug]:", msg || "unknown");
        return makeToolError("AI_ERROR", "fixBug");
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
        const prompt = [
          "Generate a concise git commit message for this diff using conventional commits format (feat/fix/refactor/docs/test/chore).",
          "Format: type(scope): description",
          "Keep the first line under 72 characters. Add a blank line and body only if the change is non-trivial.",
          "Return only the commit message, nothing else.",
          `\`\`\`diff\n${diff}\n\`\`\``,
        ].join("\n\n");

        const message = await runAI(env, "fast", prompt, 1024);
        return { content: [{ type: "text", text: message }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg === "AI_TIMEOUT") {
          console.error("Tool error [generateCommitMessage]: AI_TIMEOUT");
          return makeToolError("AI_TIMEOUT", "generateCommitMessage");
        }
        console.error("Tool error [generateCommitMessage]:", msg || "unknown");
        return makeToolError("AI_ERROR", "generateCommitMessage");
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
        const parts = [
          "Generate a complete Cloudflare Worker in TypeScript with proper Env interface, fetch handler, and error handling.",
          `Purpose: ${description}`,
        ];
        if (bindings) parts.push(`Bindings to include in the Env interface: ${bindings}`);
        parts.push("Include the wrangler.toml snippet as a comment at the top. Return only the code.");

        const boilerplate = await runAI(env, "standard", parts.join("\n\n"), 8192);
        return { content: [{ type: "text", text: boilerplate }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg === "AI_TIMEOUT") {
          console.error("Tool error [generateWorkerBoilerplate]: AI_TIMEOUT");
          return makeToolError("AI_TIMEOUT", "generateWorkerBoilerplate");
        }
        console.error("Tool error [generateWorkerBoilerplate]:", msg || "unknown");
        return makeToolError("AI_ERROR", "generateWorkerBoilerplate");
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

  return server;
}

// --- Auth handler (self-contained, PIN-based) ---

const authHandler: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const oauthHelpers = (ctx as unknown as { oauth: OAuthHelpers }).oauth;

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
          console.error("[authHandler GET] Failed to initialize auth:", err instanceof Error ? err.message : "unknown");
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
          return new Response("Too many attempts. Try again later.", { status: 429 });
        }

        const formData = await request.formData();
        const secret = formData.get("secret");
        const csrfToken = formData.get("csrf");

        if (typeof secret !== "string" || !secret.trim() || typeof csrfToken !== "string" || !csrfToken.trim()) {
          return new Response("Invalid form data.", { status: 400 });
        }

        if (secret.length > 256 || csrfToken.length > 256) {
          return new Response("Invalid form data.", { status: 400 });
        }

        const stored = await env.OAUTH_KV.get(`csrf:${csrfToken}`);
        if (!stored) {
          return new Response("Session expired. Please try again.", { status: 400 });
        }
        await env.OAUTH_KV.delete(`csrf:${csrfToken}`);

        if (!secret || !timingSafeEqual(secret, env.MCP_SECRET)) {
          return new Response("Invalid secret.", { status: 403 });
        }

        let authRequest: AuthRequest;
        try {
          authRequest = JSON.parse(stored) as AuthRequest;
        } catch {
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
          return new Response("Authorization failed.", { status: 400 });
        }

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
    <h1>${heading}</h1>
    <p>${message}</p>
    <p><a href="/authorize">Try again</a></p>
  </div>
</body>
</html>`;
}

function loginPage(csrfToken: string): string {
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
      <input type="hidden" name="csrf" value="${csrfToken}">
      <input type="password" name="secret" placeholder="MCP Secret" required autofocus>
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`;
}

// --- Test exports (named exports for unit testing) ---
export { resolveModel, isAllowedModel, timingSafeEqual, callModel, makeToolError, createMcpServer, authHandler, ALLOWED_MODELS, DEFAULT_MODELS };
export type { ModelTier, ErrorCode };

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
  accessTokenTTL: 86400, // 24 hours
});
