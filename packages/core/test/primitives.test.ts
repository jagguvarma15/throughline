import { describe, expect, it } from "vitest";
import { systemClock } from "../src/clock";
import { uuid } from "../src/id";

describe("primitives", () => {
  it("uuid generates unique v4-shaped ids", () => {
    expect(uuid()).not.toBe(uuid());
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("systemClock.now returns epoch-ms", () => {
    const t = systemClock.now();
    expect(typeof t).toBe("number");
    expect(t).toBeGreaterThan(1_700_000_000_000);
  });
});
