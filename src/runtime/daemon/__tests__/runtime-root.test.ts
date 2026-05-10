import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonStateSchema } from "../../types/daemon.js";
import { resolveConfiguredDaemonRuntimeRoot } from "../runtime-root.js";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { DaemonStateStore, openControlDatabaseSync } from "../../store/index.js";

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

async function saveDaemonStateFixture(baseDir: string, state: Record<string, unknown>): Promise<void> {
  await new DaemonStateStore(baseDir).save(state as never);
}

function insertRawDaemonStateFixture(baseDir: string, state: Record<string, unknown>): void {
  const database = openControlDatabaseSync({ baseDir });
  try {
    database.transaction((db) => {
      db.prepare(`
        INSERT INTO daemon_state_snapshots (
          state_id,
          pid,
          status,
          runtime_root,
          loop_count,
          updated_at,
          state_json
        )
        VALUES ('current', ?, ?, ?, ?, ?, json(?))
        ON CONFLICT(state_id) DO UPDATE SET
          pid = excluded.pid,
          status = excluded.status,
          runtime_root = excluded.runtime_root,
          loop_count = excluded.loop_count,
          updated_at = excluded.updated_at,
          state_json = excluded.state_json
      `).run(
        state["pid"] ?? null,
        state["status"] ?? "running",
        state["runtime_root"] ?? null,
        state["loop_count"] ?? 0,
        state["last_loop_at"] ?? state["started_at"] ?? new Date().toISOString(),
        JSON.stringify(state)
      );
    });
  } finally {
    database.close();
  }
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
  it("falls back for malformed daemon config but surfaces real config read errors", () => {
    const malformedDir = makeBaseDir();
    fs.writeFileSync(path.join(malformedDir, "daemon.json"), "{not json", "utf-8");
    fs.writeFileSync(
      path.join(malformedDir, "daemon-config.json"),
      JSON.stringify({ runtime_root: "legacy-runtime" }),
      "utf-8"
    );

    expect(resolveConfiguredDaemonRuntimeRoot(malformedDir)).toBe(path.join(malformedDir, "legacy-runtime"));

    const unreadableDir = makeBaseDir();
    fs.mkdirSync(path.join(unreadableDir, "daemon.json"));

    expect(() => resolveConfiguredDaemonRuntimeRoot(unreadableDir)).toThrow(/EISDIR|illegal operation on a directory/);
  });

  it("uses running daemon state from the control DB before daemon config", async () => {
    const baseDir = makeBaseDir();
    fs.writeFileSync(
      path.join(baseDir, "daemon.json"),
      JSON.stringify({ runtime_root: "configured-runtime" }),
      "utf-8"
    );
    await saveDaemonStateFixture(baseDir, makeDaemonState(process.pid));

    expect(resolveConfiguredDaemonRuntimeRoot(baseDir)).toBe("/corrupt-runtime-root");
  });

  it("keeps the running daemon runtime root when the pid probe reports EPERM", async () => {
    const baseDir = makeBaseDir();
    fs.writeFileSync(
      path.join(baseDir, "daemon.json"),
      JSON.stringify({ runtime_root: "configured-runtime" }),
      "utf-8"
    );
    await saveDaemonStateFixture(baseDir, makeDaemonState(4242));
    const permissionError = new Error("permission denied") as NodeJS.ErrnoException;
    permissionError.code = "EPERM";
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw permissionError;
    });

    expect(resolveConfiguredDaemonRuntimeRoot(baseDir)).toBe("/corrupt-runtime-root");
    expect(killSpy).toHaveBeenCalledWith(4242, 0);
  });

  it("falls back for malformed control DB daemon state rows", () => {
    const malformedDir = makeBaseDir();
    fs.writeFileSync(
      path.join(malformedDir, "daemon.json"),
      JSON.stringify({ runtime_root: "configured-runtime" }),
      "utf-8"
    );
    insertRawDaemonStateFixture(malformedDir, makeDaemonState(Number.MAX_SAFE_INTEGER + 1));

    expect(resolveConfiguredDaemonRuntimeRoot(malformedDir)).toBe(path.join(malformedDir, "configured-runtime"));
  });

  it("ignores running daemon-state runtime roots when the persisted pid is unsafe", () => {
    const baseDir = makeBaseDir();
    fs.writeFileSync(
      path.join(baseDir, "daemon.json"),
      JSON.stringify({ runtime_root: "configured-runtime" }),
      "utf-8"
    );
    insertRawDaemonStateFixture(baseDir, makeDaemonState(Number.MAX_SAFE_INTEGER + 1));
    const killSpy = vi.spyOn(process, "kill");

    expect(resolveConfiguredDaemonRuntimeRoot(baseDir)).toBe(path.join(baseDir, "configured-runtime"));
    expect(killSpy).not.toHaveBeenCalled();
  });
});
