import type { Pool } from "pg";
import { PostgresStore } from "./store";
import type { PostgresStoreOptions } from "./store";

/** Create a Postgres-backed durable store from a connection string or an existing pg Pool. */
export function postgres(poolOrUrl: Pool | string, opts?: PostgresStoreOptions): PostgresStore {
  return new PostgresStore(poolOrUrl, opts);
}

export { PostgresStore } from "./store";
export type { PostgresStoreOptions } from "./store";
