import { describe, expect, it } from "vitest";
import { NonRetryableError } from "../src/errors";
import { DEFAULT_RETRY, backoffMs, isNonRetryable, resolveRetry } from "../src/retry";
import type { RetryPolicy } from "../src/types";

const policy: RetryPolicy = {
  maxAttempts: 5,
  backoff: "exponential",
  baseMs: 100,
  maxMs: 1000,
  jitter: false,
};

describe("resolveRetry", () => {
  it("overrides only the provided fields", () => {
    const r = resolveRetry(DEFAULT_RETRY, { maxAttempts: 2 });
    expect(r.maxAttempts).toBe(2);
    expect(r.baseMs).toBe(DEFAULT_RETRY.baseMs);
  });
});

describe("backoffMs", () => {
  it("grows exponentially without jitter", () => {
    expect(backoffMs(1, policy)).toBe(100);
    expect(backoffMs(2, policy)).toBe(200);
    expect(backoffMs(3, policy)).toBe(400);
  });

  it("caps at maxMs", () => {
    expect(backoffMs(10, policy)).toBe(1000);
  });

  it("fixed backoff is constant", () => {
    expect(backoffMs(5, { ...policy, backoff: "fixed" })).toBe(100);
  });

  it("jitter stays within [50%, 100%] of the capped delay", () => {
    const p: RetryPolicy = { ...policy, jitter: true };
    expect(backoffMs(2, p, () => 0)).toBe(100);
    expect(backoffMs(2, p, () => 1)).toBe(200);
    expect(backoffMs(2, p, () => 0.5)).toBe(150);
  });
});

describe("isNonRetryable", () => {
  it("detects NonRetryableError only", () => {
    expect(isNonRetryable(new NonRetryableError("x"))).toBe(true);
    expect(isNonRetryable(new Error("x"))).toBe(false);
    expect(isNonRetryable("nope")).toBe(false);
  });
});
