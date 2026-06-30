import { Budget } from "../budget";
import type { Clock } from "../clock";
import {
  CancelledError,
  LeaseLostError,
  StepError,
  SuspendSignal,
  serializeError,
} from "../errors";
import { OrdinalCounter, deriveKey, stepKey } from "../keys";
import { backoffMs, isNonRetryable, resolveRetry } from "../retry";
import type {
  Context,
  Fence,
  Logger,
  RetryPolicy,
  StepOptions,
  StepRow,
  Store,
  TokenBudget,
  WorkflowRow,
} from "../types";

export interface RunContextDeps {
  store: Store;
  workflow: WorkflowRow;
  /** Journal loaded once at run start, keyed by step_key (guarantees §5, §6). */
  journal: Map<string, StepRow>;
  clock: Clock;
  defaultRetry: RetryPolicy;
  fence: Fence;
  logger: Logger;
  sleep: (ms: number) => Promise<void>;
}

export class RunContext implements Context {
  readonly runId: string;
  readonly attempt: number;
  readonly logger: Logger;
  readonly tokens: TokenBudget;
  #d: RunContextDeps;
  #ordinals = new OrdinalCounter();

  constructor(d: RunContextDeps) {
    this.#d = d;
    this.runId = d.workflow.id;
    this.attempt = d.workflow.recoveryAttempts + 1;
    this.logger = d.logger;
    this.tokens = new Budget();
  }

  deriveKey(...parts: unknown[]): string {
    return deriveKey(...parts);
  }

  maxIterations(n: number): number {
    if (n <= 0) throw new RangeError("maxIterations(n) requires n > 0");
    return n;
  }

  async step<T>(name: string, fn: () => Promise<T>, opts?: StepOptions): Promise<T> {
    // Ordinal is assigned synchronously at the call site, before any await (guarantees §4).
    const ordinal = this.#ordinals.next(name);
    const key = stepKey(name, ordinal, opts?.idempotencyKey);
    const policy = resolveRetry(this.#d.defaultRetry, opts?.retry);

    const existing = this.#d.journal.get(key);
    if (existing?.status === "completed") return existing.output as T; // REPLAY: never re-run fn
    if (existing?.status === "failed" && existing.attempts >= policy.maxAttempts) {
      throw new StepError(
        key,
        existing.attempts,
        existing.error?.message ?? "step failed permanently",
      );
    }

    let attempt = existing?.attempts ?? 0;
    for (;;) {
      attempt++;
      let output: T;
      try {
        output = await fn();
      } catch (e) {
        // Control-flow / fatal signals are never retried.
        if (
          e instanceof SuspendSignal ||
          e instanceof CancelledError ||
          e instanceof LeaseLostError
        ) {
          throw e;
        }
        if (isNonRetryable(e) || attempt >= policy.maxAttempts) {
          const se = serializeError(e);
          await this.#d.store.appendStep({
            workflowId: this.#d.workflow.id,
            stepKey: key,
            status: "failed",
            kind: opts?.kind ?? "step",
            error: se,
            attempts: attempt,
            now: this.#d.clock.now(),
            fence: this.#d.fence,
          });
          throw new StepError(key, attempt, se.message, e);
        }
        await this.#d.sleep(backoffMs(attempt, policy));
        continue;
      }
      // fn succeeded. Journaling failures (incl. LeaseLostError) propagate so the run
      // is abandoned and replayed by another worker — NOT retried (avoids double effects).
      await this.#d.store.appendStep({
        workflowId: this.#d.workflow.id,
        stepKey: key,
        status: "completed",
        kind: opts?.kind ?? "step",
        output,
        attempts: attempt,
        now: this.#d.clock.now(),
        fence: this.#d.fence,
      });
      return output;
    }
  }
}
