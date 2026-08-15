import { performance } from "node:perf_hooks";
import { type Store, throughline } from "@through-line/core";
import { withoutWake } from "../countingStore";
import type { ScenarioResult } from "../report";
import { skippedResult, summarize } from "../report";
import { postgresCase, sqliteFileCase } from "../stores";

export const name = "e2e-latency";

async function measure(
  store: Store,
  label: string,
  config: string,
  rounds: number,
): Promise<ScenarioResult> {
  const tf = throughline({ store });
  let done: (() => void) | null = null;
  tf.task("one", async (ctx) => {
    await ctx.step("s", async () => 1);
    done?.();
    return "done";
  });
  const worker = tf.worker({ leaseMs: 60_000, pollIntervalMs: 200, maxPollIntervalMs: 5000 });
  worker.start();
  const samples: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    const start = performance.now();
    await tf.start("one", { i });
    await finished;
    samples.push(performance.now() - start);
  }
  await worker.stop();
  const s = summarize(samples);
  return {
    scenario: name,
    store: label,
    config,
    metrics: [
      { name: "start_to_done_p50", value: s.p50, unit: "ms" },
      { name: "start_to_done_p95", value: s.p95, unit: "ms" },
    ],
  };
}

export async function run(quick: boolean): Promise<ScenarioResult[]> {
  const rounds = quick ? 10 : 50;
  const results: ScenarioResult[] = [];

  const sq = await sqliteFileCase().make();
  results.push(await measure(sq.store, "sqlite-file", "polling", rounds));
  await sq.cleanup();

  const pg = await postgresCase();
  if (!pg) {
    results.push(skippedResult(name, "postgres", "no Postgres reachable"));
    return results;
  }
  const pgPolling = await pg.make();
  results.push(await measure(withoutWake(pgPolling.store), "postgres", "polling only", rounds));
  await pgPolling.cleanup();

  const pgNotify = await pg.make();
  results.push(await measure(pgNotify.store, "postgres", "notify", rounds));
  await pgNotify.cleanup();

  return results;
}
