import { describe, it, expect } from "vitest";
import { buildThreshold } from "../../src/cli/commands/goal-utils.js";

describe("buildThreshold", () => {
  describe("range type", () => {
    it("parses comma-separated range", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "7,9" })).toEqual({
        type: "range",
        low: 7,
        high: 9,
      });
    });

    it("parses hyphen-separated range", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "7-9" })).toEqual({
        type: "range",
        low: 7,
        high: 9,
      });
    });

    it("parses negative range with hyphen fallback", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "-5-5" })).toEqual({
        type: "range",
        low: -5,
        high: 5,
      });
    });

    it("parses both-negative range with hyphen fallback", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "-10--5" })).toEqual({
        type: "range",
        low: -10,
        high: -5,
      });
    });

    it("parses negative decimal range with hyphen fallback", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "-5.5-10.5" })).toEqual({
        type: "range",
        low: -5.5,
        high: 10.5,
      });
    });

    it("parses decimal comma-separated range", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "10.5,20.5" })).toEqual({
        type: "range",
        low: 10.5,
        high: 20.5,
      });
    });

    it("returns null when value is missing", () => {
      expect(buildThreshold({ name: "x", type: "range", value: undefined })).toBeNull();
    });

    it("returns null when value is not parseable", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "abc" })).toBeNull();
    });
  });
});
