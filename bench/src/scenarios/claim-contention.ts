import { performance } from "node:perf_hooks";
import { throughline } from "@through-line/core";
import { CountingStore } from "../countingStore";
import type { ScenarioResult } from "../report";
import { skippedResult, summarize } from "../report";
import { postgresCase, sqliteFileCase } from "../stores";

export const name = "claim-contention";

export async function run(quick: boolean): Promise<ScenarioResult[]> {
  const runs = quick ? 100 : 500;
  const workerCounts = quick ? [1, 4] : [1, 4, 8];
  const results: ScenarioResult[] = [];
  const cases = [sqliteFileCase()];
  const pg = await postgresCase();
  if (pg) cases.push(pg);
  else results.push(skippedResult(name, "postgres", "no Postgres reachable"));

  for (const c of cases) {
    for (const workers of workerCounts) {
      const { store: inner, cleanup } = await c.make();
      const store = new CountingStore(inner);
      const tf = throughline({ store });
      let completed = 0;
      const allDone = new Promise<void>((resolve) => {
        tf.task("one", async (ctx) => {
          await ctx.step("s", async () => 1);
          completed++;
          if (completed === runs) resolve();
          return "done";
        });
      });
      for (let i = 0; i < runs; i++) await tf.start("one", { i });

      const pool = Array.from({ length: workers }, () => tf.worker({ leaseMs: 60_000 }));
      const start = performance.now();
      for (const w of pool) w.start();
      await allDone;
      const drain = (performance.now() - start) / 1000;
      await Promise.all(pool.map((w) => w.stop()));

      const s = summarize(store.claimMs);
      results.push({
        scenario: name,
        store: c.label,
        config: `${workers} workers, ${runs} runs`,
        metrics: [
          { name: "claim_p50", value: s.p50, unit: "ms" },
          { name: "claim_p95", value: s.p95, unit: "ms" },
          { name: "claim_p99", value: s.p99, unit: "ms" },
          { name: "drain", value: drain, unit: "s" },
        ],
      });
      await cleanup();
    }
  }
  return results;
}
