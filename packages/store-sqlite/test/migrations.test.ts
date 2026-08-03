import { describe, expect, it } from "vitest";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/schema";
import { SqliteStore } from "../src/store";

const version = (store: SqliteStore): number =>
  (store.db.prepare("SELECT version FROM schema_version").get() as { version: number }).version;

describe("sqlite migrations", () => {
  it("init on an empty database lands at the latest version, idempotently", async () => {
    const store = new SqliteStore(":memory:");
    await store.init();
    expect(version(store)).toBe(SCHEMA_VERSION);
    await store.init();
    const rows = store.db.prepare("SELECT COUNT(*) AS c FROM schema_version").get() as {
      c: number;
    };
    expect(rows.c).toBe(1);
    store.close();
  });

  it("init on a v1 database applies only the missing migrations", async () => {
    const store = new SqliteStore(":memory:");
    const v1 = MIGRATIONS[0];
    if (!v1 || v1.version !== 1) throw new Error("expected migration v1");
    store.db.exec(v1.sql);
    store.db.prepare("INSERT INTO schema_version (version) VALUES (1)").run();
    const v2Index = () =>
      store.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_unconsumed'",
        )
        .get();
    expect(v2Index()).toBeUndefined();

    await store.init();
    expect(v2Index()).toBeTruthy();
    expect(version(store)).toBe(SCHEMA_VERSION);
    store.close();
  });

  it("init refuses a database newer than this store", async () => {
    const store = new SqliteStore(":memory:");
    store.db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    store.db.prepare("INSERT INTO schema_version (version) VALUES (99)").run();
    await expect(store.init()).rejects.toThrow(/v99/);
    store.close();
  });
});
