# Vitest for Cloudflare Workers — Practical Setup Guide

**Project:** cf-code-assistant (MCP server with OAuthProvider + Workers AI + KV)
**Researched:** 2026-04-12
**Confidence:** HIGH (official docs + official repo test examples + verified issues)

---

## 1. Installation

```bash
npm install -D vitest @cloudflare/vitest-pool-workers
```

Version constraints as of April 2026:
- `@cloudflare/vitest-pool-workers` latest: `^0.13.x`
- Requires `vitest >= 4.1.0`
- Requires `wrangler >= 4.x` (already in this project)

**Important:** The docs say `vitest@^4.1.0` is required. Do NOT install `vitest@3.x` — the pool explicitly dropped support.

---

## 2. Project File Changes

### `vitest.config.ts` (create at project root)

```typescript
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Point at a TEST-SPECIFIC wrangler config (see Section 3 below)
      wrangler: { configPath: "./wrangler.test.jsonc" },
    }),
  ],
  test: {
    // Use Istanbul for coverage — V8 native coverage is NOT supported
    coverage: {
      provider: "istanbul",
    },
  },
});
```

### `wrangler.test.jsonc` (create at project root)

This is a COPY of `wrangler.toml` with the AI binding STRIPPED OUT. The AI binding
(`[ai]`) cannot be used locally in vitest without hitting your live Cloudflare account
(no local simulator exists). Strip it and mock it in tests instead.

```jsonc
{
  "name": "cf-code-assistant",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-12",
  "compatibility_flags": ["nodejs_compat"],
  "kv_namespaces": [
    {
      "binding": "OAUTH_KV",
      "id": "test-kv-namespace-id"
    }
  ]
  // AI binding intentionally omitted — mock env.AI in tests
  // MCP_SECRET is provided as a var below or in test env setup
}
```

**Why a separate test wrangler config?**
Using the production `wrangler.toml` with `[ai]` binding causes Miniflare to fail with
`MiniflareCoreError [ERR_RUNTIME_FAILURE]` because the AI "wrapped binding" module is
internal-only. This was issue #7434, fixed in `vitest-pool-workers@0.8.1`, but the
authoritative guidance remains: mock AI bindings locally to avoid account charges.

### `test/tsconfig.json` (create)

```json
{
  "compilerOptions": {
    "types": ["@cloudflare/vitest-pool-workers"]
  },
  "include": ["./**/*.ts", "../src/worker-configuration.d.ts"]
}
```

### `test/env.d.ts` (create)

This wires the `Env` type into the `cloudflare:workers` module so `env` imported in
tests is fully typed:

```typescript
declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {
    // Add test-only extras here if needed
    MCP_SECRET: string;
  }
}
```

### `package.json` scripts addition

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

---

## 3. The `nodejs_compat` Gotcha

This project uses `compatibility_flags = ["nodejs_compat"]` — this creates a specific
known failure mode:

**Issue #11028:** Starting with compat date `2025-09-21`, vitest broke when
`nodejs_compat` was active because two new flags became default:
- `enableNodeJsConsoleModule` → caused `"The Console method is not implemented"`
- `enableNodeJsVmModule` → caused `"vm._setUnsafeEval is not a function"`

**Status:** Fixed in `vitest-pool-workers@0.9.13+`. Since this project targets
`compatibility_date = "2026-04-12"`, you MUST use `@cloudflare/vitest-pool-workers >= 0.9.13`
(current `^0.13.x` satisfies this).

**Secondary gotcha:** `vitest-pool-workers` automatically injects `nodejs_compat` into
the test runtime even if your wrangler config doesn't declare it. This means your tests
might PASS on Node.js APIs that would FAIL in production if you forgot to add the flag
to `wrangler.toml`. This project already has the flag — no issue — but worth knowing.

---

## 4. Mocking Workers AI (`env.AI`)

Workers AI has NO local simulator. `env.AI.run()` will attempt to hit Cloudflare's live
API if you use the real binding in tests — causing failures (no auth token in CI) and
charges in dev.

### Strategy: `vi.fn()` mock in test setup

Because you call `env.AI.run(model, payload)` in `src/index.ts`, mock the entire `AI`
binding as a `vi.fn()` in your test helper:

