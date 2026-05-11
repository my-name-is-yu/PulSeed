import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata } from "../../types.js";
import { execFileNoThrow } from "../../../base/utils/execFileNoThrow.js";
import { validateFilePath } from "../FileValidationTool/FileValidationTool.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS, READ_ONLY } from "./constants.js";

const GREP_DEFAULT_LIMIT = 250;
const GREP_MAX_LIMIT = 10_000;
const GREP_MAX_CONTEXT_LINES = 20;

export const GrepInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  outputMode: z.enum(["content", "files_with_matches", "count"]).default("files_with_matches"),
  limit: z.number().int().min(1).max(GREP_MAX_LIMIT).default(GREP_DEFAULT_LIMIT),
  caseInsensitive: z.boolean().default(false),
  fixedStrings: z.boolean().optional(),
  context: z.number().int().min(0).max(GREP_MAX_CONTEXT_LINES).optional(),
}).strict();
export type GrepInput = z.infer<typeof GrepInputSchema>;

interface LimitedGrepOutput {
  output: string;
  lines: string[];
  truncated: boolean;
}

function limitGrepOutput(rawOutput: string, limit: number): LimitedGrepOutput {
  const output = rawOutput.trim();
  if (output.length === 0) {
    return { output: "", lines: [], truncated: false };
  }

  const lines = output.split("\n");
  const limitedLines = lines.slice(0, limit);
  return {
    output: limitedLines.join("\n"),
    lines: limitedLines,
    truncated: lines.length > limitedLines.length,
  };
}

function formatGrepSummary(
  pattern: string,
  outputMode: GrepInput["outputMode"],
  lineCount: number,
  truncated: boolean,
  limit: number
): string {
  const resultKind = (() => {
    switch (outputMode) {
      case "files_with_matches":
        return "files";
      case "count":
        return "count rows";
      case "content":
        return "matches";
    }
  })();
  const truncation = truncated ? ` (truncated to limit ${limit})` : "";
  return `Found ${lineCount} ${resultKind} for pattern "${pattern}"${truncation}`;
}

export class GrepTool implements ITool<GrepInput, string> {
  readonly metadata: ToolMetadata = {
    name: "grep",
    aliases: ["search", "rg"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
    activityCategory: "search",
  };
  readonly inputSchema = GrepInputSchema;

  description(): string {
    return DESCRIPTION;
  }

  async call(input: GrepInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const searchPath = input.path ?? ".";
    try {
      const args: string[] = ["--no-heading"];
      if (input.caseInsensitive) args.push("-i");
      if (input.fixedStrings === true) args.push("-F");
      if (input.glob) args.push("--glob", input.glob);
      if (input.context !== undefined) args.push("-C", String(input.context));
      switch (input.outputMode) {
        case "files_with_matches":
          args.push("-l");
          break;
        case "count":
          args.push("-c");
          break;
        case "content":
          args.push("-n");
          break;
      }
      args.push("--max-count", String(input.limit));
      args.push(input.pattern, searchPath);

      const result = await execFileNoThrow("rg", args, { cwd: context.cwd, timeoutMs: 30_000 });
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        const error = result.stderr.trim() || `ripgrep exited with code ${result.exitCode ?? "unknown"}`;
        return {
          success: false,
          data: "",
          summary: `Grep failed: ${error}`,
          error,
          durationMs: Date.now() - startTime,
        };
      }

      const limited = limitGrepOutput(result.stdout, input.limit);
      let output = limited.output;
      if (
        input.outputMode === "content" &&
        input.context !== undefined &&
        output.length > 0 &&
        !limited.truncated &&
        limited.lines.length < input.limit &&
        !output.includes("\n--\n")
      ) {
        output = `${output}\n--`;
      }
      return {
        success: true,
        data: output,
        summary: formatGrepSummary(
          input.pattern,
          input.outputMode,
          limited.lines.length,
          limited.truncated,
          input.limit
        ),
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: "",
        summary: `Grep failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(input: GrepInput, context?: ToolCallContext): Promise<PermissionCheckResult> {
    if (context) {
      const validation = validateFilePath(input.path ?? ".", context.cwd);
      if (!validation.valid) {
        return { status: "needs_approval", reason: `Searching outside the working directory: ${validation.resolved}` };
      }
    }
    return { status: "allowed" };
  }

  isConcurrencySafe(_input?: GrepInput): boolean {
    return true;
  }
}
