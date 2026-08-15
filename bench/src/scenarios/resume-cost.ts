import { performance } from "node:perf_hooks";
import { throughline } from "@through-line/core";
import type { ScenarioResult } from "../report";
import { percentile, skippedResult } from "../report";
import { postgresCase, sqliteFileCase } from "../stores";

export const name = "resume-cost";

export async function run(quick: boolean): Promise<ScenarioResult[]> {
  const journalSizes = quick ? [10, 100] : [10, 100, 1000];
  const perSize = quick ? 3 : 10;
  const results: ScenarioResult[] = [];
  const cases = [sqliteFileCase()];
  const pg = await postgresCase();
  if (pg) cases.push(pg);
  else results.push(skippedResult(name, "postgres", "no Postgres reachable"));

  for (const c of cases) {
    const slopePoints: Array<{ steps: number; p50: number }> = [];
    for (const journal of journalSizes) {
      const { store, cleanup } = await c.make();
      const tf = throughline({ store });
      tf.task("journaled", async (ctx) => {
        for (let i = 0; i < journal; i++) {
          await ctx.step(`s${i}`, async () => i);
        }
        await ctx.waitForEvent("resume");
        return "done";
      });

      const ids: string[] = [];
      for (let i = 0; i < perSize; i++) ids.push(await tf.start("journaled", { i }));
      const worker = tf.worker({ leaseMs: 60_000 });
      while (await worker.runOnce()) {
        // Park every run on its waitForEvent.
      }

      const samples: number[] = [];
      for (const id of ids) {
        await tf.signal(id, "resume", null);
        const start = performance.now();
        await worker.runOnce(); // reload journal, replay all steps, consume, finish
        samples.push(performance.now() - start);
        const run = await tf.getRun(id);
        if (run?.status !== "completed") throw new Error(`resume did not complete ${id}`);
      }
      const p50 = percentile(samples, 50);
      slopePoints.push({ steps: journal, p50 });
      results.push({
        scenario: name,
        store: c.label,
        config: `journal ${journal} steps`,
        metrics: [{ name: "resume_p50", value: p50, unit: "ms" }],
      });
      await cleanup();
    }
    const first = slopePoints[0];
    const last = slopePoints[slopePoints.length - 1];
    if (first && last && last.steps > first.steps) {
      results.push({
        scenario: name,
        store: c.label,
        config: "slope",
        metrics: [
          {
            name: "per_step",
            value: ((last.p50 - first.p50) / (last.steps - first.steps)) * 1000,
            unit: "us/step",
          },
        ],
      });
    }
  }
  return results;
}