```typescript
// test/helpers/mock-env.ts
import { vi } from "vitest";

export function createMockEnv(overrides?: Partial<Env>): Env {
  return {
    AI: {
      run: vi.fn().mockResolvedValue({ response: "mocked AI response" }),
    } as unknown as Ai,
    OAUTH_KV: new MockKV() as unknown as KVNamespace,
    MCP_SECRET: "test-secret-12345",
    ...overrides,
  };
}
```

When testing error recovery (bad model name), you can make it throw:

```typescript
env.AI.run = vi.fn()
  .mockRejectedValueOnce(new Error("Unknown model: @cf/bad/model"))
  .mockResolvedValueOnce({ response: "fallback response" });
```

This lets you test the KV-delete-and-retry logic in `runAI()` without any live calls.

---

## 5. Mocking KV Namespace (`env.OAUTH_KV`)

For unit tests, use an in-memory `MockKV`. The `@cloudflare/vitest-pool-workers` package
provides a real KV simulator for integration tests, but for unit tests this is cleaner:

```typescript
// test/helpers/mock-kv.ts
export class MockKV implements KVNamespace {
  private storage = new Map<string, { value: string; expiration?: number }>();

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: KVNamespacePutOptions
  ): Promise<void> {
    let expiration: number | undefined;
    if (options?.expirationTtl) {
      expiration = Date.now() + options.expirationTtl * 1000;
    } else if (options?.expiration) {
      expiration = options.expiration * 1000;
    }
    this.storage.set(key, { value: String(value), expiration });
  }

  async get(key: string, options?: { type?: "text" | "json" | "arrayBuffer" | "stream" } | string): Promise<any> {
    const item = this.storage.get(key);
    if (!item) return null;
    if (item.expiration && item.expiration < Date.now()) {
      this.storage.delete(key);
      return null;
    }
    const type = typeof options === "string" ? options : options?.type;
    if (type === "json") return JSON.parse(item.value);
    return item.value;
  }

  async delete(key: string): Promise<void> {
    this.storage.delete(key);
  }

  async list(options?: KVNamespaceListOptions): Promise<KVNamespaceListResult<unknown, string>> {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const keys: KVNamespaceListKey<unknown, string>[] = [];
    for (const [k] of this.storage) {
      if (k.startsWith(prefix)) keys.push({ name: k });
    }
    return { keys: keys.slice(0, limit), list_complete: keys.length <= limit };
  }

  async getWithMetadata<T>(key: string): Promise<KVNamespaceGetWithMetadataResult<string, T>> {
    const value = await this.get(key);
    return { value, metadata: null };
  }

  clear() { this.storage.clear(); }
}
```

For integration tests (actual KV writes via the real Miniflare simulator):

```typescript
// test/helpers/integration-env.ts
import { env } from "cloudflare:workers";

// env.OAUTH_KV is already a real KV simulator provided by vitest-pool-workers
// Just use it directly — it's isolated per test file
export { env };
```

---

## 6. Testing MCP Tool Handlers in Isolation

The cleanest approach for unit testing individual tools is to extract tool logic into
plain functions, then test the functions directly — bypassing the MCP server wiring.

However, the current `src/index.ts` inlines tool handlers as callbacks in
`server.registerTool()`. For now, test tools by calling through the full MCP handler.

### Unit test pattern for `runAI` / `callModel` (extractable helpers)

If you refactor `runAI` and `callModel` to be exported (or moved to a separate module),
they can be tested directly:

```typescript
// test/unit/run-ai.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAI } from "../../src/ai-helpers"; // if extracted

describe("runAI", () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  it("returns AI response for valid model", async () => {
    (env.AI.run as ReturnType<typeof vi.fn>).mockResolvedValue({ response: "generated code" });
    const result = await runAI(env, "standard", "write a hello world function");
    expect(result).toBe("generated code");
  });

  it("falls back to default model when KV model is invalid", async () => {
    await env.OAUTH_KV.put("config:model:standard", "@cf/bad/model");
    (env.AI.run as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("Unknown model: @cf/bad/model"))
      .mockResolvedValueOnce({ response: "fallback code" });

    const result = await runAI(env, "standard", "test prompt");
    expect(result).toBe("fallback code");
    // KV entry should be deleted after the model error
    const remaining = await env.OAUTH_KV.get("config:model:standard");
    expect(remaining).toBeNull();
  });
});
```

### Integration test via fetch handler

