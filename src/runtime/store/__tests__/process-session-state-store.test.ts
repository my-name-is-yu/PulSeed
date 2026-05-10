import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProcessSessionStateStore } from "../process-session-state-store.js";

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "session-1",
    label: "test",
    command: "npm",
    args: ["test"],
    cwd: "/workspace",
    running: false,
    exitCode: 0,
    signal: null,
    startedAt: "2026-05-10T00:00:00.000Z",
    exitedAt: "2026-05-10T00:00:01.000Z",
    bufferedChars: 128,
    ...overrides,
  };
}

describe("ProcessSessionStateStore", () => {
  it("persists process session snapshots with safe buffered character counts", async () => {
    const tmpRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-process-session-"));
    try {
      const store = new ProcessSessionStateStore(tmpRuntime);

      await store.saveSnapshot(makeSnapshot({ bufferedChars: Number.MAX_SAFE_INTEGER }));

      await expect(new ProcessSessionStateStore(tmpRuntime).loadSnapshot("session-1")).resolves.toEqual(
        expect.objectContaining({
          session_id: "session-1",
          bufferedChars: Number.MAX_SAFE_INTEGER,
        }),
      );
      await expect(fs.stat(path.join(tmpRuntime, "runtime", "process-sessions", "session-1.json"))).rejects.toThrow();
    } finally {
      await fs.rm(tmpRuntime, { recursive: true, force: true });
    }
  });

  it("rejects unsafe persisted buffered character counts through the raw state boundary", async () => {
    const tmpRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-process-session-"));
    try {
      const store = new ProcessSessionStateStore(tmpRuntime);

      await expect(
        store.writeRawPath("runtime/process-sessions/session-unsafe.json", makeSnapshot({
          bufferedChars: Number.MAX_SAFE_INTEGER + 1,
        })),
      ).rejects.toThrow();

      await expect(store.loadSnapshot("session-unsafe")).resolves.toBeNull();
    } finally {
      await fs.rm(tmpRuntime, { recursive: true, force: true });
    }
  });
});
