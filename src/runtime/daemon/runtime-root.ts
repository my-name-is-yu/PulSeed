import * as fs from "node:fs";
import * as path from "node:path";
import { DaemonConfigSchema, DaemonStateSchema, type DaemonConfig } from "../../base/types/daemon.js";

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
  const statePath = path.join(baseDir, "daemon-state.json");
  if (!fs.existsSync(statePath)) return null;
  try {
    const parsed = DaemonStateSchema.safeParse(readJsonFileSync(statePath));
    if (!parsed.success) return null;
    const state = parsed.data;
    if (state.status !== "running" && state.status !== "idle") return null;
    if (state.pid) {
      try {
        process.kill(state.pid, 0);
      } catch {
        return null;
      }
    }
    return state.runtime_root ?? null;
  } catch (err) {
    if (!isRecoverablePersistedJsonReadError(err)) throw err;
    return null;
  }
}
