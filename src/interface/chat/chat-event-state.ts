import type { ChatEvent } from "./chat-events.js";
import { formatLifecycleFailureMessage } from "./failure-recovery.js";
import type { AgentTimelineItem } from "../../orchestrator/execution/agent-loop/agent-timeline.js";
import { renderSurfaceDeliveryProjection } from "../../runtime/attention/index.js";
import type { ToolActivityCategory } from "../../tools/types.js";
import { renderOperationProgress } from "./operation-progress.js";
import { redactSetupSecrets } from "./setup-secret-intake.js";

type ToolActivityState = "reading" | "planning" | "editing" | "verifying" | "waiting" | "running" | "completed" | "failed";

interface StreamToolActivity {
  id: string;
  toolName: string;
  state: ToolActivityState;
  detail: string;
  activityCategory?: ToolActivityCategory;
  timestamp: Date;
}

export interface StreamChatMessage {
  id: string;
  role: "user" | "pulseed";
  text: string;
  timestamp: Date;
  messageType?: "info" | "error" | "warning" | "success";
  transient?: boolean;
  toolActivities?: StreamToolActivity[];
}

function upsertMessage(
  messages: StreamChatMessage[],
  nextMessage: StreamChatMessage,
  maxMessages: number
): StreamChatMessage[] {
  const next = [...messages];
  const index = next.findIndex((message) => message.id === nextMessage.id);
  if (index >= 0) {
    next[index] = nextMessage;
    return next;
  }
  return trimMessages([...next, nextMessage], maxMessages);
}

function trimMessages(messages: StreamChatMessage[], maxMessages: number): StreamChatMessage[] {
  if (messages.length <= maxMessages) return messages;
  const overflow = messages.length - maxMessages;
  let remainingTransientDrops = overflow;
  const withoutTransientOverflow = messages.filter((message) => {
    if (remainingTransientDrops <= 0 || !message.transient) return true;
    remainingTransientDrops -= 1;
    return false;
  });
  if (withoutTransientOverflow.length <= maxMessages) return withoutTransientOverflow;
  return withoutTransientOverflow.slice(-maxMessages);
}

function removeTransientActivityForTurn(
  messages: StreamChatMessage[],
  turnId: string
): StreamChatMessage[] {
  const transientActivityId = `activity:${turnId}`;
  const transientTimelinePrefix = `agent-timeline:${turnId}:`;
  return messages.filter((message) => {
    if (!message.transient) return true;
    if (message.id === transientActivityId) return false;
    return !message.id.startsWith(transientTimelinePrefix);
  });
}

function getToolLogId(turnId: string): string {
  return `tool-log:${turnId}`;
}

function getActivityMessageId(event: Extract<ChatEvent, { type: "activity" }>): string {
  if (event.transient === false && event.sourceId) {
    return `activity:${event.turnId}:${event.sourceId}`;
  }
  return `activity:${event.turnId}`;
}

function getTimelineMessageId(chatTurnId: string, item: AgentTimelineItem): string {
  return `agent-timeline:${chatTurnId}:${item.sourceEventId}`;
}

function getOperationProgressMessageId(turnId: string, itemId: string): string {
  return `operation-progress:${turnId}:${itemId}`;
}

export function renderAgentTimelineItemForChat(item: AgentTimelineItem): string {
  switch (item.kind) {
    case "lifecycle":
      if (item.status === "resumed") {
        return `Resumed ${item.restoredMessages ?? 0} message(s) from ${item.fromUpdatedAt ?? "saved state"}.`;
      }
      return "Started work.";
    case "turn_context":
      return `Prepared turn context with ${item.model} and ${item.visibleTools.length} tool(s).`;
    case "model_request":
      return `Asked ${item.model} for the next step with ${item.toolCount} available tool(s).`;
    case "assistant_message":
      return redactSetupSecrets(item.text);
    case "tool": {
      const detail = item.status === "started" ? item.inputPreview : item.outputPreview;
      const label = item.status === "started" ? "Started" : item.success ? "Finished" : "Failed";
      return detail ? `${label} ${item.toolName}: ${redactSetupSecrets(detail)}` : `${label} ${item.toolName}.`;
    }
    case "tool_observation":
      return `Observed ${item.toolName} (${item.state}): ${redactSetupSecrets(item.outputPreview)}`;
    case "plan":
      return `Plan changed: ${redactSetupSecrets(item.summary)}`;
    case "approval":
      return item.status === "requested"
        ? `Approval requested for ${item.toolName}: ${redactSetupSecrets(item.reason)}`
        : `Approval denied for ${item.toolName}: ${redactSetupSecrets(item.reason)}`;
    case "compaction":
      return `Compacted context (${item.phase}, ${item.reason}): ${item.inputMessages} -> ${item.outputMessages}.`;
    case "activity_summary":
      return redactSetupSecrets(item.text);
    case "final":
      return redactSetupSecrets(item.outputPreview);
    case "stopped":
      return item.reasonDetail ? `Stopped: ${item.reason} (${redactSetupSecrets(item.reasonDetail)})` : `Stopped: ${item.reason}`;
  }
}

