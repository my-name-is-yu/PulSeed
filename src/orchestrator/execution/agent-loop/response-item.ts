import { z } from "zod";
import { ToolResultSchema } from "../../../tools/types.js";
import type { ToolResult } from "../../../tools/types.js";

export const ResponseItemPhaseSchema = z.enum(["commentary", "final_answer"]);

export const AssistantTextResponseItemSchema = z.object({
  type: z.literal("assistant_text"),
  id: z.string().optional(),
  content: z.string(),
  phase: ResponseItemPhaseSchema.optional(),
});

export const ReasoningProgressResponseItemSchema = z.object({
  type: z.literal("reasoning_progress"),
  id: z.string().optional(),
  content: z.string(),
});

export const FunctionToolCallResponseItemSchema = z.object({
  type: z.literal("function_tool_call"),
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.unknown(),
});

export const ToolExecutionStateSchema = z.object({
  status: z.enum(["executed", "not_executed"]),
  reason: z.enum(["approval_denied", "permission_denied", "policy_blocked", "dry_run", "tool_error", "timed_out", "interrupted", "sandbox_required", "escalation_required", "stale_state"]).optional(),
  message: z.string().optional(),
});

export const ToolErrorCodeSchema = z.enum([
  "invalid_arguments",
  "not_allowed",
  "execution_failed",
]);

export const ToolResultResponseItemSchema = z.object({
  type: z.literal("tool_result"),
  id: z.string().optional(),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  arguments: z.unknown(),
  result: ToolResultSchema,
  durationMs: z.number(),
});

export const ToolErrorResponseItemSchema = z.object({
  type: z.literal("tool_error"),
  id: z.string().optional(),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  arguments: z.unknown(),
  error: z.object({
    code: ToolErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
  result: ToolResultSchema.optional(),
  execution: ToolExecutionStateSchema.optional(),
  durationMs: z.number(),
});

export const UnknownToolResponseItemSchema = z.object({
  type: z.literal("unknown_tool"),
  id: z.string().optional(),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  arguments: z.unknown(),
  message: z.string(),
  execution: ToolExecutionStateSchema,
  durationMs: z.number(),
});

export const ResponseItemSchema = z.discriminatedUnion("type", [
  AssistantTextResponseItemSchema,
  ReasoningProgressResponseItemSchema,
  FunctionToolCallResponseItemSchema,
  ToolResultResponseItemSchema,
  ToolErrorResponseItemSchema,
  UnknownToolResponseItemSchema,
]);

export type AssistantTextResponseItem = z.infer<typeof AssistantTextResponseItemSchema>;
export type ReasoningProgressResponseItem = z.infer<typeof ReasoningProgressResponseItemSchema>;
export type FunctionToolCallResponseItem = z.infer<typeof FunctionToolCallResponseItemSchema>;
export type ToolResultResponseItem = z.infer<typeof ToolResultResponseItemSchema>;
export type ToolErrorResponseItem = z.infer<typeof ToolErrorResponseItemSchema>;
export type UnknownToolResponseItem = z.infer<typeof UnknownToolResponseItemSchema>;
export type ResponseItem = z.infer<typeof ResponseItemSchema>;
export type ToolObservationResponseItem =
  | ToolResultResponseItem
  | ToolErrorResponseItem
  | UnknownToolResponseItem;

export function assistantTextResponseItem(
  content: string,
  phase?: AssistantTextResponseItem["phase"],
): AssistantTextResponseItem {
  return {
    type: "assistant_text",
    content,
    ...(phase ? { phase } : {}),
  };
}

export function reasoningProgressResponseItem(content: string): ReasoningProgressResponseItem {
  return {
    type: "reasoning_progress",
    content,
  };
}

export function functionToolCallResponseItem(call: { id: string; name: string; input: unknown }): FunctionToolCallResponseItem {
  return {
    type: "function_tool_call",
    id: call.id,
    name: call.name,
    arguments: call.input,
  };
}

export function toolResultResponseItem(input: {
  call: FunctionToolCallResponseItem;
  arguments: unknown;
  result: ToolResult;
  durationMs: number;
}): ToolResultResponseItem {
  return {
    type: "tool_result",
    callId: input.call.id,
    toolName: input.call.name,
    arguments: input.arguments,
    result: input.result,
    durationMs: input.durationMs,
  };
}
