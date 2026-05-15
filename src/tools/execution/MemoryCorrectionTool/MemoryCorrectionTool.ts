import { z } from "zod/v3";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolMetadata,
  ToolResult,
} from "../../types.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import {
  parseMemoryCorrectionRef,
  runUserMemoryOperation,
} from "../../../platform/corrections/user-memory-operations.js";
import { DESCRIPTION } from "./prompt.js";
import { ALIASES, PERMISSION_LEVEL, READ_ONLY, TAGS, TOOL_NAME } from "./constants.js";

export const MemoryCorrectionInputSchema = z.object({
  operation: z.enum(["correct", "forget", "retract", "history"]),
  target_ref: z.string().min(1).describe("Exact typed ref: agent_memory:<id>, runtime_evidence:<id>, dream_checkpoint:<ref>, or soil_record:<id>"),
  reason: z.string().min(1).optional(),
  replacement_value: z.string().min(1).optional(),
  replacement_ref: z.string().min(1).optional(),
  replacement_key: z.string().min(1).optional(),
  goal_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
});
export type MemoryCorrectionInput = z.infer<typeof MemoryCorrectionInputSchema>;

export class MemoryCorrectionTool implements ITool<MemoryCorrectionInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: TOOL_NAME,
    aliases: [...ALIASES],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 2000,
    tags: [...TAGS],
  };

  readonly inputSchema = MemoryCorrectionInputSchema;

  constructor(private readonly stateManager: StateManager) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: MemoryCorrectionInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const result = await runUserMemoryOperation(this.stateManager, {
        operation: input.operation,
        targetRef: parseMemoryCorrectionRef(input.target_ref),
        reason: input.reason,
        replacementValue: input.replacement_value,
        replacementKey: input.replacement_key,
        replacementRef: input.replacement_ref ? parseMemoryCorrectionRef(input.replacement_ref) : null,
        goalId: input.goal_id,
        runId: input.run_id,
        taskId: input.task_id,
      });
      return {
        success: true,
        data: result,
        summary: input.operation === "history"
          ? `Found ${result.history.length} correction history entries`
          : `Memory ${input.operation} recorded: ${result.correction?.correction_id}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "MemoryCorrectionTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(input: MemoryCorrectionInput, _context: ToolCallContext): Promise<PermissionCheckResult> {
    if (input.operation === "history") return { status: "allowed" };
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: MemoryCorrectionInput): boolean {
    return false;
  }
}
