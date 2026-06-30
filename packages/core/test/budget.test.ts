import { describe, expect, it } from "vitest";
import { Budget } from "../src/budget";

describe("Budget", () => {
  it("tracks consumption and remaining", () => {
    const b = new Budget(100);
    expect(b.consumed).toBe(0);
    expect(b.remaining()).toBe(100);
    b.consume(30);
    expect(b.consumed).toBe(30);
    expect(b.remaining()).toBe(70);
  });

  it("canAfford respects the limit", () => {
    const b = new Budget(100, 90);
    expect(b.canAfford(10)).toBe(true);
    expect(b.canAfford(11)).toBe(false);
  });

  it("clamps remaining at zero when over limit", () => {
    const b = new Budget(100, 90);
    b.consume(50);
    expect(b.remaining()).toBe(0);
  });

  it("is unbounded by default", () => {
    const b = new Budget();
    expect(b.remaining()).toBe(Number.POSITIVE_INFINITY);
    expect(b.canAfford(1e9)).toBe(true);
  });

  it("rejects negative consumption", () => {
    expect(() => new Budget(10).consume(-1)).toThrow(RangeError);
  });
});
