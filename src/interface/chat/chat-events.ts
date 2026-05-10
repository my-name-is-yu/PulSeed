import type { FailureRecoveryGuidance } from "./failure-recovery.js";
import type { ToolActivityCategory } from "../../tools/types.js";
import type { AgentTimelineItem } from "../../orchestrator/execution/agent-loop/agent-timeline.js";
import type { ChatEventContext } from "./turn-state.js";
import type { OperationProgressItem } from "./operation-progress.js";
import type { UserInput } from "./user-input.js";
import type { TurnOperation, TurnSteerOperation } from "./turn-protocol.js";

export type { ChatEventContext } from "./turn-state.js";

export interface ChatEventBase extends ChatEventContext {
  createdAt: string;
}

export interface LifecycleStartEvent extends ChatEventBase {
  type: "lifecycle_start";
  input: string;
  userInput: UserInput;
  operation: TurnOperation;
}

export interface TurnSteerEvent extends ChatEventBase {
  type: "turn_steer";
  input: string;
  userInput: UserInput;
  operation: TurnSteerOperation;
}

export interface AssistantDeltaEvent extends ChatEventBase {
  type: "assistant_delta";
  delta: string;
  text: string;
}

export interface AssistantFinalEvent extends ChatEventBase {
  type: "assistant_final";
  text: string;
  persisted: boolean;
}

export type ActivityKind = "lifecycle" | "commentary" | "checkpoint" | "diff" | "tool" | "plugin" | "skill";

export interface ActivityEvent extends ChatEventBase {
  type: "activity";
  kind: ActivityKind;
  message: string;
  sourceId?: string;
  transient?: boolean;
  presentation?: {
    gatewayProgress?: "user" | "internal";
  };
}

export interface ToolStartEvent extends ChatEventBase {
  type: "tool_start";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  activityCategory?: ToolActivityCategory;
  presentation?: {
    suppressTranscript?: boolean;
  };
}

export interface ToolUpdateEvent extends ChatEventBase {
  type: "tool_update";
  toolCallId: string;
  toolName: string;
  status: "awaiting_approval" | "running" | "result";
  message: string;
  activityCategory?: ToolActivityCategory;
  presentation?: {
    suppressTranscript?: boolean;
  };
}

export interface ToolEndEvent extends ChatEventBase {
  type: "tool_end";
  toolCallId: string;
  toolName: string;
  success: boolean;
  summary: string;
  durationMs: number;
  activityCategory?: ToolActivityCategory;
  presentation?: {
    suppressTranscript?: boolean;
  };
}

export interface AgentTimelineEvent extends ChatEventBase {
  type: "agent_timeline";
  item: AgentTimelineItem;
}

export interface OperationProgressEvent extends ChatEventBase {
  type: "operation_progress";
  item: OperationProgressItem;
}

export interface LifecycleEndEvent extends ChatEventBase {
  type: "lifecycle_end";
  status: "completed" | "error";
  elapsedMs: number;
  persisted: boolean;
}

export interface LifecycleErrorEvent extends ChatEventBase {
  type: "lifecycle_error";
  error: string;
  partialText: string;
  persisted: false;
  recovery: FailureRecoveryGuidance;
}

export type ChatEvent =
  | LifecycleStartEvent
  | TurnSteerEvent
  | AssistantDeltaEvent
  | AssistantFinalEvent
  | ActivityEvent
  | AgentTimelineEvent
  | OperationProgressEvent
  | ToolStartEvent
  | ToolUpdateEvent
  | ToolEndEvent
  | LifecycleEndEvent
  | LifecycleErrorEvent;

export type ChatEventHandler = (event: ChatEvent) => Promise<void> | void;
