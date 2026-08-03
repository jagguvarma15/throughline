import {
  type Context,
  LeaseLostError,
  TimeoutError,
  createOps,
  throughline,
} from "@through-line/core";
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

    it("durable waitForApproval survives a full worker restart and resumes on signal", async () => {
      const store = await makeStore();
      const clock = controlledClock(1000);
      const calls = { pre: 0, post: 0 };
      const handler = async (ctx: Context): Promise<boolean> => {
        await ctx.step("pre", async () => {
          calls.pre++;
          return "pre";
        });
        const ok = await ctx.waitForApproval("publish");
        await ctx.step("post", async () => {
          calls.post++;
          return "post";
        });
        return ok;
      };

      const tf1 = throughline({ store, clock, sleep: noSleep });
      tf1.task("approve", handler);
      const id = await tf1.start("approve", null);
      await tf1.worker({ leaseMs: 1000, workerId: "w1" }).runOnce();
      expect((await tf1.getRun(id))?.status).toBe("waiting");
      expect(calls).toEqual({ pre: 1, post: 0 });

      // Simulate a full restart: a fresh throughline + worker over the SAME store.
      const tf2 = throughline({ store, clock, sleep: noSleep });
      tf2.task("approve", handler);
      await tf2.signal(id, "publish", { approved: true });
      await tf2.worker({ leaseMs: 1000, workerId: "w2" }).runOnce();

      const run = await tf2.getRun(id);
      expect(run?.status).toBe("completed");
      expect(run?.output).toBe(true);
      expect(calls).toEqual({ pre: 1, post: 1 }); // pre replayed, not re-run
      await store.close();
    });

    it("ctx.sleep parks until the deadline, then resumes", async () => {
      const store = await makeStore();
      const clock = controlledClock(1000);
      const tf = throughline({ store, clock, sleep: noSleep });
      const calls = { a: 0, b: 0 };
      tf.task("t", async (ctx) => {
        await ctx.step("a", async () => {
          calls.a++;
          return 1;
        });
        await ctx.sleep("nap", 5000);
        await ctx.step("b", async () => {
          calls.b++;
          return 2;
        });
        return "done";
      });
      const id = await tf.start("t", null);
      const worker = tf.worker({ leaseMs: 1000, workerId: "w" });
      await worker.runOnce();
      expect((await tf.getRun(id))?.status).toBe("waiting");
      expect(calls).toEqual({ a: 1, b: 0 });

      clock.set(5999);
      expect(await worker.runOnce()).toBe(false); // before the deadline: not runnable
      clock.set(6000);
      await worker.runOnce();

      expect((await tf.getRun(id))?.status).toBe("completed");
      expect(calls).toEqual({ a: 1, b: 1 });
      await store.close();
    });

    it("waitForEvent times out and journals the timeout so a replay cannot flip it", async () => {
      const store = await makeStore();
      const clock = controlledClock(1000);
      const tf = throughline({ store, clock, sleep: noSleep });
      tf.task("t", async (ctx) => {
        try {
          const v = await ctx.waitForEvent("go", { timeout: 1000 });
          return { got: v };
        } catch (e) {
          if (e instanceof TimeoutError) return { timedOut: true };
          throw e;
        }
      });
      const id = await tf.start("t", null);
      const worker = tf.worker({ leaseMs: 500, workerId: "w" });
      await worker.runOnce(); // parks with wake_at = 2000
      expect((await tf.getRun(id))?.status).toBe("waiting");

      clock.set(2000);
      await worker.runOnce(); // deadline reached, no event -> timeout

      const run = await tf.getRun(id);
      expect(run?.status).toBe("completed");
      expect(run?.output).toEqual({ timedOut: true });
      expect(run?.steps.some((s) => s.kind === "timeout")).toBe(true);
      await store.close();
    });

    it("event wins over a pending timeout", async () => {
      const store = await makeStore();
      const clock = controlledClock(1000);
      const tf = throughline({ store, clock, sleep: noSleep });
      tf.task("t", async (ctx) => ctx.waitForEvent<string>("go", { timeout: 5000 }));
      const id = await tf.start("t", null);
      const worker = tf.worker({ leaseMs: 1000, workerId: "w" });
      await worker.runOnce(); // parks, wake_at = 6000
      await tf.signal(id, "go", "hello");
      clock.set(2000); // still before the timeout
      await worker.runOnce();
      const run = await tf.getRun(id);
      expect(run?.status).toBe("completed");
      expect(run?.output).toBe("hello");
      await store.close();
    });

    it("cancel transitions a pending run to cancelled", async () => {
      const store = await makeStore();
      const tf = throughline({ store, clock: controlledClock(1000), sleep: noSleep });
      tf.task("t", async (ctx) => ctx.step("a", async () => 1));
      const id = await tf.start("t", null);
      expect(await tf.cancel(id)).toBe("cancelled");
      expect(await tf.worker({ leaseMs: 1000, workerId: "w" }).runOnce()).toBe(false);
      expect((await tf.getRun(id))?.status).toBe("cancelled");
      await store.close();
    });

    it("cooperative cancel stops a running workflow at the next step boundary", async () => {
      const store = await makeStore();
      const tf = throughline({ store, clock: controlledClock(1000), sleep: noSleep });
      const calls = { a: 0, b: 0 };
      tf.task("t", async (ctx) => {
        await ctx.step("a", async () => {
          calls.a++;
          return 1;
        });
        await tf.cancel(ctx.runId); // request cancel mid-run (workflow is running)
        await ctx.step("b", async () => {
          calls.b++;
          return 2;
        });
        return "done";
      });
      const id = await tf.start("t", null);
      await tf.worker({ leaseMs: 1000, workerId: "w" }).runOnce();
      const run = await tf.getRun(id);
      expect(run?.status).toBe("cancelled");
      expect(calls).toEqual({ a: 1, b: 0 });
      await store.close();
    });

    it("a token budget halts a runaway loop with BudgetExceededError", async () => {
      const store = await makeStore();
      const tf = throughline({ store, clock: controlledClock(1000), sleep: noSleep });
      let iterations = 0;
      tf.task(
        "burn",
        async (ctx) => {
          for (let i = 0; i < 100; i++) {
            await ctx.step(
              `call${i}`,
              async () => {
                iterations++;
                return i;
              },
              { budget: { cost: 40, estimate: 40 } },
            );
          }
          return "done";
        },
        { budget: 100 },
      );
      const id = await tf.start("burn", null);
      await tf.worker({ leaseMs: 1000, workerId: "w" }).runOnce();
      const run = await tf.getRun(id);
      expect(run?.status).toBe("dead");
      expect(run?.error?.type).toBe("BudgetExceededError");
      expect(iterations).toBe(2); // 40+40 fit under 100; the 3rd is refused before running
      expect(run?.steps).toHaveLength(2);
      await store.close();
    });

    it("budget accounting is reconstructed from the journal across a crash", async () => {
      const clock = controlledClock(1000);
      const plan: FaultPlan = { crashAfterStep: "call1#0" };
      const store = faultStore(await makeStore(), plan);
      const tf = throughline({ store, clock, sleep: noSleep });
      let iterations = 0;
      tf.task(
        "burn",
        async (ctx) => {
          for (let i = 0; i < 5; i++) {
            await ctx.step(
              `call${i}`,
              async () => {
                iterations++;
                return i;
              },
              { budget: { cost: 40, estimate: 40 } },
            );
          }
          return "done";
        },
        { budget: 100 },
      );
      const id = await tf.start("burn", null);
      const worker = tf.worker({ leaseMs: 1000, workerId: "w" });
      await worker.runOnce(); // call0, call1 commit (consumed=80), then crash
      expect(iterations).toBe(2);

      plan.crashAfterStep = undefined;
      clock.advance(5000);
      await worker.runOnce(); // resume: replays call0/call1 (rebuilds consumed=80), call2 refused

      const run = await tf.getRun(id);
      expect(run?.status).toBe("dead");
      expect(run?.error?.type).toBe("BudgetExceededError");
      expect(iterations).toBe(2); // call2 fn never ran; replayed steps not re-run
      await store.close();
    });

    it("determinism guard: a step replayed with a different kind dies with NonDeterminismError", async () => {
      const clock = controlledClock(1000);
      const plan: FaultPlan = { crashAfterStep: "a#0" };
      const store = faultStore(await makeStore(), plan);
      const tf1 = throughline({ store, clock, sleep: noSleep });
      tf1.task("t", async (ctx) => {
        await ctx.step("a", async () => 1);
        await ctx.step("b", async () => 2);
        return "v1";
      });
      const id = await tf1.start("t", null);
      await tf1.worker({ leaseMs: 1000, workerId: "w1" }).runOnce(); // crash after a#0 commits

      // Divergent redeploy: "a" is now a sleep. Its replay hits the journaled step row.
      plan.crashAfterStep = undefined;
      clock.advance(5000);
      const tf2 = throughline({ store, clock, sleep: noSleep });
      tf2.task("t", async (ctx) => {
        await ctx.sleep("a", 10);
        return "v2";
      });
      await tf2.worker({ leaseMs: 1000, workerId: "w2" }).runOnce();

      const run = await tf2.getRun(id);
      expect(run?.status).toBe("dead");
      expect(run?.error?.type).toBe("NonDeterminismError");
      await store.close();
    });

    it("determinism guard: a dropped journaled step dies with NonDeterminismError at completion", async () => {
      const clock = controlledClock(1000);
      const plan: FaultPlan = { crashAfterStep: "b#0" };
      const store = faultStore(await makeStore(), plan);
      const tf1 = throughline({ store, clock, sleep: noSleep });
      tf1.task("t", async (ctx) => {
        await ctx.step("a", async () => 1);
        await ctx.step("b", async () => 2);
        return "v1";
      });
      const id = await tf1.start("t", null);
      await tf1.worker({ leaseMs: 1000, workerId: "w1" }).runOnce(); // a and b commit, then crash

      // Divergent redeploy: step "b" was removed, so its journal row is never replayed.
      plan.crashAfterStep = undefined;
      clock.advance(5000);
      const tf2 = throughline({ store, clock, sleep: noSleep });
      tf2.task("t", async (ctx) => {
        await ctx.step("a", async () => 1);
        return "v2";
      });
      await tf2.worker({ leaseMs: 1000, workerId: "w2" }).runOnce();

      const run = await tf2.getRun(id);
      expect(run?.status).toBe("dead");
      expect(run?.error?.type).toBe("NonDeterminismError");
      expect(run?.error?.message).toContain("b#0");
      await store.close();
    });

    it("determinism guard: warn mode logs instead of failing the diverged run", async () => {
      const clock = controlledClock(1000);
      const plan: FaultPlan = { crashAfterStep: "b#0" };
      const store = faultStore(await makeStore(), plan);
      const tf1 = throughline({ store, clock, sleep: noSleep });
      tf1.task("t", async (ctx) => {
        await ctx.step("a", async () => 1);
        await ctx.step("b", async () => 2);
        return "v1";
      });
      const id = await tf1.start("t", null);
      await tf1.worker({ leaseMs: 1000, workerId: "w1" }).runOnce();

      const warnings: string[] = [];
      const logger = {
        debug: () => {},
        info: () => {},
        warn: (m: string) => {
          warnings.push(m);
        },
        error: () => {},
      };
      plan.crashAfterStep = undefined;
      clock.advance(5000);
      const tf2 = throughline({ store, clock, sleep: noSleep, logger, determinism: "warn" });
      tf2.task("t", async (ctx) => {
        await ctx.step("a", async () => 1);
        return "v2";
      });
      await tf2.worker({ leaseMs: 1000, workerId: "w2" }).runOnce();

      const run = await tf2.getRun(id);
      expect(run?.status).toBe("completed");
      expect(warnings.some((m) => m.includes("b#0"))).toBe(true);
      await store.close();
    });

    it("determinism guard: crash mid-Promise.all does not false-positive", async () => {
      const clock = controlledClock(1000);
      const plan: FaultPlan = { crashAt: new Set([2]) };
      const store = faultStore(await makeStore(), plan);
      const tf = throughline({ store, clock, sleep: noSleep });
      const calls = { a: 0, b: 0, c: 0 };
      tf.task("t", async (ctx) => {
        const [x, y] = await Promise.all([
          ctx.step("a", async () => {
            calls.a++;
            return 1;
          }),
          ctx.step("b", async () => {
            calls.b++;
            return 2;
          }),
        ]);
        const z = await ctx.step("c", async () => {
          calls.c++;
          return x + y;
        });
        return z;
      });
      const id = await tf.start("t", null);
      const worker = tf.worker({ leaseMs: 1000, workerId: "w" });
      await worker.runOnce(); // the second parallel commit crashes; both rows are journaled
      clock.advance(5000);
      await worker.runOnce();

      const run = await tf.getRun(id);
      expect(run?.status).toBe("completed");
      expect(run?.output).toBe(3);
      expect(calls).toEqual({ a: 1, b: 1, c: 1 });
      await store.close();
    });

    it("ctx.now and ctx.random journal their values and replay them verbatim", async () => {
      const clock = controlledClock(1000);
      const plan: FaultPlan = { crashAfterStep: "$random#0" };
      const store = faultStore(await makeStore(), plan);
      const tf = throughline({ store, clock, sleep: noSleep });
      tf.task("t", async (ctx) => {
        const t = await ctx.now();
        const r = await ctx.random();
        return { t, r };
      });
      const id = await tf.start("t", null);
      const worker = tf.worker({ leaseMs: 1000, workerId: "w" });
      await worker.runOnce(); // $now#0 and $random#0 commit, then the crash
      const steps = (await tf.getRun(id))?.steps ?? [];
      const t0 = steps.find((s) => s.stepKey === "$now#0")?.output;
      const r0 = steps.find((s) => s.stepKey === "$random#0")?.output;
      expect(t0).toBe(1000);

      plan.crashAfterStep = undefined;
      clock.advance(5000); // a re-executed ctx.now() would observe 6000
      await worker.runOnce();

      const run = await tf.getRun(id);
      expect(run?.status).toBe("completed");
      expect(run?.output).toEqual({ t: t0, r: r0 });
      await store.close();
    });

    it("a run that crashes its worker repeatedly is marked dead by the recovery cap", async () => {
      const clock = controlledClock(1000);
      const store = await makeStore();
      const tf = throughline({ store, clock, sleep: noSleep });
      let executions = 0;
      // Throwing LeaseLostError from the handler makes the worker abandon the run,
      // modelling a worker that dies mid-run on every claim (the poison-pill shape).
      tf.task("poison", async (ctx) => {
        executions++;
        throw new LeaseLostError(ctx.runId);
      });
      const id = await tf.start("poison", null);
      const worker = tf.worker({ leaseMs: 1000, workerId: "w", maxRecoveryAttempts: 3 });
      let status = "";
      for (let guard = 0; guard < 20; guard++) {
        await worker.runOnce();
        status = (await tf.getRun(id))?.status ?? "";
        if (status === "dead") break;
        clock.advance(5000); // expire the lease so the next runOnce re-claims
      }

      const run = await tf.getRun(id);
      expect(run?.status).toBe("dead");
      expect(run?.error?.type).toBe("RecoveryExhaustedError");
      expect(executions).toBe(4); // 1 fresh claim + maxRecoveryAttempts re-claims, then capped
      await store.close();
    });

    it("the step retry budget survives a crash mid-retry-loop", async () => {
      const clock = controlledClock(1000);
      const plan: FaultPlan = { crashAfterCommits: 2 };
      const store = faultStore(await makeStore(), plan);
      const tf = throughline({ store, clock, sleep: noSleep });
      let executions = 0;
      tf.task("flaky", async (ctx) => {
        await ctx.step(
          "x",
          async () => {
            executions++;
            throw new Error("boom");
          },
          { retry: { maxAttempts: 3, backoff: "fixed", baseMs: 1, jitter: false } },
        );
        return "unreachable";
      });
      const id = await tf.start("flaky", null);
      const worker = tf.worker({ leaseMs: 1000, workerId: "w" });
      await worker.runOnce(); // attempts 1 and 2 journal as failed rows, then the crash
      expect(executions).toBe(2);
      expect((await tf.getRun(id))?.status).toBe("running");

      plan.crashAfterCommits = undefined;
      clock.advance(5000);
      await worker.runOnce(); // resumes at attempt 3, not attempt 1

      const run = await tf.getRun(id);
      expect(run?.status).toBe("dead");
      expect(executions).toBe(3); // total executions across processes == maxAttempts
      expect(run?.steps[0]?.attempts).toBe(3);
      await store.close();
    });

    it("retention: the worker sweeps terminal runs past the TTL", async () => {
      // The store stamps updated_at with its own (wall) clock, so the sweep clock must
      // start at wall time for the TTL cutoff to land on the right side of it.
      const clock = controlledClock(Date.now());
      const store = await makeStore();
      const tf = throughline({ store, clock, sleep: noSleep });
      tf.task("t", async (ctx) => ctx.step("a", async () => 1));
      const id = await tf.start("t", null);
      const worker = tf.worker({
        leaseMs: 1000,
        workerId: "w",
        retention: { terminalTtl: "1h", sweepIntervalMs: 0 },
      });
      await worker.runOnce();
      expect((await tf.getRun(id))?.status).toBe("completed");

      clock.advance(2 * 3_600_000); // past the TTL; next runOnce sweeps before claiming
      await worker.runOnce();
      expect(await tf.getRun(id)).toBeNull();
      await store.close();
    });

    it("retry redrives a dead run with its journal preserved", async () => {
      const clock = controlledClock(1000);
      const store = await makeStore();
      const tf = throughline({ store, clock, sleep: noSleep });
      const calls = { a: 0, b: 0 };
      let broken = true;
      tf.task("t", async (ctx) => {
        const a = await ctx.step("a", async () => {
          calls.a++;
          return 1;
        });
        const b = await ctx.step(
          "b",
          async () => {
            calls.b++;
            if (broken) throw new Error("downstream outage");
            return a + 10;
          },
          { retry: { maxAttempts: 1, backoff: "fixed", baseMs: 1, jitter: false } },
        );
        return { a, b };
      });
      const id = await tf.start("t", null);
      const worker = tf.worker({ leaseMs: 1000, workerId: "w" });
      await worker.runOnce();
      expect((await tf.getRun(id))?.status).toBe("dead");

      const ops = createOps(store, clock);
      expect(await ops.retry(id)).toBe("retried");
      expect((await tf.getRun(id))?.status).toBe("pending");
      // A run that is not dead cannot be redriven.
      expect(await ops.retry(id)).toBe("not-dead");

      broken = false;
      await worker.runOnce();
      const run = await tf.getRun(id);
      expect(run?.status).toBe("completed");
      expect(run?.output).toEqual({ a: 1, b: 11 });
      expect(calls.a).toBe(1); // step "a" replayed from the journal, never re-run
      expect(calls.b).toBe(2); // failed once, succeeded once after the retry
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
    }, 30_000);
  });
}