For end-to-end testing of an MCP tool via HTTP (bypassing OAuth for simplicity), call
the MCP handler directly:

```typescript
// test/integration/mcp-tools.test.ts
import { describe, it, expect } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src/index";
import { createMockEnv } from "../helpers/mock-env";

describe("MCP tool: routingInfo", () => {
  it("returns routing info without AI call", async () => {
    const env = createMockEnv();
    const ctx = createExecutionContext();

    // First get an access token (skip OAuth, inject manually or test via /mcp directly
    // with a pre-issued token stored in KV)
    const tokenPayload = { sub: "owner", scope: "mcp", iat: Date.now() };
    // Store a fake token in KV (OAuthProvider reads from KV to validate tokens)
    const fakeToken = "test-access-token-abc123";
    await env.OAUTH_KV.put(`access_token:${fakeToken}`, JSON.stringify({
      userId: "owner",
      clientId: "test-client",
      scope: ["mcp"],
      expiresAt: Date.now() + 86400_000,
      props: { userId: "owner" },
    }));

    const request = new Request("https://example.com/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${fakeToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "routingInfo", arguments: {} },
      }),
    });

    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.content[0].text).toContain("cf-code-assistant");
  });
});
```

**Note on token KV key format:** The exact key format used by
`@cloudflare/workers-oauth-provider` to store tokens is an implementation detail.
Inspect the library source or run a live auth flow once to capture the key format before
hardcoding it in tests. Alternatively, test through the full OAuth flow (see Section 7).

---

## 7. Testing the OAuth / Auth Flow

The `workers-oauth-provider` library tests its own OAuth flows with plain Vitest (no
`vitest-pool-workers` needed) because it imports from `cloudflare:workers` which Vitest
can partially handle. The key pattern from the official test suite:

### The `ctx.oauth` vs `env.OAUTH_PROVIDER` injection pattern

In the current `src/index.ts`, the `authHandler` reads:
```typescript
const oauthHelpers = (ctx as unknown as { oauth: OAuthHelpers }).oauth;
```

In the library's own test suite, the test instantiates `OAuthProvider` directly and
calls `.fetch()` passing the env and ctx. The `OAuthProvider` injects `oauth` helpers
onto `ctx` before routing to the handler. So in tests, you call the whole provider:

```typescript
// test/integration/auth-flow.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src/index";
import { MockKV } from "../helpers/mock-kv";

describe("Authorization flow", () => {
  let env: Env;
  let ctx: ExecutionContext;

  beforeEach(() => {
    env = {
      AI: { run: vi.fn() } as unknown as Ai,
      OAUTH_KV: new MockKV() as unknown as KVNamespace,
      MCP_SECRET: "correct-secret",
    };
    ctx = createExecutionContext();
  });

  it("GET /authorize renders login page", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/authorize?response_type=code&client_id=test&redirect_uri=https://example.com/cb"),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("CF Code Assistant");
    expect(html).toContain('name="csrf"');
  });

  it("POST /authorize with wrong secret returns 403", async () => {
    // Seed a CSRF token in KV
    const csrf = "test-csrf-token";
    const authRequest = {
      clientId: "test-client",
      redirectUri: "https://example.com/cb",
      responseType: "code",
      scope: [],
      state: "test-state",
    };
    await env.OAUTH_KV.put(`csrf:${csrf}`, JSON.stringify(authRequest), { expirationTtl: 300 });

    const body = new URLSearchParams({ secret: "wrong-secret", csrf });
    const response = await worker.fetch(
      new Request("https://example.com/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(403);
  });

  it("POST /authorize with correct secret redirects with code", async () => {
    const csrf = "valid-csrf-token";
    const authRequest = {
      clientId: "test-client",
      redirectUri: "https://example.com/cb",
      responseType: "code",
      scope: ["mcp"],
      state: "abc",
    };
    await env.OAUTH_KV.put(`csrf:${csrf}`, JSON.stringify(authRequest), { expirationTtl: 300 });

    const body = new URLSearchParams({ secret: "correct-secret", csrf });
    const response = await worker.fetch(
      new Request("https://example.com/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    // OAuthProvider handles completeAuthorization and redirects
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("https://example.com/cb");
    expect(location).toContain("code=");
  });

  it("GET /authorize with expired CSRF token returns 400", async () => {
    // Don't seed any CSRF token — simulate expired/missing session
    const body = new URLSearchParams({ secret: "correct-secret", csrf: "nonexistent" });
    const response = await worker.fetch(
      new Request("https://example.com/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
  });
});
```

