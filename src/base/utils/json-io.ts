// ─── JSON IO Utilities ───
//
// Shared helpers for reading and writing JSON files.
// Async versions (writeJsonFileAtomic, readJsonFileOrNull, readJsonFileWithSchema)
// are preferred over the legacy sync-style async functions below.

import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { z } from "zod";

interface WriteJsonFileAtomicOptions {
  mode?: number;
  directoryMode?: number;
}

export interface ReadTextFileWithinLimitOptions {
  maxBytes: number;
  chunkBytes?: number;
  encoding?: BufferEncoding;
}

export class TextFileSizeLimitError extends Error {
  readonly code = "ERR_PULSEED_TEXT_FILE_SIZE_LIMIT";

  constructor(
    readonly filePath: string,
    readonly maxBytes: number,
  ) {
    super(`Refused to read ${filePath} because it exceeds ${maxBytes} bytes`);
    this.name = "TextFileSizeLimitError";
  }
}

const DEFAULT_BOUNDED_TEXT_READ_CHUNK_BYTES = 64 * 1024;

export function isTextFileSizeLimitError(err: unknown): err is TextFileSizeLimitError {
  return err instanceof TextFileSizeLimitError;
}

/**
 * Write data to a JSON file atomically (write to a unique .tmp, then rename).
 * Creates parent directories as needed.
 */
export async function writeJsonFileAtomic(
  filePath: string,
  data: unknown,
  options: WriteJsonFileAtomicOptions = {}
): Promise<void> {
  const parentDir = dirname(filePath);
  await fsp.mkdir(parentDir, { recursive: true, mode: options.directoryMode });
  if (options.directoryMode !== undefined) {
    await fsp.chmod(parentDir, options.directoryMode).catch(() => undefined);
  }
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), {
      encoding: "utf-8",
      mode: options.mode,
    });
    if (options.mode !== undefined) {
      await fsp.chmod(tmpPath, options.mode).catch(() => undefined);
    }
    await fsp.rename(tmpPath, filePath);
    if (options.mode !== undefined) {
      await fsp.chmod(filePath, options.mode).catch(() => undefined);
    }
  } catch (err) {
    try {
      await fsp.unlink(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Read a UTF-8 text file from a single opened descriptor while enforcing a byte cap.
 * The implementation reads at most maxBytes + 1 bytes, so callers can reject
 * oversized JSON before loading or parsing the whole file.
 */
export async function readTextFileWithinLimit(
  filePath: string,
  options: ReadTextFileWithinLimitOptions,
): Promise<string> {
  const normalized = normalizeBoundedTextReadOptions(options);
  const handle = await fsp.open(filePath, "r");
  try {
    const { chunks, totalBytes } = await readChunksWithinLimit(
      async (buffer, length) => {
        const { bytesRead } = await handle.read(buffer, 0, length, null);
        return bytesRead;
      },
      filePath,
      normalized.maxBytes,
      normalized.chunkBytes,
    );
    return Buffer.concat(chunks, totalBytes).toString(normalized.encoding);
  } finally {
    await handle.close();
  }
}

export function readTextFileWithinLimitSync(
  filePath: string,
  options: ReadTextFileWithinLimitOptions,
): string {
  const normalized = normalizeBoundedTextReadOptions(options);
  const fd = fs.openSync(filePath, "r");
  try {
    const { chunks, totalBytes } = readChunksWithinLimitSync(
      (buffer, length) => fs.readSync(fd, buffer, 0, length, null),
      filePath,
      normalized.maxBytes,
      normalized.chunkBytes,
    );
    return Buffer.concat(chunks, totalBytes).toString(normalized.encoding);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read and parse a JSON file asynchronously.
 * Returns null on ENOENT or invalid JSON (does not throw).
 */
export async function readJsonFileOrNull<T = unknown>(filePath: string): Promise<T | null> {
  let content: string;
  try {
    content = await fsp.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  try {
    return JSON.parse(content) as T;
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

/**
 * Read, parse, and validate a JSON file against a Zod schema.
 * Returns null on ENOENT, invalid JSON, or schema validation failure (does not throw).
 */
export async function readJsonFileWithSchema<T>(
  filePath: string,
  schema: z.ZodType<T>
): Promise<T | null> {
  const raw = await readJsonFileOrNull(filePath);
  if (raw === null) return null;
  const result = schema.safeParse(raw);
  return result.success ? result.data : null;
}

// ─── Legacy helpers (async, kept for backward compatibility) ───
// Prefer the atomic/null-safe versions above for new code.

/**
 * Read and parse a JSON file asynchronously.
 * Throws if the file does not exist or contains invalid JSON.
 * @deprecated Prefer readJsonFileOrNull
 */
export async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await fsp.readFile(filePath, "utf-8");
  return JSON.parse(content) as T;
}

/**
 * Write data to a JSON file asynchronously with 2-space indent.
 * @deprecated Prefer writeJsonFileAtomic
 */
export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

interface NormalizedBoundedTextReadOptions {
  maxBytes: number;
  chunkBytes: number;
  encoding: BufferEncoding;
}

function normalizeBoundedTextReadOptions(options: ReadTextFileWithinLimitOptions): NormalizedBoundedTextReadOptions {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || options.maxBytes >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("maxBytes must be a nonnegative safe integer below Number.MAX_SAFE_INTEGER");
  }
  const chunkBytes = options.chunkBytes ?? DEFAULT_BOUNDED_TEXT_READ_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new RangeError("chunkBytes must be a positive safe integer");
  }
  return {
    maxBytes: options.maxBytes,
    chunkBytes,
    encoding: options.encoding ?? "utf-8",
  };
}

async function readChunksWithinLimit(
  read: (buffer: Buffer, length: number) => Promise<number>,
  filePath: string,
  maxBytes: number,
  chunkBytes: number,
): Promise<{ chunks: Buffer[]; totalBytes: number }> {
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, maxBytes + 1));
  let totalBytes = 0;

  while (true) {
    const remainingBytes = maxBytes + 1 - totalBytes;
    if (remainingBytes <= 0) {
      throw new TextFileSizeLimitError(filePath, maxBytes);
    }

    const bytesRead = await read(buffer, Math.min(buffer.byteLength, remainingBytes));
    if (bytesRead === 0) break;

    totalBytes += bytesRead;
    if (totalBytes > maxBytes) {
      throw new TextFileSizeLimitError(filePath, maxBytes);
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }

  return { chunks, totalBytes };
}

function readChunksWithinLimitSync(
  read: (buffer: Buffer, length: number) => number,
  filePath: string,
  maxBytes: number,
  chunkBytes: number,
): { chunks: Buffer[]; totalBytes: number } {
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, maxBytes + 1));
  let totalBytes = 0;

  while (true) {
    const remainingBytes = maxBytes + 1 - totalBytes;
    if (remainingBytes <= 0) {
      throw new TextFileSizeLimitError(filePath, maxBytes);
    }

    const bytesRead = read(buffer, Math.min(buffer.byteLength, remainingBytes));
    if (bytesRead === 0) break;

    totalBytes += bytesRead;
    if (totalBytes > maxBytes) {
      throw new TextFileSizeLimitError(filePath, maxBytes);
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }

  return { chunks, totalBytes };
}
