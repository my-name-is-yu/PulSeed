import { z } from "zod/v3";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import { globIterate } from "glob";
import { isAbsolute } from "node:path";
import { validateFilePath } from "../FileValidationTool/FileValidationTool.js";
import { DESCRIPTION_PREFIX, DESCRIPTION_SUFFIX } from "./prompt.js";
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS, READ_ONLY } from "./constants.js";

const GLOB_DEFAULT_LIMIT = 500;
const GLOB_MAX_LIMIT = 10_000;

export const GlobInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  limit: z.number().int().min(1).max(GLOB_MAX_LIMIT).default(GLOB_DEFAULT_LIMIT),
}).strict();
export type GlobInput = z.infer<typeof GlobInputSchema>;

interface GlobCollection {
  matches: string[];
  truncated: boolean;
}

async function collectGlobMatches(pattern: string, searchPath: string, limit: number): Promise<GlobCollection> {
  const matches: string[] = [];
  let truncated = false;
  for await (const match of globIterate(pattern, { cwd: searchPath, absolute: true, nodir: false })) {
    if (matches.length >= limit) {
      truncated = true;
      break;
    }
    matches.push(match);
  }
  return { matches, truncated };
}

export class GlobTool implements ITool<GlobInput, string[]> {
  readonly metadata: ToolMetadata = {
    name: "glob",
    aliases: ["find_files", "ls_glob"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
    activityCategory: "search",
    gatewayExposure: "default_safe",
  };
  readonly inputSchema = GlobInputSchema;

  description(context?: ToolDescriptionContext): string {
    const cwd = context?.cwd ?? process.cwd();
    return `${DESCRIPTION_PREFIX}${cwd}${DESCRIPTION_SUFFIX}`;
  }

  async call(input: GlobInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const searchPath = input.path ?? context.cwd;
    try {
      const { matches, truncated } = await collectGlobMatches(input.pattern, searchPath, input.limit);
      return {
        success: true,
        data: matches,
        summary: `Found ${matches.length}${truncated ? "+" : ""} files matching "${input.pattern}"${truncated ? ` (showing first ${input.limit})` : ""}`,
        durationMs: Date.now() - startTime,
        artifacts: matches,
      };
    } catch (err) {
      return {
        success: false,
        data: [],
        summary: `Glob failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(input: GlobInput, context?: ToolCallContext): Promise<PermissionCheckResult> {
    if (isAbsolute(input.pattern) || input.pattern.split(/[\\/]+/).includes("..")) {
      return { status: "needs_approval", reason: `Glob pattern may access outside the working directory: ${input.pattern}` };
    }
    if (context) {
      const validation = validateFilePath(input.path ?? ".", context.cwd);
      if (!validation.valid) {
        return { status: "needs_approval", reason: `Globbing outside the working directory: ${validation.resolved}` };
      }
    }
    return { status: "allowed" };
  }

  isConcurrencySafe(_input?: GlobInput): boolean {
    return true;
  }
}
