import { resolve } from "node:path";
import { type Context, type Throughline, throughline } from "@through-line/core";
import {
  controlledClock,
  goldenExists,
  readGolden,
  seedGolden,
  toGolden,
  writeGolden,
} from "@through-line/testing";
import { describe, expect, it } from "vitest";
import { sqlite } from "../src/index";

interface Tools {
  plan(topic: string): Promise<string[]>;
  search(query: string): Promise<string>;
  summarize(findings: string[]): Promise<string>;
}

// A small multi-step, tool-using "research" trajectory.
function research(tf: Throughline, tools: Tools): void {
  tf.task("research", async (ctx: Context, input: { topic: string }) => {
    const queries = await ctx.step("plan", () => tools.plan(input.topic));
    const findings: string[] = [];
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      if (q === undefined) continue;
      findings.push(await ctx.step(`search-${i}`, () => tools.search(q)));
    }
    const summary = await ctx.step("summarize", () => tools.summarize(findings));
    return { summary, queries };
  });
}

// Deterministic stub tools used to RECORD the golden (stand in for model/tool calls).
const realTools: Tools = {
  plan: async (topic) => [`${topic} history`, `${topic} status`],
  search: async (query) => `result(${query})`,
  summarize: async (findings) => `summary[${findings.join("; ")}]`,
};

// During REPLAY, any tool call means we hit the network — fail loudly.
const explode = (name: string) => (): never => {
  throw new Error(`tool called during replay: ${name}`);
};
const explodingTools: Tools = {
  plan: explode("plan"),
  search: explode("search"),
  summarize: explode("summarize"),
};

const GOLDEN = resolve(import.meta.dirname, "fixtures/research.golden.json");

describe("golden-trace replay", () => {
  it("records a trajectory and replays it offline with zero tool calls", async () => {
    // RECORD with deterministic stub tools.
    const recStore = sqlite(":memory:");
    const recTf = throughline({
      store: recStore,
      clock: controlledClock(1000),
      sleep: async () => {},
    });
    research(recTf, realTools);
    const id = await recTf.start("research", { topic: "otters" });
    await recTf.worker({ leaseMs: 1000, workerId: "rec" }).runOnce();
    const recorded = await recTf.getRun(id);
    if (!recorded) throw new Error("record failed");
    expect(recorded.status).toBe("completed");
    const trace = toGolden(recorded);
    await recStore.close();

    // Commit the golden on first run / when UPDATE_GOLDEN is set; otherwise assert no drift.
    if (!goldenExists(GOLDEN) || process.env.UPDATE_GOLDEN) writeGolden(GOLDEN, trace);
    const golden = readGolden(GOLDEN);
    expect(trace.output).toEqual(golden.output);
    expect(trace.steps.map((s) => s.stepKey)).toEqual(golden.steps.map((s) => s.stepKey));

    // REPLAY offline: seed from the golden, run with exploding tools — none may fire.
    const repStore = sqlite(":memory:");
    const repTf = throughline({
      store: repStore,
      clock: controlledClock(1000),
      sleep: async () => {},
    });
    research(repTf, explodingTools);
    const repId = await seedGolden(repStore, golden, 1000);
    await repTf.worker({ leaseMs: 1000, workerId: "rep" }).runOnce();
    const replayed = await repTf.getRun(repId);
    expect(replayed?.status).toBe("completed");
    expect(replayed?.output).toEqual(golden.output);
    await repStore.close();
  });
});
