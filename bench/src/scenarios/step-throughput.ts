import { performance } from "node:perf_hooks";
import { throughline } from "@through-line/core";
import type { ScenarioResult } from "../report";
import { skippedResult } from "../report";
import { postgresCase, sqliteFileCase, sqliteMemoryCase } from "../stores";

export const name = "step-throughput";

export async function run(quick: boolean): Promise<ScenarioResult[]> {
  const workflows = quick ? 5 : 20;
  const stepsPer = quick ? 50 : 200;
  const results: ScenarioResult[] = [];
  const cases = [sqliteFileCase(), sqliteMemoryCase()];
  const pg = await postgresCase();
  if (pg) cases.push(pg);
  else results.push(skippedResult(name, "postgres", "no Postgres reachable"));

  for (const c of cases) {
    const { store, cleanup } = await c.make();
    const tf = throughline({ store });
    tf.task("steps", async (ctx) => {
      for (let i = 0; i < stepsPer; i++) {
        await ctx.step(`s${i}`, async () => i);
      }
      return "done";
    });
    for (let w = 0; w < workflows; w++) await tf.start("steps", { w });

    const worker = tf.worker({ leaseMs: 60_000 });
    const start = performance.now();
    while (await worker.runOnce()) {
      // Drain until nothing is claimable.
    }
    const elapsed = (performance.now() - start) / 1000;
    results.push({
      scenario: name,
      store: c.label,
      config: `${workflows} runs x ${stepsPer} steps`,
      metrics: [
        { name: "steps_per_sec", value: (workflows * stepsPer) / elapsed, unit: "steps/s" },
        { name: "total", value: elapsed, unit: "s" },
      ],
    });
    await cleanup();
  }
  return results;
}
