// Postgres schema. JSON as JSONB; epoch-ms timestamps + seq as BIGINT/INTEGER.
// CREATE ... IF NOT EXISTS makes init() idempotent (guarantees §11).

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workflows (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  status            TEXT NOT NULL,
  input             JSONB,
  output            JSONB,
  error             JSONB,
  idempotency_key   TEXT UNIQUE,
  version           INTEGER NOT NULL DEFAULT 1,
  seq_counter       INTEGER NOT NULL DEFAULT 0,
  recovery_attempts INTEGER NOT NULL DEFAULT 0,
  wake_at           BIGINT,
  wait_event        TEXT,
  locked_by         TEXT,
  lease_epoch       INTEGER NOT NULL DEFAULT 0,
  lease_expires_at  BIGINT,
  heartbeat_at      BIGINT,
  cancel_requested  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL
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
  output       JSONB,
  error        JSONB,
  attempts     INTEGER NOT NULL DEFAULT 1,
  cost         INTEGER NOT NULL DEFAULT 0,
  created_at   BIGINT NOT NULL,
  completed_at BIGINT NOT NULL,
  UNIQUE(workflow_id, step_key)
);
CREATE INDEX IF NOT EXISTS idx_steps_workflow ON steps(workflow_id, seq);

CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  workflow_id  TEXT NOT NULL REFERENCES workflows(id),
  name         TEXT NOT NULL,
  payload      JSONB,
  created_at   BIGINT NOT NULL,
  consumed_at  BIGINT
);
CREATE INDEX IF NOT EXISTS idx_events_lookup ON events(workflow_id, name, consumed_at);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);
`;

export const SCHEMA_VERSION = 1;
