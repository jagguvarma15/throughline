import { describe, expect, it } from "vitest";
import { deriveKey, OrdinalCounter, stepKey } from "../src/keys";

describe("deriveKey", () => {
  it("is stable for identical inputs", () => {
    expect(deriveKey("a", 1, { x: 2 })).toBe(deriveKey("a", 1, { x: 2 }));
  });

  it("avoids concatenation collisions and distinguishes inputs", () => {
    expect(deriveKey("a", "b")).not.toBe(deriveKey("ab"));
    expect(deriveKey("a")).not.toBe(deriveKey("b"));
  });

  it("returns a 32-char hex string", () => {
    expect(deriveKey("x")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("stepKey", () => {
  it("uses name#ordinal by default", () => {
    expect(stepKey("fetch", 0)).toBe("fetch#0");
    expect(stepKey("fetch", 3)).toBe("fetch#3");
  });

  it("prefers an explicit idempotency key", () => {
    expect(stepKey("fetch", 0, "explicit")).toBe("explicit");
  });
});

describe("OrdinalCounter", () => {
  it("counts per name independently and resets", () => {
    const c = new OrdinalCounter();
    expect(c.next("a")).toBe(0);
    expect(c.next("a")).toBe(1);
    expect(c.next("b")).toBe(0);
    c.reset();
    expect(c.next("a")).toBe(0);
  });
});
