import { type Throughline, throughline } from "@through-line/core";
import { sqlite } from "@through-line/store-sqlite";
import { type FaultPlan, controlledClock, faultStore } from "@through-line/testing";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { experimental_durableStreamText } from "../src/index";

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

/** A scripted V4 streaming model; throws if called when `explode` is set. */
function streamingModel(counter: { calls: number }, explode = false): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => {
      if (explode) throw new Error("model must not be called on replay");
      counter.calls++;
      const deltas = ["Hello, ", "durable ", "world."];
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: "stream-start" as const, warnings: [] });
            c.enqueue({ type: "text-start" as const, id: "1" });
            for (const delta of deltas) {
              c.enqueue({ type: "text-delta" as const, id: "1", delta });
            }
            c.enqueue({ type: "text-end" as const, id: "1" });
            c.enqueue({
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: "stop" },
              usage: usage(5, 7),
            });
            c.close();
          },
        }),
      };
    },
  });
}

function registerStreamTask(
  tf: Throughline,
  model: MockLanguageModelV4,
  sink: string[],
  budget?: number,
): void {
  tf.task(
    "t",
    async (ctx) => {
      const { textStream, result } = experimental_durableStreamText(
        ctx,
        { model, prompt: "hi" },
        { name: "s", estimate: 10 },
      );
      const reader = textStream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sink.push(value);
      }
      const out = await result;
      return out.text;
    },
    budget === undefined ? undefined : { budget },
  );
}

describe("experimental_durableStreamText", () => {
  it("streams live once, journals the outcome, and replays instantly with no model call", async () => {
    const clock = controlledClock(1000);
    const plan: FaultPlan = { crashAfterStep: "s#0" };
    const store = faultStore(sqlite(":memory:"), plan);
    const counter = { calls: 0 };

    // First execution: live chunks, then the journal write commits, then the crash.
    const liveChunks: string[] = [];
    const tf1 = throughline({ store, clock, sleep: async () => {} });
    registerStreamTask(tf1, streamingModel(counter), liveChunks);
    const id = await tf1.start("t", null);
    await tf1.worker({ leaseMs: 1000, workerId: "w1" }).runOnce();
    expect(liveChunks).toEqual(["Hello, ", "durable ", "world."]);
    expect(counter.calls).toBe(1);

    // Resume on a fresh process with an exploding model: the journal must answer.
    plan.crashAfterStep = undefined;
    clock.advance(5000);
    const replayChunks: string[] = [];
    const tf2 = throughline({ store, clock, sleep: async () => {} });
    registerStreamTask(tf2, streamingModel(counter, true), replayChunks);
    await tf2.worker({ leaseMs: 1000, workerId: "w2" }).runOnce();

    const run = await tf2.getRun(id);
    expect(run?.status).toBe("completed");
    expect(run?.output).toBe("Hello, durable world.");
    expect(replayChunks).toEqual(["Hello, durable world."]); // one instant chunk
    expect(counter.calls).toBe(1); // the model was never re-called
    const step = run?.steps.find((s) => s.stepKey === "s#0");
    expect(step?.cost).toBe(12); // real usage charged to the budget
    await store.close();
  });

  it("refuses to start the stream when the budget cannot afford the estimate", async () => {
    const store = sqlite(":memory:");
    const counter = { calls: 0 };
    const chunks: string[] = [];
    const tf = throughline({ store, clock: controlledClock(1000), sleep: async () => {} });
    registerStreamTask(tf, streamingModel(counter), chunks, 5); // budget 5 < estimate 10
    const id = await tf.start("t", null);
    await tf.worker({ leaseMs: 1000, workerId: "w" }).runOnce();

    const run = await tf.getRun(id);
    expect(run?.status).toBe("dead");
    expect(run?.error?.type).toBe("BudgetExceededError");
    expect(counter.calls).toBe(0); // gated before any model call
    expect(chunks).toEqual([]);
    await store.close();
  });
});
