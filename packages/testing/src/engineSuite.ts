import { throughline } from "@throughline/core";
import { describe, expect, it } from "vitest";
import { controlledClock } from "./clock";
import { type FaultPlan, faultStore } from "./faultStore";
import type { StoreFactory } from "./harness";

const noSleep = async (): Promise<void> => {};

/** Small seeded PRNG (mulberry32) so a failing schedule is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ScenarioResult {
  status: string;
  output: unknown;
  effects: Record<string, number>;
}

/**
 * A 5-step accumulator whose every step records an effect, driven to completion under
 * a (possibly empty) set of crash indices. Returns the final state + per-step effect
 * counts so callers can assert determinism and exactly-once.
 */
async function runAccumulator(
  makeStore: StoreFactory,
  crashAt: Set<number>,
): Promise<ScenarioResult> {
  const clock = controlledClock(1000);
  const store = faultStore(await makeStore(), { crashAt });
  const tf = throughline({ store, clock, sleep: noSleep });
  const effects: Record<string, number> = {};
  tf.task("acc", async (ctx) => {
    let acc = 0;
    for (let i = 0; i < 5; i++) {
      acc = await ctx.step(`s${i}`, async () => {
        const k = `s${i}`;
        effects[k] = (effects[k] ?? 0) + 1;
        return acc + i + 1;
      });
    }
    return acc;
  });
  const id = await tf.start("acc", null);
  const worker = tf.worker({ leaseMs: 1000, workerId: "w" });
  let status = "";
  for (let guard = 0; guard < 40; guard++) {
    await worker.runOnce();
    const run = await tf.getRun(id);
    status = run?.status ?? "";
    if (status === "completed" || status === "dead") {
      await store.close();
      return { status, output: run?.output, effects };
    }
    clock.advance(5000); // expire the lease so the next runOnce re-claims
  }
  await store.close();
  return { status, output: undefined, effects };
}

/**
 * End-to-end engine semantics, parameterized over a store. Both store-sqlite and
 * store-postgres run this unchanged. Proves the §2 invariants: replay-without-rerun,
 * crash-resume, and exactly-once idempotency-keyed side effects.
 */
