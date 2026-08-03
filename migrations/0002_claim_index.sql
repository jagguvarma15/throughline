-- Throughline migration v2: partial index for the worker claim query.
-- Mirrors packages/store-postgres/src/schema.ts. The claim query filters on live
-- statuses and sorts by updated_at; this keeps its cost tracking the number of live
-- runs instead of total table size. Idempotent; safe to apply repeatedly.

CREATE INDEX IF NOT EXISTS idx_workflows_runnable ON workflows(updated_at)
  WHERE status IN ('pending','running','waiting');
