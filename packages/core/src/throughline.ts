import { type Clock, systemClock } from "./clock";
import { Worker } from "./engine/worker";
import { silentLogger } from "./logger";
import { DEFAULT_RETRY, resolveRetry } from "./retry";
import type { Logger, RetryPolicy, RunState, Store, TaskHandler } from "./types";

export interface ThroughlineOptions {
  store: Store;
  defaultRetry?: Partial<RetryPolicy>;
  clock?: Clock;
  logger?: Logger;
  /** Backoff sleeper between step retries; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
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
}

export interface TaskRef<I, O> {
  readonly name: string;
  /** Phantom types so callers can keep input/output types around. */
  readonly __types?: (input: I) => O;
}

export interface Throughline {
  task<I, O>(name: string, handler: TaskHandler<I, O>): TaskRef<I, O>;
  start<I>(name: string, input: I, opts?: StartOptions): Promise<string>;
  getRun(id: string): Promise<RunState | null>;
  worker(opts?: WorkerOptions): Worker;
}

export function throughline(options: ThroughlineOptions): Throughline {
  const store = options.store;
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? silentLogger;
  const defaultRetry = resolveRetry(DEFAULT_RETRY, options.defaultRetry);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const registry = new Map<string, TaskHandler<unknown, unknown>>();
  let initialized = false;

  const ensureInit = async (): Promise<void> => {
    if (!initialized) {
      await store.init();
      initialized = true;
    }
  };

  return {
    task<I, O>(name: string, handler: TaskHandler<I, O>): TaskRef<I, O> {
      if (registry.has(name)) throw new Error(`task already registered: ${name}`);
      registry.set(name, handler as unknown as TaskHandler<unknown, unknown>);
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
      });
    },
  };
}
