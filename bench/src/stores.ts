import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "@through-line/core";
import { postgres } from "@through-line/store-postgres";
import { sqlite } from "@through-line/store-sqlite";

export interface StoreHandle {
  store: Store;
  cleanup: () => Promise<void>;
}

export interface StoreCase {
  label: string;
  make: () => Promise<StoreHandle>;
}

export function sqliteFileCase(): StoreCase {
  return {
    label: "sqlite-file",
    make: async () => {
      const dir = mkdtempSync(join(tmpdir(), "throughline-bench-"));
      const store = sqlite(join(dir, "bench.db"));
      await store.init();
      return {
        store,
        cleanup: async () => {
          await store.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  };
}

export function sqliteMemoryCase(): StoreCase {
  return {
    label: "sqlite-memory",
    make: async () => {
      const store = sqlite(":memory:");
      await store.init();
      return { store, cleanup: async () => store.close() };
    },
  };
}

export function postgresUrl(): string {
  return (
    process.env.THROUGHLINE_BENCH_PG ??
    process.env.THROUGHLINE_TEST_PG ??
    "postgres://throughline:throughline@localhost:5444/throughline"
  );
}

/** Returns null when no Postgres is reachable so scenarios can print a skip row. */
export async function postgresCase(): Promise<StoreCase | null> {
  const url = postgresUrl();
  try {
    const probe = postgres(url);
    await probe.init();
    await probe.close();
  } catch {
    return null;
  }
  return {
    label: "postgres",
    make: async () => {
      const store = postgres(url);
      await store.init();
      await (store as unknown as { reset: () => Promise<void> }).reset();
      return { store, cleanup: async () => store.close() };
    },
  };
}
