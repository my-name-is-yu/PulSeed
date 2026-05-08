import { describe, expect, it } from "vitest";
import { parsePositiveInteger } from "../shared.js";

describe("parsePositiveInteger", () => {
  it("accepts exact positive integer strings", () => {
    expect(parsePositiveInteger("60", "--interval")).toBe(60);
    expect(parsePositiveInteger(" 10 ", "--limit")).toBe(10);
  });

  it("rejects partial numeric prefixes", () => {
    expect(() => parsePositiveInteger("60s", "--interval")).toThrow("--interval must be a positive integer");
    expect(() => parsePositiveInteger("1.5", "--interval")).toThrow("--interval must be a positive integer");
  });

  it("rejects non-positive, blank, and missing values", () => {
    expect(() => parsePositiveInteger("0", "--limit")).toThrow("--limit must be a positive integer");
    expect(() => parsePositiveInteger("-1", "--limit")).toThrow("--limit must be a positive integer");
    expect(() => parsePositiveInteger("", "--limit")).toThrow("--limit must be a positive integer");
    expect(() => parsePositiveInteger(undefined, "--limit")).toThrow("--limit must be a positive integer");
  });
});
