import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const AskHumanInputSchema = z.object({
  question: z.string().min(1, "question is required"),
  options: z.array(z.string()).optional(),
  approval_scope: z.enum(["write", "execute", "durable_run"]).optional(),
  approval_target_tool: z.string().min(1).optional(),
}).strict();
export type AskHumanInput = z.infer<typeof AskHumanInputSchema>;

export class AskHumanTool implements ITool<AskHumanInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "ask-human",
    aliases: ["ask_human", "human_input"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
    gatewayExposure: "default_safe",
  };
  readonly inputSchema = AskHumanInputSchema;

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: AskHumanInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const permissionLevel = permissionLevelForApprovalScope(input.approval_scope);
      const approved = await context.approvalFn({
        toolName: "ask-human",
        input: {
          question: input.question,
          options: input.options,
          approval_scope: input.approval_scope,
          approval_target_tool: input.approval_target_tool,
        },
        reason: input.question,
        permissionLevel,
        isDestructive: input.approval_scope !== undefined,
        reversibility: input.approval_scope === "execute" ? "unknown" : "reversible",
      });
      const answer = approved ? "approved" : "denied";
      if (!approved && input.approval_scope) {
        return {
          success: false,
          data: {
            answer,
            question: input.question,
            approval_scope: input.approval_scope,
            approval_target_tool: input.approval_target_tool,
          },
          summary: `Human denied ${input.approval_scope} permission: ${input.question}`,
          error: `Human denied ${input.approval_scope} permission`,
          execution: {
            status: "not_executed",
            reason: "approval_denied",
            message: `Human denied ${input.approval_scope} permission: ${input.question}`,
          },
          durationMs: Date.now() - startTime,
        };
      }
      return {
        success: true,
        data: {
          answer,
          question: input.question,
          approval_scope: input.approval_scope,
          approval_target_tool: input.approval_target_tool,
        },
        summary: `Human answered: ${answer}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "AskHumanTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(
    _input: AskHumanInput,
    _context: ToolCallContext,
  ): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: AskHumanInput): boolean {
    return false;
  }
}

function permissionLevelForApprovalScope(scope: AskHumanInput["approval_scope"]): "read_only" | "write_local" | "execute" {
  switch (scope) {
    case "write":
    case "durable_run":
      return "write_local";
    case "execute":
      return "execute";
    default:
      return "read_only";
  }
}
