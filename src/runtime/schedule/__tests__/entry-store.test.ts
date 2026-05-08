import { afterEach, describe, expect, it, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { ScheduleEntryStore } from "../entry-store.js";

describe("ScheduleEntryStore", () => {
  let tmpDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) cleanupTempDir(tmpDir);
  });

  it("reclaims an aged schedule file lock when owner pid is not a safe process id", async () => {
    tmpDir = makeTempDir();
    const lockDir = path.join(tmpDir, "schedules.json.lock");
    await fsp.mkdir(lockDir, { recursive: true });
    await fsp.writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ pid: -1 }), "utf-8");
    const staleTime = new Date(Date.now() - 60_000);
    await fsp.utimes(lockDir, staleTime, staleTime);

    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number | NodeJS.Signals, signal?: NodeJS.Signals | number) => {
      if (pid === -1 && signal === 0) {
        return true;
      }
      throw new Error(`unexpected process probe for ${String(pid)}`);
    }) as typeof process.kill);

    let ownerDuringPersist: unknown;
    const store = new ScheduleEntryStore(tmpDir, { warn: vi.fn() }, async () => {
      const ownerRaw = await fsp.readFile(path.join(lockDir, "owner.json"), "utf-8");
      ownerDuringPersist = JSON.parse(ownerRaw);
    });

    await expect(store.saveEntries([])).resolves.toBeUndefined();

    expect(killSpy).not.toHaveBeenCalled();
    expect(ownerDuringPersist).toMatchObject({ pid: process.pid });
    await expect(fsp.access(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
