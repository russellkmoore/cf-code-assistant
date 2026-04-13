import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockEnv, createMockKV, createMockRateLimiter } from "./helpers";
import { createMcpServer, authHandler } from "../index";

// ---------------------------------------------------------------------------
// Helper: parse structured JSON from console spy calls
// ---------------------------------------------------------------------------

function parseLogCalls(spy: ReturnType<typeof vi.spyOn>): unknown[] {
  return spy.mock.calls
    .map((args) => {
      try {
        return JSON.parse(args[0] as string);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// WARNING: Accesses SDK internals (_registeredTools). If this breaks after an SDK update,
// check McpServer's internal structure for the new property name.
function getToolHandler(env: Env, toolName: string) {
  const server = createMcpServer(env);
  const tools = (server as any)._registeredTools;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  return tool.handler;
}

// ---------------------------------------------------------------------------
// Shared spy setup
// ---------------------------------------------------------------------------

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// OBS-01: Tool invocation logging
// ---------------------------------------------------------------------------

describe("OBS-01: Tool invocation logging", () => {
  it("logs structured JSON on successful tool invocation", async () => {
    const env = createMockEnv({ aiResponse: "hello world" });
    const handler = getToolHandler(env, "quickTask");
    await handler({ instruction: "test task" }, undefined);

    const logs = parseLogCalls(logSpy);
    const invocation = logs.find(
      (l: any) => l.category === "tool_invocation"
    ) as any;

    expect(invocation).toBeDefined();
    expect(invocation.category).toBe("tool_invocation");
    expect(invocation.tool).toBe("quickTask");
    expect(invocation.tier).toBe("fast");
    expect(invocation.model).toBeDefined();
    expect(typeof invocation.latency_ms).toBe("number");
    expect(invocation.latency_ms).toBeGreaterThanOrEqual(0);
    expect(new Date(invocation.timestamp).toISOString()).toBe(
      invocation.timestamp
    );
  });

  it("does not log prompt content or AI response in invocation log", async () => {
    const env = createMockEnv({ aiResponse: "secret output" });
    const handler = getToolHandler(env, "quickTask");
    await handler({ instruction: "secret prompt data" }, undefined);

    const logs = parseLogCalls(logSpy);
    const invocation = logs.find(
      (l: any) => l.category === "tool_invocation"
    ) as any;

    expect(invocation).toBeDefined();
    expect(invocation).not.toHaveProperty("prompt");
    expect(invocation).not.toHaveProperty("response");
    expect(invocation).not.toHaveProperty("content");
    expect(invocation).not.toHaveProperty("input");
  });
});

// ---------------------------------------------------------------------------
// OBS-02: Tool error logging
// ---------------------------------------------------------------------------

describe("OBS-02: Tool error logging", () => {
  it("logs structured JSON on AI_TIMEOUT", async () => {
    const env = createMockEnv();
    (env.AI.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("AI_TIMEOUT")
    );

    const handler = getToolHandler(env, "quickTask");
    await handler({ instruction: "timeout test" }, undefined);

    const errors = parseLogCalls(errorSpy);
    const errorLog = errors.find(
      (l: any) => l.category === "tool_error"
    ) as any;

    expect(errorLog).toBeDefined();
    expect(errorLog.category).toBe("tool_error");
    expect(errorLog.tool).toBe("quickTask");
    expect(errorLog.error_type).toBe("AI_TIMEOUT");
    expect(typeof errorLog.input_size_bytes).toBe("number");
    expect(errorLog.input_size_bytes).toBeGreaterThan(0);
  });

  it("logs structured JSON on AI_ERROR", async () => {
    const env = createMockEnv();
    (env.AI.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("some random failure")
    );

    const handler = getToolHandler(env, "generateCode");
    await handler({ prompt: "generate something" }, undefined);

    const errors = parseLogCalls(errorSpy);
    const errorLog = errors.find(
      (l: any) => l.category === "tool_error"
    ) as any;

    expect(errorLog).toBeDefined();
    expect(errorLog.error_type).toBe("AI_ERROR");
    expect(errorLog.tool).toBe("generateCode");
  });

  it("error log does not contain stack traces", async () => {
    const env = createMockEnv();
    (env.AI.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("AI_TIMEOUT")
    );

    const handler = getToolHandler(env, "quickTask");
    await handler({ instruction: "test" }, undefined);

    const errors = parseLogCalls(errorSpy);
    for (const entry of errors) {
      expect(entry).not.toHaveProperty("stack");
    }
  });
});

// ---------------------------------------------------------------------------
// OBS-03: Auth event logging
// ---------------------------------------------------------------------------

describe("OBS-03: Auth event logging", () => {
  const makeBaseOAuthProvider = () => ({
    parseAuthRequest: vi.fn(async () => ({
      client_id: "test",
      redirect_uri: "https://example.com/callback",
      scope: ["read"],
      state: "xyz",
    })),
    completeAuthorization: vi.fn(async () => ({
      redirectTo: "https://example.com/callback?code=abc",
    })),
  });

  const makeBaseCtx = () =>
    ({
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    }) as unknown as ExecutionContext;

  const makeFormRequest = (secret: string, csrf: string, ip?: string) => {
    const formData = new FormData();
    formData.append("secret", secret);
    formData.append("csrf", csrf);
    const headers: Record<string, string> = {};
    if (ip) headers["CF-Connecting-IP"] = ip;
    return new Request("https://worker.example.com/authorize", {
      method: "POST",
      body: formData,
      headers,
    });
  };

  it("logs attempt and success on valid auth flow", async () => {
    const storedAuthRequest = JSON.stringify({
      client_id: "test",
      redirect_uri: "https://example.com/callback",
      scope: ["read"],
      state: "xyz",
    });

    const kv = createMockKV({ "csrf:valid-token": storedAuthRequest });
    const env = {
      OAUTH_KV: kv,
      AI: {} as Ai,
      MCP_SECRET: "test-secret-pin",
      AUTH_RATE_LIMITER: createMockRateLimiter(true),
      OAUTH_PROVIDER: makeBaseOAuthProvider(),
    } as unknown as Env;

    const ctx = makeBaseCtx();
    const request = makeFormRequest("test-secret-pin", "valid-token", "1.2.3.4");

    await authHandler.fetch!(request, env, ctx);

    const logs = parseLogCalls(logSpy);
    const authLogs = logs.filter(
      (l: any) => l.category === "auth_event"
    ) as any[];

    const attempt = authLogs.find((l: any) => l.event === "attempt");
    const success = authLogs.find((l: any) => l.event === "success");

    expect(attempt).toBeDefined();
    expect(attempt.ip).toBe("1.2.3.4");
    expect(success).toBeDefined();
    expect(success.ip).toBe("1.2.3.4");
  });

  it("logs failure on wrong PIN", async () => {
    const storedAuthRequest = JSON.stringify({
      client_id: "test",
      redirect_uri: "https://example.com/callback",
      scope: ["read"],
      state: "xyz",
    });

    const kv = createMockKV({ "csrf:valid-token": storedAuthRequest });
    const env = {
      OAUTH_KV: kv,
      AI: {} as Ai,
      MCP_SECRET: "test-secret-pin",
      AUTH_RATE_LIMITER: createMockRateLimiter(true),
      OAUTH_PROVIDER: makeBaseOAuthProvider(),
    } as unknown as Env;

    const ctx = makeBaseCtx();
    const request = makeFormRequest("wrong-pin", "valid-token", "5.6.7.8");

    await authHandler.fetch!(request, env, ctx);

    const errors = parseLogCalls(errorSpy);
    const failure = errors.find(
      (l: any) => l.category === "auth_event" && l.event === "failure"
    ) as any;

    expect(failure).toBeDefined();
    expect(failure.detail).toBe("wrong_pin");
    expect(failure.ip).toBe("5.6.7.8");
  });

  it("logs rate_limit event", async () => {
    const env = {
      OAUTH_KV: createMockKV(),
      AI: {} as Ai,
      MCP_SECRET: "test-secret-pin",
      AUTH_RATE_LIMITER: createMockRateLimiter(false),
      OAUTH_PROVIDER: makeBaseOAuthProvider(),
    } as unknown as Env;

    const ctx = makeBaseCtx();
    const request = makeFormRequest("any-pin", "any-csrf", "9.8.7.6");

    await authHandler.fetch!(request, env, ctx);

    const errors = parseLogCalls(errorSpy);
    const rateLimit = errors.find(
      (l: any) => l.category === "auth_event" && l.event === "rate_limit"
    ) as any;

    expect(rateLimit).toBeDefined();
    expect(rateLimit.ip).toBe("9.8.7.6");
  });
});
