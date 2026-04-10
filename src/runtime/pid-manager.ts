import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { writeJsonFile } from "../base/utils/json-io.js";
import { PIDInfoSchema, type PIDInfo } from "./types/daemon.js";

const PID_EPOCH_ISO = "1970-01-01T00:00:00.000Z";
const DEFAULT_STOP_TIMEOUT_MS = 35_000;
const DEFAULT_STOP_POLL_INTERVAL_MS = 100;
const PID_START_MATCH_TOLERANCE_MS = 30_000;

export interface PIDWriteOptions {
  pid?: number;
  started_at?: string;
  runtime_started_at?: string;
  owner_pid?: number;
  owner_started_at?: string;
  watchdog_pid?: number;
  watchdog_started_at?: string;
  runtime_pid?: number;
  version?: string;
}

export interface PIDManagerOptions {
  processStartedAtResolver?: (pid: number) => Promise<string | null> | string | null;
  processCommandResolver?: (pid: number) => Promise<string | null> | string | null;
}

export interface PIDRuntimeStatus {
  info: PIDInfo | null;
  running: boolean;
  runtimePid: number | null;
  ownerPid: number | null;
  alivePids: number[];
  stalePids: number[];
  verifiedPids: number[];
  unverifiedLegacyPids: number[];
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

async function readProcessStartedAt(pid: number): Promise<string | null> {
  try {
    const output = execFileSync(
      "ps",
      ["-p", String(pid), "-o", "lstart="],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          LC_ALL: "C",
        },
      }
    );
    const startedAt = String(output).trim();
    if (startedAt === "") {
      return null;
    }
    const parsed = new Date(startedAt);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed.toISOString();
  } catch {
    return null;
  }
}

async function readProcessCommand(pid: number): Promise<string | null> {
  try {
    const output = execFileSync(
      "ps",
      ["-p", String(pid), "-o", "command="],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          LC_ALL: "C",
        },
      }
    );
    const command = String(output).trim();
    return command === "" ? null : command;
  } catch {
    return null;
  }
}

