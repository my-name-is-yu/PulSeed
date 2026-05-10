import { describe, expect, it } from "vitest";
import { classifyArtifact, numberToIso } from "../registry-helpers.js";

describe("classifyArtifact", () => {
  it("does not classify arbitrary log substrings as logs", () => {
    expect(classifyArtifact("/tmp/catalog.json")).toBe("other");
    expect(classifyArtifact("/tmp/dialog.txt")).toBe("report");
  });

  it("classifies log artifacts by extension or filename token", () => {
    expect(classifyArtifact("/tmp/stdout.log")).toBe("log");
    expect(classifyArtifact("/tmp/build-log.json")).toBe("log");
    expect(classifyArtifact("/tmp/runtime.logs.txt")).toBe("log");
  });

  it("classifies metric artifacts by JSON filename tokens", () => {
    expect(classifyArtifact("/tmp/metrics.json")).toBe("metrics");
    expect(classifyArtifact("/tmp/public-score.json")).toBe("metrics");
    expect(classifyArtifact("/tmp/evidence-results.json")).toBe("metrics");
  });
});

describe("numberToIso", () => {
  it("returns ISO strings for valid epoch millisecond values", () => {
    expect(numberToIso(Date.parse("2026-04-25T00:00:00.000Z"))).toBe("2026-04-25T00:00:00.000Z");
  });

  it("returns null for finite numbers outside the JavaScript Date range", () => {
    expect(numberToIso(Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(numberToIso(-Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(numberToIso(1e100)).toBeNull();
  });
});
