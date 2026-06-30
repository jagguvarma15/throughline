import type { TokenBudget } from "./types";

/**
 * Mutable token accounting backing `ctx.tokens`. The step-gate (throw
 * BudgetExceededError before a fresh fn) is wired in Phase 2.2; this is the
 * primitive it builds on. Accounting is reconstructed from journaled step costs
 * on replay so totals are identical across replays (guarantees §8).
 */
export class Budget implements TokenBudget {
  readonly limit: number;
  #consumed: number;

  constructor(limit = Number.POSITIVE_INFINITY, consumed = 0) {
    this.limit = limit;
    this.#consumed = consumed;
  }

  get consumed(): number {
    return this.#consumed;
  }

  remaining(): number {
    return Math.max(0, this.limit - this.#consumed);
  }

  consume(n: number): void {
    if (n < 0) throw new RangeError("cannot consume a negative amount of tokens");
    this.#consumed += n;
  }

  /** True if `n` more tokens fit under the limit. */
  canAfford(n: number): boolean {
    return this.limit === Number.POSITIVE_INFINITY || this.#consumed + n <= this.limit;
  }
}
