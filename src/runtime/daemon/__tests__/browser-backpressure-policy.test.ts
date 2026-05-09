import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { applyBrowserBackpressurePolicy } from "../browser-backpressure-policy.js";

describe("applyBrowserBackpressurePolicy", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("rejects unsafe numeric backpressure options", async () => {
    await expect(applyBrowserBackpressurePolicy({
      runtimeRoot: tmpDir,
      goalIds: ["goal-browser"],
      snapshot: [],
      leaseTtlMs: Number.NaN,
    })).rejects.toThrow("leaseTtlMs");

    await expect(applyBrowserBackpressurePolicy({
      runtimeRoot: tmpDir,
      goalIds: ["goal-browser"],
      snapshot: [],
      maxConcurrentPerProvider: Number.MAX_SAFE_INTEGER + 1,
    })).rejects.toThrow("maxConcurrentPerProvider");
  });
});
