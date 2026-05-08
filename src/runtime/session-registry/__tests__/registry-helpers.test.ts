import { describe, expect, it } from "vitest";
import { classifyArtifact } from "../registry-helpers.js";

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
