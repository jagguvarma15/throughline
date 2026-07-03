import { throughline } from "@throughline/core";
import { sqlite } from "@throughline/store-sqlite";
import {
  type FaultPlan,
  controlledClock,
  faultStore,
  seedGolden,
  toGolden,
} from "@throughline/testing";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { registerDrafter } from "../src/agent";
import { scriptedModel } from "../src/model";

const COMMITS = ["Fix lease fencing", "Make appendStep idempotent", "Add budget reconstruction"];

describe("ai-sdk-agent demo", () => {
  it("resumes a crashed tool loop with zero duplicate model calls or effects, then pauses for approval", async () => {
    const clock = controlledClock(1000);
    const plan: FaultPlan = { crashAfterStep: "model#0" };
    const store = faultStore(sqlite(":memory:"), plan);
    const tf = throughline({ store, clock, sleep: async () => {} });
    let toolRuns = 0;
    let published = 0;
    registerDrafter(tf, {
      model: scriptedModel(),
      getCommits: async () => {
        toolRuns++;
        return COMMITS;
      },
      budget: 10_000,
      publish: async () => {
        published++;
      },
    });
    const id = await tf.start("release-notes", { range: "v1..v2" });
    const worker = tf.worker({ leaseMs: 1000, workerId: "w" });

    await worker.runOnce(); // model#0 commits, then crash before the tool runs
    expect((await tf.getRun(id))?.status).toBe("running");

    plan.crashAfterStep = undefined;
    clock.advance(5000);
    await worker.runOnce(); // replay model#0, run tool + model#1, park at approval
    expect((await tf.getRun(id))?.status).toBe("waiting");

    await tf.signal(id, "publish", { approved: true });
    await worker.runOnce(); // publish + complete

    const run = await tf.getRun(id);
    expect(run?.status).toBe("completed");
    expect(toolRuns).toBe(1); // toolCallId-keyed step: exactly once despite the crash
    expect(published).toBe(1); // published exactly once
    expect((run?.output as { commits: number }).commits).toBe(COMMITS.length);
    await store.close();
  });

  it("halts at the token budget before the first model call", async () => {
    const store = sqlite(":memory:");
    const tf = throughline({ store, clock: controlledClock(1000), sleep: async () => {} });
    registerDrafter(tf, { model: scriptedModel(), getCommits: async () => COMMITS, budget: 10 });
    const id = await tf.start("release-notes", { range: "v1..v2" });
    await tf.worker({ leaseMs: 1000 }).runOnce();

    const run = await tf.getRun(id);
    expect(run?.status).toBe("dead");
    expect(run?.error?.type).toBe("BudgetExceededError");
    await store.close();
  });

  it("replays the recorded trajectory offline with zero model or tool calls", async () => {
    // RECORD with the scripted model and a real tool.
    const recStore = sqlite(":memory:");
    const recTf = throughline({
      store: recStore,
      clock: controlledClock(1000),
      sleep: async () => {},
    });
    registerDrafter(recTf, {
      model: scriptedModel(),
      getCommits: async () => COMMITS,
      budget: 10_000,
      publish: async () => {},
    });
    const id = await recTf.start("release-notes", { range: "v1..v2" });
    const worker = recTf.worker({ leaseMs: 1000, workerId: "rec" });
    await worker.runOnce();
    await recTf.signal(id, "publish", { approved: true });
    await worker.runOnce();
    const recorded = await recTf.getRun(id);
    if (!recorded) throw new Error("record failed");
    expect(recorded.status).toBe("completed");
    const golden = toGolden(recorded);
    await recStore.close();

    // REPLAY from the journal: model, tool, and publish throw if anything reaches them.
    const repStore = sqlite(":memory:");
    const repTf = throughline({
      store: repStore,
      clock: controlledClock(1000),
      sleep: async () => {},
    });
    registerDrafter(repTf, {
      model: new MockLanguageModelV4({
        doGenerate: async () => {
          throw new Error("model called during replay");
        },
      }),
      getCommits: async () => {
        throw new Error("tool called during replay");
      },
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
