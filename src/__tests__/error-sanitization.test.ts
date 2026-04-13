import { describe, it, expect } from "vitest";
import { makeToolError } from "../index";

describe("SEC-04: Error message sanitization", () => {
  it("AI_TIMEOUT error includes tool name but no stack trace", () => {
    const result = makeToolError("AI_TIMEOUT", "generateCode");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("AI_TIMEOUT");
    expect(result.content[0].text).toContain("generateCode");
    expect(result.content[0].text).not.toMatch(/at\s+\w+\s+\(/); // no stack trace pattern
    expect(result.content[0].text).not.toContain("env.");
  });

  it("AI_ERROR returns generic message without internal details", () => {
    const result = makeToolError("AI_ERROR", "reviewCode");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("AI_ERROR");
    expect(result.content[0].text).toContain("reviewCode");
    expect(result.content[0].text).not.toContain("KV");
    expect(result.content[0].text).not.toContain("OAUTH_KV");
  });

  it("INTERNAL_ERROR returns generic message without internal state", () => {
    const result = makeToolError("INTERNAL_ERROR", "fixBug");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("INTERNAL_ERROR");
    expect(result.content[0].text).not.toContain("stack");
    expect(result.content[0].text).not.toContain("config:");
  });

  it("all error codes produce MCP-compatible response shape", () => {
    for (const code of ["AI_TIMEOUT", "AI_ERROR", "INTERNAL_ERROR"] as const) {
      const result = makeToolError(code, "testTool");
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(typeof result.content[0].text).toBe("string");
      expect(result.isError).toBe(true);
    }
  });

  // Removed: "auth 403 response says 'Invalid secret.' without revealing actual secret"
  // was vacuous — tested a local constant, not actual handler behavior.
  // Covered by auth-flow.test.ts (line 190-193) which invokes authHandler.fetch.
});
