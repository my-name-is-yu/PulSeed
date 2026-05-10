import * as fs from "node:fs";
import * as path from "node:path";
import { DaemonConfigSchema, type DaemonConfig } from "../../base/types/daemon.js";
import { signalProcessPid } from "../../base/utils/process-pid.js";
import { loadDaemonStateSync } from "../store/daemon-state-store.js";

export function resolveDaemonRuntimeRoot(baseDir: string, configuredRoot?: string): string {
  if (!configuredRoot || configuredRoot.trim() === "") {
    return path.join(baseDir, "runtime");
  }
  return path.isAbsolute(configuredRoot)
    ? configuredRoot
    : path.resolve(baseDir, configuredRoot);
}

function isRecoverablePersistedJsonReadError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || error instanceof SyntaxError;
}

function readJsonFileSync(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
}

export function loadDaemonConfigSync(baseDir: string): DaemonConfig {
  for (const fileName of ["daemon.json", "daemon-config.json"]) {
    const filePath = path.join(baseDir, fileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      const parsed = DaemonConfigSchema.safeParse(readJsonFileSync(filePath));
      if (parsed.success) return parsed.data;
    } catch (err) {
      if (!isRecoverablePersistedJsonReadError(err)) throw err;
      // Ignore missing, malformed, or schema-invalid daemon config here; callers fall back to the default runtime root.
    }
  }
  return DaemonConfigSchema.parse({});
}

export function resolveConfiguredDaemonRuntimeRoot(baseDir: string): string {
  const runningStateRoot = readRunningDaemonRuntimeRoot(baseDir);
  if (runningStateRoot) return runningStateRoot;
  const config = loadDaemonConfigSync(baseDir);
  return resolveDaemonRuntimeRoot(baseDir, config.runtime_root);
}

function readRunningDaemonRuntimeRoot(baseDir: string): string | null {
  try {
    const state = loadDaemonStateSync(baseDir);
    if (!state) return null;
    if (state.status !== "running" && state.status !== "idle") return null;
    if (state.pid) {
      const result = signalProcessPid(state.pid, 0);
      if (result.status !== "sent") {
        return null;
      }
    }
    return state.runtime_root ?? null;
  } catch {
    return null;
  }
}
