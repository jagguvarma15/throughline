import { type StoreFactory, defineEngineSuite, defineStoreSuite } from "@throughline/testing";
import pg from "pg";
import { afterAll, describe } from "vitest";
import { postgres } from "../src/index";

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
  afterAll(async () => {
    await pool?.end();
  });
} else {
  describe.skip("store-postgres (no Postgres reachable)", () => {});
}
