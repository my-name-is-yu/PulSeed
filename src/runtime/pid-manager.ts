import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { writeJsonFile } from "../base/utils/json-io.js";
import { PIDInfoSchema, type PIDInfo } from "./types/daemon.js";

const PID_EPOCH_ISO = "1970-01-01T00:00:00.000Z";
const DEFAULT_STOP_TIMEOUT_MS = 35_000;
const DEFAULT_STOP_POLL_INTERVAL_MS = 100;

export interface PIDWriteOptions {
  pid?: number;
  started_at?: string;
  owner_pid?: number;
  watchdog_pid?: number;
  runtime_pid?: number;
  version?: string;
}

export interface PIDRuntimeStatus {
  info: PIDInfo | null;
  running: boolean;
  runtimePid: number | null;
  ownerPid: number | null;
  alivePids: number[];
  stalePids: number[];
}

export interface StopRuntimeOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface StopRuntimeResult {
  info: PIDInfo | null;
  runtimePid: number | null;
  ownerPid: number | null;
  sentSignalsTo: number[];
  forced: boolean;
  stopped: boolean;
  alivePids: number[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniquePids(pids: Array<number | null | undefined>): number[] {
  return [...new Set(pids.filter((pid): pid is number => typeof pid === "number" && pid > 0))];
}

function getRuntimePid(info: PIDInfo): number {
  return info.runtime_pid ?? info.pid;
}

function getOwnerPid(info: PIDInfo): number {
  return info.owner_pid ?? info.watchdog_pid ?? getRuntimePid(info);
}

export class PIDManager {
  private pidPath: string;

  constructor(baseDir: string, pidFile: string = "pulseed.pid") {
    this.pidPath = path.join(baseDir, pidFile);
  }

  /** Write PID ownership info to file (atomic write). */
  async writePID(options: PIDWriteOptions = {}): Promise<PIDInfo> {
    const runtimePid = options.runtime_pid ?? options.pid ?? process.pid;
    const info = PIDInfoSchema.parse({
      pid: options.pid ?? runtimePid,
      started_at: options.started_at ?? new Date().toISOString(),
      owner_pid: options.owner_pid ?? options.watchdog_pid ?? runtimePid,
      watchdog_pid: options.watchdog_pid,
      runtime_pid: runtimePid,
      version: options.version,
    });
    const tmpPath = this.pidPath + ".tmp";
    await writeJsonFile(tmpPath, info);
    await fsp.rename(tmpPath, this.pidPath);
    return info;
  }

  /** Read PID ownership info. Returns null if the file does not exist or is invalid. */
  async readPID(): Promise<PIDInfo | null> {
    try {
      const content = await fsp.readFile(this.pidPath, "utf-8");
      return this.normalizePIDInfo(content);
    } catch {
      return null;
    }
  }

  /** Inspect the pidfile and resolve the currently alive runtime tree processes. */
  async inspect(): Promise<PIDRuntimeStatus> {
    const info = await this.readPID();
    if (!info) {
      return {
        info: null,
        running: false,
        runtimePid: null,
        ownerPid: null,
        alivePids: [],
        stalePids: [],
      };
    }

    const runtimePid = getRuntimePid(info);
    const ownerPid = getOwnerPid(info);
    const trackedPids = uniquePids([info.pid, runtimePid, ownerPid, info.watchdog_pid]);
    const alivePids = trackedPids.filter((pid) => this.isPidAlive(pid));
    const stalePids = trackedPids.filter((pid) => !alivePids.includes(pid));

    if (alivePids.length === 0) {
      await this.cleanup();
      return {
        info,
        running: false,
        runtimePid,
        ownerPid,
        alivePids: [],
        stalePids,
      };
    }

    return {
      info,
      running: true,
      runtimePid,
      ownerPid,
      alivePids,
      stalePids,
    };
  }

  /** Check whether any process recorded in the pidfile is still alive. */
  async isRunning(): Promise<boolean> {
    const status = await this.inspect();
    return status.running;
  }

  /**
   * Gracefully stop the tracked runtime tree.
   * Sends SIGTERM to the owner/watchdog and runtime child, waits, then SIGKILLs survivors if needed.
   */
  async stopRuntime(options: StopRuntimeOptions = {}): Promise<StopRuntimeResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_STOP_POLL_INTERVAL_MS;
    const initialStatus = await this.inspect();

    if (!initialStatus.info || !initialStatus.running) {
      return {
        info: initialStatus.info,
        runtimePid: initialStatus.runtimePid,
        ownerPid: initialStatus.ownerPid,
        sentSignalsTo: [],
        forced: false,
        stopped: false,
        alivePids: initialStatus.alivePids,
      };
    }

    const lifecyclePids = uniquePids([
      initialStatus.ownerPid,
      initialStatus.runtimePid,
      ...initialStatus.alivePids,
    ]);
    const sentSignalsTo: number[] = [];

    for (const pid of lifecyclePids) {
      if (this.sendSignal(pid, "SIGTERM")) {
        sentSignalsTo.push(pid);
      }
    }

    const deadline = Date.now() + timeoutMs;
    let forced = false;

    while (Date.now() < deadline) {
      const status = await this.inspect();
      if (!status.running) {
        return {
          info: initialStatus.info,
          runtimePid: initialStatus.runtimePid,
          ownerPid: initialStatus.ownerPid,
          sentSignalsTo,
          forced,
          stopped: true,
          alivePids: [],
        };
      }
      await sleep(pollIntervalMs);
    }

    const beforeForce = await this.inspect();
    for (const pid of beforeForce.alivePids) {
      if (this.sendSignal(pid, "SIGKILL")) {
        forced = true;
      }
    }

    const forceDeadline = Date.now() + Math.max(1_000, pollIntervalMs * 10);
    while (Date.now() < forceDeadline) {
      const status = await this.inspect();
      if (!status.running) {
        return {
          info: initialStatus.info,
          runtimePid: initialStatus.runtimePid,
          ownerPid: initialStatus.ownerPid,
          sentSignalsTo,
          forced,
          stopped: true,
          alivePids: [],
        };
      }
      await sleep(pollIntervalMs);
    }

    const finalStatus = await this.inspect();
    return {
      info: initialStatus.info,
      runtimePid: initialStatus.runtimePid,
      ownerPid: initialStatus.ownerPid,
      sentSignalsTo,
      forced,
      stopped: !finalStatus.running,
      alivePids: finalStatus.alivePids,
    };
  }

  /** Remove PID file. */
  async cleanup(): Promise<void> {
    try {
      await fsp.unlink(this.pidPath);
    } catch {
      // Ignore cleanup errors (file may not exist)
    }
  }

  /** Get the PID file path. */
  getPath(): string {
    return this.pidPath;
  }

  private normalizePIDInfo(content: string): PIDInfo | null {
    const trimmed = content.trim();
    if (trimmed === "") {
      return null;
    }

    if (!trimmed.startsWith("{")) {
      const pid = parseInt(trimmed, 10);
      if (!Number.isInteger(pid) || pid <= 0) {
        return null;
      }
      return PIDInfoSchema.parse({
        pid,
        runtime_pid: pid,
        owner_pid: pid,
        started_at: PID_EPOCH_ISO,
      });
    }

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const pid =
        typeof parsed["runtime_pid"] === "number"
          ? parsed["runtime_pid"]
          : typeof parsed["pid"] === "number"
            ? parsed["pid"]
            : null;
      if (pid === null || !Number.isInteger(pid) || pid <= 0) {
        return null;
      }

      const startedAt =
        typeof parsed["started_at"] === "string" ? parsed["started_at"] : PID_EPOCH_ISO;
      const ownerPid =
        typeof parsed["owner_pid"] === "number"
          ? parsed["owner_pid"]
          : typeof parsed["watchdog_pid"] === "number"
            ? parsed["watchdog_pid"]
            : pid;

      return PIDInfoSchema.parse({
        ...parsed,
        pid,
        runtime_pid: typeof parsed["runtime_pid"] === "number" ? parsed["runtime_pid"] : pid,
        owner_pid: ownerPid,
        started_at: startedAt,
      });
    } catch {
      return null;
    }
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private sendSignal(pid: number, signal: NodeJS.Signals): boolean {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}
