import { performance } from "node:perf_hooks";
import type {
  AppendStepInput,
  AppendStepResult,
  ConsumeEventInput,
  Fence,
  HeartbeatResult,
  ListWorkflowsOptions,
  NewWorkflow,
  PruneOptions,
  StepRow,
  Store,
  StoreStats,
  WorkflowPatch,
  WorkflowRow,
} from "@through-line/core";

/** Wraps a Store to count per-method calls and record claim wall times. */
export class CountingStore implements Store {
  #inner: Store;
  readonly calls = new Map<string, number>();
  readonly claimMs: number[] = [];

  subscribeWake?: (listener: () => void) => Promise<() => Promise<void>>;

  constructor(inner: Store) {
    this.#inner = inner;
    const subscribe = inner.subscribeWake?.bind(inner);
    if (subscribe) this.subscribeWake = subscribe;
  }

  #count(method: string): void {
    this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
  }

  count(method: string): number {
    return this.calls.get(method) ?? 0;
  }

  init(): Promise<void> {
    this.#count("init");
    return this.#inner.init();
  }

  createWorkflow(rec: NewWorkflow): Promise<WorkflowRow> {
    this.#count("createWorkflow");
    return this.#inner.createWorkflow(rec);
  }

  getWorkflow(id: string): Promise<WorkflowRow | null> {
    this.#count("getWorkflow");
    return this.#inner.getWorkflow(id);
  }

  async claim(workerId: string, leaseMs: number, now: number): Promise<WorkflowRow | null> {
    this.#count("claim");
    const start = performance.now();
    try {
      return await this.#inner.claim(workerId, leaseMs, now);
    } finally {
      this.claimMs.push(performance.now() - start);
    }
  }

  heartbeat(id: string, fence: Fence, leaseMs: number, now: number): Promise<HeartbeatResult> {
    this.#count("heartbeat");
    return this.#inner.heartbeat(id, fence, leaseMs, now);
  }

  loadJournal(workflowId: string): Promise<StepRow[]> {
    this.#count("loadJournal");
    return this.#inner.loadJournal(workflowId);
  }

  appendStep(step: AppendStepInput): Promise<AppendStepResult> {
    this.#count("appendStep");
    return this.#inner.appendStep(step);
  }

  updateWorkflow(id: string, patch: WorkflowPatch, fence?: Fence): Promise<void> {
    this.#count("updateWorkflow");
    return this.#inner.updateWorkflow(id, patch, fence);
  }

  addEvent(workflowId: string, name: string, payload: unknown, now: number): Promise<void> {
    this.#count("addEvent");
    return this.#inner.addEvent(workflowId, name, payload, now);
  }

  consumeEventIntoJournal(
    args: ConsumeEventInput,
  ): Promise<{ found: true; payload: unknown; seq: number } | { found: false }> {
    this.#count("consumeEventIntoJournal");
    return this.#inner.consumeEventIntoJournal(args);
  }

  requestCancel(id: string, now: number): Promise<"cancelled" | "requested" | "noop"> {
    this.#count("requestCancel");
    return this.#inner.requestCancel(id, now);
  }

  listWorkflows(opts?: ListWorkflowsOptions): Promise<WorkflowRow[]> {
    this.#count("listWorkflows");
    return this.#inner.listWorkflows(opts);
  }

  stats(): Promise<StoreStats> {
    this.#count("stats");
    return this.#inner.stats();
  }

  pruneRuns(opts: PruneOptions): Promise<number> {
    this.#count("pruneRuns");
    return this.#inner.pruneRuns(opts);
  }

  resetFailedSteps(workflowId: string): Promise<number> {
    this.#count("resetFailedSteps");
    return this.#inner.resetFailedSteps(workflowId);
  }

  close(): void | Promise<void> {
    return this.#inner.close();
  }
}

/** A view of a store with the wake capability hidden, to force pure polling. */
export function withoutWake(inner: Store): Store {
  const clone: Store = {
    init: () => inner.init(),
    createWorkflow: (rec) => inner.createWorkflow(rec),
    getWorkflow: (id) => inner.getWorkflow(id),
    claim: (w, l, n) => inner.claim(w, l, n),
    heartbeat: (id, f, l, n) => inner.heartbeat(id, f, l, n),
    loadJournal: (id) => inner.loadJournal(id),
    appendStep: (s) => inner.appendStep(s),
    updateWorkflow: (id, p, f) => inner.updateWorkflow(id, p, f),
    addEvent: (id, n, p, t) => inner.addEvent(id, n, p, t),
    consumeEventIntoJournal: (a) => inner.consumeEventIntoJournal(a),
    requestCancel: (id, n) => inner.requestCancel(id, n),
    listWorkflows: (o) => inner.listWorkflows(o),
    stats: () => inner.stats(),
    pruneRuns: (o) => inner.pruneRuns(o),
    resetFailedSteps: (id) => inner.resetFailedSteps(id),
    close: () => {},
  };
  return clone;
}
