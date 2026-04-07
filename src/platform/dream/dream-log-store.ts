import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { writeJsonFileAtomic, readJsonFileOrNull } from "../../base/utils/json-io.js";
import { DreamWatermarkSchema, type DreamWatermark } from "./dream-types.js";
import type { z } from "zod";

export interface JsonlReadResult<T> {
  records: T[];
  malformed_lines: number;
  total_lines: number;
}

export interface JsonlRotationConfig {
  rotation_mode: "size" | "date";
  max_file_size_bytes: number;
  target_fill_ratio: number;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function resolvedJsonlPath(filePath: string, rotationMode: "size" | "date"): string {
  if (rotationMode !== "date") return filePath;
  const ext = path.extname(filePath);
  const stem = path.basename(filePath, ext);
  return path.join(path.dirname(filePath), `${stem}.${todayISO()}${ext || ".jsonl"}`);
}

async function ensureDir(filePath: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

async function countLines(filePath: string): Promise<number> {
  try {
    const content = await fsp.readFile(filePath, "utf-8");
    return content.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

async function maybeRotateBySize(filePath: string, rotation: JsonlRotationConfig): Promise<void> {
  if (rotation.rotation_mode !== "size") return;
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const maxBytes = rotation.max_file_size_bytes;
  if (stat.size <= maxBytes) return;

  const content = await fsp.readFile(filePath, "utf-8");
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const targetBytes = Math.max(1, Math.floor(maxBytes * rotation.target_fill_ratio));
  const kept: string[] = [];
  let bytes = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const lineBytes = Buffer.byteLength(line + "\n", "utf-8");
    if (kept.length > 0 && bytes + lineBytes > targetBytes) break;
    kept.unshift(line);
    bytes += lineBytes;
  }

  await fsp.writeFile(filePath, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf-8");
}

export async function appendJsonlRecord(
  filePath: string,
  record: unknown,
  rotation: JsonlRotationConfig
): Promise<string> {
  const targetPath = resolvedJsonlPath(filePath, rotation.rotation_mode);
  await ensureDir(targetPath);
  await maybeRotateBySize(targetPath, rotation);
  await fsp.appendFile(targetPath, `${JSON.stringify(record)}\n`, "utf-8");
  return targetPath;
}

export async function readJsonlRecords<T>(
  filePath: string,
  schema?: z.ZodType<T>
): Promise<JsonlReadResult<T>> {
  let content = "";
  try {
    content = await fsp.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [], malformed_lines: 0, total_lines: 0 };
    }
    throw err;
  }

  const records: T[] = [];
  let malformed = 0;
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed) as unknown;
      if (schema) {
        const parsed = schema.safeParse(raw);
        if (parsed.success) {
          records.push(parsed.data);
        } else {
          malformed++;
        }
      } else {
        records.push(raw as T);
      }
    } catch {
      malformed++;
    }
  }

  return {
    records,
    malformed_lines: malformed,
    total_lines: lines.filter((line) => line.trim().length > 0).length,
  };
}

export async function readJsonlSinceLine<T>(
  filePath: string,
  sinceLine: number,
  schema?: z.ZodType<T>
): Promise<JsonlReadResult<T>> {
  const result = await readJsonlRecords<T>(filePath, schema);
  if (sinceLine <= 0) return result;
  return {
    ...result,
    records: result.records.slice(Math.max(0, sinceLine)),
  };
}

export async function loadDreamWatermarks(filePath: string): Promise<DreamWatermark> {
  const raw = await readJsonFileOrNull<unknown>(filePath);
  const parsed = DreamWatermarkSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DreamWatermarkSchema.parse({});
}

export async function saveDreamWatermarks(filePath: string, watermarks: DreamWatermark): Promise<void> {
  await writeJsonFileAtomic(filePath, DreamWatermarkSchema.parse(watermarks));
}

export async function updateDreamWatermark(
  filePath: string,
  scope: "goal" | "importance_buffer",
  keyOrLine: string | number,
  timestamp: string
): Promise<DreamWatermark> {
  const current = await loadDreamWatermarks(filePath);
  const updated: DreamWatermark = { ...current };

  if (scope === "goal") {
    const goalId = String(keyOrLine);
    updated.goals[goalId] = {
      lastProcessedLine: typeof keyOrLine === "number" ? keyOrLine : current.goals[goalId]?.lastProcessedLine ?? 0,
      lastProcessedTimestamp: timestamp,
    };
  } else {
    const line = typeof keyOrLine === "number" ? keyOrLine : Number(keyOrLine) || 0;
    updated.importanceBuffer = {
      lastProcessedLine: line,
      lastProcessedTimestamp: timestamp,
    };
  }

  await saveDreamWatermarks(filePath, updated);
  return updated;
}

export async function getJsonlLineCount(filePath: string): Promise<number> {
  return countLines(filePath);
}

export { resolvedJsonlPath };
