import { z } from "zod";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolMetadata, ToolResult } from "../../types.js";
import { ShellTimeoutMsSchema, ShellTool } from "../ShellTool/ShellTool.js";
import { containsShellExecutable } from "../ShellTool/command-policy.js";

export const ShellCommandInputSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: ShellTimeoutMsSchema,
  description: z.string().optional(),
});
export type ShellCommandInput = z.infer<typeof ShellCommandInputSchema>;

export class ShellCommandTool implements ITool<ShellCommandInput> {
  private readonly shellTool = new ShellTool();

  readonly metadata: ToolMetadata = {
    ...this.shellTool.metadata,
    name: "shell_command",
    aliases: ["shell_cmd"],
    tags: ["agentloop", "system", "verification"],
  };

  readonly inputSchema = ShellCommandInputSchema;

  description(): string {
    return "Run a shell command with explicit cwd and timeout. Use for inspection, verification, and supported one-line commands. Do not use for file edits, heredocs, here-strings, inline language rewrites, or other multiline shell write patterns; use apply_patch or another typed file edit tool instead.";
  }

  async call(input: ShellCommandInput, context: ToolCallContext): Promise<ToolResult> {
    if (containsShellExecutable(input.command, "apply_patch")) {
      return {
        success: false,
        data: null,
        summary: "Use the apply_patch tool for patch edits instead of shell_command.",
        error: "apply_patch must be called via the apply_patch tool",
        execution: {
          status: "not_executed",
          reason: "policy_blocked",
          message: "apply_patch must be called via the apply_patch tool",
        },
        durationMs: 0,
      };
    }
    return this.shellTool.call(input, context);
  }

  async checkPermissions(input: ShellCommandInput, context: ToolCallContext): Promise<PermissionCheckResult> {
    return this.shellTool.checkPermissions(input, context);
  }

  isConcurrencySafe(input: ShellCommandInput): boolean {
    return this.shellTool.isConcurrencySafe(input);
  }
}
