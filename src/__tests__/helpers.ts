import { vi } from "vitest";

/**
 * Create a mock KVNamespace with controllable get/put/delete.
 * By default, get returns null (empty KV).
 */
export function createMockKV(overrides: Record<string, string | null> = {}): KVNamespace {
  const store = new Map<string, string>(
    Object.entries(overrides).filter((e): e is [string, string] => e[1] !== null)
  );
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null, cacheStatus: null })),
  } as unknown as KVNamespace;
}

/**
 * Create a mock AI binding. By default, run() returns { response: "mock-response" }.
 */
export function createMockAI(response: string = "mock-response"): Ai {
  return {
    run: vi.fn(async () => ({ response })),
  } as unknown as Ai;
}

/**
 * Create a mock RateLimit binding. By default, limit() returns { success: true }.
 */
export function createMockRateLimiter(success: boolean = true): RateLimit {
  return {
    limit: vi.fn(async () => ({ success })),
  } as unknown as RateLimit;
}

/**
 * Create a complete mock Env with all bindings.
 * Pass overrides to customize individual bindings.
 */
export function createMockEnv(overrides: {
  kvData?: Record<string, string | null>;
  aiResponse?: string;
  mcpSecret?: string;
  rateLimitSuccess?: boolean;
} = {}): Env {
  return {
    OAUTH_KV: createMockKV(overrides.kvData ?? {}),
    AI: createMockAI(overrides.aiResponse ?? "mock-response"),
    MCP_SECRET: overrides.mcpSecret ?? "test-secret-pin",
    AUTH_RATE_LIMITER: createMockRateLimiter(overrides.rateLimitSuccess ?? true),
  } as Env;
}
