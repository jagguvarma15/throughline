// Error taxonomy and internal control-flow signals. See docs/guarantees.md §10.

export interface SerializedError {
  message: string;
  type: string;
  stack?: string;
}

export function serializeError(e: unknown): SerializedError {
  if (e instanceof Error) {
    return { message: e.message, type: e.name, stack: e.stack };
  }
  return { message: String(e), type: "Unknown" };
}

export class ThroughlineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A step failed after exhausting retries -> the workflow becomes `dead`. */
export class StepError extends ThroughlineError {
  readonly stepKey: string;
  readonly attempts: number;
  constructor(stepKey: string, attempts: number, message: string, cause?: unknown) {
    super(message, { cause });
    this.stepKey = stepKey;
    this.attempts = attempts;
  }
}

/** Thrown by user code (or wrapping a cause) to skip retries and fail a step immediately. */
export class NonRetryableError extends ThroughlineError {}

/** A token budget would be exceeded; thrown BEFORE a fresh step's fn runs. */
export class BudgetExceededError extends ThroughlineError {
  readonly limit: number;
  readonly consumed: number;
  readonly requested: number;
  constructor(limit: number, consumed: number, requested: number) {
    super(`token budget exceeded: ${consumed}+${requested} > ${limit}`);
    this.limit = limit;
    this.consumed = consumed;
    this.requested = requested;
  }
}

export class WorkflowNotFoundError extends ThroughlineError {
  readonly workflowId: string;
  constructor(workflowId: string) {
    super(`workflow not found: ${workflowId}`);
    this.workflowId = workflowId;
  }
}

/** A worker's fencing epoch is stale; it must abandon the run (NOT mark it dead). */
export class LeaseLostError extends ThroughlineError {
  readonly workflowId: string;
  constructor(workflowId: string) {
    super(`lease lost for workflow: ${workflowId}`);
    this.workflowId = workflowId;
  }
}

/** Internal control flow for cooperative cancellation of a running step. */
export class CancelledError extends ThroughlineError {
  readonly workflowId: string;
  constructor(workflowId: string) {
    super(`workflow cancelled: ${workflowId}`);
    this.workflowId = workflowId;
  }
}

/** Dev-mode guard: replayed step_key order diverged from the journal (see guarantees §4). */
export class NonDeterminismError extends ThroughlineError {}

/**
 * Internal control-flow signal for durable waits/sleeps. This is NOT a failure:
 * the worker catches it and parks the workflow; it is never journaled as a failed
 * step and never counts against retries (see guarantees §7).
 */
export class SuspendSignal {
  readonly waitEvent?: string;
  readonly wakeAt?: number;
  constructor(opts: { waitEvent?: string; wakeAt?: number }) {
    this.waitEvent = opts.waitEvent;
    this.wakeAt = opts.wakeAt;
  }
}

export function isControlSignal(e: unknown): e is SuspendSignal | CancelledError {
  return e instanceof SuspendSignal || e instanceof CancelledError;
}
