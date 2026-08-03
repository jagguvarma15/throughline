import { type Clock, systemClock } from "../clock";
import { parseDuration } from "../duration";
import { CancelledError, LeaseLostError, RecoveryExhaustedError, serializeError } from "../errors";
import { silentLogger } from "../logger";
import type {
  DeterminismMode,
  Duration,
  Fence,
  Logger,
  RetryPolicy,
  Store,
  TaskRegistration,
  WorkflowPatch,
} from "../types";
import { runWorkflow } from "./run";

/** Terminal-run garbage collection swept opportunistically by the worker. */
export interface RetentionOptions {
  /** Delete completed/dead/cancelled runs older than this. */
  terminalTtl: Duration;
  /** How often to sweep. Default 60s. */
  sweepIntervalMs?: number;
  /** Max runs deleted per sweep. Default 1000. */
  limit?: number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface WorkerDeps {
  store: Store;
  registry: Map<string, TaskRegistration>;
  defaultRetry: RetryPolicy;
  clock?: Clock;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
  workerId?: string;
  leaseMs?: number;
  pollIntervalMs?: number;
  concurrency?: number;
  /**
   * Poison-pill guard (guarantees §5): a run re-claimed after crashing more than this
   * many times is marked `dead` instead of being retried forever. Default 10.
   */
  maxRecoveryAttempts?: number;
  /** Determinism-guard mode (guarantees §4). Default: strict outside production. */
  determinism?: DeterminismMode;
  /** Opportunistic terminal-run GC; off unless configured. */
  retention?: RetentionOptions;
}

let workerSeq = 0;

/** Claims runnable workflows, runs them, heartbeats the lease, and records the outcome. */
export class Worker {
  #store: Store;
  #registry: Map<string, TaskRegistration>;
  #defaultRetry: RetryPolicy;
  #clock: Clock;
  #logger: Logger;
  #sleep: (ms: number) => Promise<void>;
  #workerId: string;
  #leaseMs: number;
  #pollIntervalMs: number;
  #concurrency: number;
  #maxRecoveryAttempts: number;
  #determinism?: DeterminismMode;
  #retention?: RetentionOptions;
  #lastSweepAt = Number.NEGATIVE_INFINITY;
  #running = false;
  #loops: Promise<void>[] = [];
  #initialized = false;

  constructor(d: WorkerDeps) {
    this.#store = d.store;
    this.#registry = d.registry;
    this.#defaultRetry = d.defaultRetry;
    this.#clock = d.clock ?? systemClock;
    this.#logger = d.logger ?? silentLogger;
    this.#sleep = d.sleep ?? realSleep;
    this.#workerId = d.workerId ?? `worker-${(workerSeq++).toString(36)}-${process.pid}`;
    this.#leaseMs = d.leaseMs ?? 30_000;
    this.#pollIntervalMs = d.pollIntervalMs ?? 200;
    this.#concurrency = d.concurrency ?? 1;
    this.#maxRecoveryAttempts = d.maxRecoveryAttempts ?? 10;
    this.#determinism = d.determinism;
    this.#retention = d.retention;
  }

