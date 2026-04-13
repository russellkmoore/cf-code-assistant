import { describe, it, expect, beforeEach } from "vitest";
import { createMcpServer } from "../index";
import { createMockEnv } from "./helpers";

function getToolSchema(env: Env, toolName: string) {
  const server = createMcpServer(env);
  const tools = (server as any)._registeredTools;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  return tool.inputSchema; // ZodObject from SDK's getZodSchemaObject()
}

function strOfLen(n: number): string {
  return "x".repeat(n);
}

describe("SEC-02: Input size caps", () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  describe("generateCode", () => {
    it("rejects prompt over 20,000 characters", () => {
      const schema = getToolSchema(env, "generateCode");
      expect(() => schema.parse({ prompt: strOfLen(20_001) })).toThrow();
    });

    it("accepts prompt at exactly 20,000 characters", () => {
      const schema = getToolSchema(env, "generateCode");
      expect(() => schema.parse({ prompt: strOfLen(20_000) })).not.toThrow();
    });

    it("rejects context over 50,000 characters", () => {
      const schema = getToolSchema(env, "generateCode");
      expect(() => schema.parse({ prompt: "valid", context: strOfLen(50_001) })).toThrow();
    });

    it("accepts context at exactly 50,000 characters", () => {
      const schema = getToolSchema(env, "generateCode");
      expect(() => schema.parse({ prompt: "valid", context: strOfLen(50_000) })).not.toThrow();
    });
  });

  describe("reviewCode", () => {
    it("rejects code over 100,000 characters", () => {
      const schema = getToolSchema(env, "reviewCode");
      expect(() => schema.parse({ code: strOfLen(100_001) })).toThrow();
    });

    it("accepts code at exactly 100,000 characters", () => {
      const schema = getToolSchema(env, "reviewCode");
      expect(() => schema.parse({ code: strOfLen(100_000) })).not.toThrow();
    });

    it("rejects criteria over 2,000 characters", () => {
      const schema = getToolSchema(env, "reviewCode");
      expect(() => schema.parse({ code: "valid", criteria: strOfLen(2_001) })).toThrow();
    });
  });

  describe("transformCode", () => {
    it("rejects code over 100,000 characters", () => {
      const schema = getToolSchema(env, "transformCode");
      expect(() => schema.parse({ code: strOfLen(100_001), instruction: "rename" })).toThrow();
    });

    it("rejects instruction over 10,000 characters", () => {
      const schema = getToolSchema(env, "transformCode");
      expect(() => schema.parse({ code: "valid", instruction: strOfLen(10_001) })).toThrow();
    });
  });

  describe("scaffoldTests", () => {
    it("rejects code over 100,000 characters", () => {
      const schema = getToolSchema(env, "scaffoldTests");
      expect(() => schema.parse({ code: strOfLen(100_001) })).toThrow();
    });

    it("accepts code at exactly 100,000 characters", () => {
      const schema = getToolSchema(env, "scaffoldTests");
      expect(() => schema.parse({ code: strOfLen(100_000) })).not.toThrow();
    });
  });

  describe("quickTask", () => {
    it("rejects instruction over 10,000 characters", () => {
      const schema = getToolSchema(env, "quickTask");
      expect(() => schema.parse({ instruction: strOfLen(10_001) })).toThrow();
    });

    it("accepts instruction at exactly 10,000 characters", () => {
      const schema = getToolSchema(env, "quickTask");
      expect(() => schema.parse({ instruction: strOfLen(10_000) })).not.toThrow();
    });
  });

  describe("explainCode", () => {
    it("rejects code over 100,000 characters", () => {
      const schema = getToolSchema(env, "explainCode");
      expect(() => schema.parse({ code: strOfLen(100_001) })).toThrow();
    });
  });

  describe("generateDocs", () => {
    it("rejects code over 100,000 characters", () => {
      const schema = getToolSchema(env, "generateDocs");
      expect(() => schema.parse({ code: strOfLen(100_001) })).toThrow();
    });
  });

  describe("generateTypes", () => {
    it("rejects code over 100,000 characters", () => {
      const schema = getToolSchema(env, "generateTypes");
      expect(() => schema.parse({ code: strOfLen(100_001) })).toThrow();
    });
  });

  describe("fixBug", () => {
    it("rejects code over 100,000 characters", () => {
      const schema = getToolSchema(env, "fixBug");
      expect(() => schema.parse({ code: strOfLen(100_001), error: "err" })).toThrow();
    });

    it("rejects error over 10,000 characters", () => {
      const schema = getToolSchema(env, "fixBug");
      expect(() => schema.parse({ code: "valid", error: strOfLen(10_001) })).toThrow();
    });
  });

  describe("generateCommitMessage", () => {
    it("rejects diff over 50,000 characters", () => {
      const schema = getToolSchema(env, "generateCommitMessage");
      expect(() => schema.parse({ diff: strOfLen(50_001) })).toThrow();
    });

    it("accepts diff at exactly 50,000 characters", () => {
      const schema = getToolSchema(env, "generateCommitMessage");
      expect(() => schema.parse({ diff: strOfLen(50_000) })).not.toThrow();
    });
  });

  describe("generateWorkerBoilerplate", () => {
    it("rejects description over 10,000 characters", () => {
      const schema = getToolSchema(env, "generateWorkerBoilerplate");
      expect(() => schema.parse({ description: strOfLen(10_001) })).toThrow();
    });

    it("accepts description at exactly 10,000 characters", () => {
      const schema = getToolSchema(env, "generateWorkerBoilerplate");
      expect(() => schema.parse({ description: strOfLen(10_000) })).not.toThrow();
    });

    it("rejects bindings over 500 characters", () => {
      const schema = getToolSchema(env, "generateWorkerBoilerplate");
      expect(() => schema.parse({ description: "valid", bindings: strOfLen(501) })).toThrow();
    });
  });
});
