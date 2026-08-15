import { type StoreFactory, defineEngineSuite, defineStoreSuite } from "@through-line/testing";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { postgres } from "../src/index";
import { SCHEMA_VERSION } from "../src/schema";

// Runs the shared store + engine suites against Postgres. Skips cleanly when no
// Postgres is reachable (set THROUGHLINE_TEST_PG, or run `docker compose up postgres`).
const url =
  process.env.THROUGHLINE_TEST_PG ??
  "postgres://throughline:throughline@localhost:5444/throughline";

let pool: pg.Pool | undefined;
let available = false;
try {
  const probe = new pg.Pool({ connectionString: url, max: 1 });
  await probe.query("SELECT 1");
  await probe.end();
  pool = new pg.Pool({ connectionString: url, max: 8 });
  await postgres(pool).init();
  available = true;
} catch {
  available = false;
}

// A shared pool isolates each test by truncating; store.close() is a no-op for it.
const makeStore: StoreFactory = async () => {
  const store = postgres(pool as pg.Pool);
  await store.reset();
  return store;
};

if (available) {
  defineStoreSuite(makeStore);
  defineEngineSuite(makeStore);

  describe("postgres migrations", () => {
    it("init records the latest schema version and refuses a newer database", async () => {
      const p = pool as pg.Pool;
      const v = await p.query<{ version: number }>("SELECT version FROM schema_version");
      expect(v.rows[0]?.version).toBe(SCHEMA_VERSION);

      // Pretend a future release migrated this database further.
      await p.query("UPDATE schema_version SET version=99");
      await expect(postgres(p).init()).rejects.toThrow(/v99/);
      await p.query("UPDATE schema_version SET version=$1", [SCHEMA_VERSION]);
    });
  });

  describe("postgres wake listener", () => {
    it("recovers from a killed LISTEN backend and delivers later wakes", async () => {
      const p = pool as pg.Pool;
      const store = postgres(p);
      await store.reset();
      let wakes = 0;
      const unsubscribe = await store.subscribeWake(() => {
        wakes++;
      });

      await store.createWorkflow({ name: "t", input: 0, now: 1 });
      await waitFor(() => wakes > 0);

      // Kill the dedicated LISTEN backend out from under the store.
      const killer = new pg.Pool({ connectionString: url, max: 1 });
      await killer.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE pid <> pg_backend_pid() AND query ILIKE '%LISTEN throughline_wake%'`,
      );
      await killer.end();

      // The reconnect uses a capped backoff starting at 1s; poll generously and
      // keep writing so a wake arrives once the new LISTEN is established.
      const before = wakes;
      const deadline = Date.now() + 15_000;
      while (wakes === before && Date.now() < deadline) {
        await store.createWorkflow({ name: "t", input: 0, now: 2 });
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(wakes).toBeGreaterThan(before);
      await unsubscribe();
    }, 20_000);
  });

  async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for a wake");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  afterAll(async () => {
    await pool?.end();
  });
} else {
  describe.skip("store-postgres (no Postgres reachable)", () => {});
}
