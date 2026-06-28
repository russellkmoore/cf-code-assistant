import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveModel, isAllowedModel, ALLOWED_MODELS, DEFAULT_MODELS } from "../index";
import { createMockEnv, createMockKV } from "./helpers";

describe("SEC-01/SEC-03: isAllowedModel", () => {
  it("returns true for allowlisted model @cf/qwen/qwen3-30b-a3b-fp8", () => {
    expect(isAllowedModel("@cf/qwen/qwen3-30b-a3b-fp8")).toBe(true);
  });

  it("returns true for allowlisted standard tier model (DEFAULT_MODELS.standard / kimi-k2.5)", () => {
    expect(isAllowedModel(DEFAULT_MODELS.standard)).toBe(true);
  });

  it("returns false for non-allowlisted model", () => {
    expect(isAllowedModel("@cf/meta/llama-3-70b")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isAllowedModel("")).toBe(false);
  });

  it("returns false for partial match", () => {
    expect(isAllowedModel("@cf/qwen/qwen3-30b")).toBe(false);
  });
});

describe("TEST-01: resolveModel", () => {
  it("returns default fast model when KV is empty", async () => {
    const env = createMockEnv();
    const model = await resolveModel(env, "fast");
    expect(model).toBe(DEFAULT_MODELS.fast);
    expect(env.OAUTH_KV.get).toHaveBeenCalledWith("config:model:fast");
  });

  it("returns default standard model when KV is empty", async () => {
    const env = createMockEnv();
    const model = await resolveModel(env, "standard");
    expect(model).toBe(DEFAULT_MODELS.standard);
    expect(env.OAUTH_KV.get).toHaveBeenCalledWith("config:model:standard");
  });

  it("returns KV override when model is in allowlist", async () => {
    const env = createMockEnv({
      kvData: { "config:model:fast": "@cf/qwen/qwen3-30b-a3b-fp8" },
    });
    const model = await resolveModel(env, "fast");
    expect(model).toBe("@cf/qwen/qwen3-30b-a3b-fp8");
  });

  it("deletes invalid KV model and returns default (self-healing)", async () => {
    const env = createMockEnv({
      kvData: { "config:model:standard": "bad-model-name" },
    });
    const model = await resolveModel(env, "standard");
    expect(model).toBe(DEFAULT_MODELS.standard);
    expect(env.OAUTH_KV.delete).toHaveBeenCalledWith("config:model:standard");
  });

  it("returns default when KV.get throws (graceful degradation)", async () => {
    const env = createMockEnv();
    (env.OAUTH_KV.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("KV unavailable"));
    const model = await resolveModel(env, "fast");
    expect(model).toBe(DEFAULT_MODELS.fast);
  });

  it("standard tier resolves to Kimi model (DEFAULT_MODELS.standard) and diverges from fast tier", async () => {
    const env = createMockEnv();
    const model = await resolveModel(env, "standard");
    expect(model).toBe(DEFAULT_MODELS.standard);
    expect(model).not.toBe(DEFAULT_MODELS.fast);
  });

  it("fast tier resolves to qwen3 (DEFAULT_MODELS.fast) and is unchanged", async () => {
    const env = createMockEnv();
    const model = await resolveModel(env, "fast");
    expect(model).toBe(DEFAULT_MODELS.fast);
  });
});
