import fs from "node:fs/promises";
import type { ProcessSessionSnapshot } from "../system/ProcessSessionTool/ProcessSessionTool.js";
import { signalProcessPid } from "../../base/utils/process-pid.js";
import { getPulseedDirPath } from "../../base/utils/paths.js";
import { isTextFileSizeLimitError, readTextFileWithinLimit } from "../../base/utils/json-io.js";
import {
  PROCESS_SESSION_SNAPSHOT_REF_PREFIX,
  ProcessSessionStateStore,
} from "../../runtime/store/process-session-state-store.js";
import {
  parseKaggleMetricsCompatible,
  type KaggleMetricParseResult,
} from "./metrics.js";

export const KAGGLE_EXPERIMENT_METRICS_MAX_BYTES = 1024 * 1024;

export type KaggleMetricsFallback = Parameters<typeof parseKaggleMetricsCompatible>[1];

export async function readKaggleMetrics(
  metricsPath: string,
  fallback: KaggleMetricsFallback = {},
): Promise<KaggleMetricParseResult> {
  let raw: string;
  try {
    raw = await readTextFileWithinLimit(metricsPath, {
      maxBytes: KAGGLE_EXPERIMENT_METRICS_MAX_BYTES,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "missing", message: "metrics.json is missing" };
    }
    if (isTextFileSizeLimitError(err)) {
      return {
        ok: false,
        reason: "malformed",
        message: `metrics.json exceeds ${KAGGLE_EXPERIMENT_METRICS_MAX_BYTES} bytes`,
      };
    }
    throw err;
  }
  try {
    return parseKaggleMetricsCompatible(JSON.parse(raw), fallback);
  } catch (err) {
    return {
      ok: false,
      reason: "malformed",
      message: `metrics.json is not valid JSON: ${(err as Error).message}`,
    };
  }
}

export async function readKaggleTail(
  filePath: string,
  maxChars: number,
): Promise<{ text: string; truncated: boolean; path: string }> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return {
      text: raw.length > maxChars ? raw.slice(raw.length - maxChars) : raw,
      truncated: raw.length > maxChars,
      path: filePath,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { text: "", truncated: false, path: filePath };
    }
    throw err;
  }
}

export async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function readProcessSnapshotFromMetadata(processPath: string): Promise<ProcessSessionSnapshot | null> {
  const localProcess = await readJsonObject(processPath);
  const metadataRef = typeof localProcess?.metadataRef === "string"
    ? localProcess.metadataRef
    : typeof localProcess?.metadata_ref === "string"
      ? localProcess.metadata_ref
      : null;
  if (metadataRef?.startsWith(PROCESS_SESSION_SNAPSHOT_REF_PREFIX)) {
    const sessionId = decodeURIComponent(metadataRef.slice(PROCESS_SESSION_SNAPSHOT_REF_PREFIX.length));
    const durable = await new ProcessSessionStateStore(getPulseedDirPath()).loadSnapshot(sessionId).catch(() => null);
    if (durable) return durable as ProcessSessionSnapshot;
  }
  return localProcess as unknown as ProcessSessionSnapshot | null;
}

export async function missingArtifactPaths(pathsToCheck: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const candidate of pathsToCheck) {
    try {
      await fs.access(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        missing.push(candidate);
        continue;
      }
      throw err;
    }
  }
  return missing;
}

export async function signalKaggleChildProcess(childProcessPath: string, signal: NodeJS.Signals): Promise<void> {
  const childProcess = await readJsonObject(childProcessPath);
  signalProcessPid(childProcess?.pid, signal);
}