function isTransientTimelineItem(item: AgentTimelineItem): boolean {
  if (item.kind === "final") return true;
  return item.kind === "stopped" && item.reason === "completed";
}

function summarizeValue(value: unknown): string {
  if (typeof value === "string") {
    const normalized = redactSetupSecrets(value).replace(/\s+/g, " ").trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length > 0 ? `{${keys.slice(0, 3).join(", ")}}` : "{}";
  }
  return "";
}

function summarizeToolArgs(args: Record<string, unknown>): string {
  const priorityKeys = [
    "command",
    "cmd",
    "path",
    "file",
    "filename",
    "cwd",
    "pattern",
    "query",
    "url",
    "target",
    "plan_id",
  ];
  const entries = priorityKeys
    .filter((key) => Object.prototype.hasOwnProperty.call(args, key))
    .map((key) => {
      const value = summarizeValue(args[key]);
      return value ? `${key}=${value}` : "";
    })
    .filter(Boolean);
  if (entries.length > 0) return entries.slice(0, 2).join(", ");
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  return keys.slice(0, 3).map((key) => `${key}=${summarizeValue(args[key])}`).filter(Boolean).join(", ");
}

function stateFromToolActivityCategory(
  activityCategory: ToolActivityCategory | undefined,
  status?: "awaiting_approval" | "running" | "result",
): ToolActivityState {
  if (status === "awaiting_approval") return "waiting";
  switch (activityCategory) {
    case "search":
    case "read":
      return "reading";
    case "planning":
      return "planning";
    case "file_create":
    case "file_modify":
      return "editing";
    case "test":
      return "verifying";
    case "approval":
      return "waiting";
    case "command":
    case undefined:
      return "running";
  }
}

function formatToolActivityState(state: ToolActivityState): string {
  switch (state) {
    case "reading":
      return "Reading";
    case "planning":
      return "Planning";
    case "editing":
      return "Editing";
    case "verifying":
      return "Verifying";
    case "waiting":
      return "Waiting for approval";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "running":
      return "Running";
  }
}

function renderToolActivityMessage(activities: StreamToolActivity[]): string {
  const lines = activities.map((activity) => {
    const detail = activity.detail ? ` - ${activity.detail}` : "";
    return `- ${formatToolActivityState(activity.state)} ${activity.toolName}${detail}`;
  });
  return lines.join("\n");
}

function closeToolActivityForTurn(messages: StreamChatMessage[], turnId: string): StreamChatMessage[] {
  const toolLogId = getToolLogId(turnId);
  return messages.map((message) => {
    if (message.id !== toolLogId || !message.toolActivities) return message;
    return {
      ...message,
      text: renderToolActivityMessage(message.toolActivities),
      transient: false,
    };
  });
}

function upsertToolActivity(
  messages: StreamChatMessage[],
  event: Extract<ChatEvent, { type: "tool_start" | "tool_update" | "tool_end" }>,
  maxMessages: number
): StreamChatMessage[] {
  const timestamp = new Date(event.createdAt);
  const toolLogId = getToolLogId(event.turnId);
  const previous = messages.find((message) => message.id === toolLogId);
  const previousActivities = previous?.toolActivities ?? [];
  const existing = previousActivities.find((activity) => activity.id === event.toolCallId);
  const fallbackDetail = event.type === "tool_start"
    ? summarizeToolArgs(event.args)
    : event.type === "tool_update"
      ? (event.status === "running" ? existing?.detail ?? event.message : event.message)
      : event.summary;
  const detail = fallbackDetail || existing?.detail || "";
  const activityCategory = event.activityCategory ?? existing?.activityCategory;
  const state = event.type === "tool_end"
    ? event.success ? "completed" : "failed"
    : event.type === "tool_update" && event.status !== "awaiting_approval" && existing && existing.state !== "waiting"
      ? existing.state
      : stateFromToolActivityCategory(activityCategory, event.type === "tool_update" ? event.status : "running");
  const nextActivity: StreamToolActivity = {
    id: event.toolCallId,
    toolName: event.toolName,
    state,
    detail,
    ...(activityCategory ? { activityCategory } : {}),
    timestamp,
  };
  const nextActivities = [
    ...previousActivities.filter((activity) => activity.id !== event.toolCallId),
    nextActivity,
  ];

  return upsertMessage(messages, {
    id: toolLogId,
    role: "pulseed",
    text: renderToolActivityMessage(nextActivities),
    timestamp,
    messageType: "info",
    toolActivities: nextActivities,
  }, maxMessages);
}

