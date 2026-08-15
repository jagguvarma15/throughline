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
import pg from "pg";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema";

const { Pool } = pg;
type PgPool = pg.Pool;
type PgClient = pg.PoolClient;

interface RawWf {
  id: string;
  name: string;
  status: string;
  input: unknown;
  output: unknown;
  error: unknown;
  idempotency_key: string | null;
  version: number;
  seq_counter: number;
  recovery_attempts: number;
  wake_at: string | null;
  wait_event: string | null;
  locked_by: string | null;
  lease_epoch: number;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
}

interface RawStep {
  id: string;
  workflow_id: string;
  step_key: string;
  seq: number;
  status: string;
  kind: string;
  output: unknown;
  error: unknown;
  attempts: number;
  cost: number;
  created_at: string;
  completed_at: string;
}

interface RawEvent {
  id: string;
  workflow_id: string;
  name: string;
  payload: unknown;
  created_at: string;
  consumed_at: string | null;
}

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));
// JSONB read: pg already parses; normalize SQL NULL to undefined (matches store-sqlite).
const j = (v: unknown): unknown => (v === null ? undefined : v);
const jErr = (v: unknown): SerializedError | null => (v == null ? null : (v as SerializedError));
// JSONB write: stringify (undefined -> SQL NULL); paired with a ::jsonb cast.
const ser = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));

