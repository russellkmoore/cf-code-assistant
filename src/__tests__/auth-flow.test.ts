import { describe, it, expect, vi, beforeEach } from "vitest";
import { timingSafeEqual, authHandler } from "../index";
import { createMockKV, createMockRateLimiter } from "./helpers";

// ---------------------------------------------------------------------------
// TEST-02: timingSafeEqual unit tests
// ---------------------------------------------------------------------------

describe("TEST-02: timingSafeEqual", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqual("test-secret", "test-secret")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(timingSafeEqual("abc", "def")).toBe(false);
  });

  it("returns false for different-length strings", () => {
    expect(timingSafeEqual("short", "muchlonger")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("returns false when one string is empty", () => {
    expect(timingSafeEqual("abc", "")).toBe(false);
  });

  it("returns false when only lengths differ but prefix matches", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TEST-02: Auth GET /authorize — CSRF creation
// ---------------------------------------------------------------------------

describe("TEST-02: Auth GET /authorize", () => {
  it("returns 200 with HTML containing CSRF hidden input and login form", async () => {
    const kv = createMockKV();
    const env = {
      OAUTH_KV: kv,
      AI: {} as Ai,
      MCP_SECRET: "test-secret-pin",
      AUTH_RATE_LIMITER: createMockRateLimiter(true),
    } as Env;

    const request = new Request("https://worker.example.com/authorize", {
      method: "GET",
    });

    const ctx = {
      oauth: {
        parseAuthRequest: vi.fn(async () => ({
          client_id: "test",
          redirect_uri: "https://example.com/callback",
          scope: ["read"],
          state: "xyz",
        })),
        completeAuthorization: vi.fn(),
      },
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    const response = await authHandler.fetch!(request, env, ctx);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('name="csrf"');
    expect(html).toContain('name="secret"');
    expect(html).toContain("<form");
    // Verify CSRF token was stored in KV with csrf: prefix
    expect(kv.put).toHaveBeenCalledWith(
      expect.stringMatching(/^csrf:/),
      expect.any(String),
      expect.objectContaining({ expirationTtl: 300 }),
    );
  });

  it("returns 500 error page when parseAuthRequest throws", async () => {
    const env = {
      OAUTH_KV: createMockKV(),
      AI: {} as Ai,
      MCP_SECRET: "test-secret-pin",
      AUTH_RATE_LIMITER: createMockRateLimiter(true),
    } as Env;

    const request = new Request("https://worker.example.com/authorize", {
      method: "GET",
    });

    const ctx = {
      oauth: {
        parseAuthRequest: vi.fn(async () => {
          throw new Error("bad request");
        }),
        completeAuthorization: vi.fn(),
      },
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    const response = await authHandler.fetch!(request, env, ctx);
    expect(response.status).toBe(500);
    const html = await response.text();
    expect(html).toContain("Authorization Error");
  });
});

// ---------------------------------------------------------------------------
// TEST-02/TEST-04: Auth POST /authorize — PIN submission and error paths
// ---------------------------------------------------------------------------

describe("TEST-02/TEST-04: Auth POST /authorize", () => {
  const makeBaseCtx = () =>
    ({
      oauth: {
        parseAuthRequest: vi.fn(),
        completeAuthorization: vi.fn(async () => ({
          redirectTo: "https://example.com/callback?code=abc",
        })),
      },
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    }) as unknown as ExecutionContext;

  const makeFormRequest = (
    secret: string,
    csrf: string,
    ip?: string,
  ) => {
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

  it("returns 302 redirect with correct PIN and valid CSRF", async () => {
    const storedAuthRequest = JSON.stringify({
      client_id: "test",
      redirect_uri: "https://example.com/callback",
      scope: ["read"],
      state: "xyz",
    });

    const kv = createMockKV({ "csrf:valid-csrf-token": storedAuthRequest });
    const env = {
      OAUTH_KV: kv,
      AI: {} as Ai,
      MCP_SECRET: "test-secret-pin",
      AUTH_RATE_LIMITER: createMockRateLimiter(true),
    } as Env;

    const ctx = makeBaseCtx();
    const request = makeFormRequest("test-secret-pin", "valid-csrf-token", "1.2.3.4");

    const response = await authHandler.fetch!(request, env, ctx);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("callback");
  });

  it("returns 403 with wrong PIN", async () => {
    const storedAuthRequest = JSON.stringify({
      client_id: "test",
      redirect_uri: "https://example.com/callback",
      scope: ["read"],
      state: "xyz",
    });

    const kv = createMockKV({ "csrf:valid-csrf-token": storedAuthRequest });
    const env = {
      OAUTH_KV: kv,
      AI: {} as Ai,
      MCP_SECRET: "test-secret-pin",
      AUTH_RATE_LIMITER: createMockRateLimiter(true),
    } as Env;

    const ctx = makeBaseCtx();
    const request = makeFormRequest("wrong-pin", "valid-csrf-token", "1.2.3.4");

    const response = await authHandler.fetch!(request, env, ctx);
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toBe("Invalid secret.");
    // Must NOT reveal the actual secret
    expect(body).not.toContain("test-secret-pin");
  });

  it("returns 400 when CSRF token not in KV (expired)", async () => {
    const kv = createMockKV({}); // empty KV — no CSRF stored
    const env = {
      OAUTH_KV: kv,
      AI: {} as Ai,
      MCP_SECRET: "test-secret-pin",
      AUTH_RATE_LIMITER: createMockRateLimiter(true),
    } as Env;

    const ctx = makeBaseCtx();
    const request = makeFormRequest("test-secret-pin", "expired-csrf-token", "1.2.3.4");

    const response = await authHandler.fetch!(request, env, ctx);
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("Session expired");
  });

  it("returns 400 with missing form fields", async () => {
    const env = {
      OAUTH_KV: createMockKV(),
      AI: {} as Ai,
      MCP_SECRET: "test-secret-pin",
      AUTH_RATE_LIMITER: createMockRateLimiter(true),
    } as Env;

    // Submit form with empty fields
    const formData = new FormData();
    formData.append("secret", "");
    formData.append("csrf", "");
    const request = new Request("https://worker.example.com/authorize", {
      method: "POST",
      body: formData,
      headers: { "CF-Connecting-IP": "1.2.3.4" },
    });

    const ctx = makeBaseCtx();
    const response = await authHandler.fetch!(request, env, ctx);
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("Invalid form data.");
  });

  it("returns 400 when secret exceeds 256 chars", async () => {
    const env = {
      OAUTH_KV: createMockKV(),
      AI: {} as Ai,
      MCP_SECRET: "test-secret-pin",
      AUTH_RATE_LIMITER: createMockRateLimiter(true),
    } as Env;

    const oversizedSecret = "x".repeat(257);
    const ctx = makeBaseCtx();
    const request = makeFormRequest(oversizedSecret, "some-token", "1.2.3.4");

    const response = await authHandler.fetch!(request, env, ctx);
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("Invalid form data.");
  });

  it("returns 400 when stored CSRF value is malformed JSON", async () => {
    // KV has the CSRF key but the stored value is not valid JSON
    const kv = createMockKV({ "csrf:bad-json-token": "not-valid-json{{{" });
    const env = {
      OAUTH_KV: kv,
      AI: {} as Ai,
      MCP_SECRET: "test-secret-pin",
      AUTH_RATE_LIMITER: createMockRateLimiter(true),
    } as Env;

    const ctx = makeBaseCtx();
    const request = makeFormRequest("test-secret-pin", "bad-json-token", "1.2.3.4");

    const response = await authHandler.fetch!(request, env, ctx);
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("Authorization failed.");
  });
});
