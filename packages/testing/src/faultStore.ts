import {
  type AppendStepInput,
  type AppendStepResult,
  type ConsumeEventInput,
  type Fence,
  type HeartbeatResult,
  LeaseLostError,
  type ListWorkflowsOptions,
  type NewWorkflow,
  type PruneOptions,
  type StepRow,
  type Store,
  type StoreStats,
  type WorkflowPatch,
  type WorkflowRow,
} from "@through-line/core";

export interface FaultPlan {
  /** Simulate a crash right after the step with this key commits (before the next op). */
  crashAfterStep?: string;
  /** Simulate a crash after the Nth non-replay appendStep commit (1-based). */
  crashAfterCommits?: number;
  /**
   * Global fresh-commit indices (1-based) to crash after. Because replayed steps do
   * not increment the counter, each index occurs once across the whole run — ideal for
   * randomized crash schedules that always converge.
   */
  crashAt?: Set<number>;
  /** Run the same committing appendStep twice (duplicate delivery) for this key. */
  duplicateStep?: string;
}

/**
 * Wraps any Store to inject faults at step boundaries (guarantees-driven robustness
 * proof). A "crash" is modeled as the in-flight write aborting after it has committed:
 * the worker abandons the run, the lease expires, and another worker re-claims and
 * replays the journal — exactly the real crash-resume path. The plan is mutable so a
 * test can arm a fault, run, then disarm before the resume.
 */
export class FaultStore implements Store {
  #inner: Store;
  #plan: FaultPlan;
  #commits = 0;

  /** Mirrored only when the wrapped store has the capability (optional method). */
  subscribeWake?: (listener: () => void) => Promise<() => Promise<void>>;

  constructor(inner: Store, plan: FaultPlan) {
    this.#inner = inner;
    this.#plan = plan;
    const subscribe = inner.subscribeWake?.bind(inner);
    if (subscribe) this.subscribeWake = subscribe;
  }

  init(): Promise<void> {
    return this.#inner.init();
  }

  createWorkflow(rec: NewWorkflow): Promise<WorkflowRow> {
    return this.#inner.createWorkflow(rec);
  }

  getWorkflow(id: string): Promise<WorkflowRow | null> {
    return this.#inner.getWorkflow(id);
  }

  claim(workerId: string, leaseMs: number, now: number): Promise<WorkflowRow | null> {
    return this.#inner.claim(workerId, leaseMs, now);
  }

  heartbeat(id: string, fence: Fence, leaseMs: number, now: number): Promise<HeartbeatResult> {
    return this.#inner.heartbeat(id, fence, leaseMs, now);
  }

  loadJournal(workflowId: string): Promise<StepRow[]> {
    return this.#inner.loadJournal(workflowId);
  }

  async appendStep(step: AppendStepInput): Promise<AppendStepResult> {
    if (this.#plan.duplicateStep === step.stepKey) {
      // Duplicate delivery: the same step body committed twice. The UNIQUE/UPSERT
      // contract must make the second a no-op (replayed) with no duplicate row.
      await this.#inner.appendStep(step);
    }
    const res = await this.#inner.appendStep(step);
    if (!res.replayed) {
      this.#commits++;
      const crash =
        this.#plan.crashAfterStep === step.stepKey ||
        (this.#plan.crashAfterCommits !== undefined &&
          this.#commits >= this.#plan.crashAfterCommits) ||
        (this.#plan.crashAt?.has(this.#commits) ?? false);
      if (crash) throw new LeaseLostError(step.workflowId);
    }
    return res;
  }

  updateWorkflow(id: string, patch: WorkflowPatch, fence?: Fence): Promise<void> {
    return this.#inner.updateWorkflow(id, patch, fence);
  }

  addEvent(workflowId: string, name: string, payload: unknown, now: number): Promise<void> {
    return this.#inner.addEvent(workflowId, name, payload, now);
  }

  consumeEventIntoJournal(
    args: ConsumeEventInput,
  ): Promise<{ found: true; payload: unknown; seq: number } | { found: false }> {
    return this.#inner.consumeEventIntoJournal(args);
  }

  requestCancel(id: string, now: number): Promise<"cancelled" | "requested" | "noop"> {
    return this.#inner.requestCancel(id, now);
  }

  listWorkflows(opts?: ListWorkflowsOptions): Promise<WorkflowRow[]> {
    return this.#inner.listWorkflows(opts);
  }

  stats(): Promise<StoreStats> {
    return this.#inner.stats();
  }

  pruneRuns(opts: PruneOptions): Promise<number> {
    return this.#inner.pruneRuns(opts);
  }

  resetFailedSteps(workflowId: string): Promise<number> {
    return this.#inner.resetFailedSteps(workflowId);
  }

  close(): void | Promise<void> {
    return this.#inner.close();
  }
}

export function faultStore(inner: Store, plan: FaultPlan): FaultStore {
  return new FaultStore(inner, plan);
}
