import * as net from "node:net";
import { exec } from "node:child_process";
import {
  ScheduleResultSchema,
  type ScheduleEntry,
  type ScheduleResult,
} from "../types/schedule.js";

function isProcessPidValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export async function executeHeartbeatEntry(
  entry: ScheduleEntry,
  logger: {
    error(message: string, context?: Record<string, unknown>): void;
  }
): Promise<ScheduleResult> {
  const firedAt = new Date().toISOString();
  const start = Date.now();
  const cfg = entry.heartbeat;

  if (!cfg) {
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "error",
      duration_ms: 0,
      error_message: "No heartbeat config",
      fired_at: firedAt,
      failure_kind: "permanent",
    });
  }

  try {
    const timeoutMs = cfg.timeout_ms;
    switch (cfg.check_type) {
      case "http":
        await checkHttp(cfg.check_config.url, timeoutMs);
        break;
      case "tcp":
        await checkTcp(cfg.check_config.host, cfg.check_config.port, timeoutMs);
        break;
      case "process":
        checkProcess(cfg.check_config.pid);
        break;
      case "disk":
        await checkDisk(cfg.check_config.path);
        break;
      case "custom":
        await checkCustom(cfg.check_config.command, timeoutMs);
        break;
    }

    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "ok",
      duration_ms: Date.now() - start,
      fired_at: firedAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Heartbeat "${entry.name}" failed: ${msg}`);
    return ScheduleResultSchema.parse({
      entry_id: entry.id,
      status: "down",
      duration_ms: Date.now() - start,
      error_message: msg,
      fired_at: firedAt,
      failure_kind: "transient",
    });
  }
}

async function checkHttp(url: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

function checkTcp(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy();
      resolve();
    });
    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error(`TCP timeout after ${timeoutMs}ms`));
    });
    socket.on("error", (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

function checkProcess(pid: unknown): void {
  if (!isProcessPidValue(pid)) {
    throw new Error("Process heartbeat pid must be a positive safe integer");
  }
  process.kill(pid, 0);
}

function checkCustom(command: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: timeoutMs }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function checkDisk(diskPath: string): Promise<void> {
  const { statfs } = await import("node:fs/promises");
  await statfs(diskPath);
}
