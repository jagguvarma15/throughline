import { SqliteStore } from "./store";
import type { SqliteStoreOptions } from "./store";

/** Create a SQLite-backed durable store. Use ":memory:" for ephemeral/test stores. */
export function sqlite(path = "throughline.db", opts?: SqliteStoreOptions): SqliteStore {
  return new SqliteStore(path, opts);
}

export { SqliteStore } from "./store";
export type { SqliteStoreOptions } from "./store";
