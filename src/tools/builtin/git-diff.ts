import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../types.js";
import { execFileNoThrow } from "../../base/utils/execFileNoThrow.js";

export const GitDiffInputSchema = z.object({
  target: z.enum(["staged", "unstaged", "commit", "branch"]).default("unstaged"),
  path: z.string().optional(),
  ref: z.string().optional(),
  maxLines: z.number().int().min(1).max(1000).default(200),
});
export type GitDiffInput = z.infer<typeof GitDiffInputSchema>;

const SAFE_REF_RE = /^[a-zA-Z0-9._/~^-]+$/;

function validateRef(ref: string | undefined): string | null {
  if (ref === undefined) return null;
  if (!SAFE_REF_RE.test(ref)) {
    return `Invalid ref '${ref}': only alphanumeric, '.', '_', '/', '~', '^', '-' are allowed`;
  }
  return null;
}

function validatePath(path: string | undefined): string | null {
  if (path === undefined) return null;
  if (!SAFE_REF_RE.test(path)) {
    return `Invalid path '${path}': only alphanumeric, '.', '_', '/', '~', '^', '-' are allowed`;
  }
  return null;
}

export class GitDiffTool implements ITool<GitDiffInput, string> {
  readonly metadata: ToolMetadata = {
    name: "git_diff",
    aliases: ["git-diff", "gitdiff"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 5,
    maxOutputChars: 8000,
    tags: ["git", "diff", "changes", "verification"],
  };

  readonly inputSchema = GitDiffInputSchema;

  description(_context?: ToolDescriptionContext): string {
    return "View git diffs (staged, unstaged, between commits/branches) for change verification";
  }

  async call(input: GitDiffInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();

    const refErr = validateRef(input.ref);
    if (refErr) {
      return {
        success: false,
        data: "",
        summary: refErr,
        error: refErr,
        durationMs: Date.now() - startTime,
      };
    }

    const pathErr = validatePath(input.path);
    if (pathErr) {
      return {
        success: false,
        data: "",
        summary: pathErr,
        error: pathErr,
        durationMs: Date.now() - startTime,
      };
    }

    const args = buildDiffArgs(input);
    const result = await execFileNoThrow("git", args, { cwd: context.cwd, timeoutMs: 15_000 });

    if (result.exitCode !== 0) {
      return {
        success: false,
        data: "",
        summary: `git diff failed: ${result.stderr.slice(0, 200)}`,
        error: result.stderr.slice(0, 500),
        durationMs: Date.now() - startTime,
      };
    }

    const raw = result.stdout ?? "";
    if (!raw.trim()) {
      return {
        success: true,
        data: "",
        summary: "No changes found",
        durationMs: Date.now() - startTime,
      };
    }

    const NL = "\n";
    const lines = raw.split(NL);
    const truncated = lines.length > input.maxLines;
    const output = truncated
      ? lines.slice(0, input.maxLines).join(NL) + NL + "[truncated]"
      : raw;

    return {
      success: true,
      data: output,
      summary: `git diff (${input.target}): ${lines.length} lines${truncated ? ` (truncated to ${input.maxLines})` : ""}`,
      durationMs: Date.now() - startTime,
    };
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}

function buildDiffArgs(input: GitDiffInput): string[] {
  const args: string[] = ["diff"];

  switch (input.target) {
    case "staged":
      args.push("--cached");
      break;
    case "unstaged":
      break;
    case "commit":
      if (input.ref) {
        args.push(`${input.ref}^..${input.ref}`);
      }
      break;
    case "branch":
      if (input.ref) {
        args.push(`${input.ref}...HEAD`);
      }
      break;
  }

  if (input.path) {
    args.push("--", input.path);
  }

  return args;
}
