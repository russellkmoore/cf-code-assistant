import { describe, it, expect } from "vitest";

describe("HARD-02: Auth PIN rate limiting", () => {
  it.todo("allows 5 POST requests within 60 seconds");
  it.todo("returns 429 on 6th POST request within 60 seconds");
  it.todo("uses CF-Connecting-IP header as rate limit key");
  it.todo("falls back to 'unknown' key when CF-Connecting-IP is absent");
});
