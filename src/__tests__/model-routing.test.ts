import { describe, it, expect } from "vitest";

describe("SEC-01: Type-safe model routing", () => {
  it.todo("callModel accepts keyof AiModels parameter without as-any cast");
  it.todo("DEFAULT_MODELS values are typed as keyof AiModels");
  it.todo("resolveModel returns keyof AiModels");
});

describe("SEC-03: Model allowlist validation", () => {
  it.todo("isAllowedModel returns true for allowlisted models");
  it.todo("isAllowedModel returns false for non-allowlisted models");
  it.todo("resolveModel deletes invalid KV model and returns default");
  it.todo("resolveModel returns KV override when model is in allowlist");
});
