import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import { applyNaturalLanguageNotificationRouting } from "../../../runtime/notification-routing.js";
import { buildLLMClient } from "../../../base/llm/provider-factory.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const ConfigureNotificationRoutingInputSchema = z.object({
  instruction: z.string().min(1, "instruction is required"),
}).strict();
export type ConfigureNotificationRoutingInput = z.infer<typeof ConfigureNotificationRoutingInputSchema>;

export interface ConfigureNotificationRoutingToolDeps {
  buildLLMClient?: () => Promise<Pick<ILLMClient, "sendMessage" | "parseJSON">>;
}

export class ConfigureNotificationRoutingTool implements ITool<ConfigureNotificationRoutingInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "configure_notification_routing",
    aliases: ["route_notifications", "configure_reports"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };
  readonly inputSchema = ConfigureNotificationRoutingInputSchema;

  constructor(private readonly deps: ConfigureNotificationRoutingToolDeps = {}) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: ConfigureNotificationRoutingInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const llmClient = await (this.deps.buildLLMClient ?? buildLLMClient)();
      const update = await applyNaturalLanguageNotificationRouting(input.instruction, undefined, { llmClient });
      return {
        success: update.applied,
        data: update,
        summary: update.summary,
        error: update.applied ? undefined : update.summary,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: null,
        summary: "ConfigureNotificationRoutingTool failed: " + message,
        error: message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: ConfigureNotificationRoutingInput, context: ToolCallContext): Promise<PermissionCheckResult> {
    if (context.preApproved) return { status: "allowed" };
    return {
      status: "needs_approval",
      reason: "Changing notification and report routing requires user confirmation",
    };
  }

  isConcurrencySafe(_input?: ConfigureNotificationRoutingInput): boolean {
    return false;
  }
}
