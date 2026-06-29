import { describe, it, expect, vi } from "vitest";
import { TASK_SPECS, runTask, createMcpServer, DEFAULT_MODELS } from "../index";
import type { TaskKind } from "../index";
import { createMockEnv } from "./helpers";

// WARNING: Accesses SDK internals (_registeredTools). If this breaks after an SDK update,
// check McpServer's internal structure for the new property name.
function getToolHandler(env: Env, toolName: string) {
  const server = createMcpServer(env);
  const tools = (server as any)._registeredTools;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  return tool.handler;
}

const strOfLen = (n: number) => "x".repeat(n);

// ---------------------------------------------------------------------------
// BATCH-02: buildPrompt byte-equality snapshots
// ---------------------------------------------------------------------------

describe("BATCH-02: buildPrompt snapshots", () => {

  // --- generateCode ---

  it("generateCode: prompt only (no optional fields)", () => {
    expect(
      TASK_SPECS.generateCode.buildPrompt({ prompt: "write hello world" })
    ).toBe("Task:\nwrite hello world");
  });

  it("generateCode: with language only", () => {
    expect(
      TASK_SPECS.generateCode.buildPrompt({ prompt: "write hello world", language: "typescript" })
    ).toBe("Language: typescript\n\nTask:\nwrite hello world");
  });

  it("generateCode: with style only", () => {
    expect(
      TASK_SPECS.generateCode.buildPrompt({ prompt: "write hello world", style: "functional" })
    ).toBe("Style: functional\n\nTask:\nwrite hello world");
  });

  it("generateCode: with context only", () => {
    expect(
      TASK_SPECS.generateCode.buildPrompt({ prompt: "write hello world", context: "existing code here" })
    ).toBe("Context:\nexisting code here\n\nTask:\nwrite hello world");
  });

  it("generateCode: with all optional fields", () => {
    expect(
      TASK_SPECS.generateCode.buildPrompt({
        prompt: "write hello world",
        language: "typescript",
        style: "functional",
        context: "existing code here",
      })
    ).toBe(
      "Language: typescript\n\nStyle: functional\n\nContext:\nexisting code here\n\nTask:\nwrite hello world"
    );
  });

  // --- reviewCode ---

  it("reviewCode: without criteria (.filter(Boolean) drops empty slot)", () => {
    expect(
      TASK_SPECS.reviewCode.buildPrompt({ code: "const x = 1" })
    ).toBe(
      "Review the following code and return structured findings as a markdown list.\n\nCategories: Bugs, Style, Performance, Security, Suggestions.\n\nOnly include categories where you find issues.\n\n```\nconst x = 1\n```"
    );
  });

  it("reviewCode: with criteria", () => {
    expect(
      TASK_SPECS.reviewCode.buildPrompt({ code: "const x = 1", criteria: "security" })
    ).toBe(
      "Review the following code and return structured findings as a markdown list.\n\nCategories: Bugs, Style, Performance, Security, Suggestions.\n\nOnly include categories where you find issues.\n\nFocus on: security\n\n```\nconst x = 1\n```"
    );
  });

  // --- transformCode ---

  it("transformCode: prompt is correct 3-part join", () => {
    expect(
      TASK_SPECS.transformCode.buildPrompt({ code: "const x = 1", instruction: "rename to y" })
    ).toBe(
      "Apply the following transformation to this code. Return only the transformed code.\n\nTransformation: rename to y\n\n```\nconst x = 1\n```"
    );
  });

  // --- scaffoldTests ---

  it("scaffoldTests: default framework (vitest)", () => {
    expect(
      TASK_SPECS.scaffoldTests.buildPrompt({ code: "function add(a,b){return a+b}" })
    ).toBe(
      "Generate comprehensive test scaffolding using vitest for the following code.\n\nInclude happy path, edge cases, and error cases. Return only test code.\n\n```\nfunction add(a,b){return a+b}\n```"
    );
  });

  it("scaffoldTests: explicit framework (jest)", () => {
    expect(
      TASK_SPECS.scaffoldTests.buildPrompt({ code: "function add(a,b){return a+b}", framework: "jest" })
    ).toBe(
      "Generate comprehensive test scaffolding using jest for the following code.\n\nInclude happy path, edge cases, and error cases. Return only test code.\n\n```\nfunction add(a,b){return a+b}\n```"
    );
  });

  // --- quickTask ---

  it("quickTask: returns instruction raw with no wrapping", () => {
    expect(
      TASK_SPECS.quickTask.buildPrompt({ instruction: "regex for email" })
    ).toBe("regex for email");
  });

  // --- explainCode ---

  it("explainCode: brief depth", () => {
    expect(
      TASK_SPECS.explainCode.buildPrompt({ code: "x++", depth: "brief" })
    ).toBe(
      "Explain in 1-2 concise sentences what this code does.\n\n```\nx++\n```"
    );
  });

  it("explainCode: detailed depth", () => {
    expect(
      TASK_SPECS.explainCode.buildPrompt({ code: "x++", depth: "detailed" })
    ).toBe(
      "Provide a detailed walkthrough of this code: purpose, control flow, key decisions, and any notable patterns.\n\n```\nx++\n```"
    );
  });

  it("explainCode: eli5 depth", () => {
    expect(
      TASK_SPECS.explainCode.buildPrompt({ code: "x++", depth: "eli5" })
    ).toBe(
      "Explain this code like I'm 5 years old, using a simple real-world analogy. No jargon.\n\n```\nx++\n```"
    );
  });

  it("explainCode: default (no depth) = brief", () => {
    expect(
      TASK_SPECS.explainCode.buildPrompt({ code: "x++" })
    ).toBe(
      "Explain in 1-2 concise sentences what this code does.\n\n```\nx++\n```"
    );
  });

  // --- generateDocs ---

  it("generateDocs: default style (tsdoc)", () => {
    expect(
      TASK_SPECS.generateDocs.buildPrompt({ code: "function f(){}" })
    ).toBe(
      "Add TSDoc comments (/** */) to all exported functions, classes, and interfaces. Include @param, @returns, @remarks, and @example where appropriate. Use TSDoc-specific tags. Return the full code with documentation added.\n\n```\nfunction f(){}\n```"
    );
  });

  it("generateDocs: jsdoc style", () => {
    expect(
      TASK_SPECS.generateDocs.buildPrompt({ code: "function f(){}", style: "jsdoc" })
    ).toBe(
      "Add JSDoc comments (/** */) to all exported functions, classes, and interfaces. Include @param, @returns, and @example where appropriate. Return the full code with documentation added.\n\n```\nfunction f(){}\n```"
    );
  });

  it("generateDocs: inline style", () => {
    expect(
      TASK_SPECS.generateDocs.buildPrompt({ code: "function f(){}", style: "inline" })
    ).toBe(
      "Add concise inline comments (// ) above non-obvious logic. Do not comment self-evident code. Focus on why, not what. Return the full code with documentation added.\n\n```\nfunction f(){}\n```"
    );
  });

  // --- generateTypes ---

  it("generateTypes: prompt is correct 2-part join", () => {
    expect(
      TASK_SPECS.generateTypes.buildPrompt({ code: "const x = 1" })
    ).toBe(
      "Generate TypeScript type definitions for this code. Infer interfaces, type aliases, and generics from usage patterns. Return only the typed version of the code.\n\n```\nconst x = 1\n```"
    );
  });

  // --- fixBug ---

  it("fixBug: prompt is correct 3-part join", () => {
    expect(
      TASK_SPECS.fixBug.buildPrompt({ code: "x()", error: "x is not a function" })
    ).toBe(
      "Fix the bug in this code. Return only the corrected code.\n\nError:\nx is not a function\n\n```\nx()\n```"
    );
  });

  // --- generateCommitMessage ---

  it("generateCommitMessage: uses ```diff language tag (not bare ```)", () => {
    expect(
      TASK_SPECS.generateCommitMessage.buildPrompt({ diff: "+const x = 1" })
    ).toBe(
      "Generate a concise git commit message for this diff using conventional commits format (feat/fix/refactor/docs/test/chore).\n\nFormat: type(scope): description\n\nKeep the first line under 72 characters. Add a blank line and body only if the change is non-trivial.\n\nReturn only the commit message, nothing else.\n\n```diff\n+const x = 1\n```"
    );
  });

  // --- generateWorkerBoilerplate ---

  it("generateWorkerBoilerplate: without bindings", () => {
    expect(
      TASK_SPECS.generateWorkerBoilerplate.buildPrompt({ description: "hello world worker" })
    ).toBe(
      "Generate a complete Cloudflare Worker in TypeScript with proper Env interface, fetch handler, and error handling.\n\nPurpose: hello world worker\n\nInclude the wrangler.toml snippet as a comment at the top. Return only the code."
    );
  });

  it("generateWorkerBoilerplate: with bindings", () => {
    expect(
      TASK_SPECS.generateWorkerBoilerplate.buildPrompt({ description: "hello world worker", bindings: "KV, R2" })
    ).toBe(
      "Generate a complete Cloudflare Worker in TypeScript with proper Env interface, fetch handler, and error handling.\n\nPurpose: hello world worker\n\nBindings to include in the Env interface: KV, R2\n\nInclude the wrangler.toml snippet as a comment at the top. Return only the code."
    );
  });

});

