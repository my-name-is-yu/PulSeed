import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { WaitMetadataSchema, type WaitMetadata } from "../types/strategy.js";
import {
  buildWaitApprovalId,
  evaluateWaitConditions,
  isProcessPidValue,
  isProcessTimestampValue,
  parseJsonPointerArrayIndex,
  readJsonPointer,
  resolveConditionPath,
} from "../portfolio-wait-observation.js";

function waitMetadata(overrides: Partial<WaitMetadata> = {}): WaitMetadata {
  return WaitMetadataSchema.parse({
    wait_until: "2026-05-10T00:00:00.000Z",
    conditions: [],
    ...overrides,
  });
}

describe("portfolio wait observation helpers", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("keeps wait approval ids deterministic and URL-safe", () => {
    expect(buildWaitApprovalId("goal/one", "strategy two")).toBe("wait-goal%2Fone-strategy%20two");
  });

  it("resolves condition paths inside the state base and rejects escapes", () => {
    expect(resolveConditionPath("runtime/metrics.json", tmpDir)).toBe(path.join(tmpDir, "runtime", "metrics.json"));
    expect(resolveConditionPath(path.join(tmpDir, "runtime", "metrics.json"), tmpDir)).toBe(
      path.join(tmpDir, "runtime", "metrics.json")
    );
    expect(resolveConditionPath("../outside.json", tmpDir)).toBeNull();
    expect(resolveConditionPath(path.dirname(tmpDir), tmpDir)).toBeNull();
  });

  it("reads JSON pointers while rejecting unsafe array indexes", () => {
    const value = {
      metrics: [{ label: "score", value: 0.91 }],
      "escaped/key": { "~field": true },
    };
    expect(readJsonPointer(value, "/metrics/0/value")).toBe(0.91);
    expect(readJsonPointer(value, "/escaped~1key/~0field")).toBe(true);
    expect(readJsonPointer(value, "metrics.0.label")).toBe("score");
    expect(readJsonPointer(value, `/metrics/${Number.MAX_SAFE_INTEGER + 1}/value`)).toBeUndefined();

    expect(parseJsonPointerArrayIndex("2")).toBe(2);
    expect(parseJsonPointerArrayIndex("-1")).toBeNull();
    expect(parseJsonPointerArrayIndex(String(Number.MAX_SAFE_INTEGER + 1))).toBeNull();
  });

  it("validates process snapshot pid and timestamp boundary values before liveness checks", () => {
    expect(isProcessPidValue(process.pid)).toBe(true);
    expect(isProcessPidValue(0)).toBe(false);
    expect(isProcessPidValue(Number.NaN)).toBe(false);
    expect(isProcessPidValue(Number.MAX_SAFE_INTEGER + 1)).toBe(false);

    expect(isProcessTimestampValue("2026-05-10T00:00:00.000Z")).toBe(true);
    expect(isProcessTimestampValue("2026-05-10T00:00:00Z")).toBe(false);
    expect(isProcessTimestampValue("not-a-date")).toBe(false);
  });

  it("evaluates artifact JSON conditions through state-base path and pointer guards", async () => {
    await fsp.writeFile(
      path.join(tmpDir, "result.json"),
      `${JSON.stringify({ metrics: [{ label: "score", value: 0.92 }] })}\n`,
      "utf8"
    );

    const satisfied = await evaluateWaitConditions([
      {
        type: "artifact_json_value",
        path: "result.json",
        json_pointer: "/metrics/0/value",
        expected: 0.92,
      },
    ], waitMetadata(), {
      nowMs: Date.parse("2026-05-10T00:00:00.000Z"),
      stateBaseDir: tmpDir,
    });
    expect(satisfied).toMatchObject({
      status: "satisfied",
      next_observe_at: null,
      resume_hint: "wait_conditions_satisfied",
    });

    const escaped = await evaluateWaitConditions([
      {
        type: "file_exists",
        path: "../outside.txt",
      },
    ], waitMetadata(), {
      nowMs: Date.parse("2026-05-10T00:00:00.000Z"),
      stateBaseDir: tmpDir,
    });
    expect(escaped.status).toBe("failed");
    expect(escaped.resume_hint).toContain("path escapes state base");
  });
});
