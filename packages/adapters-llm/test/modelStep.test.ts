import { type Context, throughline } from "@throughline/core";
import { sqlite } from "@throughline/store-sqlite";
import { describe, expect, it } from "vitest";
import { type CallModel, modelStep } from "../src/index";

describe("modelStep", () => {
  it("journals the response and charges actual usage to ctx.tokens", async () => {
    const store = sqlite(":memory:");
    const tf = throughline({ store, sleep: async () => {} });
    let calls = 0;
    const model: CallModel<{ prompt: string }> = async () => {
      calls++;
      return { text: "hello", usage: { totalTokens: 30 } };
    };
    let consumed = 0;
    tf.task(
      "t",
      async (ctx: Context) => {
        const r = await modelStep(ctx, "ask", model, { prompt: "x" });
        consumed = ctx.tokens.consumed;
        return r.text;
      },
      { budget: 100 },
    );
    const id = await tf.start("t", null);
    await tf.worker({ leaseMs: 1000 }).runOnce();

    const run = await tf.getRun(id);
    expect(run?.status).toBe("completed");
    expect(run?.output).toBe("hello");
    expect(calls).toBe(1);
    expect(consumed).toBe(30);
    await store.close();
  });
});
