import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolMetadata, ToolResult } from "../../types.js";

export const ApplyPatchInputSchema = z.object({
  patch: z.string().min(1),
  cwd: z.string().optional(),
  checkOnly: z.boolean().default(false),
});
export type ApplyPatchInput = z.infer<typeof ApplyPatchInputSchema>;

export class ApplyPatchTool implements ITool<ApplyPatchInput> {
  readonly metadata: ToolMetadata = {
    name: "apply_patch",
    aliases: ["patch"],
    permissionLevel: "write_local",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: true,
    maxConcurrency: 1,
    maxOutputChars: 8000,
    tags: ["agentloop", "filesystem", "edit"],
  };

  readonly inputSchema = ApplyPatchInputSchema;

  description(): string {
    return "Apply a unified diff patch to files under the current workspace.";
  }

  async call(input: ApplyPatchInput, context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    const cwd = input.cwd ?? context.cwd;
    if (input.patch.trimStart().startsWith("*** Begin Patch")) {
      return this.callCodexPatch(input, cwd, started);
    }
    const args = input.checkOnly ? ["apply", "--check", "--whitespace=nowarn", "-"] : ["apply", "--whitespace=nowarn", "-"];
    const result = await runGitApply(args, input.patch, cwd);
    const changedPaths = extractPatchPaths(input.patch);
    return {
      success: result.exitCode === 0,
      data: {
        changedPaths,
        stdout: result.stdout,
        stderr: result.stderr,
        checkOnly: input.checkOnly,
      },
      summary: result.exitCode === 0
        ? `${input.checkOnly ? "Patch check passed" : "Patch applied"}: ${changedPaths.join(", ") || "no paths detected"}`
        : `Patch failed: ${result.stderr || result.stdout}`,
      error: result.exitCode === 0 ? undefined : result.stderr || result.stdout,
      durationMs: Date.now() - started,
      artifacts: changedPaths,
    };
  }

  private async callCodexPatch(input: ApplyPatchInput, cwd: string, started: number): Promise<ToolResult> {
    try {
      const operations = parseCodexPatch(input.patch);
      if (input.checkOnly) {
        for (const operation of operations) {
          await validateCodexPatchOperation(operation, cwd);
        }
      } else {
        for (const operation of operations) {
          await applyCodexPatchOperation(operation, cwd);
        }
      }
      const changedPaths = operations.map((operation) => operation.filePath);
      return {
        success: true,
        data: {
          changedPaths,
          stdout: "",
          stderr: "",
          checkOnly: input.checkOnly,
          format: "codex",
        },
        summary: `${input.checkOnly ? "Patch check passed" : "Patch applied"}: ${changedPaths.join(", ") || "no paths detected"}`,
        durationMs: Date.now() - started,
        artifacts: changedPaths,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: {
          changedPaths: [],
          stdout: "",
          stderr: message,
          checkOnly: input.checkOnly,
          format: "codex",
        },
        summary: `Patch failed: ${message}`,
        error: message,
        durationMs: Date.now() - started,
        artifacts: [],
      };
    }
  }

  async checkPermissions(_input: ApplyPatchInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(input: ApplyPatchInput): boolean {
    return input.checkOnly;
  }
}

function runGitApply(args: string[], patch: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
    child.stdin.end(patch);
  });
}

function extractPatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const match = line.match(/^\+\+\+\s+b\/(.+)$/);
    if (match?.[1] && match[1] !== "/dev/null") {
      paths.add(match[1]);
    }
  }
  return [...paths];
}

type CodexPatchOperation =
  | { type: "add"; filePath: string; content: string }
  | { type: "update"; filePath: string; hunks: Array<{ oldText: string; newText: string }> };

