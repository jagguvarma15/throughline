// SQLite schema. All timestamps are epoch-ms integers; JSON is stored as TEXT.
// CREATE ... IF NOT EXISTS makes init() idempotent (guarantees §11).

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workflows (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  status            TEXT NOT NULL,
  input             TEXT,
  output            TEXT,
  error             TEXT,
  idempotency_key   TEXT UNIQUE,
  version           INTEGER NOT NULL DEFAULT 1,
  seq_counter       INTEGER NOT NULL DEFAULT 0,
  recovery_attempts INTEGER NOT NULL DEFAULT 0,
  wake_at           INTEGER,
  wait_event        TEXT,
  locked_by         TEXT,
  lease_epoch       INTEGER NOT NULL DEFAULT 0,
  lease_expires_at  INTEGER,
  heartbeat_at      INTEGER,
  cancel_requested  INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflows_status_wake  ON workflows(status, wake_at);
CREATE INDEX IF NOT EXISTS idx_workflows_status_lease ON workflows(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_workflows_wait_event   ON workflows(wait_event);

CREATE TABLE IF NOT EXISTS steps (
  id           TEXT PRIMARY KEY,
  workflow_id  TEXT NOT NULL REFERENCES workflows(id),
  step_key     TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  status       TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'step',
  output       TEXT,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 1,
  cost         INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  UNIQUE(workflow_id, step_key)
);
CREATE INDEX IF NOT EXISTS idx_steps_workflow ON steps(workflow_id, seq);

CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  workflow_id  TEXT NOT NULL REFERENCES workflows(id),
  name         TEXT NOT NULL,
  payload      TEXT,
  created_at   INTEGER NOT NULL,
  consumed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_lookup ON events(workflow_id, name, consumed_at);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);
`;

export const SCHEMA_VERSION = 1;
