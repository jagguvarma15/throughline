import type { Clock } from "@through-line/core";

export interface ControlledClock extends Clock {
  advance(ms: number): void;
  set(t: number): void;
}

/** A manually-advanced clock for deterministic timer/lease tests. */
export function controlledClock(start = 0): ControlledClock {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (v) => {
      t = v;
    },
  };
}
