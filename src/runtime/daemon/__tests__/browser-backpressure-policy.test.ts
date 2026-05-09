import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { applyBrowserBackpressurePolicy } from "../browser-backpressure-policy.js";
import { GuardrailStore } from "../../guardrails/index.js";

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

  it("uses the configured control DB base for custom runtime roots", async () => {
    const runtimeRoot = path.join(tmpDir, "runtime-v2");
    await new GuardrailStore(runtimeRoot, { controlBaseDir: tmpDir }).saveBackpressureSnapshot({
      updated_at: "2026-01-01T00:00:00.000Z",
      active: [{
        provider_id: "manus_browser",
        service_key: "mail.example.com",
        run_key: "browser-run-1",
        acquired_at: new Date().toISOString(),
      }],
      throttled: [],
    });

    const result = await applyBrowserBackpressurePolicy({
      runtimeRoot,
      controlBaseDir: tmpDir,
      goalIds: ["goal-browser", "goal-normal"],
      snapshot: [{
        goalId: "goal-browser",
        shouldActivate: true,
        schedule: {
          browser_provider_id: "manus_browser",
          browser_service_key: "mail.example.com",
        } as never,
      }],
    });

    expect(result.activeGoalIds).toEqual(["goal-normal"]);
    await expect(new GuardrailStore(runtimeRoot, { controlBaseDir: tmpDir }).loadBackpressureSnapshot())
      .resolves.toEqual(expect.objectContaining({
        throttled: [
          expect.objectContaining({
            provider_id: "manus_browser",
            service_key: "mail.example.com",
            reason: expect.stringContaining("goal-browser"),
          }),
        ],
      }));
    expect(fs.existsSync(path.join(runtimeRoot, "state", "pulseed-control.sqlite"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "state", "pulseed-control.sqlite"))).toBe(true);
  });
});
