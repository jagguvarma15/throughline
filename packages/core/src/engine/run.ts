import type { Clock } from "../clock";
import {
  CancelledError,
  LeaseLostError,
  type SerializedError,
  SuspendSignal,
  serializeError,
} from "../errors";
import type { Fence, Logger, RetryPolicy, Store, TaskHandler, WorkflowRow } from "../types";
import { RunContext } from "./context";

export interface RunOutcome {
  status: "completed" | "suspended" | "dead";
  output?: unknown;
  error?: SerializedError;
  suspend?: { waitEvent?: string; wakeAt?: number };
}

export interface RunDeps {
  store: Store;
  handler: TaskHandler<unknown, unknown>;
  workflow: WorkflowRow;
  clock: Clock;
  defaultRetry: RetryPolicy;
  fence: Fence;
  logger: Logger;
  sleep: (ms: number) => Promise<void>;
  budgetLimit?: number;
  checkCancel?: () => Promise<boolean>;
}

/**
 * Execute one run attempt: fold the journal, build ctx, run the handler. Completed
 * steps replay; the first incomplete step runs. SuspendSignal -> suspended; a step
 * that exhausts retries (StepError) or any handler error -> dead. LeaseLostError and
 * CancelledError propagate to the worker (abandon / cancel).
 */
export async function runWorkflow(deps: RunDeps): Promise<RunOutcome> {
  const rows = await deps.store.loadJournal(deps.workflow.id);
  const journal = new Map(rows.map((r) => [r.stepKey, r] as const));
  const ctx = new RunContext({
    store: deps.store,
    workflow: deps.workflow,
    journal,
    clock: deps.clock,
    defaultRetry: deps.defaultRetry,
    fence: deps.fence,
    logger: deps.logger,
    sleep: deps.sleep,
    budgetLimit: deps.budgetLimit,
    checkCancel: deps.checkCancel,
  });

  try {
    const output = await deps.handler(ctx, deps.workflow.input);
    return { status: "completed", output };
  } catch (e) {
    if (e instanceof SuspendSignal) {
      return { status: "suspended", suspend: { waitEvent: e.waitEvent, wakeAt: e.wakeAt } };
    }
    if (e instanceof LeaseLostError || e instanceof CancelledError) throw e;
    return { status: "dead", error: serializeError(e) };
  }
}