export function defineEngineSuite(makeStore: StoreFactory): void {
  describe("Engine", () => {
    it("runs a multi-step task to completion, each step body once", async () => {
      const store = await makeStore();
      const tf = throughline({ store, clock: controlledClock(1000), sleep: noSleep });
      const calls = { a: 0, b: 0 };
      tf.task("t", async (ctx, input: { n: number }) => {
        const a = await ctx.step("a", async () => {
          calls.a++;
          return input.n + 1;
        });
        const b = await ctx.step("b", async () => {
          calls.b++;
          return a * 2;
        });
        return { a, b };
      });
      const id = await tf.start("t", { n: 4 });
      const worker = tf.worker({ leaseMs: 1000 });
      expect(await worker.runOnce()).toBe(true);

      const run = await tf.getRun(id);
      expect(run?.status).toBe("completed");
      expect(run?.output).toEqual({ a: 5, b: 10 });
      expect(calls).toEqual({ a: 1, b: 1 });
      expect(run?.steps).toHaveLength(2);
      await store.close();
    });

    it("crash after a step commits: re-claims and replays without re-running that fn", async () => {
      const clock = controlledClock(1000);
      const plan: FaultPlan = { crashAfterStep: "a#0" };
      const store = faultStore(await makeStore(), plan);
      const tf = throughline({ store, clock, sleep: noSleep });
      const calls = { a: 0, b: 0 };
      tf.task("t", async (ctx) => {
        const a = await ctx.step("a", async () => {
          calls.a++;
          return 1;
        });
        const b = await ctx.step("b", async () => {
          calls.b++;
          return a + 10;
        });
        return { a, b };
      });
      const id = await tf.start("t", null);
      const worker = tf.worker({ leaseMs: 1000, workerId: "w1" });

      // First attempt crashes right after step "a" commits.
      await worker.runOnce();
      expect(calls).toEqual({ a: 1, b: 0 });
      expect((await tf.getRun(id))?.status).toBe("running");

      // Recover: disarm the fault, let the lease expire, re-claim.
      plan.crashAfterStep = undefined;
      clock.advance(5000);
      await worker.runOnce();

      const run = await tf.getRun(id);
      expect(run?.status).toBe("completed");
      expect(run?.output).toEqual({ a: 1, b: 11 });
      expect(calls).toEqual({ a: 1, b: 1 }); // "a" replayed from journal, never re-run
      await store.close();
    });

    it("an idempotency-keyed side effect runs exactly once across a crash", async () => {
      const clock = controlledClock(1000);
      const plan: FaultPlan = { crashAfterStep: "charge#0" };
      const store = faultStore(await makeStore(), plan);
      const tf = throughline({ store, clock, sleep: noSleep });
      const effects: string[] = [];
      tf.task("pay", async (ctx) => {
        await ctx.step("charge", async () => {
          effects.push("charged");
          return "ok";
        });
        await ctx.step("receipt", async () => "sent");
        return "done";
      });
      const id = await tf.start("pay", null);
      const worker = tf.worker({ leaseMs: 1000, workerId: "w1" });

      await worker.runOnce(); // crashes after charge commits
      plan.crashAfterStep = undefined;
      clock.advance(5000);
      await worker.runOnce(); // resume

      expect((await tf.getRun(id))?.status).toBe("completed");
      expect(effects).toEqual(["charged"]); // exactly once despite the crash
      await store.close();
    });

    it("duplicate delivery of a committing step produces no duplicate journal row", async () => {
      const store = faultStore(await makeStore(), { duplicateStep: "a#0" });
      const tf = throughline({ store, clock: controlledClock(1000), sleep: noSleep });
      tf.task("t", async (ctx) => ctx.step("a", async () => 7));
      const id = await tf.start("t", null);
      await tf.worker({ leaseMs: 1000 }).runOnce();
      const run = await tf.getRun(id);
      expect(run?.status).toBe("completed");
      expect(run?.steps).toHaveLength(1);
      expect(run?.steps[0]?.output).toBe(7);
      await store.close();
    });

    it("a step that exhausts retries fails the workflow as dead", async () => {
      const store = await makeStore();
      const tf = throughline({ store, clock: controlledClock(1000), sleep: noSleep });
      let attempts = 0;
      tf.task("fail", async (ctx) => {
        await ctx.step(
          "x",
          async () => {
            attempts++;
            throw new Error("boom");
          },
          { retry: { maxAttempts: 3, backoff: "fixed", baseMs: 1, jitter: false } },
        );
        return "unreachable";
      });
      const id = await tf.start("fail", null);
      await tf.worker({ leaseMs: 1000 }).runOnce();

      const run = await tf.getRun(id);
      expect(run?.status).toBe("dead");
      expect(run?.error?.message).toBe("boom");
      expect(attempts).toBe(3);
      expect(run?.steps[0]?.status).toBe("failed");
      await store.close();
    });

    it("property: identical final state + zero duplicate keyed effects across random crash schedules", async () => {
      const baseline = await runAccumulator(makeStore, new Set());
      expect(baseline.status).toBe("completed");
      expect(baseline.effects).toEqual({ s0: 1, s1: 1, s2: 1, s3: 1, s4: 1 });

      const SCHEDULES = 120;
      for (let seed = 0; seed < SCHEDULES; seed++) {
        const rng = mulberry32(seed + 1);
        const crashAt = new Set<number>();
        for (let i = 1; i <= 5; i++) {
          if (rng() < 0.6) crashAt.add(i);
        }
        const result = await runAccumulator(makeStore, crashAt);
        expect(result.status, `seed ${seed}`).toBe("completed");
        expect(result.output, `seed ${seed}`).toEqual(baseline.output);
        expect(result.effects, `seed ${seed}`).toEqual(baseline.effects);
      }
    });
  });
}
