import { z } from "zod";
import fs from "node:fs/promises";
import { join, resolve, dirname, relative, isAbsolute, sep } from "node:path";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import { getPulseedDirPath } from "../../../base/utils/paths.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, MAX_OUTPUT_CHARS, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const WritePulseedFileInputSchema = z.object({
  path: z.string().min(1, "path is required"),
  content: z.string(),
});
export type WritePulseedFileInput = z.infer<typeof WritePulseedFileInputSchema>;

function resolveSafe(relativePath: string): string | null {
  const base = resolve(getPulseedDirPath());
  const full = resolve(join(base, relativePath));
  const rel = relative(base, full);
  if (rel.startsWith("..") || rel === ".." || isAbsolute(rel)) {
    return null;
  }
  return full;
}

async function isRealPathInPulseedHome(fullPath: string): Promise<boolean> {
  const realBase = await fs.realpath(getPulseedDirPath());
  const realPath = await fs.realpath(fullPath);
  const rel = relative(realBase, realPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function ensureSafeParentDir(fullPath: string): Promise<boolean> {
  const base = resolve(getPulseedDirPath());
  await fs.mkdir(base, { recursive: true });
  const realBase = await fs.realpath(base);
  const parent = dirname(fullPath);
  const parentRel = relative(base, parent);
  const parts = parentRel === "" ? [] : parentRel.split(sep).filter(Boolean);
  let current = base;

  for (const part of parts) {
    current = join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() && !stat.isSymbolicLink()) {
        return false;
      }
      if (!(await isRealPathInPulseedHome(current))) {
        return false;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
      await fs.mkdir(current);
      if (!(await isRealPathInPulseedHome(current))) {
        return false;
      }
    }
  }

  try {
    await fs.lstat(fullPath);
    return isRealPathInPulseedHome(fullPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw err;
  }
}

export class WritePulseedFileTool implements ITool<WritePulseedFileInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "write-pulseed-file",
    aliases: [],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };
  readonly inputSchema = WritePulseedFileInputSchema;

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: WritePulseedFileInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const fullPath = resolveSafe(input.path);
    if (!fullPath) {
      return {
        success: false,
        data: null,
        summary: "Path traversal blocked: " + input.path,
        error: "Path must be within ~/.pulseed/",
        durationMs: Date.now() - startTime,
      };
    }
    try {
      if (!(await ensureSafeParentDir(fullPath))) {
        return {
          success: false,
          data: null,
          summary: "Path traversal blocked: " + input.path,
          error: "Path must be within ~/.pulseed/",
          durationMs: Date.now() - startTime,
        };
      }
      await fs.writeFile(fullPath, input.content, "utf-8");
      const byteLength = Buffer.byteLength(input.content, "utf-8");
      return {
        success: true,
        data: { path: fullPath, byteLength },
        summary: `Wrote ${byteLength} bytes to ~/.pulseed/${input.path}`,
        durationMs: Date.now() - startTime,
        artifacts: [fullPath],
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "Failed to write ~/.pulseed/" + input.path,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(input: WritePulseedFileInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return {
      status: "needs_approval",
      reason: `Writing to ~/.pulseed/${input.path}`,
    };
  }

  isConcurrencySafe(_input: WritePulseedFileInput): boolean {
    return false;
  }
}
