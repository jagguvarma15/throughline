import { Budget } from "../budget";
import type { Clock } from "../clock";
import { parseDuration } from "../duration";
import {
  BudgetExceededError,
  CancelledError,
  LeaseLostError,
  NonDeterminismError,
  StepError,
  SuspendSignal,
  TimeoutError,
  serializeError,
} from "../errors";
import { OrdinalCounter, deriveKey, stepKey } from "../keys";
import type { Tracing } from "../otel";
import { backoffMs, isNonRetryable, resolveRetry } from "../retry";
import type {
  Context,
  DeterminismMode,
  Duration,
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
  /** Per-run token budget limit; reconstructed accounting is exposed as ctx.tokens. */
  budgetLimit?: number;
  /** Optional OpenTelemetry tracing (no-op without a registered provider). */
  tracing?: Tracing | null;
  /** Cooperative-cancel probe; checked before each fresh step. */
  checkCancel?: () => Promise<boolean>;
  /** Determinism-guard mode (guarantees §4). Default: strict outside production. */
  determinism?: DeterminismMode;
}

export class RunContext implements Context {
  readonly runId: string;
  readonly attempt: number;
  readonly logger: Logger;
  readonly tokens: TokenBudget;
  #d: RunContextDeps;
  #ordinals = new OrdinalCounter();
  #determinism: DeterminismMode;
  /** step_keys this replay has touched; compared against the journal at completion (§4). */
  #consumed = new Set<string>();

  constructor(d: RunContextDeps) {
    this.#d = d;
    this.runId = d.workflow.id;
    this.attempt = d.workflow.recoveryAttempts + 1;
    this.logger = d.logger;
    this.tokens = new Budget(d.budgetLimit ?? Number.POSITIVE_INFINITY);
    this.#determinism =
      d.determinism ?? (process.env.NODE_ENV === "production" ? "warn" : "strict");
  }

  /** Determinism-guard sink: throw in strict mode, log in warn mode, ignore when off. */
  #violation(message: string): void {
    if (this.#determinism === "off") return;
    if (this.#determinism === "warn") {
      this.logger.warn(`non-determinism detected: ${message}`, { workflowId: this.runId });
      return;
    }
    throw new NonDeterminismError(message);
  }

