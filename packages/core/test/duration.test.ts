import { describe, expect, it } from "vitest";
import { parseDuration } from "../src/duration";

describe("parseDuration", () => {
  it("passes numbers through as milliseconds", () => {
    expect(parseDuration(500)).toBe(500);
  });

  it("parses unit suffixes", () => {
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseDuration(" 10 s ")).toBe(10_000);
  });

  it("throws on invalid input", () => {
    expect(() => parseDuration("5 weeks")).toThrow();
    expect(() => parseDuration("abc")).toThrow();
  });
});