function parseCodexPatch(patch: string): CodexPatchOperation[] {
  const lines = patch.split("\n");
  const operations: CodexPatchOperation[] = [];
  let i = 0;
  if (lines[i]?.trim() !== "*** Begin Patch") {
    throw new Error("Codex patch must start with *** Begin Patch");
  }
  i++;

  while (i < lines.length) {
    const line = lines[i]?.trimEnd() ?? "";
    if (line === "*** End Patch") break;
    if (line.startsWith("*** Add File: ")) {
      const filePath = line.slice("*** Add File: ".length).trim();
      i++;
      const contentLines: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith("*** ")) {
        const contentLine = lines[i]!;
        if (!contentLine.startsWith("+")) throw new Error(`Invalid add-file line for ${filePath}: ${contentLine}`);
        contentLines.push(contentLine.slice(1));
        i++;
      }
      operations.push({ type: "add", filePath, content: contentLines.join("\n") + "\n" });
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const filePath = line.slice("*** Update File: ".length).trim();
      i++;
      const hunks: Array<{ oldText: string; newText: string }> = [];
      let oldLines: string[] = [];
      let newLines: string[] = [];
      const flush = () => {
        if (oldLines.length === 0 && newLines.length === 0) return;
        hunks.push({ oldText: oldLines.join("\n") + "\n", newText: newLines.join("\n") + "\n" });
        oldLines = [];
        newLines = [];
      };
      while (i < lines.length && !lines[i]!.startsWith("*** ")) {
        const hunkLine = lines[i]!;
        if (hunkLine.startsWith("@@")) {
          flush();
        } else if (hunkLine.startsWith("-")) {
          oldLines.push(hunkLine.slice(1));
        } else if (hunkLine.startsWith("+")) {
          newLines.push(hunkLine.slice(1));
        } else if (hunkLine.startsWith(" ")) {
          oldLines.push(hunkLine.slice(1));
          newLines.push(hunkLine.slice(1));
        } else if (hunkLine.trim() !== "") {
          throw new Error(`Invalid update-file line for ${filePath}: ${hunkLine}`);
        }
        i++;
      }
      flush();
      if (hunks.length === 0) throw new Error(`No update hunks found for ${filePath}`);
      operations.push({ type: "update", filePath, hunks });
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    throw new Error(`Unsupported Codex patch operation: ${line}`);
  }

  if (operations.length === 0) throw new Error("No patch operations found");
  return operations;
}

async function validateCodexPatchOperation(operation: CodexPatchOperation, cwd: string): Promise<void> {
  const target = resolveWorkspacePath(cwd, operation.filePath);
  if (operation.type === "add") {
    try {
      await fsp.access(target);
      throw new Error(`File already exists: ${operation.filePath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return;
  }
  const current = await fsp.readFile(target, "utf-8");
  for (const hunk of operation.hunks) {
    if (!current.includes(hunk.oldText)) {
      throw new Error(`Patch context not found in ${operation.filePath}: ${hunk.oldText.trim()}`);
    }
  }
}

async function applyCodexPatchOperation(operation: CodexPatchOperation, cwd: string): Promise<void> {
  const target = resolveWorkspacePath(cwd, operation.filePath);
  if (operation.type === "add") {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, operation.content, "utf-8");
    return;
  }
  let current = await fsp.readFile(target, "utf-8");
  for (const hunk of operation.hunks) {
    if (!current.includes(hunk.oldText)) {
      throw new Error(`Patch context not found in ${operation.filePath}: ${hunk.oldText.trim()}`);
    }
    current = current.replace(hunk.oldText, hunk.newText);
  }
  await fsp.writeFile(target, current, "utf-8");
}

function resolveWorkspacePath(cwd: string, filePath: string): string {
  const resolvedCwd = path.resolve(cwd);
  const resolved = path.resolve(resolvedCwd, filePath);
  if (resolved !== resolvedCwd && !resolved.startsWith(`${resolvedCwd}${path.sep}`)) {
    throw new Error(`Patch path escapes workspace: ${filePath}`);
  }
  return resolved;
}
