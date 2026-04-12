import { defineConfig } from "vitest/config";
import { cloudflarePool } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  test: {
    globals: true,
    pool: cloudflarePool({
      wrangler: {
        configPath: "./wrangler.toml",
      },
      miniflare: {
        kvNamespaces: ["OAUTH_KV"],
        rateLimits: {
          AUTH_RATE_LIMITER: { simple: { limit: 5, period: 60 } },
        },
        bindings: {
          MCP_SECRET: "test-secret-pin",
        },
      },
    }),
  },
});