  /** Opportunistic GC (off unless retention is configured): prune terminal runs on an interval. */
  async #sweepIfDue(): Promise<void> {
    const retention = this.#retention;
    if (!retention) return;
    const now = this.#clock.now();
    if (now - this.#lastSweepAt < (retention.sweepIntervalMs ?? 60_000)) return;
    this.#lastSweepAt = now;
    try {
      const pruned = await this.#store.pruneRuns({
        olderThanMs: parseDuration(retention.terminalTtl),
        limit: retention.limit,
        now,
      });
      if (pruned > 0) this.#logger.info("pruned terminal runs", { pruned });
    } catch (e) {
      this.#logger.warn("terminal-run prune failed", e);
    }
  }

  get id(): string {
    return this.#workerId;
  }

  /** Claim and run a single workflow. Returns false if nothing was runnable. */
  async runOnce(): Promise<boolean> {
    if (!this.#initialized) {
      await this.#store.init();
      this.#initialized = true;
    }
    await this.#sweepIfDue();
    const wf = await this.#store.claim(this.#workerId, this.#leaseMs, this.#clock.now());
    if (!wf) return false;
    const fence: Fence = { workerId: this.#workerId, leaseEpoch: wf.leaseEpoch };

    // Poison-pill guard (guarantees §5): recovery_attempts counts crash re-claims only
    // (waits/wakes do not bump it). Past the cap the run is dead, not retried forever.
    if (wf.recoveryAttempts > this.#maxRecoveryAttempts) {
      await this.#safeFinish(
        wf.id,
        {
          status: "dead",
          error: serializeError(new RecoveryExhaustedError(wf.id, wf.recoveryAttempts)),
        },
        fence,
      );
      return true;
    }

    const reg = this.#registry.get(wf.name);
    if (!reg) {
      await this.#finish(
        wf.id,
        {
          status: "dead",
          error: { message: `no task registered: ${wf.name}`, type: "WorkflowNotFoundError" },
        },
        fence,
      );
      return true;
    }

    const heartbeat = this.#startHeartbeat(wf.id, fence);
    try {
      const outcome = await runWorkflow({
        store: this.#store,
        handler: reg.handler,
        workflow: wf,
        clock: this.#clock,
        defaultRetry: this.#defaultRetry,
        budgetLimit: reg.budget,
        fence,
        logger: this.#logger,
        sleep: this.#sleep,
        checkCancel: async () => (await this.#store.getWorkflow(wf.id))?.cancelRequested ?? false,
        determinism: this.#determinism,
      });
      if (outcome.status === "completed") {
        await this.#finish(wf.id, { status: "completed", output: outcome.output }, fence);
      } else if (outcome.status === "suspended") {
        await this.#finish(
          wf.id,
          {
            status: "waiting",
            waitEvent: outcome.suspend?.waitEvent ?? null,
            wakeAt: outcome.suspend?.wakeAt ?? null,
          },
          fence,
        );
      } else {
        await this.#finish(wf.id, { status: "dead", error: outcome.error ?? null }, fence);
      }
    } catch (e) {
      if (e instanceof LeaseLostError) {
        this.#logger.warn("lease lost; abandoning run for re-claim", { workflowId: wf.id });
      } else if (e instanceof CancelledError) {
        await this.#safeFinish(wf.id, { status: "cancelled" }, fence);
      } else {
        await this.#safeFinish(wf.id, { status: "dead", error: serializeError(e) }, fence);
      }
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    for (let i = 0; i < this.#concurrency; i++) this.#loops.push(this.#loop());
  }

  async stop(): Promise<void> {
    this.#running = false;
    await Promise.allSettled(this.#loops);
    this.#loops = [];
  }

  async #loop(): Promise<void> {
    while (this.#running) {
      let did = false;
      try {
        did = await this.runOnce();
      } catch (e) {
        this.#logger.error("worker loop error", e);
      }
      if (!did && this.#running) await this.#sleep(this.#pollIntervalMs);
    }
  }

  #finish(id: string, patch: WorkflowPatch, fence: Fence): Promise<void> {
    return this.#store.updateWorkflow(
      id,
      { ...patch, lockedBy: null, leaseExpiresAt: null },
      fence,
    );
  }

  async #safeFinish(id: string, patch: WorkflowPatch, fence: Fence): Promise<void> {
    try {
      await this.#finish(id, patch, fence);
    } catch {
      // Lease lost during cleanup — another worker owns the run now.
    }
  }

  #startHeartbeat(id: string, fence: Fence): ReturnType<typeof setInterval> {
    const interval = Math.max(1, Math.floor(this.#leaseMs / 3));
    return setInterval(() => {
      this.#store.heartbeat(id, fence, this.#leaseMs, this.#clock.now()).catch(() => {
        // Lease lost — the in-flight run will fail its next fenced write and abandon.
      });
    }, interval);
  }
}
