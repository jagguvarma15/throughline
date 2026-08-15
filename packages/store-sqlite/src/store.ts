import {
  type AppendStepInput,
  type AppendStepResult,
  type Clock,
  type ConsumeEventInput,
  DEFAULT_PRUNE_STATUSES,
  type Fence,
  type HeartbeatResult,
  LeaseLostError,
  type ListWorkflowsOptions,
  type NewWorkflow,
  type PruneOptions,
  type SerializedError,
  type StepRow,
  type Store,
  type StoreStats,
  TERMINAL_STATUSES,
  WorkflowNotFoundError,
  type WorkflowPatch,
  type WorkflowRow,
  type WorkflowStatus,
  systemClock,
  uuid,
} from "@through-line/core";
import Database from "better-sqlite3";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema";

type Db = Database.Database;
type Stmt = Database.Statement;

interface RawWf {
  id: string;
  name: string;
  status: string;
  input: string | null;
  output: string | null;
  error: string | null;
  idempotency_key: string | null;
  version: number;
  seq_counter: number;
  recovery_attempts: number;
  wake_at: number | null;
  wait_event: string | null;
  locked_by: string | null;
  lease_epoch: number;
  lease_expires_at: number | null;
  heartbeat_at: number | null;
  cancel_requested: number;
  created_at: number;
  updated_at: number;
}

interface RawStep {
  id: string;
  workflow_id: string;
  step_key: string;
  seq: number;
  status: string;
  kind: string;
  output: string | null;
  error: string | null;
  attempts: number;
  cost: number;
  created_at: number;
  completed_at: number;
}

interface RawEvent {
  id: string;
  workflow_id: string;
  name: string;
  payload: string | null;
  created_at: number;
  consumed_at: number | null;
}

const ser = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));
const deser = (t: string | null): unknown => (t == null ? undefined : JSON.parse(t));
const serErr = (e: SerializedError | null | undefined): string | null =>
  e == null ? null : JSON.stringify(e);
const deserErr = (t: string | null): SerializedError | null =>
  t == null ? null : (JSON.parse(t) as SerializedError);

