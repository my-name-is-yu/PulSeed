import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { readTextFileWithinLimit, writeJsonFileAtomic } from "./json-io.js";

export const EVENT_SPOOL_MAX_FILE_BYTES = 1_048_576;
export const EVENT_SPOOL_MAX_PENDING_FILES = 10_000;
export const EVENT_SPOOL_RETAINED_DIRECTORY_MAX_FILES = 1_000;
export const EVENT_SPOOL_RETAINED_DIRECTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const RESERVED_EVENT_SPOOL_FILENAMES = new Set(["daemon-token.json"]);

export interface EventSpoolListOptions {
  maxFiles?: number;
}

export interface EventSpoolWriteOptions {
  prefix?: string;
  maxPendingFiles?: number;
  maxBytes?: number;
}

export interface EventSpoolPruneOptions {
  now?: number;
  maxFiles?: number;
  maxAgeMs?: number;
}

export function isEventSpoolJsonFileName(fileName: string): boolean {
  return path.basename(fileName) === fileName
    && fileName.endsWith(".json")
    && !fileName.endsWith(".tmp")
    && !RESERVED_EVENT_SPOOL_FILENAMES.has(fileName);
}

export function assertEventSpoolJsonFileName(fileName: string): void {
  if (!isEventSpoolJsonFileName(fileName)) {
    throw new Error(`Unsafe event spool filename: ${fileName}`);
  }
}

export async function listEventSpoolJsonFiles(
  spoolDir: string,
  options: EventSpoolListOptions = {},
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(spoolDir);
  } catch {
    return [];
  }
  const safeFiles = entries.filter(isEventSpoolJsonFileName).sort();
  const maxFiles = normalizePositiveSafeInteger(
    options.maxFiles ?? EVENT_SPOOL_MAX_PENDING_FILES,
    "maxFiles",
  );
  return safeFiles.slice(0, maxFiles);
}

export async function readEventSpoolText(
  spoolDir: string,
  fileName: string,
  maxBytes = EVENT_SPOOL_MAX_FILE_BYTES,
): Promise<string> {
  assertEventSpoolJsonFileName(fileName);
  return readTextFileWithinLimit(path.join(spoolDir, fileName), {
    maxBytes: normalizePositiveSafeInteger(maxBytes, "maxBytes"),
  });
}

export async function writeEventSpoolJson(
  spoolDir: string,
  payload: unknown,
  options: EventSpoolWriteOptions = {},
): Promise<string> {
  await fsp.mkdir(spoolDir, { recursive: true });
  const maxPendingFiles = normalizePositiveSafeInteger(
    options.maxPendingFiles ?? EVENT_SPOOL_MAX_PENDING_FILES,
    "maxPendingFiles",
  );
  const pendingFiles = await listEventSpoolJsonFiles(spoolDir, { maxFiles: maxPendingFiles + 1 });
  if (pendingFiles.length >= maxPendingFiles) {
    throw new Error(`Event spool has reached the pending file limit (${maxPendingFiles})`);
  }

  const maxBytes = normalizePositiveSafeInteger(options.maxBytes ?? EVENT_SPOOL_MAX_FILE_BYTES, "maxBytes");
  const encoded = JSON.stringify(payload, null, 2);
  if (encoded === undefined) {
    throw new Error("Event spool payload must be JSON-serializable");
  }
  if (Buffer.byteLength(encoded, "utf-8") > maxBytes) {
    throw new Error(`Event spool payload exceeds ${maxBytes} bytes`);
  }

  const prefix = normalizeEventSpoolPrefix(options.prefix ?? "event");
  const fileName = `${prefix}_${Date.now()}_${randomUUID()}.json`;
  assertEventSpoolJsonFileName(fileName);
  await writeJsonFileAtomic(path.join(spoolDir, fileName), payload);
  return fileName;
}

export async function moveEventSpoolFile(
  spoolDir: string,
  fileName: string,
  destinationDir: string,
): Promise<string> {
  assertEventSpoolJsonFileName(fileName);
  await fsp.mkdir(destinationDir, { recursive: true });
  const srcPath = path.join(spoolDir, fileName);
  const dstPath = await reserveEventSpoolDestination(destinationDir, fileName);
  await fsp.rename(srcPath, dstPath);
  return path.basename(dstPath);
}

export async function pruneEventSpoolDirectory(
  dir: string,
  options: EventSpoolPruneOptions = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  const maxFiles = normalizePositiveSafeInteger(
    options.maxFiles ?? EVENT_SPOOL_RETAINED_DIRECTORY_MAX_FILES,
    "maxFiles",
  );
  const maxAgeMs = normalizePositiveSafeInteger(
    options.maxAgeMs ?? EVENT_SPOOL_RETAINED_DIRECTORY_MAX_AGE_MS,
    "maxAgeMs",
  );
  const fileNames = await listEventSpoolJsonFiles(dir, { maxFiles: Number.MAX_SAFE_INTEGER - 1 });
  const entries: Array<{ fileName: string; mtimeMs: number }> = [];
  for (const fileName of fileNames) {
    try {
      const stat = await fsp.stat(path.join(dir, fileName));
      if (stat.isFile()) {
        entries.push({ fileName, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // A concurrent processor may already have removed the file.
    }
  }

  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const retained = new Set(entries.slice(0, maxFiles).map((entry) => entry.fileName));
  let removed = 0;
  for (const entry of entries) {
    const expired = now - entry.mtimeMs > maxAgeMs;
    const overLimit = !retained.has(entry.fileName);
    if (!expired && !overLimit) continue;
    try {
      await fsp.unlink(path.join(dir, entry.fileName));
      removed += 1;
    } catch {
      // Best-effort cleanup only.
    }
  }
  return removed;
}

async function reserveEventSpoolDestination(dir: string, fileName: string): Promise<string> {
  let candidate = path.join(dir, fileName);
  try {
    await fsp.access(candidate);
  } catch {
    return candidate;
  }

  const parsed = path.parse(fileName);
  for (let attempt = 0; attempt < 10; attempt++) {
    const uniqueName = `${parsed.name}-${Date.now()}-${randomUUID()}${parsed.ext}`;
    assertEventSpoolJsonFileName(uniqueName);
    candidate = path.join(dir, uniqueName);
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error(`Unable to reserve event spool destination for ${fileName}`);
}

function normalizeEventSpoolPrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (trimmed.length === 0) return "event";
  const safe = trimmed
    .split("")
    .map((char) => {
      const code = char.charCodeAt(0);
      const isDigit = code >= 48 && code <= 57;
      const isUpper = code >= 65 && code <= 90;
      const isLower = code >= 97 && code <= 122;
      return isDigit || isUpper || isLower || char === "-" || char === "_" ? char : "_";
    })
    .join("");
  return safe.length === 0 ? "event" : safe;
}

function normalizePositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
