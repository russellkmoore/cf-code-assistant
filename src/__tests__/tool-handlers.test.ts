import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMcpServer } from "../index";
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

describe("TEST-03: Fast-tier tool handlers", () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv({ aiResponse: "mock AI output" });
  });

  describe("quickTask", () => {
    it("returns AI response for valid instruction", async () => {
      const handler = getToolHandler(env, "quickTask");
      const result = await handler({ instruction: "regex for email" }, undefined);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toBe("mock AI output");
      expect(env.AI.run).toHaveBeenCalled();
    });

    it("returns AI_TIMEOUT error when AI times out", async () => {
      (env.AI.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("AI_TIMEOUT"));
      const handler = getToolHandler(env, "quickTask");
      const result = await handler({ instruction: "test" }, undefined);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("AI_TIMEOUT");
    });

    it("returns AI_ERROR for non-timeout errors", async () => {
      (env.AI.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("model not found"));
      const handler = getToolHandler(env, "quickTask");
      const result = await handler({ instruction: "test" }, undefined);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("AI_ERROR");
    });
  });

  describe("generateCommitMessage", () => {
    it("returns AI response for valid diff", async () => {
      const handler = getToolHandler(env, "generateCommitMessage");
      const result = await handler({ diff: "+const x = 1" }, undefined);
      expect(result.content[0].text).toBe("mock AI output");
    });

    it("returns AI_TIMEOUT error on timeout", async () => {
      (env.AI.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("AI_TIMEOUT"));
      const handler = getToolHandler(env, "generateCommitMessage");
      const result = await handler({ diff: "+test" }, undefined);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("AI_TIMEOUT");
    });

    it("returns AI_ERROR for non-timeout errors", async () => {
      (env.AI.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("unexpected"));
      const handler = getToolHandler(env, "generateCommitMessage");
      const result = await handler({ diff: "+test" }, undefined);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("AI_ERROR");
    });
  });

  describe("explainCode (brief/eli5 = fast tier)", () => {
    it("returns AI response for brief explanation", async () => {
      const handler = getToolHandler(env, "explainCode");
      const result = await handler({ code: "x++", depth: "brief" }, undefined);
      expect(result.content[0].text).toBe("mock AI output");
    });

    it("returns AI response for eli5 explanation", async () => {
      const handler = getToolHandler(env, "explainCode");
      const result = await handler({ code: "x++", depth: "eli5" }, undefined);
      expect(result.content[0].text).toBe("mock AI output");
    });

    it("returns AI_TIMEOUT error on timeout", async () => {
      (env.AI.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("AI_TIMEOUT"));
      const handler = getToolHandler(env, "explainCode");
      const result = await handler({ code: "x++", depth: "brief" }, undefined);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("AI_TIMEOUT");
    });

    it("returns AI_ERROR for non-timeout errors", async () => {
      (env.AI.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("unexpected"));
      const handler = getToolHandler(env, "explainCode");
      const result = await handler({ code: "x++", depth: "brief" }, undefined);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("AI_ERROR");
    });
  });
});

describe("TEST-03: Standard-tier tool handlers", () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv({ aiResponse: "mock AI output" });
  });

  const standardTools = [
    { name: "generateCode", args: { prompt: "write hello world" } },
    { name: "reviewCode", args: { code: "const x = 1" } },
    { name: "transformCode", args: { code: "const x = 1", instruction: "rename to y" } },
    { name: "scaffoldTests", args: { code: "function add(a,b){return a+b}" } },
    { name: "generateDocs", args: { code: "function f(){}" } },
    { name: "generateTypes", args: { code: "const x = 1" } },
    { name: "fixBug", args: { code: "x()", error: "x is not a function" } },
    { name: "generateWorkerBoilerplate", args: { description: "hello world worker" } },
  ];

  for (const { name, args } of standardTools) {
    describe(name, () => {
      it("returns AI response for valid input", async () => {
        const handler = getToolHandler(env, name);
        const result = await handler(args, undefined);
        expect(result.content[0].type).toBe("text");
        expect(result.content[0].text).toBe("mock AI output");
        expect(env.AI.run).toHaveBeenCalled();
      });

      it("returns AI_TIMEOUT error when AI times out", async () => {
        (env.AI.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("AI_TIMEOUT"));
        const handler = getToolHandler(env, name);
        const result = await handler(args, undefined);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("AI_TIMEOUT");
      });

      it("returns AI_ERROR for non-timeout errors", async () => {
        (env.AI.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("unexpected"));
        const handler = getToolHandler(env, name);
        const result = await handler(args, undefined);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("AI_ERROR");
      });
    });
  }

  describe("explainCode (detailed = standard tier)", () => {
    it("returns AI response for detailed explanation", async () => {
      const env2 = createMockEnv({ aiResponse: "mock AI output" });
      const handler = getToolHandler(env2, "explainCode");
      const result = await handler({ code: "x++", depth: "detailed" }, undefined);
      expect(result.content[0].text).toBe("mock AI output");
    });

    it("returns AI_TIMEOUT error on timeout", async () => {
      const env2 = createMockEnv({ aiResponse: "mock AI output" });
      (env2.AI.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("AI_TIMEOUT"));
      const handler = getToolHandler(env2, "explainCode");
      const result = await handler({ code: "x++", depth: "detailed" }, undefined);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("AI_TIMEOUT");
    });

    it("returns AI_ERROR for non-timeout errors", async () => {
      const env2 = createMockEnv({ aiResponse: "mock AI output" });
      (env2.AI.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("unexpected"));
      const handler = getToolHandler(env2, "explainCode");
      const result = await handler({ code: "x++", depth: "detailed" }, undefined);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("AI_ERROR");
    });
  });
});

describe("TEST-03: routingInfo (no AI call)", () => {
  it("returns static routing info without calling AI", async () => {
    const env = createMockEnv();
    const handler = getToolHandler(env, "routingInfo");
    const result = await handler({}, undefined);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("Tool Routing Guide");
    expect(env.AI.run).not.toHaveBeenCalled();
  });
});
