import { describe, it, expect, vi } from "vitest";
import { authHandler } from "../index";

describe("HARD-02/TEST-04: Auth PIN rate limiting", () => {
  // The rate limiter is checked on every POST /authorize before any other logic.
  // When AUTH_RATE_LIMITER.limit returns { success: false }, handler returns 429.

  it("rate-limited request returns 429 without processing PIN", async () => {
    const formData = new FormData();
    formData.append("secret", "test-secret-pin");
    formData.append("csrf", "some-token");

    const request = new Request("https://worker.example.com/authorize", {
      method: "POST",
      body: formData,
      headers: { "CF-Connecting-IP": "1.2.3.4" },
    });

    const env = {
      OAUTH_KV: { get: vi.fn(), put: vi.fn(), delete: vi.fn() } as unknown as KVNamespace,
      AI: {} as Ai,
      MCP_SECRET: "test-secret-pin",
      AUTH_RATE_LIMITER: {
        limit: vi.fn(async () => ({ success: false })),
      } as unknown as RateLimit,
    };

    const ctx = {
      oauth: {},
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    const response = await authHandler.fetch!(request, env as Env, ctx);
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("Too many attempts");
    // Verify KV was NOT consulted (rate limit short-circuits)
    expect(env.OAUTH_KV.get).not.toHaveBeenCalled();
  });

  it("uses CF-Connecting-IP header as rate limit key", async () => {
    const formData = new FormData();
    formData.append("secret", "wrong");
    formData.append("csrf", "token");

    const request = new Request("https://worker.example.com/authorize", {
      method: "POST",
      body: formData,
      headers: { "CF-Connecting-IP": "10.0.0.1" },
    });

    const limitFn = vi.fn(async () => ({ success: true }));
    const env = {
      OAUTH_KV: {
        get: vi.fn(async () => null), // CSRF not found = 400
        put: vi.fn(),
        delete: vi.fn(),
      } as unknown as KVNamespace,
      AI: {} as Ai,
      MCP_SECRET: "test-secret-pin",
      AUTH_RATE_LIMITER: { limit: limitFn } as unknown as RateLimit,
    };

    const ctx = {
      oauth: {},
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    await authHandler.fetch!(request, env as Env, ctx);
    expect(limitFn).toHaveBeenCalledWith({ key: "10.0.0.1" });
  });

  it("falls back to 'unknown' key when CF-Connecting-IP is absent", async () => {
    const formData = new FormData();
    formData.append("secret", "wrong");
    formData.append("csrf", "token");

    const request = new Request("https://worker.example.com/authorize", {
      method: "POST",
      body: formData,
      // No CF-Connecting-IP header
    });

    const limitFn = vi.fn(async () => ({ success: true }));
    const env = {
      OAUTH_KV: {
        get: vi.fn(async () => null),
        put: vi.fn(),
        delete: vi.fn(),
      } as unknown as KVNamespace,
      AI: {} as Ai,
      MCP_SECRET: "test-secret-pin",
      AUTH_RATE_LIMITER: { limit: limitFn } as unknown as RateLimit,
    };

    const ctx = {
      oauth: {},
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    await authHandler.fetch!(request, env as Env, ctx);
    expect(limitFn).toHaveBeenCalledWith({ key: "unknown" });
  });
});