**Caveat:** The `completeAuthorization` call in the real handler delegates to
`oauthHelpers` which is injected by `OAuthProvider` onto `ctx`. This works correctly
when testing through the full `worker.fetch()` call as shown above — the OAuthProvider
processes the request, injects `ctx.oauth`, then routes to `authHandler`. You cannot
test `authHandler.fetch` in isolation without manually constructing a fake `ctx.oauth`.

---

## 8. `SELF` vs Direct Import — When to Use Each

| Approach | How | When |
|---|---|---|
| Direct import `worker.fetch(req, env, ctx)` | Import from `../../src/index` | Unit/integration tests — use your own mock `env`. Most flexible. |
| `SELF.fetch(req)` | Import `SELF` from `cloudflare:test` | Integration tests using real Miniflare bindings from `wrangler.test.jsonc` |

For this project, **direct import with mock env is recommended** because:
1. You must mock `env.AI` (no local simulator)
2. You want test-isolated KV state via `MockKV`
3. `SELF` uses the Miniflare KV which is isolated per test file anyway

---

## 9. Coverage

V8 native coverage is NOT supported. Use Istanbul:

```bash
npm install -D @vitest/coverage-istanbul
```

`vitest.config.ts` already shows the `coverage: { provider: "istanbul" }` config above.
Run: `npx vitest run --coverage`

---

## 10. Known Issues Summary

| Issue | Affects This Project | Fix |
|---|---|---|
| AI binding fails in vitest with `[ai]` in wrangler | YES | Use `wrangler.test.jsonc` without `[ai]` + mock |
| `nodejs_compat` breaks vitest at compat dates >= 2025-09-21 | YES (compat date 2026-04-12) | Fixed in `vitest-pool-workers >= 0.9.13` — install `^0.13.x` |
| V8 coverage unsupported | Minor | Use `@vitest/coverage-istanbul` |
| Fake timers don't expire KV entries | KV TTL tests | Test TTL logic via MockKV's expiration logic instead |
| `vi.mock()` doesn't work with `cloudflare:test` in setup files | Potential issue | Define mocks in test files or use `vi.fn()` on env objects instead of module mocks |
| Dynamic `import()` inside export default handlers fails in integration tests | N/A (not used here) | Use static imports |
| Global setup files run in Node.js not workerd | Low risk here | Avoid complex Worker imports in global setup |

---

## 11. Recommended Test File Structure

```
test/
  helpers/
    mock-env.ts          # createMockEnv() factory
    mock-kv.ts           # MockKV class
  unit/
    run-ai.test.ts       # runAI() helper logic
    resolve-model.test.ts # KV model override logic
    timing-safe.test.ts  # timingSafeEqual() utility
  integration/
    auth-flow.test.ts    # Full OAuth authorize flow via worker.fetch()
    mcp-routing.test.ts  # OAuthProvider routing to /mcp vs default handler
    mcp-tools.test.ts    # Tool call e2e (routingInfo no-AI tool first)
  env.d.ts               # ProvidedEnv declaration
  tsconfig.json          # types: ["@cloudflare/vitest-pool-workers"]
```

Start with `routingInfo` tool tests (zero AI calls, pure static response) to validate
the test harness works before tackling AI-dependent tools.

---

## Sources

- [Vitest integration overview](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Write your first test](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)
- [Test APIs reference](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)
- [Configuration reference](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/)
- [Known issues](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/)
- [Recipes and examples](https://developers.cloudflare.com/workers/testing/vitest-integration/recipes/)
- [Isolation and concurrency](https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/)
- [workers-oauth-provider test suite](https://github.com/cloudflare/workers-oauth-provider/blob/main/__tests__/oauth-provider.test.ts)
- [AI/Vectorize wrapped binding issue #7434](https://github.com/cloudflare/workers-sdk/issues/7434)
- [nodejs_compat + vitest breakage issue #11028](https://github.com/cloudflare/workers-sdk/issues/11028)
- [Testing your Agents](https://developers.cloudflare.com/agents/getting-started/testing-your-agent/)
- [createMcpHandler API reference](https://developers.cloudflare.com/agents/model-context-protocol/mcp-handler-api/)