export function applyChatEventToMessages(
  messages: StreamChatMessage[],
  event: ChatEvent,
  maxMessages: number
): StreamChatMessage[] {
  const timestamp = new Date(event.createdAt);

  if (event.type === "assistant_delta") {
    return upsertMessage(messages, {
      id: event.turnId,
      role: "pulseed",
      text: event.text,
      timestamp,
      messageType: "info",
    }, maxMessages);
  }

  if (event.type === "assistant_final") {
    const next = removeTransientActivityForTurn(messages, event.turnId);
    return upsertMessage(next, {
      id: event.turnId,
      role: "pulseed",
      text: event.text,
      timestamp,
      messageType: event.persisted ? "info" : "warning",
    }, maxMessages);
  }

  if (event.type === "activity") {
    return upsertMessage(messages, {
      id: getActivityMessageId(event),
      role: "pulseed",
      text: event.message,
      timestamp,
      messageType: "info",
      transient: event.transient === true,
    }, maxMessages);
  }

  if (event.type === "agent_timeline") {
    if (event.item.visibility !== "user") return messages;
    const text = renderAgentTimelineItemForChat(event.item).trim();
    if (!text) return messages;
    return upsertMessage(messages, {
      id: getTimelineMessageId(event.turnId, event.item),
      role: "pulseed",
      text,
      timestamp: new Date(event.item.createdAt),
      messageType: event.item.kind === "stopped" ? "warning" : "info",
      transient: isTransientTimelineItem(event.item),
    }, maxMessages);
  }

  if (event.type === "operation_progress") {
    const text = renderOperationProgress(event.item).trim();
    if (!text) return messages;
    return upsertMessage(messages, {
      id: getOperationProgressMessageId(event.turnId, event.item.id),
      role: "pulseed",
      text,
      timestamp: new Date(event.item.createdAt),
      messageType: event.item.kind === "blocked" ? "warning" : "info",
    }, maxMessages);
  }

  if (event.type === "surface_delivery") {
    const text = renderSurfaceDeliveryProjection(event.projection);
    if (!text) return messages;
    const next = removeTransientActivityForTurn(messages, event.turnId);
    return upsertMessage(next, {
      id: event.projection.delivery_id,
      role: "pulseed",
      text: redactSetupSecrets(text),
      timestamp,
      messageType: event.projection.delivery_mode === "approval_request" ||
        event.projection.delivery_mode === "urgent_alert"
        ? "warning"
        : "info",
    }, maxMessages);
  }

  if (event.type === "lifecycle_error") {
    const next = closeToolActivityForTurn(removeTransientActivityForTurn(messages, event.turnId), event.turnId);
    const messageId = event.partialText ? event.turnId : `error:${event.runId}`;
    const text = formatLifecycleFailureMessage(event.error, event.partialText, event.recovery);
    return upsertMessage(next, {
      id: messageId,
      role: "pulseed",
      text,
      timestamp,
      messageType: "error",
    }, maxMessages);
  }

  if (event.type === "lifecycle_end") {
    return closeToolActivityForTurn(removeTransientActivityForTurn(messages, event.turnId), event.turnId);
  }

  if (event.type === "tool_start") {
    if (event.presentation?.suppressTranscript) return messages;
    return upsertToolActivity(messages, event, maxMessages);
  }

  if (event.type === "tool_update") {
    if (event.presentation?.suppressTranscript) return messages;
    return upsertToolActivity(messages, event, maxMessages);
  }

  if (event.type === "tool_end") {
    if (event.presentation?.suppressTranscript) return messages;
    return upsertToolActivity(messages, event, maxMessages);
  }

  return messages;
}
