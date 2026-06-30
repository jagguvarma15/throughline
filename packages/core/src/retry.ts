import { NonRetryableError } from "./errors";
import type { RetryPolicy } from "./types";

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 5,
  backoff: "exponential",
  baseMs: 200,
  maxMs: 30_000,
  jitter: true,
};

export function resolveRetry(base: RetryPolicy, override?: Partial<RetryPolicy>): RetryPolicy {
  return { ...base, ...override };
}

/**
 * Delay before the next attempt. `attempt` is 1-based (delay after attempt N fails,
 * before attempt N+1). With jitter, returns a value in [50%, 100%] of the capped delay.
 */
export function backoffMs(
  attempt: number,
  policy: RetryPolicy,
  rand: () => number = Math.random,
): number {
  const raw = policy.backoff === "exponential" ? policy.baseMs * 2 ** (attempt - 1) : policy.baseMs;
  const capped = Math.min(raw, policy.maxMs ?? Number.POSITIVE_INFINITY);
  if (!policy.jitter) return Math.floor(capped);
  return Math.floor(capped * (0.5 + rand() * 0.5));
}

export function isNonRetryable(e: unknown): boolean {
  return e instanceof NonRetryableError;
}
