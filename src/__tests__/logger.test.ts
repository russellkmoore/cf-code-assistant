import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("logToolInvocation", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("outputs structured JSON with category tool_invocation", async () => {
    const { logToolInvocation } = await import("../logger");
    logToolInvocation({ tool: "generateCode", tier: "standard", model: "@cf/qwen/qwen3-30b-a3b-fp8", latency_ms: 1234 });

    expect(logSpy).toHaveBeenCalledOnce();
    const entry = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(entry.category).toBe("tool_invocation");
    expect(entry.tool).toBe("generateCode");
    expect(entry.tier).toBe("standard");
    expect(entry.model).toBe("@cf/qwen/qwen3-30b-a3b-fp8");
    expect(entry.latency_ms).toBe(1234);
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
  });

  it("uses console.log (not console.error)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { logToolInvocation } = await import("../logger");
    logToolInvocation({ tool: "quickTask", tier: "fast", model: "test-model", latency_ms: 50 });

    expect(logSpy).toHaveBeenCalledOnce();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("logToolError", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("outputs structured JSON with category tool_error via console.error", async () => {
    const { logToolError } = await import("../logger");
    logToolError({ tool: "reviewCode", error_type: "AI_TIMEOUT", input_size_bytes: 512 });

    expect(errorSpy).toHaveBeenCalledOnce();
    const entry = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(entry.category).toBe("tool_error");
    expect(entry.tool).toBe("reviewCode");
    expect(entry.error_type).toBe("AI_TIMEOUT");
    expect(entry.input_size_bytes).toBe(512);
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
  });

  it("does NOT include a stack field", async () => {
    const { logToolError } = await import("../logger");
    logToolError({ tool: "fixBug", error_type: "AI_ERROR", input_size_bytes: 100 });

    const entry = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(entry).not.toHaveProperty("stack");
  });

  it("uses console.error (not console.log)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { logToolError } = await import("../logger");
    logToolError({ tool: "fixBug", error_type: "AI_ERROR", input_size_bytes: 100 });

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

describe("logAuthEvent", () => {
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

  it("routes 'attempt' event to console.log with category auth_event", async () => {
    const { logAuthEvent } = await import("../logger");
    logAuthEvent({ event: "attempt", ip: "1.2.3.4" });

    expect(logSpy).toHaveBeenCalledOnce();
    expect(errorSpy).not.toHaveBeenCalled();
    const entry = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(entry.category).toBe("auth_event");
    expect(entry.event).toBe("attempt");
    expect(entry.ip).toBe("1.2.3.4");
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
  });

  it("routes 'success' event to console.log", async () => {
    const { logAuthEvent } = await import("../logger");
    logAuthEvent({ event: "success", ip: "1.2.3.4" });

    expect(logSpy).toHaveBeenCalledOnce();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("routes 'failure' event to console.error", async () => {
    const { logAuthEvent } = await import("../logger");
    logAuthEvent({ event: "failure", ip: "5.6.7.8", detail: "invalid pin" });

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(logSpy).not.toHaveBeenCalled();
    const entry = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(entry.event).toBe("failure");
    expect(entry.detail).toBe("invalid pin");
  });

  it("routes 'rate_limit' event to console.error", async () => {
    const { logAuthEvent } = await import("../logger");
    logAuthEvent({ event: "rate_limit", ip: "9.8.7.6" });

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(logSpy).not.toHaveBeenCalled();
  });
});
