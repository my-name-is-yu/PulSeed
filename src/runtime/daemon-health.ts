/**
 * daemon-health.ts
 *
 * Standalone utilities for daemon log rotation and adaptive sleep calculation.
 * Extracted from DaemonRunner to keep daemon-runner.ts focused on the loop.
 */

import * as fsp from "node:fs/promises";
import type { Stats } from "node:fs";
import * as path from "node:path";
import type { Logger } from "./logger.js";

// ─── AdaptiveSleepConfig ───
// Mirrors the adaptive_sleep shape from DaemonConfigSchema.
export interface AdaptiveSleepConfig {
  enabled: boolean;
  min_interval_ms: number;
  max_interval_ms: number;
  night_start_hour: number;
  night_end_hour: number;
  night_multiplier: number;
}

// ─── Log Rotation ───

/**
 * Rotate the main log file if it exceeds the configured size limit.
 * Renames pulseed.log to pulseed.<timestamp>.log and keeps at most maxFiles rotated files.
 * Called at daemon startup.
 */
export async function rotateDaemonLog(
  logPath: string,
  logDir: string,
  maxSizeBytes: number,
  maxFiles: number,
  logger: Logger
): Promise<void> {
  try {
    // Check if log file exists and exceeds size limit
    let stat: Stats;
    try {
      stat = await fsp.stat(logPath);
    } catch {
      // File doesn't exist — nothing to rotate
      return;
    }

    if (stat.size < maxSizeBytes) return;

    // Rotate: rename current log with timestamp suffix
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rotatedName = `pulseed.${timestamp}.log`;
    const rotatedPath = path.join(logDir, rotatedName);
    await fsp.rename(logPath, rotatedPath);

    logger.info("Log file rotated", {
      rotated_to: rotatedName,
      size_bytes: stat.size,
    });

    // Prune old rotated files: keep only the most recent maxFiles
    await pruneRotatedDaemonLogs(logDir, maxFiles);
  } catch {
    // Non-fatal — rotation failures should not prevent daemon startup
  }
}

/**
 * Remove oldest rotated log files, keeping at most maxFiles.
 */
export async function pruneRotatedDaemonLogs(logDir: string, maxFiles: number): Promise<void> {
  try {
    const entries = await fsp.readdir(logDir);
    // Rotated files match: pulseed.<timestamp>.log (not pulseed.log itself)
    const rotated = entries
      .filter((f) => /^pulseed\..+\.log$/.test(f) && f !== "pulseed.log")
      .sort(); // ISO timestamps sort lexicographically = chronologically

    // Remove oldest files beyond maxFiles
    const excess = rotated.length - maxFiles;
    if (excess <= 0) return;

    for (let i = 0; i < excess; i++) {
      await fsp.unlink(path.join(logDir, rotated[i]!));
    }
  } catch {
    // Non-fatal
  }
}

// ─── Adaptive Sleep ───

/**
 * Calculate the adaptive sleep interval based on time-of-day, urgency, and activity.
 * Returns baseInterval unchanged if adaptive_sleep is disabled.
 */
export function calculateAdaptiveInterval(
  baseInterval: number,
  goalsActivatedThisCycle: number,
  maxGapScore: number,
  consecutiveIdleCycles: number,
  cfg: AdaptiveSleepConfig
): number {
  if (!cfg.enabled) return baseInterval;

  // 1. Time-of-day factor
  const hour = new Date().getHours();
  const { night_start_hour, night_end_hour, night_multiplier } = cfg;
  let timeOfDayFactor: number;
  if (night_start_hour > night_end_hour) {
    // Spans midnight: night is [night_start_hour, 24) ∪ [0, night_end_hour)
    timeOfDayFactor = (hour >= night_start_hour || hour < night_end_hour) ? night_multiplier : 1.0;
  } else {
    // Same-day range
    timeOfDayFactor = (hour >= night_start_hour && hour < night_end_hour) ? night_multiplier : 1.0;
  }

  // 2. Urgency factor
  let urgencyFactor: number;
  if (maxGapScore >= 0.8) {
    urgencyFactor = 0.5;
  } else if (maxGapScore >= 0.5) {
    urgencyFactor = 0.75;
  } else {
    urgencyFactor = 1.0;
  }

  // 3. Activity factor
  let activityFactor: number;
  if (goalsActivatedThisCycle > 0) {
    activityFactor = 0.75;
  } else if (consecutiveIdleCycles >= 5) {
    activityFactor = 1.5;
  } else {
    activityFactor = 1.0;
  }

  // 4. Apply factors and clamp
  const effective = baseInterval * timeOfDayFactor * urgencyFactor * activityFactor;
  const clamped = Math.max(cfg.min_interval_ms, Math.min(cfg.max_interval_ms, effective));
  return Math.round(clamped);
}
