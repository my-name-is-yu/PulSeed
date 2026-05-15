import { z } from "zod/v3";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata } from "../../types.js";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { validateFilePath } from "../FileValidationTool/FileValidationTool.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS, READ_ONLY } from "./constants.js";

const READ_DEFAULT_LIMIT = 2_000;
const READ_MAX_OFFSET = 1_000_000;
const READ_MAX_LIMIT = 10_000;

export const ReadInputSchema = z.object({
  file_path: z.string().min(1),
  offset: z.number().int().min(0).max(READ_MAX_OFFSET).optional(),
  limit: z.number().int().min(1).max(READ_MAX_LIMIT).default(READ_DEFAULT_LIMIT),
}).strict();
export type ReadInput = z.infer<typeof ReadInputSchema>;

interface ReadLineWindow {
  formatted: string;
  selectedCount: number;
  startLine: number;
  endLine: number;
}

async function readLineWindow(filePath: string, offset: number, limit: number): Promise<ReadLineWindow> {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const selected: string[] = [];
  let lineNumber = 0;

  try {
    for await (const line of reader) {
      lineNumber += 1;
      if (lineNumber <= offset) continue;

      selected.push(`${lineNumber}\t${line}`);
      if (selected.length >= limit) {
        reader.close();
        stream.destroy();
        break;
      }
    }
  } finally {
    reader.close();
    if (!stream.destroyed) {
      stream.destroy();
    }
  }

  return {
    formatted: selected.join("\n"),
    selectedCount: selected.length,
    startLine: offset + 1,
    endLine: selected.length > 0 ? offset + selected.length : offset,
  };
}

function formatReadSummary(filePath: string, window: ReadLineWindow): string {
  const basename = path.basename(filePath);
  if (window.selectedCount === 0) {
    return `Read 0 lines from ${basename} (starting at line ${window.startLine})`;
  }
  return `Read ${window.selectedCount} lines from ${basename} (lines ${window.startLine}-${window.endLine})`;
}

export class ReadTool implements ITool<ReadInput, string> {
  readonly metadata: ToolMetadata = {
    name: "read",
    aliases: ["cat", "view"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
    activityCategory: "read",
    gatewayExposure: "default_safe",
  };
  readonly inputSchema = ReadInputSchema;

  description(): string {
    return DESCRIPTION;
  }

  async call(input: ReadInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const filePath = path.isAbsolute(input.file_path)
      ? input.file_path
      : path.resolve(context.cwd, input.file_path);
    try {
      const start = input.offset ?? 0;
      const window = await readLineWindow(filePath, start, input.limit);
      return {
        success: true,
        data: window.formatted,
        summary: formatReadSummary(filePath, window),
        durationMs: Date.now() - startTime,
        artifacts: [filePath],
      };
    } catch (err) {
      return {
        success: false,
        data: "",
        summary: `Read failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(input: ReadInput, context?: ToolCallContext): Promise<PermissionCheckResult> {
    const basename = path.basename(input.file_path);
    const sensitivePatterns = [".env", "credentials", "secret", "private_key"];
    if (sensitivePatterns.some((p) => basename.toLowerCase().includes(p))) {
      return { status: "needs_approval", reason: `Reading potentially sensitive file: ${basename}` };
    }
    if (context) {
      const validation = validateFilePath(input.file_path, context.cwd);
      if (!validation.valid) {
        return { status: "needs_approval", reason: `Reading outside the working directory: ${validation.resolved}` };
      }
    }
    return { status: "allowed" };
  }

  isConcurrencySafe(_input?: ReadInput): boolean {
    return true;
  }
}
