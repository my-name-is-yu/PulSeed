import fs from "node:fs";
import path from "node:path";
import { getLogsDir } from "../../base/utils/paths.js";

const FALSEY_ENV_VALUES = new Set(["0", "false", "off", "no"]);
const DEFAULT_LOG_NAME = "tui-debug.log";

function isDebugEnabled(): boolean {
  const raw = process.env.PULSEED_TUI_DEBUG_LOG;
  if (!raw) return false;
  return !FALSEY_ENV_VALUES.has(raw.toLowerCase());
}

export function getTuiDebugLogPath(): string {
  const raw = process.env.PULSEED_TUI_DEBUG_LOG;
  if (raw && !FALSEY_ENV_VALUES.has(raw.toLowerCase()) && raw !== "1" && raw !== "true") {
    return raw;
  }
  return path.join(getLogsDir(), DEFAULT_LOG_NAME);
}

export function resetTuiDebugLog(): void {
  if (!isDebugEnabled()) return;
  const logPath = getTuiDebugLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, "");
}

export function logTuiDebug(scope: string, event: string, payload: Record<string, unknown> = {}): void {
  if (!isDebugEnabled()) return;

  const logPath = getTuiDebugLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    scope,
    event,
    ...payload,
  });
  fs.appendFileSync(logPath, `${line}\n`);
}
