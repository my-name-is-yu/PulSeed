import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata } from "../../types.js";
import { execFileNoThrow } from "../../../base/utils/execFileNoThrow.js";
import { expandTildePath } from "../../fs/FileValidationTool/protected-path-policy.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, MAX_OUTPUT_CHARS, PERMISSION_LEVEL } from "./constants.js";
import { assessShellCommand, formatShellPolicyDenialReason, isReadOnlyShellCommand } from "./command-policy.js";
import { resolveWorkspaceCwd } from "../../workspace-scope.js";

export const SHELL_TIMEOUT_DEFAULT_MS = 120_000;
export const SHELL_TIMEOUT_MAX_MS = 600_000;
export const ShellTimeoutMsSchema = z.number().int().min(1).max(SHELL_TIMEOUT_MAX_MS).default(SHELL_TIMEOUT_DEFAULT_MS);

export const ShellInputSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: ShellTimeoutMsSchema,
  description: z.string().optional(),
}).strict();
export type ShellInput = z.infer<typeof ShellInputSchema>;

export interface ShellOutput { stdout: string; stderr: string; exitCode: number; }

export class ShellTool implements ITool<ShellInput, ShellOutput> {
  readonly metadata: ToolMetadata = {
    name: "shell", aliases: ["bash", "exec", "run"],
    permissionLevel: PERMISSION_LEVEL, isReadOnly: false, isDestructive: false,
    shouldDefer: false, alwaysLoad: true, maxConcurrency: 3,
    maxOutputChars: MAX_OUTPUT_CHARS, tags: [...TAGS],
    activityCategory: "command",
  };
  readonly inputSchema = ShellInputSchema;

  description(): string {
    return DESCRIPTION;
  }

  async call(input: ShellInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const cwdValidation = resolveWorkspaceCwd(input.cwd, context);
    if (!cwdValidation.valid) {
      return {
        success: false,
        data: { stdout: "", stderr: cwdValidation.error ?? "Invalid cwd", exitCode: -1 },
        summary: `Shell command blocked: ${cwdValidation.error ?? "Invalid cwd"}`,
        error: cwdValidation.error ?? "Invalid cwd",
        execution: { status: "not_executed", reason: "policy_blocked", message: cwdValidation.error ?? "Invalid cwd" },
        durationMs: Date.now() - startTime,
      };
    }
    const cwd = expandTildePath(cwdValidation.resolved);
    try {
      const shell = process.env.SHELL ?? "/bin/zsh";
      const result = await execFileNoThrow(shell, ["-c", input.command], { cwd, timeoutMs: input.timeoutMs, signal: context.abortSignal, killProcessGroup: true });
      const exitCode = result.exitCode ?? -1;
      const output: ShellOutput = { stdout: result.stdout, stderr: result.stderr, exitCode };
      return {
        success: exitCode === 0, data: output,
        summary: exitCode === 0
          ? `Command succeeded (exit 0)${result.stdout.length > 0 ? `: ${result.stdout.slice(0, 200)}` : ""}`
          : `Command failed (exit ${exitCode}): ${result.stderr.slice(0, 200)}`,
        error: exitCode !== 0 ? result.stderr.slice(0, 500) : undefined,
        durationMs: Date.now() - startTime,
        contextModifier: exitCode === 0 ? `Shell output: ${result.stdout.slice(0, 500)}` : undefined,
      };
    } catch (err) {
      return {
        success: false, data: { stdout: "", stderr: (err as Error).message, exitCode: -1 },
        summary: `Shell execution failed: ${(err as Error).message}`,
        error: (err as Error).message, durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(input: ShellInput, context?: ToolCallContext): Promise<PermissionCheckResult> {
    let assessmentCwd = input.cwd ?? context?.cwd;
    if (context) {
      const cwdValidation = resolveWorkspaceCwd(input.cwd, context);
      if (!cwdValidation.valid) {
        return { status: "denied", reason: cwdValidation.error ?? "Invalid cwd", executionReason: "policy_blocked" };
      }
      assessmentCwd = cwdValidation.resolved;
    }
    const assessment = assessShellCommand(
      input.command,
      context?.executionPolicy,
      context?.trusted === true,
      assessmentCwd,
    );
    if (assessment.status === "allowed") return { status: "allowed" };
    if (assessment.status === "needs_approval") {
      return { status: "needs_approval", reason: assessment.reason ?? "Shell command requires approval" };
    }
    return {
      status: "denied",
      reason: formatShellPolicyDenialReason(assessment.reason ?? "Shell command denied by policy"),
      executionReason: "policy_blocked",
    };
  }

  isConcurrencySafe(input: ShellInput): boolean {
    return isReadOnlyShellCommand(input.command);
  }
}
