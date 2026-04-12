import { describe, it, expect } from "vitest";

describe("SEC-04: Error message sanitization", () => {
  it.todo("tool handler catch block returns generic error message");
  it.todo("tool handler catch block does not include err.message in response");
  it.todo("tool handler catch block does not include stack trace in response");
  it.todo("auth handler JSON.parse failure returns generic 400");
  it.todo("auth handler does not expose KV contents in error responses");
});
