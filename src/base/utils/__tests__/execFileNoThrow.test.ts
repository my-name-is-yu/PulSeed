import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { execFileNoThrow } from "../execFileNoThrow.js";

const INVALID_TIMEOUT_ERROR = "Invalid timeoutMs: expected a safe integer";

function writeMarkerScript(markerPath: string): string {
  return `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran");`;
}

describe("execFileNoThrow", () => {
  it("runs a valid command and returns its captured output", async () => {
    const result = await execFileNoThrow(process.execPath, ["-e", "console.log('ok')"], {
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({ stdout: "ok\n", stderr: "", exitCode: 0 });
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["fractional", 1.5],
    ["zero", 0],
  ])("rejects %s timeoutMs before spawning a child process", async (_name, timeoutMs) => {
    const tmpDir = makeTempDir("pulseed-exec-timeout-");
    try {
      const markerPath = path.join(tmpDir, "marker");

      const result = await execFileNoThrow(process.execPath, ["-e", writeMarkerScript(markerPath)], {
        timeoutMs,
      });

      expect(result).toMatchObject({ stdout: "", exitCode: null });
      expect(result.stderr).toContain(INVALID_TIMEOUT_ERROR);
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("rejects invalid process-group timeoutMs before spawning a child process", async () => {
    const tmpDir = makeTempDir("pulseed-exec-group-timeout-");
    try {
      const markerPath = path.join(tmpDir, "marker");

      const result = await execFileNoThrow(process.execPath, ["-e", writeMarkerScript(markerPath)], {
        killProcessGroup: true,
        timeoutMs: Number.POSITIVE_INFINITY,
      });

      expect(result).toMatchObject({ stdout: "", exitCode: null });
      expect(result.stderr).toContain(INVALID_TIMEOUT_ERROR);
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });
});
