import type { Clock } from "../clock";
import {
  CancelledError,
  LeaseLostError,
  type SerializedError,
  SuspendSignal,
  serializeError,
} from "../errors";
import { loadTracing } from "../otel";
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
 * CancelledError propagate to the worker (abandon / cancel). The whole run is wrapped
 * in a workflow span, and each step in a child span, when tracing is available.
 */
export async function runWorkflow(deps: RunDeps): Promise<RunOutcome> {
  const rows = await deps.store.loadJournal(deps.workflow.id);
  const journal = new Map(rows.map((r) => [r.stepKey, r] as const));
  const tracing = await loadTracing();
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
    tracing,
  });

  const exec = async (): Promise<RunOutcome> => {
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
  };

  if (!tracing) return exec();
  return tracing.tracer.startActiveSpan(`workflow ${deps.workflow.name}`, async (span) => {
    span.setAttribute("throughline.workflow_id", deps.workflow.id);
    span.setAttribute("throughline.workflow_name", deps.workflow.name);
    try {
      const outcome = await exec();
      span.setStatus({ code: outcome.status === "dead" ? tracing.error : tracing.ok });
      return outcome;
    } catch (e) {
      span.setStatus({ code: tracing.error });
      if (e instanceof Error) span.recordException(e);
      throw e;
    } finally {
      span.end();
    }
  });
}
