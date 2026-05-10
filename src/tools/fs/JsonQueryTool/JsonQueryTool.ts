import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata } from "../../types.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { validateFilePath } from "../FileValidationTool/FileValidationTool.js";
import { DESCRIPTION } from "./prompt.js";
import {
  TAGS,
  CATEGORY as _CATEGORY,
  MAX_OUTPUT_CHARS,
  READ_ONLY,
  PERMISSION_LEVEL,
  JSON_QUERY_MAX_FILE_BYTES,
  JSON_QUERY_READ_CHUNK_BYTES,
} from "./constants.js";

export const JsonQueryInputSchema = z.object({
  file_path: z.string().min(1),
  query: z.string().min(1),
}).strict();
export type JsonQueryInput = z.infer<typeof JsonQueryInputSchema>;

function oversizedJsonError(filePath: string): Error {
  return new Error(
    `JSON query refused to parse ${path.basename(filePath)} because it exceeds the parse limit; limit is ${JSON_QUERY_MAX_FILE_BYTES} bytes`
  );
}

async function readJsonFileWithinLimit(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(Math.min(JSON_QUERY_READ_CHUNK_BYTES, JSON_QUERY_MAX_FILE_BYTES + 1));
    let totalBytes = 0;

    while (true) {
      const remainingBytes = JSON_QUERY_MAX_FILE_BYTES + 1 - totalBytes;
      if (remainingBytes <= 0) {
        throw oversizedJsonError(filePath);
      }

      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, remainingBytes), null);
      if (bytesRead === 0) break;

      totalBytes += bytesRead;
      if (totalBytes > JSON_QUERY_MAX_FILE_BYTES) {
        throw oversizedJsonError(filePath);
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }

    return Buffer.concat(chunks, totalBytes).toString("utf-8");
  } finally {
    await handle.close();
  }
}

export class JsonQueryTool implements ITool<JsonQueryInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "json_query", aliases: ["jq", "json_read"],
    permissionLevel: PERMISSION_LEVEL, isReadOnly: READ_ONLY, isDestructive: false,
    shouldDefer: true, alwaysLoad: false, maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS, tags: [...TAGS],
    activityCategory: "read",
  };
  readonly inputSchema = JsonQueryInputSchema;

  description(): string {
    return DESCRIPTION;
  }

  async call(input: JsonQueryInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const filePath = path.isAbsolute(input.file_path) ? input.file_path : path.resolve(context.cwd, input.file_path);
    try {
      const content = await readJsonFileWithinLimit(filePath);
      const json = JSON.parse(content);
      const value = this.queryPath(json, input.query);
      return { success: true, data: value, summary: `${input.query} = ${JSON.stringify(value ?? null).slice(0, 200)}`, durationMs: Date.now() - startTime };
    } catch (err) {
      return { success: false, data: null, summary: `JSON query failed: ${(err as Error).message}`, error: (err as Error).message, durationMs: Date.now() - startTime };
    }
  }

  async checkPermissions(input: JsonQueryInput, context?: ToolCallContext): Promise<PermissionCheckResult> {
    if (context) {
      const validation = validateFilePath(input.file_path, context.cwd, context.executionPolicy?.protectedPaths);
      if (!validation.valid) {
        return { status: "needs_approval", reason: `Reading JSON outside the working directory: ${validation.resolved}` };
      }
    }
    return { status: "allowed" };
  }

  isConcurrencySafe(_input?: JsonQueryInput): boolean {
    return true;
  }

  private queryPath(obj: unknown, query: string): unknown {
    const parts = query.split(".").flatMap((part) => {
      const match = part.match(/^(.+?)\[(\d+)]$/);
      if (match) return [match[1], match[2]];
      return [part];
    });
    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (typeof current === "object") { current = (current as Record<string, unknown>)[part]; }
      else return undefined;
    }
    return current;
  }
}
