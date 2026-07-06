import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { throughline } from "@through-line/core";
import { controlledClock } from "@through-line/testing";
import { afterEach, describe, expect, it } from "vitest";
import { sqlite } from "../src/index";

describe("OpenTelemetry spans", () => {
  afterEach(() => {
    trace.disable();
    context.disable();
  });

  it("emits a workflow span with child step spans", async () => {
    // A context manager (the OTel Node SDK registers one in production) is required for
    // span nesting across async/await.
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);

    const tf = throughline({
      store: sqlite(":memory:"),
      clock: controlledClock(1000),
      sleep: async () => {},
    });
    tf.task("demo", async (ctx) => {
      await ctx.step("a", async () => 1);
      await ctx.step("b", async () => 2);
      return "ok";
    });
    const id = await tf.start("demo", null);
    await tf.worker({ leaseMs: 1000 }).runOnce();
    expect((await tf.getRun(id))?.status).toBe("completed");

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const wf = spans.find((s) => s.name === "workflow demo");
    const steps = spans.filter((s) => s.name.startsWith("step "));

    expect(wf).toBeTruthy();
    expect(steps.map((s) => s.name).sort()).toEqual(["step a", "step b"]);
    const wfId = wf?.spanContext().spanId;
    expect(steps.every((s) => s.parentSpanContext?.spanId === wfId)).toBe(true);
    expect(steps.find((s) => s.name === "step a")?.attributes["throughline.step_key"]).toBe("a#0");
  });
});