// ---------------------------------------------------------------------------
// BATCH-02: explainCode resolve — tier + maxTokens per depth
// ---------------------------------------------------------------------------

describe("BATCH-02: explainCode resolve", () => {

  it("detailed -> {tier:'standard', maxTokens:4096}", () => {
    expect(TASK_SPECS.explainCode.resolve({ code: "x", depth: "detailed" }))
      .toEqual({ tier: "standard", maxTokens: 4096 });
  });

  it("brief -> {tier:'fast', maxTokens:2048}", () => {
    expect(TASK_SPECS.explainCode.resolve({ code: "x", depth: "brief" }))
      .toEqual({ tier: "fast", maxTokens: 2048 });
  });

  it("eli5 -> {tier:'fast', maxTokens:2048}", () => {
    expect(TASK_SPECS.explainCode.resolve({ code: "x", depth: "eli5" }))
      .toEqual({ tier: "fast", maxTokens: 2048 });
  });

  it("default (no depth) -> {tier:'fast', maxTokens:2048}", () => {
    expect(TASK_SPECS.explainCode.resolve({ code: "x" }))
      .toEqual({ tier: "fast", maxTokens: 2048 });
  });

  // constant-tier kinds sanity check
  it("generateCode resolve returns standard/8192", () => {
    expect(TASK_SPECS.generateCode.resolve({})).toEqual({ tier: "standard", maxTokens: 8192 });
  });

  it("quickTask resolve returns fast/4096", () => {
    expect(TASK_SPECS.quickTask.resolve({})).toEqual({ tier: "fast", maxTokens: 4096 });
  });

  it("generateCommitMessage resolve returns fast/1024", () => {
    expect(TASK_SPECS.generateCommitMessage.resolve({})).toEqual({ tier: "fast", maxTokens: 1024 });
  });

  it("reviewCode resolve returns standard/4096", () => {
    expect(TASK_SPECS.reviewCode.resolve({})).toEqual({ tier: "standard", maxTokens: 4096 });
  });

});