function mapWorkflow(r: RawWf): WorkflowRow {
  return {
    id: r.id,
    name: r.name,
    status: r.status as WorkflowStatus,
    input: deser(r.input),
    output: deser(r.output),
    error: deserErr(r.error),
    idempotencyKey: r.idempotency_key,
    version: r.version,
    seqCounter: r.seq_counter,
    recoveryAttempts: r.recovery_attempts,
    wakeAt: r.wake_at,
    waitEvent: r.wait_event,
    lockedBy: r.locked_by,
    leaseEpoch: r.lease_epoch,
    leaseExpiresAt: r.lease_expires_at,
    heartbeatAt: r.heartbeat_at,
    cancelRequested: r.cancel_requested !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapStep(r: RawStep): StepRow {
  return {
    id: r.id,
    workflowId: r.workflow_id,
    stepKey: r.step_key,
    seq: r.seq,
    status: r.status as StepRow["status"],
    kind: r.kind as StepRow["kind"],
    output: deser(r.output),
    error: deserErr(r.error),
    attempts: r.attempts,
    cost: r.cost,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

const WF_COLUMN: Record<keyof WorkflowPatch, string> = {
  status: "status",
  output: "output",
  error: "error",
  wakeAt: "wake_at",
  waitEvent: "wait_event",
  lockedBy: "locked_by",
  leaseExpiresAt: "lease_expires_at",
  heartbeatAt: "heartbeat_at",
  recoveryAttempts: "recovery_attempts",
};

export interface SqliteStoreOptions {
  /** Clock for bookkeeping timestamps where `now` is not an argument. */
  clock?: Clock;
  idGen?: () => string;
}

export class SqliteStore implements Store {
  readonly db: Db;
  #clock: Clock;
  #id: () => string;
  #cache = new Map<string, Stmt>();

  constructor(path: string, opts: SqliteStoreOptions = {}) {
    this.db = new Database(path);
    this.#clock = opts.clock ?? systemClock;
    this.#id = opts.idGen ?? uuid;
  }

  #s(sql: string): Stmt {
    let s = this.#cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.#cache.set(sql, s);
    }
    return s;
  }

  async init(): Promise<void> {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    // Bootstrap the version table so the ladder can read where this database stands.
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    const tx = this.db.transaction((): void => {
      const row = this.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
        | { version: number }
        | undefined;
      const current = row?.version ?? 0;
      if (current > SCHEMA_VERSION) {
        throw new Error(
          `database schema is v${current} but this store only knows v${SCHEMA_VERSION}: upgrade @through-line/store-sqlite, or point it at an older database`,
        );
      }
      for (const m of MIGRATIONS) {
        if (m.version > current) this.db.exec(m.sql);
      }
      if (current === SCHEMA_VERSION) return;
      if (row) this.db.prepare("UPDATE schema_version SET version=?").run(SCHEMA_VERSION);
      else this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
    });
    tx.immediate();
  }

  async createWorkflow(rec: NewWorkflow): Promise<WorkflowRow> {
    const id = rec.id ?? this.#id();
    const key = rec.idempotencyKey ?? null;
    const tx = this.db.transaction((): RawWf => {
      if (key !== null) {
        const existing = this.#s("SELECT * FROM workflows WHERE idempotency_key=?").get(key) as
          | RawWf
          | undefined;
        if (existing) return existing;
      }
      this.#s(
        `INSERT INTO workflows (id, name, status, input, idempotency_key, version, seq_counter,
           recovery_attempts, lease_epoch, created_at, updated_at)
         VALUES (@id, @name, 'pending', @input, @key, 1, 0, 0, 0, @now, @now)`,
      ).run({ id, name: rec.name, input: ser(rec.input), key, now: rec.now });
      return this.#s("SELECT * FROM workflows WHERE id=?").get(id) as RawWf;
    });
    return mapWorkflow(tx.immediate());
  }

  async getWorkflow(id: string): Promise<WorkflowRow | null> {
    const r = this.#s("SELECT * FROM workflows WHERE id=?").get(id) as RawWf | undefined;
    return r ? mapWorkflow(r) : null;
  }

  async claim(workerId: string, leaseMs: number, now: number): Promise<WorkflowRow | null> {
    const tx = this.db.transaction((): RawWf | null => {
      // One targeted, index-backed probe per runnable predicate (a single OR query
      // cannot use any one index and degrades to a scan of every live row per poll).
      const winner = this.#s(
        `SELECT id FROM (
            SELECT * FROM (SELECT id, updated_at FROM workflows
              WHERE status='pending' ORDER BY updated_at ASC LIMIT 1)
            UNION ALL
            SELECT * FROM (SELECT id, updated_at FROM workflows
              WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < @now
              ORDER BY updated_at ASC LIMIT 1)
            UNION ALL
            SELECT * FROM (SELECT id, updated_at FROM workflows
              WHERE status='waiting' AND wake_at IS NOT NULL AND wake_at <= @now
              ORDER BY updated_at ASC LIMIT 1)
            UNION ALL
            SELECT * FROM (SELECT w.id, w.updated_at FROM workflows w
              WHERE w.status='waiting' AND w.wait_event IS NOT NULL AND EXISTS (
                SELECT 1 FROM events e
                WHERE e.workflow_id = w.id AND e.name = w.wait_event AND e.consumed_at IS NULL)
              ORDER BY w.updated_at ASC LIMIT 1)
          ) ORDER BY updated_at ASC LIMIT 1`,
      ).get({ now }) as { id: string } | undefined;
      if (!winner) return null;
      const candidate = this.#s("SELECT * FROM workflows WHERE id=?").get(winner.id) as RawWf;
      const recoveryDelta = candidate.status === "running" ? 1 : 0;
      this.#s(
        `UPDATE workflows
           SET status='running', locked_by=@workerId, lease_epoch=lease_epoch+1,
               lease_expires_at=@expires, heartbeat_at=@now,
               recovery_attempts=recovery_attempts+@delta, updated_at=@now
         WHERE id=@id`,
      ).run({ id: candidate.id, workerId, expires: now + leaseMs, now, delta: recoveryDelta });
      return this.#s("SELECT * FROM workflows WHERE id=?").get(candidate.id) as RawWf;
    });
    const claimed = tx.immediate();
    return claimed ? mapWorkflow(claimed) : null;
  }

  async heartbeat(id: string, fence: Fence, leaseMs: number, now: number): Promise<HeartbeatResult> {
    const row = this.#s(
      `UPDATE workflows SET lease_expires_at=@expires, heartbeat_at=@now, updated_at=@now
       WHERE id=@id AND locked_by=@workerId AND lease_epoch=@epoch
       RETURNING cancel_requested`,
    ).get({ id, expires: now + leaseMs, now, workerId: fence.workerId, epoch: fence.leaseEpoch }) as
      | { cancel_requested: number }
      | undefined;
    if (!row) throw new LeaseLostError(id);
    return { cancelRequested: row.cancel_requested !== 0 };
  }

  async loadJournal(workflowId: string): Promise<StepRow[]> {
    const rows = this.#s("SELECT * FROM steps WHERE workflow_id=? ORDER BY seq ASC").all(
      workflowId,
    ) as RawStep[];
    return rows.map(mapStep);
  }

  async appendStep(step: AppendStepInput): Promise<AppendStepResult> {
    const tx = this.db.transaction((): AppendStepResult => {
      // The cancel flag rides along with the fence read: same row, same transaction,
      // zero extra queries (guarantees §9).
      const wf = this.#s(
        "SELECT seq_counter, lease_epoch, locked_by, cancel_requested FROM workflows WHERE id=?",
      ).get(step.workflowId) as
        | {
            seq_counter: number;
            lease_epoch: number;
            locked_by: string | null;
            cancel_requested: number;
          }
        | undefined;
      if (!wf) throw new WorkflowNotFoundError(step.workflowId);
      if (
        step.fence &&
        (wf.locked_by !== step.fence.workerId || wf.lease_epoch !== step.fence.leaseEpoch)
      ) {
        throw new LeaseLostError(step.workflowId);
      }
      const cancelRequested = wf.cancel_requested !== 0;
      const existing = this.#s(
        "SELECT id, seq, status FROM steps WHERE workflow_id=? AND step_key=?",
      ).get(step.workflowId, step.stepKey) as
        | { id: string; seq: number; status: string }
        | undefined;
      if (existing) {
        if (existing.status === "completed") {
          return { seq: existing.seq, replayed: true, cancelRequested };
        }
        // failed -> update to the new terminal state, preserving seq
        this.#s(
          `UPDATE steps SET status=@status, kind=@kind, output=@output, error=@error,
             attempts=@attempts, cost=@cost, completed_at=@now WHERE id=@id`,
        ).run({
          id: existing.id,
          status: step.status,
          kind: step.kind ?? "step",
          output: ser(step.output),
          error: serErr(step.error),
          attempts: step.attempts,
          cost: step.cost ?? 0,
          now: step.now,
        });
        return { seq: existing.seq, replayed: false, cancelRequested };
      }
      const seq = wf.seq_counter;
      this.#s("UPDATE workflows SET seq_counter=seq_counter+1, updated_at=@now WHERE id=@id").run({
        id: step.workflowId,
        now: step.now,
      });
      this.#s(
        `INSERT INTO steps (id, workflow_id, step_key, seq, status, kind, output, error,
           attempts, cost, created_at, completed_at)
         VALUES (@id, @wf, @key, @seq, @status, @kind, @output, @error, @attempts, @cost, @now, @now)`,
      ).run({
        id: this.#id(),
        wf: step.workflowId,
        key: step.stepKey,
        seq,
        status: step.status,
        kind: step.kind ?? "step",
        output: ser(step.output),
        error: serErr(step.error),
        attempts: step.attempts,
        cost: step.cost ?? 0,
        now: step.now,
      });
      return { seq, replayed: false, cancelRequested };
    });
    return tx.immediate();
  }

  async updateWorkflow(id: string, patch: WorkflowPatch, fence?: Fence): Promise<void> {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id, now: this.#clock.now() };
    for (const [k, v] of Object.entries(patch)) {
      const col = WF_COLUMN[k as keyof WorkflowPatch];
      if (!col) continue;
      let val: unknown = v;
      if (k === "output") val = ser(v);
      else if (k === "error") val = v == null ? null : JSON.stringify(v);
      sets.push(`${col}=@${k}`);
      params[k] = val ?? null;
    }
    sets.push("updated_at=@now");
    let sql = `UPDATE workflows SET ${sets.join(", ")} WHERE id=@id`;
    if (fence) {
      sql += " AND locked_by=@workerId AND lease_epoch=@epoch";
      params.workerId = fence.workerId;
      params.epoch = fence.leaseEpoch;
    }
    const res = this.#s(sql).run(params);
    if (fence && res.changes === 0) throw new LeaseLostError(id);
  }

  async addEvent(workflowId: string, name: string, payload: unknown, now: number): Promise<void> {
    this.#s(
      `INSERT INTO events (id, workflow_id, name, payload, created_at, consumed_at)
       VALUES (@id, @wf, @name, @payload, @now, NULL)`,
    ).run({ id: this.#id(), wf: workflowId, name, payload: ser(payload), now });
  }

  async consumeEventIntoJournal(
    args: ConsumeEventInput,
  ): Promise<{ found: true; payload: unknown; seq: number } | { found: false }> {
    const tx = this.db.transaction(
      (): { found: true; payload: unknown; seq: number } | { found: false } => {
        const wf = this.#s(
          "SELECT seq_counter, lease_epoch, locked_by FROM workflows WHERE id=?",
        ).get(args.workflowId) as
          | { seq_counter: number; lease_epoch: number; locked_by: string | null }
          | undefined;
        if (!wf) throw new WorkflowNotFoundError(args.workflowId);
        if (
          args.fence &&
          (wf.locked_by !== args.fence.workerId || wf.lease_epoch !== args.fence.leaseEpoch)
        ) {
          throw new LeaseLostError(args.workflowId);
        }
        const existing = this.#s(
          "SELECT seq, status, output FROM steps WHERE workflow_id=? AND step_key=?",
        ).get(args.workflowId, args.stepKey) as
          | { seq: number; status: string; output: string | null }
          | undefined;
        if (existing && existing.status === "completed") {
          return { found: true, payload: deser(existing.output), seq: existing.seq };
        }
        const ev = this.#s(
          `SELECT * FROM events WHERE workflow_id=? AND name=? AND consumed_at IS NULL
           ORDER BY created_at ASC LIMIT 1`,
        ).get(args.workflowId, args.name) as RawEvent | undefined;
        if (!ev) return { found: false };
        this.#s("UPDATE events SET consumed_at=? WHERE id=?").run(args.now, ev.id);
        const seq = existing ? existing.seq : wf.seq_counter;
        if (!existing) {
          this.#s(
            "UPDATE workflows SET seq_counter=seq_counter+1, updated_at=@now WHERE id=@id",
          ).run({ id: args.workflowId, now: args.now });
          this.#s(
            `INSERT INTO steps (id, workflow_id, step_key, seq, status, kind, output, error,
               attempts, cost, created_at, completed_at)
             VALUES (@id, @wf, @key, @seq, 'completed', 'event', @output, NULL, 1, 0, @now, @now)`,
          ).run({
            id: this.#id(),
            wf: args.workflowId,
            key: args.stepKey,
            seq,
            output: ev.payload,
            now: args.now,
          });
        } else {
          this.#s(
            `UPDATE steps SET status='completed', kind='event', output=@output, error=NULL,
               completed_at=@now WHERE workflow_id=@wf AND step_key=@key`,
          ).run({ output: ev.payload, now: args.now, wf: args.workflowId, key: args.stepKey });
        }
        return { found: true, payload: deser(ev.payload), seq };
      },
    );
    return tx.immediate();
  }

  async listWorkflows(opts: ListWorkflowsOptions = {}): Promise<WorkflowRow[]> {
    const params: Record<string, unknown> = { limit: opts.limit ?? 100, offset: opts.offset ?? 0 };
    let sql = "SELECT * FROM workflows";
    if (opts.status) {
      sql += " WHERE status=@status";
      params.status = opts.status;
    }
    sql += " ORDER BY created_at DESC LIMIT @limit OFFSET @offset";
    return (this.#s(sql).all(params) as RawWf[]).map(mapWorkflow);
  }

  async stats(): Promise<StoreStats> {
    const workflowsByStatus: Record<string, number> = {};
    const rows = this.#s(
      "SELECT status, COUNT(*) AS c FROM workflows GROUP BY status",
    ).all() as Array<{
      status: string;
      c: number;
    }>;
    for (const r of rows) workflowsByStatus[r.status] = r.c;
    const stepCount = (this.#s("SELECT COUNT(*) AS c FROM steps").get() as { c: number }).c;
    const failedStepCount = (
      this.#s("SELECT COUNT(*) AS c FROM steps WHERE status='failed'").get() as { c: number }
    ).c;
    const tokenSum = (
      this.#s("SELECT COALESCE(SUM(cost), 0) AS s FROM steps").get() as { s: number }
    ).s;
    const maxRecoveryAttempts = (
      this.#s(
        `SELECT COALESCE(MAX(recovery_attempts), 0) AS m FROM workflows
         WHERE status IN ('pending','running','waiting')`,
      ).get() as { m: number }
    ).m;
    return { workflowsByStatus, stepCount, failedStepCount, tokenSum, maxRecoveryAttempts };
  }

  async resetFailedSteps(workflowId: string): Promise<number> {
    const res = this.#s("UPDATE steps SET attempts=0 WHERE workflow_id=? AND status='failed'").run(
      workflowId,
    );
    return res.changes;
  }

  async pruneRuns(opts: PruneOptions): Promise<number> {
    const statuses = opts.statuses ?? DEFAULT_PRUNE_STATUSES;
    const nonTerminal = statuses.filter((s) => !TERMINAL_STATUSES.has(s));
    if (nonTerminal.length > 0) {
      throw new Error(`pruneRuns only deletes terminal runs; got: ${nonTerminal.join(", ")}`);
    }
    const limit = opts.limit ?? 1000;
    const cutoff = opts.now - opts.olderThanMs;
    const tx = this.db.transaction((): number => {
      const marks = statuses.map(() => "?").join(",");
      const ids = (
        this.db
          .prepare(`SELECT id FROM workflows WHERE status IN (${marks}) AND updated_at < ? LIMIT ?`)
          .all(...statuses, cutoff, limit) as Array<{ id: string }>
      ).map((r) => r.id);
      if (ids.length === 0) return 0;
      const idMarks = ids.map(() => "?").join(",");
      // Children first: the schema has plain REFERENCES, no ON DELETE CASCADE.
      this.db.prepare(`DELETE FROM steps WHERE workflow_id IN (${idMarks})`).run(...ids);
      this.db.prepare(`DELETE FROM events WHERE workflow_id IN (${idMarks})`).run(...ids);
      this.db.prepare(`DELETE FROM workflows WHERE id IN (${idMarks})`).run(...ids);
      return ids.length;
    });
    return tx.immediate();
  }

  async requestCancel(id: string, now: number): Promise<"cancelled" | "requested" | "noop"> {
    const tx = this.db.transaction((): "cancelled" | "requested" | "noop" => {
      const row = this.#s("SELECT status FROM workflows WHERE id=?").get(id) as
        | { status: string }
        | undefined;
      if (!row) return "noop";
      if (row.status === "pending" || row.status === "waiting") {
        this.#s(
          `UPDATE workflows SET status='cancelled', wait_event=NULL, wake_at=NULL,
             locked_by=NULL, lease_expires_at=NULL, updated_at=@now WHERE id=@id`,
        ).run({ id, now });
        return "cancelled";
      }
      if (row.status === "running") {
        this.#s("UPDATE workflows SET cancel_requested=1, updated_at=@now WHERE id=@id").run({
          id,
          now,
        });
        return "requested";
      }
      return "noop";
    });
    return tx.immediate();
  }

  close(): void {
    this.db.close();
  }
}
