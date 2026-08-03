import type { SerializedError } from "./errors";

// ---------------------------------------------------------------------------
// Persistence rows (see docs/guarantees.md §11 and the store schema)
// ---------------------------------------------------------------------------

/**
 * Terminal failure is `dead` (exhausted retries, budget exceeded, recovery exhausted,
 * or an unhandled handler error). `failed` is reserved and never assigned by the engine;
 * it is kept so consumers switching on this union do not break.
 */
export type WorkflowStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "dead"
  | "cancelled";

/**
 * Determinism-guard mode (guarantees §4). `strict` throws NonDeterminismError when a
 * replay diverges from the journal; `warn` logs instead; `off` disables the checks.
 * Default: `strict` unless NODE_ENV is "production", then `warn`.
 */
export type DeterminismMode = "strict" | "warn" | "off";

export type StepStatus = "completed" | "failed";
export type StepKind = "step" | "sleep" | "event" | "timeout";

export interface WorkflowRow {
  id: string;
  name: string;
  status: WorkflowStatus;
  input: unknown;
  output: unknown;
  error: SerializedError | null;
  idempotencyKey: string | null;
  version: number;
  seqCounter: number;
  recoveryAttempts: number;
  wakeAt: number | null;
  waitEvent: string | null;
  lockedBy: string | null;
  leaseEpoch: number;
  leaseExpiresAt: number | null;
  heartbeatAt: number | null;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface StepRow {
  id: string;
  workflowId: string;
  stepKey: string;
  seq: number;
  status: StepStatus;
  kind: StepKind;
  output: unknown;
  error: SerializedError | null;
  attempts: number;
  cost: number;
  createdAt: number;
  completedAt: number;
}

export interface EventRow {
  id: string;
  workflowId: string;
  name: string;
  payload: unknown;
  createdAt: number;
  consumedAt: number | null;
}

// ---------------------------------------------------------------------------
// Store interface (the pluggability seam) — implemented by store-sqlite/postgres
// ---------------------------------------------------------------------------

export interface NewWorkflow {
  id?: string;
  name: string;
  input: unknown;
  idempotencyKey?: string | null;
  now: number;
}

/** Identifies the worker + lease generation making a write (lease fencing, guarantees §5). */
export interface Fence {
  workerId: string;
  leaseEpoch: number;
}

export interface AppendStepInput {
  workflowId: string;
  stepKey: string;
  status: StepStatus;
  kind?: StepKind;
  output?: unknown;
  error?: SerializedError | null;
  attempts: number;
  cost?: number;
  now: number;
  /** When present, the write is rejected with LeaseLostError unless the fence matches. */
  fence?: Fence;
}

export interface ConsumeEventInput {
  workflowId: string;
  stepKey: string;
  name: string;
  now: number;
  fence?: Fence;
}

export type WorkflowPatch = Partial<
  Pick<
    WorkflowRow,
    | "status"
    | "output"
    | "error"
    | "wakeAt"
    | "waitEvent"
    | "lockedBy"
    | "leaseExpiresAt"
    | "heartbeatAt"
    | "recoveryAttempts"
  >
>;

export interface StoreStats {
  workflowsByStatus: Record<string, number>;
  stepCount: number;
  failedStepCount: number;
  tokenSum: number;
}

export interface ListWorkflowsOptions {
  status?: WorkflowStatus;
  limit?: number;
  offset?: number;
}

export interface Store {
  /** Idempotent migrations. Safe to call repeatedly; never destroys data. */
  init(): Promise<void>;
  /** Create a run. Honors idempotencyKey: returns the existing row on conflict. */
  createWorkflow(rec: NewWorkflow): Promise<WorkflowRow>;
  getWorkflow(id: string): Promise<WorkflowRow | null>;
  /**
   * Atomically pick one runnable workflow and take its lease (bumping lease_epoch).
   * Runnable = pending | (running & lease expired) | (waiting & wake_at<=now) |
   * (waiting & an unconsumed event matches wait_event).
   */
  claim(workerId: string, leaseMs: number, now: number): Promise<WorkflowRow | null>;
  /** Extend the lease. Throws LeaseLostError if the fence is stale. */
  heartbeat(id: string, fence: Fence, leaseMs: number, now: number): Promise<void>;
  /** The journal, ordered by seq. */
  loadJournal(workflowId: string): Promise<StepRow[]>;
  /**
   * UPSERT a terminal step row. A `failed` row may be updated to `completed`; a
   * `completed` row is never overwritten. Allocates seq on first insert.
   * `replayed: true` means a completed row already existed (no-op).
   */
  appendStep(step: AppendStepInput): Promise<{ seq: number; replayed: boolean }>;
  updateWorkflow(id: string, patch: WorkflowPatch, fence?: Fence): Promise<void>;
  addEvent(workflowId: string, name: string, payload: unknown, now: number): Promise<void>;
  /**
   * Consume one unconsumed event by name (marks consumed_at).
   * @deprecated Not used by the engine (superseded by consumeEventIntoJournal, which is
   * atomic with journaling). Retained for store tooling; may be removed in a future minor.
   */
  takeEvent(workflowId: string, name: string, now: number): Promise<EventRow | null>;
  /**
   * Atomically consume a matching unconsumed event AND journal its payload as a step,
   * in one transaction (guarantees §7). If a journal entry already exists for stepKey,
   * returns it (consumed:false). If no event is available, returns { found:false }.
   */
  consumeEventIntoJournal(
    args: ConsumeEventInput,
  ): Promise<{ found: true; payload: unknown; seq: number } | { found: false }>;
  /** pending/waiting -> cancelled (terminal); running -> set cancel_requested flag. */
  requestCancel(id: string, now: number): Promise<"cancelled" | "requested" | "noop">;
  /** List workflows for the control-plane, newest first. */
  listWorkflows(opts?: ListWorkflowsOptions): Promise<WorkflowRow[]>;
  /** Aggregate counts for metrics. */
  stats(): Promise<StoreStats>;
  /**
   * @deprecated Not used by the engine (the worker releases leases via an updateWorkflow
   * patch). Retained for test harnesses; may be removed in a future minor.
   */
  releaseLease(id: string, fence?: Fence): Promise<void>;
  close(): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Engine-facing types
// ---------------------------------------------------------------------------

/** A duration in milliseconds, or a string like "30s", "5m", "1h". */
export type Duration = number | string;

export interface RetryPolicy {
  maxAttempts: number;
  backoff: "exponential" | "fixed";
  baseMs: number;
  maxMs?: number;
  jitter: boolean;
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export interface TokenBudget {
  readonly limit: number;
  readonly consumed: number;
  remaining(): number;
  consume(n: number): void;
}

export interface StepOptions<T = unknown> {
  retry?: Partial<RetryPolicy>;
  idempotencyKey?: string;
  kind?: StepKind;
  /**
   * Token budgeting for this step. `estimate` gates BEFORE fn runs; `cost` is charged AFTER
   * success — a number, or a function of the result (e.g. actual model usage).
   */
  budget?: { estimate?: number; cost?: number | ((result: T) => number) };
}

export interface Context {
  readonly runId: string;
  readonly attempt: number;
  readonly logger: Logger;
  readonly tokens: TokenBudget;
  step<T>(name: string, fn: () => Promise<T>, opts?: StepOptions<T>): Promise<T>;
  /** Durable timer: suspend until `ms` have elapsed, surviving restarts. */
  sleep(name: string, ms: number): Promise<void>;
  /** Durably wait for a signalled event; optionally time out. */
  waitForEvent<T = unknown>(name: string, opts?: { timeout?: Duration }): Promise<T>;
  /** Sugar over waitForEvent: returns whether the signal approved. */
  waitForApproval(name: string, opts?: { timeout?: Duration }): Promise<boolean>;
  /**
   * The current time as a journaled micro-step (guarantees §3): read once, replayed
   * verbatim, so branching on it is deterministic across replays.
   */
  now(): Promise<number>;
  /**
   * A random number in [0, 1) as a journaled micro-step (guarantees §3): drawn once,
   * replayed verbatim, so branching on it is deterministic across replays.
   */
  random(): Promise<number>;
  deriveKey(...parts: unknown[]): string;
  maxIterations(n: number): number;
}

export type TaskHandler<I, O> = (ctx: Context, input: I) => Promise<O>;

export interface TaskRegistration {
  handler: TaskHandler<unknown, unknown>;
  budget?: number;
}

export interface RunState {
  id: string;
  name: string;
  status: WorkflowStatus;
  input: unknown;
  output: unknown;
  error: SerializedError | null;
  steps: StepRow[];
}
