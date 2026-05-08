import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonStateSchema } from "../../types/daemon.js";
import { resolveConfiguredDaemonRuntimeRoot } from "../runtime-root.js";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";

const tempDirs: string[] = [];

function makeBaseDir(): string {
  const dir = makeTempDir();
  tempDirs.push(dir);
  return dir;
}

function makeDaemonState(pid: number): Record<string, unknown> {
  return {
    pid,
    started_at: "2026-05-09T00:00:00.000Z",
    last_loop_at: null,
    loop_count: 0,
    active_goals: [],
    status: "running",
    runtime_root: "/corrupt-runtime-root",
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    cleanupTempDir(dir);
  }
  vi.restoreAllMocks();
});

describe("DaemonStateSchema", () => {
  it("rejects daemon-state pids outside the safe integer range", () => {
    const parsed = DaemonStateSchema.safeParse(makeDaemonState(Number.MAX_SAFE_INTEGER + 1));

    expect(parsed.success).toBe(false);
  });
});

describe("resolveConfiguredDaemonRuntimeRoot", () => {
  it("ignores running daemon-state runtime roots when the persisted pid is unsafe", () => {
    const baseDir = makeBaseDir();
    fs.writeFileSync(
      path.join(baseDir, "daemon.json"),
      JSON.stringify({ runtime_root: "configured-runtime" }),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(baseDir, "daemon-state.json"),
      JSON.stringify(makeDaemonState(Number.MAX_SAFE_INTEGER + 1)),
      "utf-8"
    );
    const killSpy = vi.spyOn(process, "kill");

    expect(resolveConfiguredDaemonRuntimeRoot(baseDir)).toBe(path.join(baseDir, "configured-runtime"));
    expect(killSpy).not.toHaveBeenCalled();
  });
});
