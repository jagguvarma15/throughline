import { type AppendStepInput, LeaseLostError, type Store } from "@through-line/core";
import { describe, expect, it } from "vitest";
import { controlledClock } from "../src/clock";
import { faultStore } from "../src/faultStore";

describe("controlledClock", () => {
  it("advances and sets time", () => {
    const c = controlledClock(100);
    expect(c.now()).toBe(100);
    c.advance(50);
    expect(c.now()).toBe(150);
    c.set(10);
    expect(c.now()).toBe(10);
  });
});

describe("faultStore", () => {
  function stub(): { inner: Store; appended: AppendStepInput[] } {
    const appended: AppendStepInput[] = [];
    const inner = {
      appendStep: async (s: AppendStepInput) => {
        appended.push(s);
        return { seq: appended.length - 1, replayed: false };
      },
      close: () => {},
    } as unknown as Store;
    return { inner, appended };
  }

  const step: AppendStepInput = {
    workflowId: "w",
    stepKey: "a#0",
    status: "completed",
    attempts: 1,
    now: 1,
  };

  it("delegates appendStep and returns the inner result", async () => {
    const { inner, appended } = stub();
    const r = await faultStore(inner, {}).appendStep(step);
    expect(r).toEqual({ seq: 0, replayed: false });
    expect(appended).toHaveLength(1);
  });

  it("crashes (LeaseLostError) after committing at a crashAt index", async () => {
    const { inner, appended } = stub();
    await expect(
      faultStore(inner, { crashAt: new Set([1]) }).appendStep(step),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(appended).toHaveLength(1); // committed before the simulated crash
  });

  it("duplicateStep delivers the same committing step twice", async () => {
    const { inner, appended } = stub();
    await faultStore(inner, { duplicateStep: "a#0" }).appendStep(step);
    expect(appended).toHaveLength(2);
  });
});
