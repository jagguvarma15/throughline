import type { SerializedError } from "./errors";

// ---------------------------------------------------------------------------
// Persistence rows (see docs/guarantees.md §11 and the store schema)
// ---------------------------------------------------------------------------

export type WorkflowStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "dead"
  | "cancelled";

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
  /** Consume one unconsumed event by name (marks consumed_at). */
  takeEvent(workflowId: string, name: string, now: number): Promise<EventRow | null>;
  /**
   * Atomically consume a matching unconsumed event AND journal its payload as a step,
   * in one transaction (guarantees §7). If a journal entry already exists for stepKey,
   * returns it (consumed:false). If no event is available, returns { found:false }.
   */
  consumeEventIntoJournal(
    args: ConsumeEventInput,
  ): Promise<{ found: true; payload: unknown; seq: number } | { found: false }>;
  releaseLease(id: string, fence?: Fence): Promise<void>;
  close(): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Engine-facing types
// ---------------------------------------------------------------------------

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

export interface StepOptions {
  retry?: Partial<RetryPolicy>;
  idempotencyKey?: string;
  kind?: StepKind;
  /** A-priori token cost for this step: `estimate` gates BEFORE fn, `cost` is charged after. */
  budget?: { estimate?: number; cost?: number };
}

export interface Context {
  readonly runId: string;
  readonly attempt: number;
  readonly logger: Logger;
  readonly tokens: TokenBudget;
  step<T>(name: string, fn: () => Promise<T>, opts?: StepOptions): Promise<T>;
  deriveKey(...parts: unknown[]): string;
  maxIterations(n: number): number;
}

export type TaskHandler<I, O> = (ctx: Context, input: I) => Promise<O>;

export interface RunState {
  id: string;
  name: string;
  status: WorkflowStatus;
  input: unknown;
  output: unknown;
  error: SerializedError | null;
  steps: StepRow[];
}
