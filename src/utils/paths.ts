// ─── SeedPulse Path Utilities ───
//
// Centralizes ~/.seedpulse path construction.
// SEEDPULSE_HOME env var overrides the default ~/.seedpulse location.

import * as os from "node:os";
import * as path from "node:path";

/**
 * Returns the SeedPulse base directory.
 * Defaults to ~/.seedpulse; can be overridden via SEEDPULSE_HOME env var.
 */
export function getSeedPulseDirPath(): string {
  return process.env["SEEDPULSE_HOME"] ?? path.join(os.homedir(), ".seedpulse");
}

export function getGoalsDir(base?: string): string {
  return path.join(base ?? getSeedPulseDirPath(), "goals");
}

export function getEventsDir(base?: string): string {
  return path.join(base ?? getSeedPulseDirPath(), "events");
}

export function getArchiveDir(base?: string): string {
  return path.join(base ?? getSeedPulseDirPath(), "archive");
}

export function getPluginsDir(base?: string): string {
  return path.join(base ?? getSeedPulseDirPath(), "plugins");
}

export function getLogsDir(base?: string): string {
  return path.join(base ?? getSeedPulseDirPath(), "logs");
}

export function getDatasourcesDir(base?: string): string {
  return path.join(base ?? getSeedPulseDirPath(), "datasources");
}

export function getScheduleDir(base?: string): string {
  return path.join(base ?? getSeedPulseDirPath(), "schedule");
}

export function getReportsDir(base?: string): string {
  return path.join(base ?? getSeedPulseDirPath(), "reports");
}