function normalizeStartedAt(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

export class PIDManager {
  private pidPath: string;
  private readonly processStartedAtResolver: (pid: number) => Promise<string | null>;
  private readonly processCommandResolver: (pid: number) => Promise<string | null>;

  constructor(baseDir: string, pidFile: string = "pulseed.pid", options: PIDManagerOptions = {}) {
    this.pidPath = path.join(baseDir, pidFile);
    this.processStartedAtResolver = async (pid: number) => {
      if (options.processStartedAtResolver) {
        return await options.processStartedAtResolver(pid);
      }
      return await readProcessStartedAt(pid);
    };
    this.processCommandResolver = async (pid: number) => {
      if (options.processCommandResolver) {
        return await options.processCommandResolver(pid);
      }
      return await readProcessCommand(pid);
    };
  }

  /** Write PID ownership info to file (atomic write). */
  async writePID(options: PIDWriteOptions = {}): Promise<PIDInfo> {
    const runtimePid = options.runtime_pid ?? options.pid ?? process.pid;
    const ownerPid = options.owner_pid ?? options.watchdog_pid ?? runtimePid;
    const startedAt = options.started_at ?? new Date().toISOString();
    const runtimeStartedAt =
      options.runtime_started_at
      ?? normalizeStartedAt(await this.processStartedAtResolver(runtimePid))
      ?? startedAt;
    const ownerStartedAt =
      options.owner_started_at
      ?? normalizeStartedAt(await this.processStartedAtResolver(ownerPid))
      ?? startedAt;
    const watchdogStartedAt =
      options.watchdog_started_at
      ?? (options.watchdog_pid ? ownerStartedAt : undefined);
    const info = PIDInfoSchema.parse({
      pid: options.pid ?? runtimePid,
      started_at: startedAt,
      runtime_started_at: runtimeStartedAt,
      owner_pid: ownerPid,
      owner_started_at: ownerStartedAt,
      watchdog_pid: options.watchdog_pid,
      watchdog_started_at: watchdogStartedAt,
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
        verifiedPids: [],
        unverifiedLegacyPids: [],
      };
    }

    const runtimePid = getRuntimePid(info);
    const ownerPid = getOwnerPid(info);
    const trackedPids = uniquePids([info.pid, runtimePid, ownerPid, info.watchdog_pid]);
    const alivePids: number[] = [];
    const stalePids: number[] = [];
    const verifiedPids: number[] = [];
    const unverifiedLegacyPids: number[] = [];
    const expectedStartedAt = new Map<number, string>();
    expectedStartedAt.set(info.pid, info.runtime_started_at ?? info.started_at);
    expectedStartedAt.set(runtimePid, info.runtime_started_at ?? info.started_at);
    if (typeof ownerPid === "number") {
      expectedStartedAt.set(ownerPid, info.owner_started_at ?? info.started_at);
    }
    if (typeof info.watchdog_pid === "number") {
      expectedStartedAt.set(
        info.watchdog_pid,
        info.watchdog_started_at ?? info.owner_started_at ?? info.started_at
      );
    }

    for (const pid of trackedPids) {
      const expected = expectedStartedAt.get(pid) ?? info.started_at;
      const state = await this.getTrackedPidState(pid, expected);
      if (state === "verified") {
        alivePids.push(pid);
        verifiedPids.push(pid);
      } else if (state === "legacy_alive") {
        alivePids.push(pid);
        unverifiedLegacyPids.push(pid);
      } else {
        stalePids.push(pid);
      }
    }

    if (alivePids.length === 0) {
      await this.cleanup();
      return {
        info,
        running: false,
        runtimePid,
        ownerPid,
        alivePids: [],
        stalePids,
        verifiedPids,
        unverifiedLegacyPids,
      };
    }

    return {
      info,
      running: alivePids.length > 0,
      runtimePid,
      ownerPid,
      alivePids,
      stalePids,
      verifiedPids,
      unverifiedLegacyPids,
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

    if (!initialStatus.info || initialStatus.alivePids.length === 0) {
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
      const runtimeStartedAt =
        typeof parsed["runtime_started_at"] === "string"
          ? parsed["runtime_started_at"]
          : startedAt;
      const ownerPid =
        typeof parsed["owner_pid"] === "number"
          ? parsed["owner_pid"]
          : typeof parsed["watchdog_pid"] === "number"
            ? parsed["watchdog_pid"]
            : pid;
      const ownerStartedAt =
        typeof parsed["owner_started_at"] === "string"
          ? parsed["owner_started_at"]
          : startedAt;
      const watchdogStartedAt =
        typeof parsed["watchdog_started_at"] === "string"
          ? parsed["watchdog_started_at"]
          : ownerStartedAt;

      return PIDInfoSchema.parse({
        ...parsed,
        pid,
        runtime_pid: typeof parsed["runtime_pid"] === "number" ? parsed["runtime_pid"] : pid,
        runtime_started_at: runtimeStartedAt,
        owner_pid: ownerPid,
        owner_started_at: ownerStartedAt,
        watchdog_started_at: watchdogStartedAt,
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

  private async getTrackedPidState(
    pid: number,
    expectedStartedAt: string
  ): Promise<"verified" | "legacy_alive" | "stale"> {
    if (!this.isPidAlive(pid)) {
      return "stale";
    }

    if (expectedStartedAt === PID_EPOCH_ISO) {
      return await this.isLegacyPulseedProcess(pid) ? "legacy_alive" : "stale";
    }

    const actualStartedAt = await this.processStartedAtResolver(pid);
    const normalizedActualStartedAt = normalizeStartedAt(actualStartedAt);
    if (!normalizedActualStartedAt) {
      return "stale";
    }

    const expectedMs = Date.parse(expectedStartedAt);
    const actualMs = Date.parse(normalizedActualStartedAt);
    if (!Number.isFinite(expectedMs) || !Number.isFinite(actualMs)) {
      return "stale";
    }

    return Math.abs(actualMs - expectedMs) <= PID_START_MATCH_TOLERANCE_MS
      ? "verified"
      : "stale";
  }

  private async isLegacyPulseedProcess(pid: number): Promise<boolean> {
    const command = await this.processCommandResolver(pid);
    if (!command) {
      return false;
    }

    return /pulseed|cli-runner\.js|daemon(?:\s|$)|watchdog/i.test(command);
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
