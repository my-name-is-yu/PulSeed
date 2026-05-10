import { describe, expect, it } from "vitest";
import { parseResumeChoiceNumber } from "../resume-choice.js";

describe("parseResumeChoiceNumber", () => {
  it("accepts exact positive integer choices", () => {
    expect(parseResumeChoiceNumber("1")).toBe(1);
    expect(parseResumeChoiceNumber(" 2\n")).toBe(2);
  });

  it("rejects non-choice text and non-canonical numeric forms", () => {
    expect(parseResumeChoiceNumber("")).toBeNull();
    expect(parseResumeChoiceNumber("1.5")).toBeNull();
    expect(parseResumeChoiceNumber("01")).toBeNull();
    expect(parseResumeChoiceNumber("1e3")).toBeNull();
    expect(parseResumeChoiceNumber("latest")).toBeNull();
  });

  it("rejects unsafe integer choices", () => {
    expect(parseResumeChoiceNumber(String(Number.MAX_SAFE_INTEGER + 1))).toBeNull();
  });
});
