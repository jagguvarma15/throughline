import type { Duration } from "./types";

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse a Duration (ms number, or a string like "30s", "5m", "1h", "2d") to milliseconds. */
export function parseDuration(d: Duration): number {
  if (typeof d === "number") return d;
  const match = /^(\d+)\s*(ms|s|m|h|d)$/.exec(d.trim());
  const num = match?.[1];
  const unit = match?.[2];
  const mult = unit ? UNIT_MS[unit] : undefined;
  if (!num || mult === undefined) throw new Error(`invalid duration: ${d}`);
  return Number(num) * mult;
}
