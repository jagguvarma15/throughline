import type { CallModel } from "@throughline/adapters-llm";
import { throughline } from "@throughline/core";
import { sqlite } from "@throughline/store-sqlite";
import {
  type FaultPlan,
  controlledClock,
  faultStore,
  seedGolden,
  toGolden,
} from "@throughline/testing";
import { describe, expect, it } from "vitest";
import { registerResearch } from "../src/agent";
import { mockModel } from "../src/model";

describe("deep-research demo", () => {
  it("resumes after a crash with zero duplicate model calls or effects, then pauses for approval", async () => {
    const clock = controlledClock(1000);
    const plan: FaultPlan = { crashAfterStep: "search-0#0" };
    const store = faultStore(sqlite(":memory:"), plan);
    const tf = throughline({ store, clock, sleep: async () => {} });
    let modelCalls = 0;
    let published = 0;
    const model: CallModel<{ prompt: string }> = async (req) => {
      modelCalls++;
      return { text: `r:${req.prompt.length}`, usage: { totalTokens: 40 } };
    };
    registerResearch(tf, {
      model,
      budget: 10_000,
      publish: async () => {
        published++;
      },
    });
    const id = await tf.start("deep-research", { topic: "otters", maxIterations: 3 });
    const worker = tf.worker({ leaseMs: 1000, workerId: "w" });

    await worker.runOnce(); // plan + search-0 commit, then crash
    expect((await tf.getRun(id))?.status).toBe("running");

    plan.crashAfterStep = undefined;
    clock.advance(5000);
    await worker.runOnce(); // replay plan/search-0, run search-1/2 + draft, park at approval
    expect((await tf.getRun(id))?.status).toBe("waiting");

    await tf.signal(id, "publish", { approved: true });
    await worker.runOnce(); // publish + complete

    const run = await tf.getRun(id);
    expect(run?.status).toBe("completed");
    expect(modelCalls).toBe(5); // plan + 3 searches + draft, each exactly once
    expect(published).toBe(1); // published exactly once despite the crash
    await store.close();
  });

  it("halts a runaway loop at the token budget", async () => {
    const store = sqlite(":memory:");
    const tf = throughline({ store, clock: controlledClock(1000), sleep: async () => {} });
    registerResearch(tf, { model: mockModel(40), budget: 150 });
    const id = await tf.start("deep-research", { topic: "x", maxIterations: 100 });
    await tf.worker({ leaseMs: 1000 }).runOnce();

    const run = await tf.getRun(id);
    expect(run?.status).toBe("dead");
    expect(run?.error?.type).toBe("BudgetExceededError");
    await store.close();
  });

  it("replays the recorded trajectory offline with zero model calls or effects", async () => {
    // Record with a deterministic model.
    const recStore = sqlite(":memory:");
    const recTf = throughline({
      store: recStore,
      clock: controlledClock(1000),
      sleep: async () => {},
    });
    registerResearch(recTf, { model: mockModel(40), budget: 10_000, publish: async () => {} });
    const id = await recTf.start("deep-research", { topic: "otters", maxIterations: 2 });
    const worker = recTf.worker({ leaseMs: 1000, workerId: "rec" });
    await worker.runOnce();
    await recTf.signal(id, "publish", { approved: true });
    await worker.runOnce();
    const recorded = await recTf.getRun(id);
    if (!recorded) throw new Error("record failed");
    expect(recorded.status).toBe("completed");
    const golden = toGolden(recorded);
    await recStore.close();

    // Replay from the journal with a model + publish that throw if called.
    const repStore = sqlite(":memory:");
    const repTf = throughline({
      store: repStore,
      clock: controlledClock(1000),
      sleep: async () => {},
    });
    const explode: CallModel<{ prompt: string }> = async () => {
      throw new Error("model called during replay");
    };
    registerResearch(repTf, {
      model: explode,
      budget: 10_000,
      publish: async () => {
        throw new Error("publish during replay");
      },
    });
    const repId = await seedGolden(repStore, golden, 1000);
    await repTf.worker({ leaseMs: 1000, workerId: "rep" }).runOnce();

    const replayed = await repTf.getRun(repId);
    expect(replayed?.status).toBe("completed");
    expect(replayed?.output).toEqual(golden.output);
    await repStore.close();
  });
});
