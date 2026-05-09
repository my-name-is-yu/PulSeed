import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { atomicWrite, atomicRead } from "./state-persistence.js";

// Snapshot dir: <baseDir>/goals/<goalId>/snapshots/

function snapshotDir(goalId: string, baseDir: string): string {
  return path.join(baseDir, "goals", goalId, "snapshots");
}

function tsToFilename(ts: string): string {
  return ts.replace(/:/g, "-") + ".json";
}

interface SnapshotRecord {
  ts: string;
  data: unknown;
}

function isCanonicalSnapshotTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function parseSnapshotRecord(raw: unknown): SnapshotRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  if (
    typeof record.ts !== "string" ||
    !isCanonicalSnapshotTimestamp(record.ts) ||
    !Object.prototype.hasOwnProperty.call(record, "data")
  ) {
    return null;
  }

  return { ts: record.ts, data: record.data };
}

/** Write a snapshot. Returns the snapshot filename. */
export async function writeSnapshot(
  goalId: string,
  baseDir: string,
  data: unknown
): Promise<string> {
  const dir = snapshotDir(goalId, baseDir);
  await fsp.mkdir(dir, { recursive: true });
  const ts = new Date().toISOString();
  const filename = tsToFilename(ts);
  await atomicWrite(path.join(dir, filename), { ts, data });
  return filename;
}

/** Load the most recent snapshot. Returns null if none exist. */
export async function loadLatestSnapshot(
  goalId: string,
  baseDir: string
): Promise<{ ts: string; data: unknown } | null> {
  const dir = snapshotDir(goalId, baseDir);
  let files: string[];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const jsonFiles = files.filter((f) => f.endsWith(".json")).sort().reverse();
  for (const f of jsonFiles) {
    const parsed = parseSnapshotRecord(await atomicRead<unknown>(path.join(dir, f)));
    if (parsed) return parsed;
  }
  return null;
}

/** List snapshot filenames, sorted ascending by time. */
export async function listSnapshots(goalId: string, baseDir: string): Promise<string[]> {
  const dir = snapshotDir(goalId, baseDir);
  let files: string[];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return [];
  }
  return files.filter((f) => f.endsWith(".json")).sort();
}

/** Delete old snapshots, keeping the most recent keepCount. Returns count deleted. */
export async function deleteOldSnapshots(
  goalId: string,
  baseDir: string,
  keepCount = 5
): Promise<number> {
  const all = await listSnapshots(goalId, baseDir);
  const toDelete = all.slice(0, Math.max(0, all.length - keepCount));
  const dir = snapshotDir(goalId, baseDir);
  await Promise.all(toDelete.map((f) => fsp.unlink(path.join(dir, f))));
  return toDelete.length;
}