// ---------------------------------------------------------------------------
// BATCH-02: transformCode 8KB cap
// ---------------------------------------------------------------------------

describe("BATCH-02: transformCode 8KB cap", () => {

  it("validate passes at exactly 8000 bytes", () => {
    expect(() =>
      TASK_SPECS.transformCode.validate!({ code: strOfLen(8000), instruction: "rename" })
    ).not.toThrow();
  });

  it("validate throws at 8001 bytes", () => {
    expect(() =>
      TASK_SPECS.transformCode.validate!({ code: strOfLen(8001), instruction: "rename" })
    ).toThrow();
  });

});

// ---------------------------------------------------------------------------
// BATCH-01: runTask wiring (smoke test — end-to-end through mock AI)
// ---------------------------------------------------------------------------

describe("BATCH-01: runTask wiring", () => {

  it("runTask returns AIResult for a valid kind", async () => {
    const env = createMockEnv({ aiResponse: "mock AI output" });
    const result = await runTask(env, "generateCode" as TaskKind, { prompt: "hi" });
    expect(result.text).toBe("mock AI output");
    expect(result.model).toBe(DEFAULT_MODELS.standard);
    expect(typeof result.latency_ms).toBe("number");
  });

  it("runTask works for a fast-tier kind (quickTask)", async () => {
    const env = createMockEnv({ aiResponse: "mock AI output" });
    const result = await runTask(env, "quickTask" as TaskKind, { instruction: "test" });
    expect(result.text).toBe("mock AI output");
    expect(result.model).toBe("@cf/qwen/qwen3-30b-a3b-fp8");
  });

});

