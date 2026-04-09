import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../../base/utils/json-io.js";
import type { RuntimeStorePaths } from "./runtime-paths.js";
import { ensureRuntimeStorePaths } from "./runtime-paths.js";
import type { z } from "zod";

export async function ensureRuntimeDirectory(dirPath: string): Promise<void> {
  await fsp.mkdir(dirPath, { recursive: true });
}

export async function loadRuntimeJson<T>(
  filePath: string,
  schema: z.ZodType<T>
): Promise<T | null> {
  const raw = await readJsonFileOrNull<unknown>(filePath);
  if (raw === null) return null;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function saveRuntimeJson<T>(
  filePath: string,
  schema: z.ZodType<T>,
  value: T
): Promise<T> {
  const parsed = schema.parse(value);
  await writeJsonFileAtomic(filePath, parsed);
  return parsed;
}

export async function removeRuntimeJson(filePath: string): Promise<void> {
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

export async function listRuntimeJson<T>(
  dirPath: string,
  schema: z.ZodType<T>
): Promise<T[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dirPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const files = entries.filter((entry) => entry.endsWith(".json")).sort();
  const records: T[] = [];
  for (const fileName of files) {
    const record = await loadRuntimeJson(path.join(dirPath, fileName), schema);
    if (record !== null) records.push(record);
  }
  return records;
}

export async function moveRuntimeJson(sourcePath: string, targetPath: string): Promise<void> {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.rename(sourcePath, targetPath);
}

export class RuntimeJournal {
  constructor(private readonly paths: RuntimeStorePaths) {}

  async ensureReady(): Promise<void> {
    await ensureRuntimeStorePaths(this.paths);
  }

  async load<T>(filePath: string, schema: z.ZodType<T>): Promise<T | null> {
    return loadRuntimeJson(filePath, schema);
  }

  async save<T>(filePath: string, schema: z.ZodType<T>, value: T): Promise<T> {
    return saveRuntimeJson(filePath, schema, value);
  }

  async list<T>(dirPath: string, schema: z.ZodType<T>): Promise<T[]> {
    return listRuntimeJson(dirPath, schema);
  }

  async remove(filePath: string): Promise<void> {
    await removeRuntimeJson(filePath);
  }

  async move(sourcePath: string, targetPath: string): Promise<void> {
    await moveRuntimeJson(sourcePath, targetPath);
  }
}
