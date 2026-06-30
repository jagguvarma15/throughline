/** Injectable wall clock (epoch-ms). Tests substitute a controlled clock. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};
