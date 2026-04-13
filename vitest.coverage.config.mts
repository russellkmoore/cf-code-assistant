/**
 * Separate vitest config for coverage reporting.
 *
 * The cloudflare workers pool does not support v8 native coverage (requires
 * node:inspector) and Istanbul instrumentation causes workerd to crash on
 * startup. This config uses the default node pool to collect coverage from
 * source files, accepting that Workers-specific runtime APIs are mocked.
 *
 * Use: npm run test:coverage
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**"],
      reporter: ["text", "html"],
    },
  },
});
