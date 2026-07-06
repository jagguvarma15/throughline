import { type Context, type Throughline, throughline } from "@through-line/core";
import { sqlite } from "@through-line/store-sqlite";
import {
  type FaultPlan,
  controlledClock,
  faultStore,
  seedGolden,
  toGolden,
} from "@through-line/testing";
import { generateText, jsonSchema, stepCountIs, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { durableModel, durableToolExecute } from "../src/index";

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: usage(10, 5),
  warnings: [],
  response: { id: "res-1", modelId: "mock", timestamp: new Date(1_700_000_000_000) },
});

const toolCallResult = () => ({
  content: [
    {
      type: "tool-call" as const,
      toolCallId: "call-1",
      toolName: "getCommits",
      input: JSON.stringify({ range: "v1..v2" }),
    },
  ],
  finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
  usage: usage(8, 4),
  warnings: [],
});

// Deterministic scripted model: tool-call first, final text once a tool result is in the
// prompt — decided from the request, not an instance counter, so it behaves identically
// when a "restarted worker" replays with a fresh instance.
const scriptedModel = (counter: { calls: number }) =>
  new MockLanguageModelV4({
    doGenerate: async (options) => {
      counter.calls++;
      return options.prompt.some((m) => m.role === "tool")
        ? textResult("notes: fixed leases")
        : toolCallResult();
    },
  });

// The drafter loop under test: one model-driven tool round, durable at every seam.
function registerDraft(
  tf: Throughline,
  model: MockLanguageModelV4,
  getCommits: (range: string) => Promise<string>,
): void {
  tf.task("draft", async (ctx: Context, input: { range: string }) => {
    const res = await generateText({
      model: durableModel(ctx, model),
      tools: {
        getCommits: tool({
          description: "List commits in a range",
          inputSchema: jsonSchema<{ range: string }>({
            type: "object",
            properties: { range: { type: "string" } },
            required: ["range"],
          }),
          execute: durableToolExecute(ctx, "getCommits", ({ range }) => getCommits(range)),
        }),
      },
      stopWhen: stepCountIs(3),
      maxRetries: 0,
      prompt: `draft release notes for ${input.range}`,
    });
    return res.text;
  });
}

describe("adapters-ai-sdk", () => {
  it("journals the model call, charges usage to ctx.tokens, and revives the response Date", async () => {
    const store = sqlite(":memory:");
    const tf = throughline({ store, sleep: async () => {} });
    const counter = { calls: 0 };
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        counter.calls++;
        return textResult("hello");
      },
    });
    let consumed = 0;
    let timestampIsDate = false;
    tf.task(
      "t",
      async (ctx: Context) => {
        const res = await generateText({
          model: durableModel(ctx, model),
          maxRetries: 0,
          prompt: "hi",
        });
        consumed = ctx.tokens.consumed;
        timestampIsDate = res.response.timestamp instanceof Date;
        return res.text;
      },
      { budget: 100 },
    );
    const id = await tf.start("t", null);
    await tf.worker({ leaseMs: 1000 }).runOnce();

    const run = await tf.getRun(id);
    expect(run?.status).toBe("completed");
    expect(run?.output).toBe("hello");
    expect(counter.calls).toBe(1);
    expect(consumed).toBe(15); // inputTokens.total 10 + outputTokens.total 5
    expect(timestampIsDate).toBe(true);
    await store.close();
  });

  it("resumes a crashed tool loop with zero duplicate model calls or tool effects", async () => {
    const clock = controlledClock(1000);
    const plan: FaultPlan = { crashAfterStep: "model#0" };
    const store = faultStore(sqlite(":memory:"), plan);
    const tf = throughline({ store, clock, sleep: async () => {} });
    const counter = { calls: 0 };
    let toolRuns = 0;
    registerDraft(tf, scriptedModel(counter), async (range) => {
      toolRuns++;
      return `commits(${range})`;
    });
    const id = await tf.start("draft", { range: "v1..v2" });
    const worker = tf.worker({ leaseMs: 1000, workerId: "w" });

    await worker.runOnce(); // model#0 commits, then crash before the tool runs
    expect((await tf.getRun(id))?.status).toBe("running");

    plan.crashAfterStep = undefined;
    clock.advance(5000);
    await worker.runOnce(); // replay model#0 from the journal, run tool + model#1

    const run = await tf.getRun(id);
    expect(run?.status).toBe("completed");
    expect(run?.output).toBe("notes: fixed leases");
    expect(counter.calls).toBe(2); // one per unique model step, none replayed against the provider
    expect(toolRuns).toBe(1); // toolCallId-keyed step: exactly once across the crash
    await store.close();
  });

  it("replays a recorded tool-loop trajectory offline with zero model or tool calls", async () => {
    // RECORD with the scripted model and a real tool.
    const recStore = sqlite(":memory:");
    const recTf = throughline({
      store: recStore,
      clock: controlledClock(1000),
      sleep: async () => {},
    });
    registerDraft(recTf, scriptedModel({ calls: 0 }), async (range) => `commits(${range})`);
    const id = await recTf.start("draft", { range: "v1..v2" });
    await recTf.worker({ leaseMs: 1000, workerId: "rec" }).runOnce();
    const recorded = await recTf.getRun(id);
    if (!recorded) throw new Error("record failed");
    expect(recorded.status).toBe("completed");
    const golden = toGolden(recorded);
    await recStore.close();

    // REPLAY from the journal: model and tool throw if anything reaches them.
    const repStore = sqlite(":memory:");
    const repTf = throughline({
      store: repStore,
      clock: controlledClock(1000),
      sleep: async () => {},
    });
    const explodingModel = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("model called during replay");
      },
    });
    registerDraft(repTf, explodingModel, async () => {
      throw new Error("tool called during replay");
    });
    const repId = await seedGolden(repStore, golden, 1000);
    await repTf.worker({ leaseMs: 1000, workerId: "rep" }).runOnce();

    const replayed = await repTf.getRun(repId);
    expect(replayed?.status).toBe("completed");
    expect(replayed?.output).toEqual(golden.output);
    await repStore.close();
  });
});
