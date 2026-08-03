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

  afterAll(async () => {
    await pool?.end();
  });
} else {
  describe.skip("store-postgres (no Postgres reachable)", () => {});
}