  /** A journaled row hit with the wrong kind means a renamed/reordered call aliased into it. */
  #checkKind(existing: StepRow | undefined, expected: string, key: string): void {
    if (existing && existing.kind !== expected) {
      this.#violation(
        `journaled step "${key}" has kind "${existing.kind}" but was replayed with kind "${expected}" - the step sequence diverged from the journal`,
      );
    }
  }

  /**
   * Called by runWorkflow when the handler returns: every completed journal row must have
   * been replayed by this execution, else steps were removed, renamed, or reordered (§4).
   * Only checked at completion so a crash mid-Promise.all cannot false-positive.
   */
  verifyJournalConsumed(): void {
    if (this.#determinism === "off") return;
    const orphaned: string[] = [];
    for (const [key, row] of this.#d.journal) {
      if (row.status === "completed" && !this.#consumed.has(key)) orphaned.push(key);
    }
    if (orphaned.length > 0) {
      this.#violation(
        `run completed but journaled steps were never replayed: ${orphaned.join(", ")} - steps were removed, renamed, or reordered`,
      );
    }
  }

  deriveKey(...parts: unknown[]): string {
    return deriveKey(...parts);
  }

  maxIterations(n: number): number {
    if (n <= 0) throw new RangeError("maxIterations(n) requires n > 0");
    return n;
  }

  async step<T>(name: string, fn: () => Promise<T>, opts?: StepOptions<T>): Promise<T> {
    // Ordinal is assigned synchronously at the call site, before any await (guarantees §4).
    const ordinal = this.#ordinals.next(name);
    const key = stepKey(name, ordinal, opts?.idempotencyKey);
    const tracing = this.#d.tracing;
    if (!tracing) return this.#runStep<T>(key, fn, opts);
    return tracing.tracer.startActiveSpan(`step ${name}`, async (span) => {
      span.setAttribute("throughline.step_key", key);
      try {
        const out = await this.#runStep<T>(key, fn, opts);
        span.setAttribute("throughline.tokens_consumed", this.tokens.consumed);
        span.setStatus({ code: tracing.ok });
        return out;
      } catch (e) {
        if (e instanceof Error) span.recordException(e);
        span.setStatus({ code: tracing.error });
        throw e;
      } finally {
        span.end();
      }
    });
  }

  async #runStep<T>(key: string, fn: () => Promise<T>, opts?: StepOptions<T>): Promise<T> {
    const policy = resolveRetry(this.#d.defaultRetry, opts?.retry);

    const existing = this.#d.journal.get(key);
    this.#consumed.add(key);
    this.#checkKind(existing, opts?.kind ?? "step", key);
    if (existing?.status === "completed") {
      this.tokens.consume(existing.cost); // reconstruct budget accounting on replay (§8)
      return existing.output as T; // REPLAY: never re-run fn
    }
    if (existing?.status === "failed" && existing.attempts >= policy.maxAttempts) {
      throw new StepError(
        key,
        existing.attempts,
        existing.error?.message ?? "step failed permanently",
      );
    }

    // Cooperative cancellation: only a fresh execution is interrupted (guarantees §9).
    if (this.#d.checkCancel && (await this.#d.checkCancel())) {
      throw new CancelledError(this.#d.workflow.id);
    }

    // Budget gate: a fresh step is refused BEFORE fn runs if it cannot be afforded (§8).
    // Only a numeric a-priori estimate can gate before fn; a function cost is charged after.
    const rawCost = opts?.budget?.cost;
    const estimate = opts?.budget?.estimate ?? (typeof rawCost === "number" ? rawCost : undefined);
    if (estimate !== undefined && this.tokens.remaining() < estimate) {
      throw new BudgetExceededError(this.tokens.limit, this.tokens.consumed, estimate);
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
        // Journal EVERY failed attempt (cumulative count), not just the terminal one, so
        // the retry budget survives a crash mid-retry-loop: on resume, line "attempt ="
        // above seeds from the journaled count and total executions stay <= maxAttempts.
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
        if (isNonRetryable(e) || attempt >= policy.maxAttempts) {
          throw new StepError(key, attempt, se.message, e);
        }
        await this.#d.sleep(backoffMs(attempt, policy));
        continue;
      }
      // fn succeeded. Journaling failures (incl. LeaseLostError) propagate so the run
      // is abandoned and replayed by another worker — NOT retried (avoids double effects).
      const cost = typeof rawCost === "function" ? rawCost(output) : (rawCost ?? 0);
      this.tokens.consume(cost);
      await this.#d.store.appendStep({
        workflowId: this.#d.workflow.id,
        stepKey: key,
        status: "completed",
        kind: opts?.kind ?? "step",
        output,
        attempts: attempt,
        cost,
        now: this.#d.clock.now(),
        fence: this.#d.fence,
      });
      return output;
    }
  }

  async sleep(name: string, ms: number): Promise<void> {
    const key = stepKey(name, this.#ordinals.next(name));
    const existing = this.#d.journal.get(key);
    this.#consumed.add(key);
    this.#checkKind(existing, "sleep", key);
    if (existing?.status === "completed") {
      // Journaled deadline; re-suspend with the SAME deadline if a reclaim arrived early.
      const deadline = existing.output as number;
      if (this.#d.clock.now() >= deadline) return;
      throw new SuspendSignal({ wakeAt: deadline });
    }
    const deadline = this.#d.clock.now() + ms;
    await this.#d.store.appendStep({
      workflowId: this.#d.workflow.id,
      stepKey: key,
      status: "completed",
      kind: "sleep",
      output: deadline,
      attempts: 1,
      now: this.#d.clock.now(),
      fence: this.#d.fence,
    });
    throw new SuspendSignal({ wakeAt: deadline });
  }

  async waitForEvent<T = unknown>(name: string, opts?: { timeout?: Duration }): Promise<T> {
    const key = stepKey(name, this.#ordinals.next(name));
    const existing = this.#d.journal.get(key);
    this.#consumed.add(key);
    if (existing && existing.kind !== "event" && existing.kind !== "timeout") {
      this.#violation(
        `journaled step "${key}" has kind "${existing.kind}" but was replayed as a waitForEvent - the step sequence diverged from the journal`,
      );
    }
    if (existing?.status === "completed") {
      if (existing.kind === "timeout") throw new TimeoutError(name);
      return existing.output as T; // REPLAY: journaled payload, never re-consume
    }

    // Journal-first atomic consume (guarantees §7); event wins over a pending timeout.
    const r = await this.#d.store.consumeEventIntoJournal({
      workflowId: this.#d.workflow.id,
      stepKey: key,
      name,
      now: this.#d.clock.now(),
      fence: this.#d.fence,
    });
    if (r.found) return r.payload as T;

    // No event. Resolve the (stable) deadline: when resuming a park on THIS wait, reuse the
    // persisted workflow.wakeAt; otherwise this is a fresh wait, so derive it from opts.timeout.
    // (Same-name waits in a loop with timeouts are not individually tracked in v0.1.)
    const isResumeOfThisWait =
      this.#d.workflow.waitEvent === name && this.#d.workflow.wakeAt !== null;
    const deadline = isResumeOfThisWait
      ? this.#d.workflow.wakeAt
      : opts?.timeout !== undefined
        ? this.#d.clock.now() + parseDuration(opts.timeout)
        : null;

    if (deadline !== null && deadline !== undefined && this.#d.clock.now() >= deadline) {
      await this.#d.store.appendStep({
        workflowId: this.#d.workflow.id,
        stepKey: key,
        status: "completed",
        kind: "timeout",
        output: null,
        attempts: 1,
        now: this.#d.clock.now(),
        fence: this.#d.fence,
      });
      throw new TimeoutError(name);
    }
    throw new SuspendSignal({ waitEvent: name, wakeAt: deadline ?? undefined });
  }

  async waitForApproval(name: string, opts?: { timeout?: Duration }): Promise<boolean> {
    const payload = await this.waitForEvent<unknown>(name, opts);
    if (typeof payload === "boolean") return payload;
    return Boolean((payload as { approved?: unknown } | null)?.approved);
  }

  /** Wall-clock read as a journaled micro-step (§3): stable across replays. */
  now(): Promise<number> {
    return this.step("$now", async () => this.#d.clock.now());
  }

  /** Randomness as a journaled micro-step (§3): drawn once, replayed verbatim. */
  random(): Promise<number> {
    return this.step("$random", async () => Math.random());
  }
}
