import { performance } from "node:perf_hooks";
import { throughline } from "@through-line/core";
import { CountingStore } from "../countingStore";
import type { ScenarioResult } from "../report";
import { skippedResult } from "../report";
import { postgresCase, sqliteFileCase } from "../stores";

export const name = "idle-qps";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function run(quick: boolean): Promise<ScenarioResult[]> {
  const windowMs = quick ? 2000 : 5000;
  const results: ScenarioResult[] = [];
  const cases = [sqliteFileCase()];
  const pg = await postgresCase();
  if (pg) cases.push(pg);
  else results.push(skippedResult(name, "postgres", "no Postgres reachable"));

  const configs = [
    { label: "fixed 200ms", pollIntervalMs: 200, maxPollIntervalMs: 200 },
    { label: "backoff to 5s", pollIntervalMs: 200, maxPollIntervalMs: 5000 },
  ];

  for (const c of cases) {
    for (const cfg of configs) {
      const { store: inner, cleanup } = await c.make();
      const store = new CountingStore(inner);
      const tf = throughline({ store });
      tf.task("noop", async () => "done");
      const worker = tf.worker({
        leaseMs: 60_000,
        pollIntervalMs: cfg.pollIntervalMs,
        maxPollIntervalMs: cfg.maxPollIntervalMs,
      });
      worker.start();
      const start = performance.now();
      await sleep(windowMs);
      const claims = store.count("claim");
      const elapsed = (performance.now() - start) / 1000;
      await worker.stop();
      results.push({
        scenario: name,
        store: c.label,
        config: cfg.label,
        metrics: [{ name: "claims_per_sec", value: claims / elapsed, unit: "q/s" }],
      });
      await cleanup();
    }
  }

  // Postgres only: latency from creating a run to its completion while the worker
  // idles at the backoff cap with LISTEN/NOTIFY active.
  if (pg) {
    const { store, cleanup } = await pg.make();
    const tf = throughline({ store });
    let done: (() => void) | null = null;
    tf.task("wakeup", async () => {
      done?.();
      return "done";
    });
    const worker = tf.worker({ leaseMs: 60_000, pollIntervalMs: 200, maxPollIntervalMs: 5000 });
    worker.start();
    await sleep(quick ? 1500 : 6000); // let the loop reach the cap
    const samples: number[] = [];
    const rounds = quick ? 3 : 10;
    for (let i = 0; i < rounds; i++) {
      const finished = new Promise<void>((resolve) => {
        done = resolve;
      });
      const start = performance.now();
      await tf.start("wakeup", { i });
      await finished;
      samples.push(performance.now() - start);
      await sleep(quick ? 1500 : 6000); // fall back to the cap between rounds
    }
    await worker.stop();
    await cleanup();
    samples.sort((a, b) => a - b);
    results.push({
      scenario: name,
      store: "postgres",
      config: "notify wake at cap",
      metrics: [
        {
          name: "wake_to_done_p50",
          value: samples[Math.floor(samples.length / 2)] ?? Number.NaN,
          unit: "ms",
        },
        { name: "wake_to_done_max", value: samples[samples.length - 1] ?? Number.NaN, unit: "ms" },
      ],
    });
  }
  return results;
}