function mapWorkflow(r: RawWf): WorkflowRow {
  return {
    id: r.id,
    name: r.name,
    status: r.status as WorkflowStatus,
    input: j(r.input),
    output: j(r.output),
    error: jErr(r.error),
    idempotencyKey: r.idempotency_key,
    version: r.version,
    seqCounter: r.seq_counter,
    recoveryAttempts: r.recovery_attempts,
    wakeAt: num(r.wake_at),
    waitEvent: r.wait_event,
    lockedBy: r.locked_by,
    leaseEpoch: r.lease_epoch,
    leaseExpiresAt: num(r.lease_expires_at),
    heartbeatAt: num(r.heartbeat_at),
    cancelRequested: r.cancel_requested,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
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
    output: j(r.output),
    error: jErr(r.error),
    attempts: r.attempts,
    cost: r.cost,
    createdAt: Number(r.created_at),
    completedAt: Number(r.completed_at),
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

export interface PostgresStoreOptions {
  clock?: Clock;
  idGen?: () => string;
}

/** NOTIFY channel poked whenever a workflow may have become claimable. */
const WAKE_CHANNEL = "throughline_wake";

export class PostgresStore implements Store {
  #pool: PgPool;
  #ownsPool: boolean;
  #clock: Clock;
  #id: () => string;
  #wakeListeners = new Set<() => void>();
  #listenClient: PgClient | null = null;
  #listenSetup: Promise<void> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectDelayMs = 1000;
  #closed = false;

  constructor(poolOrUrl: PgPool | string, opts: PostgresStoreOptions = {}) {
    if (typeof poolOrUrl === "string") {
      this.#pool = new Pool({ connectionString: poolOrUrl, max: 4 });
      this.#ownsPool = true;
    } else {
      this.#pool = poolOrUrl;
      this.#ownsPool = false;
    }
    this.#clock = opts.clock ?? systemClock;
    this.#id = opts.idGen ?? uuid;
  }

  get pool(): PgPool {
    return this.#pool;
  }

  async #tx<T>(fn: (c: PgClient) => Promise<T>): Promise<T> {
    const c = await this.#pool.connect();
    try {
      await c.query("BEGIN");
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  async init(): Promise<void> {
    // Bootstrap the version table so the ladder can read where this database stands.
    await this.#pool.query("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    await this.#tx(async (c) => {
      const r = await c.query<{ version: number }>(
        "SELECT version FROM schema_version LIMIT 1 FOR UPDATE",
      );
      const current = r.rows[0]?.version ?? 0;
      if (current > SCHEMA_VERSION) {
        throw new Error(
          `database schema is v${current} but this store only knows v${SCHEMA_VERSION}: upgrade @through-line/store-postgres, or point it at an older database`,
        );
      }
      for (const m of MIGRATIONS) {
        if (m.version > current) await c.query(m.sql);
      }
      if (current === SCHEMA_VERSION) return;
      if (r.rows[0]) await c.query("UPDATE schema_version SET version=$1", [SCHEMA_VERSION]);
      else await c.query("INSERT INTO schema_version (version) VALUES ($1)", [SCHEMA_VERSION]);
    });
  }

  /** Test helper: drop all rows. Not part of the Store interface; never called by init(). */
  async reset(): Promise<void> {
    await this.#pool.query("TRUNCATE steps, events, workflows RESTART IDENTITY CASCADE");
  }

  async createWorkflow(rec: NewWorkflow): Promise<WorkflowRow> {
    const id = rec.id ?? this.#id();
    const key = rec.idempotencyKey ?? null;
    return this.#tx(async (c) => {
      if (key !== null) {
        const ex = await c.query<RawWf>("SELECT * FROM workflows WHERE idempotency_key=$1", [key]);
        if (ex.rows[0]) return mapWorkflow(ex.rows[0]);
      }
      const ins = await c.query<RawWf>(
        `INSERT INTO workflows (id, name, status, input, idempotency_key, version, seq_counter,
           recovery_attempts, lease_epoch, created_at, updated_at)
         VALUES ($1, $2, 'pending', $3::jsonb, $4, 1, 0, 0, 0, $5, $5)
         RETURNING *`,
        [id, rec.name, ser(rec.input), key, rec.now],
      );
      // Delivered on commit (transactional NOTIFY), so a woken worker always sees the row.
      await c.query(`SELECT pg_notify('${WAKE_CHANNEL}', '')`);
      return mapWorkflow(ins.rows[0] as RawWf);
    });
  }

  async getWorkflow(id: string): Promise<WorkflowRow | null> {
    const r = await this.#pool.query<RawWf>("SELECT * FROM workflows WHERE id=$1", [id]);
    return r.rows[0] ? mapWorkflow(r.rows[0]) : null;
  }

  async claim(workerId: string, leaseMs: number, now: number): Promise<WorkflowRow | null> {
    return this.#tx(async (c) => {
      // One targeted, index-backed probe per runnable predicate (a single OR query
      // cannot use any one index and degrades to a scan of every live row per poll).
      // Each branch locks its candidate with SKIP LOCKED, so concurrent workers pick
      // disjoint candidates instead of colliding on one winner.
      const sel = await c.query<{ id: string }>(
        `SELECT id FROM (
            SELECT * FROM (SELECT id, updated_at FROM workflows
              WHERE status='pending'
              ORDER BY updated_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED) b1
            UNION ALL
            SELECT * FROM (SELECT id, updated_at FROM workflows
              WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < $1
              ORDER BY updated_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED) b2
            UNION ALL
            SELECT * FROM (SELECT id, updated_at FROM workflows
              WHERE status='waiting' AND wake_at IS NOT NULL AND wake_at <= $1
              ORDER BY updated_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED) b3
            UNION ALL
            SELECT * FROM (SELECT w.id, w.updated_at FROM workflows w
              WHERE w.status='waiting' AND w.wait_event IS NOT NULL AND EXISTS (
                SELECT 1 FROM events e
                WHERE e.workflow_id = w.id AND e.name = w.wait_event AND e.consumed_at IS NULL)
              ORDER BY w.updated_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED) b4
          ) c ORDER BY updated_at ASC LIMIT 1`,
        [now],
      );
      const winnerId = sel.rows[0]?.id;
      if (!winnerId) return null;
      const full = await c.query<RawWf>("SELECT * FROM workflows WHERE id=$1", [winnerId]);
      const candidate = full.rows[0];
      if (!candidate) return null;
      const delta = candidate.status === "running" ? 1 : 0;
      const upd = await c.query<RawWf>(
        `UPDATE workflows
           SET status='running', locked_by=$2, lease_epoch=lease_epoch+1,
               lease_expires_at=$3, heartbeat_at=$4, recovery_attempts=recovery_attempts+$5,
               updated_at=$4
         WHERE id=$1
         RETURNING *`,
        [candidate.id, workerId, now + leaseMs, now, delta],
      );
      return mapWorkflow(upd.rows[0] as RawWf);
    });
  }

  async heartbeat(
    id: string,
    fence: Fence,
    leaseMs: number,
    now: number,
  ): Promise<HeartbeatResult> {
    const r = await this.#pool.query<{ cancel_requested: boolean }>(
      `UPDATE workflows SET lease_expires_at=$1, heartbeat_at=$2, updated_at=$2
       WHERE id=$3 AND locked_by=$4 AND lease_epoch=$5
       RETURNING cancel_requested`,
      [now + leaseMs, now, id, fence.workerId, fence.leaseEpoch],
    );
    const row = r.rows[0];
    if (!row) throw new LeaseLostError(id);
    return { cancelRequested: row.cancel_requested };
  }

  async loadJournal(workflowId: string): Promise<StepRow[]> {
    const r = await this.#pool.query<RawStep>(
      "SELECT * FROM steps WHERE workflow_id=$1 ORDER BY seq ASC",
      [workflowId],
    );
    return r.rows.map(mapStep);
  }

  async appendStep(step: AppendStepInput): Promise<AppendStepResult> {
    return this.#tx(async (c) => {
      // The cancel flag rides along with the fence read: same locked row, same
      // transaction, zero extra queries (guarantees §9).
      const wfRes = await c.query<{
        seq_counter: number;
        lease_epoch: number;
        locked_by: string | null;
        cancel_requested: boolean;
      }>(
        `SELECT seq_counter, lease_epoch, locked_by, cancel_requested
         FROM workflows WHERE id=$1 FOR UPDATE`,
        [step.workflowId],
      );
      const wf = wfRes.rows[0];
      if (!wf) throw new WorkflowNotFoundError(step.workflowId);
      if (
        step.fence &&
        (wf.locked_by !== step.fence.workerId || wf.lease_epoch !== step.fence.leaseEpoch)
      ) {
        throw new LeaseLostError(step.workflowId);
      }
      const cancelRequested = wf.cancel_requested;
      const exRes = await c.query<{ seq: number; status: string }>(
        "SELECT seq, status FROM steps WHERE workflow_id=$1 AND step_key=$2",
        [step.workflowId, step.stepKey],
      );
      const existing = exRes.rows[0];
      if (existing) {
        if (existing.status === "completed") {
          return { seq: existing.seq, replayed: true, cancelRequested };
        }
        await c.query(
          `UPDATE steps SET status=$1, kind=$2, output=$3::jsonb, error=$4::jsonb,
             attempts=$5, cost=$6, completed_at=$7 WHERE workflow_id=$8 AND step_key=$9`,
          [
            step.status,
            step.kind ?? "step",
            ser(step.output),
            ser(step.error),
            step.attempts,
            step.cost ?? 0,
            step.now,
            step.workflowId,
            step.stepKey,
          ],
        );
        return { seq: existing.seq, replayed: false, cancelRequested };
      }
      const seq = wf.seq_counter;
      await c.query("UPDATE workflows SET seq_counter=seq_counter+1, updated_at=$2 WHERE id=$1", [
        step.workflowId,
        step.now,
      ]);
      await c.query(
        `INSERT INTO steps (id, workflow_id, step_key, seq, status, kind, output, error,
           attempts, cost, created_at, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$11)`,
        [
          this.#id(),
          step.workflowId,
          step.stepKey,
          seq,
          step.status,
          step.kind ?? "step",
          ser(step.output),
          ser(step.error),
          step.attempts,
          step.cost ?? 0,
          step.now,
        ],
      );
      return { seq, replayed: false, cancelRequested };
    });
  }

  async updateWorkflow(id: string, patch: WorkflowPatch, fence?: Fence): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(patch)) {
      const col = WF_COLUMN[k as keyof WorkflowPatch];
      if (!col) continue;
      const isJson = k === "output" || k === "error";
      const val = isJson ? ser(v) : (v ?? null);
      sets.push(`${col}=$${i}${isJson ? "::jsonb" : ""}`);
      vals.push(val);
      i++;
    }
    sets.push(`updated_at=$${i}`);
    vals.push(this.#clock.now());
    i++;
    let sql = `UPDATE workflows SET ${sets.join(", ")} WHERE id=$${i}`;
    vals.push(id);
    i++;
    if (fence) {
      sql += ` AND locked_by=$${i} AND lease_epoch=$${i + 1}`;
      vals.push(fence.workerId, fence.leaseEpoch);
    }
    const r = await this.#pool.query(sql, vals);
    if (fence && r.rowCount === 0) throw new LeaseLostError(id);
    // A run patched back to pending (ops.retry redrive) is claimable again. The
    // notify is a follow-up statement, not atomic with the update; polling is the
    // correctness backstop if it is lost.
    if (patch.status === "pending" && (r.rowCount ?? 0) > 0) {
      await this.#pool.query(`SELECT pg_notify('${WAKE_CHANNEL}', '')`).catch(() => {});
    }
  }

  async addEvent(workflowId: string, name: string, payload: unknown, now: number): Promise<void> {
    // Single atomic statement: the notify fires only if the insert happened.
    await this.#pool.query(
      `WITH ins AS (
         INSERT INTO events (id, workflow_id, name, payload, created_at, consumed_at)
         VALUES ($1,$2,$3,$4::jsonb,$5,NULL)
         RETURNING id
       )
       SELECT pg_notify('${WAKE_CHANNEL}', '') FROM ins`,
      [this.#id(), workflowId, name, ser(payload), now],
    );
  }

  async consumeEventIntoJournal(
    args: ConsumeEventInput,
  ): Promise<{ found: true; payload: unknown; seq: number } | { found: false }> {
    return this.#tx(async (c) => {
      const wfRes = await c.query<{
        seq_counter: number;
        lease_epoch: number;
        locked_by: string | null;
      }>("SELECT seq_counter, lease_epoch, locked_by FROM workflows WHERE id=$1 FOR UPDATE", [
        args.workflowId,
      ]);
      const wf = wfRes.rows[0];
      if (!wf) throw new WorkflowNotFoundError(args.workflowId);
      if (
        args.fence &&
        (wf.locked_by !== args.fence.workerId || wf.lease_epoch !== args.fence.leaseEpoch)
      ) {
        throw new LeaseLostError(args.workflowId);
      }
      const exRes = await c.query<{ seq: number; status: string; output: unknown }>(
        "SELECT seq, status, output FROM steps WHERE workflow_id=$1 AND step_key=$2",
        [args.workflowId, args.stepKey],
      );
      const existing = exRes.rows[0];
      if (existing && existing.status === "completed") {
        return { found: true as const, payload: j(existing.output), seq: existing.seq };
      }
      const evRes = await c.query<RawEvent>(
        `SELECT * FROM events WHERE workflow_id=$1 AND name=$2 AND consumed_at IS NULL
         ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [args.workflowId, args.name],
      );
      const ev = evRes.rows[0];
      if (!ev) return { found: false as const };
      await c.query("UPDATE events SET consumed_at=$1 WHERE id=$2", [args.now, ev.id]);
      const seq = existing ? existing.seq : wf.seq_counter;
      if (!existing) {
        await c.query("UPDATE workflows SET seq_counter=seq_counter+1, updated_at=$2 WHERE id=$1", [
          args.workflowId,
          args.now,
        ]);
        await c.query(
          `INSERT INTO steps (id, workflow_id, step_key, seq, status, kind, output, error,
             attempts, cost, created_at, completed_at)
           VALUES ($1,$2,$3,$4,'completed','event',$5::jsonb,NULL,1,0,$6,$6)`,
          [this.#id(), args.workflowId, args.stepKey, seq, ser(ev.payload), args.now],
        );
      } else {
        await c.query(
          `UPDATE steps SET status='completed', kind='event', output=$1::jsonb, error=NULL,
             completed_at=$2 WHERE workflow_id=$3 AND step_key=$4`,
          [ser(ev.payload), args.now, args.workflowId, args.stepKey],
        );
      }
      return { found: true as const, payload: j(ev.payload), seq };
    });
  }

  async listWorkflows(opts: ListWorkflowsOptions = {}): Promise<WorkflowRow[]> {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    if (opts.status) {
      const r = await this.#pool.query<RawWf>(
        "SELECT * FROM workflows WHERE status=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
        [opts.status, limit, offset],
      );
      return r.rows.map(mapWorkflow);
    }
    const r = await this.#pool.query<RawWf>(
      "SELECT * FROM workflows ORDER BY created_at DESC LIMIT $1 OFFSET $2",
      [limit, offset],
    );
    return r.rows.map(mapWorkflow);
  }

  async stats(): Promise<StoreStats> {
    const workflowsByStatus: Record<string, number> = {};
    const s = await this.#pool.query<{ status: string; c: number }>(
      "SELECT status, COUNT(*)::int AS c FROM workflows GROUP BY status",
    );
    for (const r of s.rows) workflowsByStatus[r.status] = Number(r.c);
    const sc = await this.#pool.query<{ c: number }>("SELECT COUNT(*)::int AS c FROM steps");
    const fc = await this.#pool.query<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM steps WHERE status='failed'",
    );
    // bigint, not int: a token counter passes 2^31 quickly; pg returns it as a string.
    const tk = await this.#pool.query<{ s: string | number }>(
      "SELECT COALESCE(SUM(cost), 0)::bigint AS s FROM steps",
    );
    const mr = await this.#pool.query<{ m: number }>(
      `SELECT COALESCE(MAX(recovery_attempts), 0)::int AS m FROM workflows
       WHERE status IN ('pending','running','waiting')`,
    );
    return {
      workflowsByStatus,
      stepCount: Number(sc.rows[0]?.c ?? 0),
      failedStepCount: Number(fc.rows[0]?.c ?? 0),
      tokenSum: Number(tk.rows[0]?.s ?? 0),
      maxRecoveryAttempts: Number(mr.rows[0]?.m ?? 0),
    };
  }

  async resetFailedSteps(workflowId: string): Promise<number> {
    const r = await this.#pool.query(
      "UPDATE steps SET attempts=0 WHERE workflow_id=$1 AND status='failed'",
      [workflowId],
    );
    return r.rowCount ?? 0;
  }

  async pruneRuns(opts: PruneOptions): Promise<number> {
    const statuses = opts.statuses ?? DEFAULT_PRUNE_STATUSES;
    const nonTerminal = statuses.filter((s) => !TERMINAL_STATUSES.has(s));
    if (nonTerminal.length > 0) {
      throw new Error(`pruneRuns only deletes terminal runs; got: ${nonTerminal.join(", ")}`);
    }
    const limit = opts.limit ?? 1000;
    const cutoff = opts.now - opts.olderThanMs;
    return this.#tx(async (c) => {
      const sel = await c.query<{ id: string }>(
        `SELECT id FROM workflows WHERE status = ANY($1) AND updated_at < $2
         LIMIT $3 FOR UPDATE SKIP LOCKED`,
        [statuses, cutoff, limit],
      );
      const ids = sel.rows.map((r) => r.id);
      if (ids.length === 0) return 0;
      // Children first: the schema has plain REFERENCES, no ON DELETE CASCADE.
      await c.query("DELETE FROM steps WHERE workflow_id = ANY($1)", [ids]);
      await c.query("DELETE FROM events WHERE workflow_id = ANY($1)", [ids]);
      await c.query("DELETE FROM workflows WHERE id = ANY($1)", [ids]);
      return ids.length;
    });
  }

  async requestCancel(id: string, now: number): Promise<"cancelled" | "requested" | "noop"> {
    return this.#tx(async (c) => {
      const r = await c.query<{ status: string }>(
        "SELECT status FROM workflows WHERE id=$1 FOR UPDATE",
        [id],
      );
      const row = r.rows[0];
      if (!row) return "noop";
      if (row.status === "pending" || row.status === "waiting") {
        await c.query(
          `UPDATE workflows SET status='cancelled', wait_event=NULL, wake_at=NULL,
             locked_by=NULL, lease_expires_at=NULL, updated_at=$2 WHERE id=$1`,
          [id, now],
        );
        return "cancelled";
      }
      if (row.status === "running") {
        await c.query("UPDATE workflows SET cancel_requested=TRUE, updated_at=$2 WHERE id=$1", [
          id,
          now,
        ]);
        return "requested";
      }
      return "noop";
    });
  }

  /**
   * LISTEN-based push wakeups (optional Store capability). Holds one dedicated
   * client from the pool while subscribers exist and reconnects with capped
   * backoff if that connection drops. Best-effort by design: any failure here
   * only costs wake latency, because workers keep polling regardless.
   */
  async subscribeWake(listener: () => void): Promise<() => Promise<void>> {
    this.#wakeListeners.add(listener);
    try {
      await this.#ensureListening();
    } catch (e) {
      this.#wakeListeners.delete(listener);
      throw e;
    }
    return async () => {
      this.#wakeListeners.delete(listener);
      if (this.#wakeListeners.size === 0) await this.#teardownListener();
    };
  }

  async #ensureListening(): Promise<void> {
    if (this.#closed || this.#listenClient || this.#wakeListeners.size === 0) return;
    if (!this.#listenSetup) {
      this.#listenSetup = (async () => {
        const c = await this.#pool.connect();
        try {
          await c.query(`LISTEN ${WAKE_CHANNEL}`);
        } catch (e) {
          c.release(true);
          throw e;
        }
        c.on("notification", () => {
          for (const l of this.#wakeListeners) l();
        });
        c.on("error", () => this.#restartListener());
        this.#listenClient = c;
      })();
    }
    try {
      await this.#listenSetup;
    } finally {
      this.#listenSetup = null;
    }
  }

  #restartListener(): void {
    const c = this.#listenClient;
    this.#listenClient = null;
    if (c) {
      c.removeAllListeners("notification");
      c.removeAllListeners("error");
      try {
        c.release(true);
      } catch {
        // Already released.
      }
    }
    if (this.#closed || this.#wakeListeners.size === 0 || this.#reconnectTimer) return;
    const delay = this.#reconnectDelayMs;
    this.#reconnectDelayMs = Math.min(delay * 2, 30_000);
    const timer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#ensureListening()
        .then(() => {
          this.#reconnectDelayMs = 1000;
          // Poke subscribers once: anything notified during the gap was lost.
          for (const l of this.#wakeListeners) l();
        })
        .catch(() => this.#restartListener());
    }, delay);
    timer.unref?.();
    this.#reconnectTimer = timer;
  }

  async #teardownListener(): Promise<void> {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const c = this.#listenClient;
    this.#listenClient = null;
    if (!c) return;
    c.removeAllListeners("notification");
    c.removeAllListeners("error");
    try {
      await c.query("UNLISTEN *");
      c.release();
    } catch {
      try {
        c.release(true);
      } catch {
        // Already released.
      }
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#teardownListener();
    if (this.#ownsPool) await this.#pool.end();
  }
}
