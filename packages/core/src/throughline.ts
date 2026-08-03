import { type Clock, systemClock } from "./clock";
import { Worker } from "./engine/worker";
import { silentLogger } from "./logger";
import { DEFAULT_RETRY, resolveRetry } from "./retry";
import type {
  DeterminismMode,
  Logger,
  RetryPolicy,
  RunState,
  Store,
  TaskHandler,
  TaskRegistration,
} from "./types";

export interface ThroughlineOptions {
  store: Store;
  defaultRetry?: Partial<RetryPolicy>;
  clock?: Clock;
  logger?: Logger;
  /** Backoff sleeper between step retries; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Determinism-guard mode (guarantees §4): `strict` throws NonDeterminismError when a
   * replay diverges from the journal, `warn` logs, `off` disables. Default: strict
   * unless NODE_ENV is "production", then warn.
   */
  determinism?: DeterminismMode;
}

export interface StartOptions {
  id?: string;
  idempotencyKey?: string;
}

export interface WorkerOptions {
  concurrency?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  workerId?: string;
  /**
   * Poison-pill guard (guarantees §5): a run re-claimed after crashing more than this
   * many times is marked `dead` instead of being retried forever. Default 10.
   */
  maxRecoveryAttempts?: number;
}

export interface TaskRef<I, O> {
  readonly name: string;
  /** Phantom types so callers can keep input/output types around. */
  readonly __types?: (input: I) => O;
}

export interface Throughline {
  task<I, O>(name: string, handler: TaskHandler<I, O>, opts?: { budget?: number }): TaskRef<I, O>;
  start<I>(name: string, input: I, opts?: StartOptions): Promise<string>;
  getRun(id: string): Promise<RunState | null>;
  signal(id: string, name: string, payload?: unknown): Promise<void>;
  cancel(id: string): Promise<"cancelled" | "requested" | "noop">;
  worker(opts?: WorkerOptions): Worker;
}

export function throughline(options: ThroughlineOptions): Throughline {
  const store = options.store;
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? silentLogger;
  const defaultRetry = resolveRetry(DEFAULT_RETRY, options.defaultRetry);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const registry = new Map<string, TaskRegistration>();
  let initialized = false;

  const ensureInit = async (): Promise<void> => {
    if (!initialized) {
      await store.init();
      initialized = true;
    }
  };

  return {
    task<I, O>(
      name: string,
      handler: TaskHandler<I, O>,
      opts?: { budget?: number },
    ): TaskRef<I, O> {
      if (registry.has(name)) throw new Error(`task already registered: ${name}`);
      registry.set(name, {
        handler: handler as unknown as TaskHandler<unknown, unknown>,
        budget: opts?.budget,
      });
      return { name };
    },

    async start<I>(name: string, input: I, opts?: StartOptions): Promise<string> {
      if (!registry.has(name)) throw new Error(`task not registered: ${name}`);
      await ensureInit();
      const wf = await store.createWorkflow({
        id: opts?.id,
        name,
        input,
        idempotencyKey: opts?.idempotencyKey ?? null,
        now: clock.now(),
      });
      return wf.id;
    },

    async getRun(id: string): Promise<RunState | null> {
      const wf = await store.getWorkflow(id);
      if (!wf) return null;
      const steps = await store.loadJournal(id);
      return {
        id: wf.id,
        name: wf.name,
        status: wf.status,
        input: wf.input,
        output: wf.output,
        error: wf.error,
        steps,
      };
    },

    async signal(id: string, name: string, payload?: unknown): Promise<void> {
      await ensureInit();
      await store.addEvent(id, name, payload, clock.now());
    },

    async cancel(id: string): Promise<"cancelled" | "requested" | "noop"> {
      await ensureInit();
      return store.requestCancel(id, clock.now());
    },

    worker(opts?: WorkerOptions): Worker {
      return new Worker({
        store,
        registry,
        defaultRetry,
        clock,
        logger,
        sleep,
        concurrency: opts?.concurrency,
        pollIntervalMs: opts?.pollIntervalMs,
        leaseMs: opts?.leaseMs,
        workerId: opts?.workerId,
        maxRecoveryAttempts: opts?.maxRecoveryAttempts,
        determinism: options.determinism,
      });
    },
  };
}
