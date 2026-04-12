import { describe, it, expect } from "vitest";

describe("SEC-02: Input size caps", () => {
  it.todo("rejects code input over 100,000 characters");
  it.todo("rejects context input over 50,000 characters");
  it.todo("rejects prompt input over 20,000 characters");
  it.todo("rejects diff input over 50,000 characters");
  it.todo("rejects error input over 10,000 characters");
  it.todo("rejects instruction input over 10,000 characters");
  it.todo("rejects description input over 10,000 characters");
  it.todo("rejects bindings input over 500 characters");
});

describe("HARD-03: Auth form input validation", () => {
  it.todo("rejects POST with missing secret field");
  it.todo("rejects POST with missing csrf field");
  it.todo("rejects POST with empty secret field");
  it.todo("rejects POST with empty csrf field");
});