// ---------------------------------------------------------------------------
// BATCH-F03: per-task tier override
// ---------------------------------------------------------------------------

describe("BATCH-F03: per-task tier override", () => {

  it("overrides to fast model when tier:'fast' is passed (tier)", async () => {
    const env = createMockEnv({ aiResponse: "fast output" });
    const result = await runTask(env, "generateCode", { prompt: "hello" }, { tier: "fast" });
    expect(result.model).toBe(DEFAULT_MODELS.fast);
  });

  it("uses kind default (standard) when no tier override is passed (tier)", async () => {
    const env = createMockEnv({ aiResponse: "standard output" });
    const result = await runTask(env, "generateCode", { prompt: "hello" });
    expect(result.model).toBe(DEFAULT_MODELS.standard);
  });

  it("tier override does NOT change max_tokens — kind's maxTokens is always used (maxTokens)", async () => {
    // generateCode has maxTokens:8192 regardless of tier
    const envDefault = createMockEnv({ aiResponse: "output" });
    await runTask(envDefault, "generateCode", { prompt: "hello" });
    const defaultMaxTokens = (envDefault.AI.run as ReturnType<typeof vi.fn>).mock.calls[0][1].max_tokens;

    const envOverride = createMockEnv({ aiResponse: "output" });
    await runTask(envOverride, "generateCode", { prompt: "hello" }, { tier: "fast" });
    const overrideMaxTokens = (envOverride.AI.run as ReturnType<typeof vi.fn>).mock.calls[0][1].max_tokens;

    expect(overrideMaxTokens).toBe(defaultMaxTokens);
    expect(overrideMaxTokens).toBe(8192);
  });

});

// ---------------------------------------------------------------------------
// BATCH-01: transformCode single-task over-cap INPUT_TOO_LARGE envelope
// ---------------------------------------------------------------------------

describe("BATCH-01: transformCode over-cap INPUT_TOO_LARGE envelope", () => {

  it("returns isError true with byte-identical INPUT_TOO_LARGE message at 8001 bytes", async () => {
    const env = createMockEnv({ aiResponse: "should not be called" });
    const handler = getToolHandler(env, "transformCode");
    const result = await handler(
      { code: strOfLen(8001), instruction: "rename" },
      undefined
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      "[ERROR: INPUT_TOO_LARGE] transformCode received 8001 bytes; cap is 8000. Full-file rewrites at this size routinely exceed the 45s model timeout. Scope the transformation to a single function or block and splice the result back yourself."
    );
  });

  it("INPUT_TOO_LARGE message starts with the exact error prefix", async () => {
    const env = createMockEnv({ aiResponse: "should not be called" });
    const handler = getToolHandler(env, "transformCode");
    const result = await handler(
      { code: strOfLen(8001), instruction: "rename" },
      undefined
    );
    expect(result.content[0].text).toMatch(
      /^\[ERROR: INPUT_TOO_LARGE\] transformCode received 8001 bytes; cap is 8000\./
    );
  });

});
