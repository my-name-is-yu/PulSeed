import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { PIDManager } from "../pid-manager.js";
import { makeTempDir } from "../../../tests/helpers/temp-dir.js";

// ─── Test Suite ───

describe("PIDManager", () => {
  let tmpDir: string;
  let pidManager: PIDManager;

  beforeEach(() => {
    tmpDir = makeTempDir();
    pidManager = new PIDManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
  });

  // ─── constructor / getPath ───

  describe("constructor and getPath", () => {
    it("should use default PID filename 'pulseed.pid'", () => {
      expect(pidManager.getPath()).toBe(path.join(tmpDir, "pulseed.pid"));
    });

    it("should support a custom PID filename", () => {
      const custom = new PIDManager(tmpDir, "custom.pid");
      expect(custom.getPath()).toBe(path.join(tmpDir, "custom.pid"));
    });

    it("should build the path from baseDir and pidFile correctly", () => {
      const nestedDir = path.join(tmpDir, "nested");
      fs.mkdirSync(nestedDir, { recursive: true });
      const pm = new PIDManager(nestedDir, "my.pid");
      expect(pm.getPath()).toBe(path.join(nestedDir, "my.pid"));
    });
  });

  // ─── writePID ───

  describe("writePID", () => {
    it("should write a PID file with the current process PID", async () => {
      await pidManager.writePID();
      const info = await pidManager.readPID();
      expect(info).not.toBeNull();
      expect(info!.pid).toBe(process.pid);
    });

    it("should write a PID file with a valid ISO started_at timestamp", async () => {
      const before = new Date().toISOString();
      await pidManager.writePID();
      const after = new Date().toISOString();

      const info = await pidManager.readPID();
      expect(info).not.toBeNull();
      expect(info!.started_at).toBeTruthy();
      expect(info!.started_at >= before).toBe(true);
      expect(info!.started_at <= after).toBe(true);
    });

    it("should not leave a .tmp file behind after write (atomic write)", async () => {
      await pidManager.writePID();
      const files = fs.readdirSync(tmpDir);
      expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    });

    it("should create a valid JSON file", async () => {
      await pidManager.writePID();
      const raw = fs.readFileSync(pidManager.getPath(), "utf-8");
      expect(() => JSON.parse(raw)).not.toThrow();
    });

    it("should overwrite an existing PID file without error", async () => {
      await pidManager.writePID();
      const written = await pidManager.writePID();
      const info = await pidManager.readPID();
      expect(written.pid).toBe(process.pid);
      expect(info!.pid).toBe(process.pid);
    });
  });

  // ─── readPID ───

  describe("readPID", () => {
    it("should return null when no PID file exists", async () => {
      expect(await pidManager.readPID()).toBeNull();
    });

    it("should return the correct pid and started_at after writePID", async () => {
      await pidManager.writePID();
      const info = await pidManager.readPID();
      expect(info).not.toBeNull();
      expect(typeof info!.pid).toBe("number");
      expect(typeof info!.started_at).toBe("string");
    });

    it("should return null for completely invalid JSON", async () => {
      fs.writeFileSync(pidManager.getPath(), "not valid json !!!", "utf-8");
      expect(await pidManager.readPID()).toBeNull();
    });

    it("should return null when pid field is missing", async () => {
      fs.writeFileSync(
        pidManager.getPath(),
        JSON.stringify({ started_at: new Date().toISOString() }),
        "utf-8"
      );
      expect(await pidManager.readPID()).toBeNull();
    });

    it("should return null when pid field is not a number", async () => {
      fs.writeFileSync(
        pidManager.getPath(),
        JSON.stringify({ pid: "not-a-number", started_at: new Date().toISOString() }),
        "utf-8"
      );
      expect(await pidManager.readPID()).toBeNull();
    });

    it("should return null for an empty file", async () => {
      fs.writeFileSync(pidManager.getPath(), "", "utf-8");
      expect(await pidManager.readPID()).toBeNull();
    });

    it("should round-trip arbitrary pid values correctly", async () => {
      const fakeInfo = { pid: 12345, started_at: "2026-01-01T00:00:00.000Z" };
      fs.writeFileSync(pidManager.getPath(), JSON.stringify(fakeInfo), "utf-8");
      const result = await pidManager.readPID();
      expect(result!.pid).toBe(12345);
      expect(result!.started_at).toBe("2026-01-01T00:00:00.000Z");
      expect(result!.runtime_pid).toBe(12345);
      expect(result!.owner_pid).toBe(12345);
    });
  });

  // ─── isRunning ───

  describe("isRunning", () => {
    it("should return false when no PID file exists", async () => {
      expect(await pidManager.isRunning()).toBe(false);
    });

    it("should return true when the current process PID is written to the file", async () => {
      await pidManager.writePID();
      expect(await pidManager.isRunning()).toBe(true);
    });

    it("should return false for a PID that does not exist (stale PID file)", async () => {
      // PID 999999 is almost certainly not a running process
      const fakeInfo = { pid: 999999, started_at: new Date().toISOString() };
      fs.writeFileSync(pidManager.getPath(), JSON.stringify(fakeInfo), "utf-8");
      expect(await pidManager.isRunning()).toBe(false);
    });

    it("should return false when PID file is invalid JSON", async () => {
      fs.writeFileSync(pidManager.getPath(), "corrupted", "utf-8");
      expect(await pidManager.isRunning()).toBe(false);
    });

    it("should return false after cleanup removes the PID file", async () => {
      await pidManager.writePID();
      await pidManager.cleanup();
      expect(await pidManager.isRunning()).toBe(false);
    });
  });

  // ─── cleanup ───

  describe("cleanup", () => {
    it("should remove the PID file", async () => {
      await pidManager.writePID();
      expect(fs.existsSync(pidManager.getPath())).toBe(true);
      await pidManager.cleanup();
      expect(fs.existsSync(pidManager.getPath())).toBe(false);
    });

    it("should not throw when no PID file exists", async () => {
      await expect(pidManager.cleanup()).resolves.toBeUndefined();
    });

    it("should make readPID return null after cleanup", async () => {
      await pidManager.writePID();
      await pidManager.cleanup();
      expect(await pidManager.readPID()).toBeNull();
    });

    it("should be idempotent — calling cleanup twice does not throw", async () => {
      await pidManager.writePID();
      await pidManager.cleanup();
      await expect(pidManager.cleanup()).resolves.toBeUndefined();
    });

    it("should work correctly with a custom filename", async () => {
      const custom = new PIDManager(tmpDir, "another.pid");
      await custom.writePID();
      expect(fs.existsSync(custom.getPath())).toBe(true);
      await custom.cleanup();
      expect(fs.existsSync(custom.getPath())).toBe(false);
    });
  });

  // ─── Edge cases ───

  describe("edge cases", () => {
    it("two PIDManagers in the same directory with different filenames do not interfere", async () => {
      const pm1 = new PIDManager(tmpDir, "a.pid");
      const pm2 = new PIDManager(tmpDir, "b.pid");

      await pm1.writePID();
      expect(await pm2.readPID()).toBeNull();

      await pm2.writePID();
      expect(await pm1.readPID()).not.toBeNull();
      expect(await pm2.readPID()).not.toBeNull();
    });

    it("writePID then readPID then cleanup cycle works end-to-end", async () => {
      await pidManager.writePID();
      const info = await pidManager.readPID();
      expect(info!.pid).toBe(process.pid);
      expect(await pidManager.isRunning()).toBe(true);
      await pidManager.cleanup();
      expect(await pidManager.isRunning()).toBe(false);
    });
  });

  describe("runtime tree ownership", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("stores watchdog and runtime child ownership in the pid file", async () => {
      await pidManager.writePID({
        pid: 2202,
        runtime_pid: 2202,
        owner_pid: 1101,
        watchdog_pid: 1101,
        started_at: "2026-04-10T00:00:00.000Z",
      });

      const info = await pidManager.readPID();
      expect(info).toMatchObject({
        pid: 2202,
        runtime_pid: 2202,
        owner_pid: 1101,
        watchdog_pid: 1101,
        started_at: "2026-04-10T00:00:00.000Z",
      });
    });

    it("stopRuntime terminates the watchdog and runtime child together", async () => {
      const alive = new Set([4101, 4202]);
      const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
        if (signal === 0) {
          if (!alive.has(pid)) {
            const err = new Error("ESRCH") as NodeJS.ErrnoException;
            err.code = "ESRCH";
            throw err;
          }
          return true;
        }

        if (signal === "SIGTERM" || signal === "SIGKILL") {
          alive.delete(pid);
          return true;
        }

        return true;
      }) as typeof process.kill);

      await pidManager.writePID({
        pid: 4202,
        runtime_pid: 4202,
        owner_pid: 4101,
        watchdog_pid: 4101,
        started_at: "2026-04-10T00:00:00.000Z",
      });

      const result = await pidManager.stopRuntime({ timeoutMs: 50, pollIntervalMs: 1 });

      expect(killSpy).toHaveBeenCalledWith(4101, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(4202, "SIGTERM");
      expect(result.stopped).toBe(true);
      expect(result.forced).toBe(false);
      expect(fs.existsSync(pidManager.getPath())).toBe(false);
    });
  });
});
