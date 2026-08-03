// Store-level operations facade shared by every ops surface (control-plane HTTP API,
// CLI, MCP server). Unlike `throughline()`, this has no task registry: it can start,
// inspect, signal, and cancel runs, but never executes them - that is the worker's job.

import { type Clock, systemClock } from "./clock";
import { WorkflowNotFoundError } from "./errors";
import type { ListWorkflowsOptions, StepRow, Store, StoreStats, WorkflowRow } from "./types";

export interface StartRunInput {
  /** Task name. NOTE: there is no registry here - starting a task no worker registers
   * leaves the run to be claimed and marked `dead` with "no task registered". */
  name: string;
  input?: unknown;
  id?: string;
  idempotencyKey?: string;
}

export interface RunDetail {
  run: WorkflowRow;
  steps: StepRow[];
}

/** The operations every ops surface exposes over a durable store. */
export interface Ops {
  listRuns(opts?: ListWorkflowsOptions): Promise<WorkflowRow[]>;
  getRun(id: string): Promise<RunDetail | null>;
  /** Create a run (honoring idempotencyKey dedupe). Returns the run id. */
  startRun(input: StartRunInput): Promise<{ id: string }>;
  /** Deliver an event to a run. Throws WorkflowNotFoundError for an unknown id. */
  signal(id: string, name: string, payload?: unknown): Promise<void>;
  /** Sugar over signal for waitForApproval gates: payload is { approved }. */
  approve(id: string, name: string, approved?: boolean): Promise<void>;
  cancel(id: string): Promise<"cancelled" | "requested" | "noop">;
  stats(): Promise<StoreStats>;
}

export function createOps(store: Store, clock: Clock = systemClock): Ops {
  let initialized = false;
  const ensureInit = async (): Promise<void> => {
    if (!initialized) {
      await store.init();
      initialized = true;
    }
  };

  const signal = async (id: string, name: string, payload?: unknown): Promise<void> => {
    await ensureInit();
    const wf = await store.getWorkflow(id);
    if (!wf) throw new WorkflowNotFoundError(id);
    await store.addEvent(id, name, payload, clock.now());
  };

  return {
    async listRuns(opts?: ListWorkflowsOptions): Promise<WorkflowRow[]> {
      await ensureInit();
      return store.listWorkflows(opts);
    },

    async getRun(id: string): Promise<RunDetail | null> {
      await ensureInit();
      const run = await store.getWorkflow(id);
      if (!run) return null;
      return { run, steps: await store.loadJournal(id) };
    },

    async startRun(input: StartRunInput): Promise<{ id: string }> {
      await ensureInit();
      const wf = await store.createWorkflow({
        id: input.id,
        name: input.name,
        input: input.input,
        idempotencyKey: input.idempotencyKey ?? null,
        now: clock.now(),
      });
      return { id: wf.id };
    },

    signal,

    approve(id: string, name: string, approved = true): Promise<void> {
      return signal(id, name, { approved });
    },

    async cancel(id: string): Promise<"cancelled" | "requested" | "noop"> {
      await ensureInit();
      return store.requestCancel(id, clock.now());
    },

    async stats(): Promise<StoreStats> {
      await ensureInit();
      return store.stats();
    },
  };
}
