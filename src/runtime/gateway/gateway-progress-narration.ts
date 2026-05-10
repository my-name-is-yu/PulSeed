import type {
  ActivityEvent,
  ToolEndEvent,
  ToolStartEvent,
  ToolUpdateEvent,
} from "../../interface/chat/chat-events.js";
import type { GatewayPublicProgress } from "../../interface/chat/gateway-progress.js";
import type {
  OperationProgressItem,
  OperationProgressKind,
} from "../../interface/chat/operation-progress.js";
import type {
  AgentTimelineActivityKind,
  AgentTimelineItem,
} from "../../orchestrator/execution/agent-loop/agent-timeline.js";

type GatewayToolEvent = ToolStartEvent | ToolUpdateEvent | ToolEndEvent;

const ACTIVITY_SUBJECT: Record<AgentTimelineActivityKind, string> = {
  search: "the workspace search",
  read: "the relevant project files",
  planning: "the plan",
  command: "the tool-backed step",
  file_create: "the new file changes",
  file_modify: "the file changes",
  test: "the verification checks",
  approval: "the approval request",
};

const ACTIVITY_REASON: Record<AgentTimelineActivityKind, string> = {
  search: "find the relevant evidence before answering",
  read: "use the current implementation as the source of truth",
  planning: "keep the next steps organized",
  command: "gather the result needed for the next step",
  file_create: "prepare the requested update",
  file_modify: "apply the requested update",
  test: "verify the behavior before reporting back",
  approval: "wait for the user decision before continuing",
};

const OPERATION_KIND_PHASE: Record<OperationProgressKind, GatewayPublicProgress["phase"]> = {
  started: "planning",
  checked_status: "checking",
  read_config: "checking",
  planned_action: "planning",
  awaiting_approval: "waiting",
  wrote_config: "editing",
  verified: "testing",
  completed: "finalizing",
  blocked: "blocked",
};

const OPERATION_KIND_IMPORTANCE: Record<OperationProgressKind, GatewayPublicProgress["importance"]> = {
  started: "heartbeat",
  checked_status: "heartbeat",
  read_config: "heartbeat",
  planned_action: "milestone",
  awaiting_approval: "action_required",
  wrote_config: "milestone",
  verified: "milestone",
  completed: "milestone",
  blocked: "blocked",
};

const OPERATION_KIND_REASON: Record<OperationProgressKind, string> = {
  started: "start the requested operation safely",
  checked_status: "confirm the current state before changing anything",
  read_config: "verify the current configuration",
  planned_action: "choose the next safe step",
  awaiting_approval: "wait for the required user decision",
  wrote_config: "apply the requested configuration",
  verified: "confirm the operation worked",
  completed: "finish the response with the latest result",
  blocked: "explain what needs attention next",
};

export function renderGatewayPublicProgress(progress: GatewayPublicProgress | null): string | null {
  if (!progress) return null;
  if (progress.audience !== "user" || progress.verbosity === "silent") return null;
  const subject = normalizePhrase(progress.subject);
  if (!subject) return null;
  const reason = progress.reason ? normalizePhrase(progress.reason) : "";

  if (progress.importance === "action_required") {
    return reason
      ? `Approval is needed for ${subject}: ${endSentence(reason)}`
      : `Approval is needed for ${endSentence(subject)}`;
  }

  if (progress.importance === "blocked" || progress.phase === "blocked") {
    return reason
      ? `Blocked on ${subject}: ${endSentence(reason)}`
      : `Blocked on ${endSentence(subject)}`;
  }

  if (progress.phase === "waiting") {
    const elapsed = formatElapsed(progress.elapsedMs);
    const lastActivity = progress.lastActivityLabel
      ? normalizePhrase(progress.lastActivityLabel)
      : subject;
    if (elapsed) {
      return `This is taking longer than usual. The last visible activity was ${lastActivity} ${elapsed} ago, and the process is still active.`;
    }
    return reason
      ? `Waiting on ${subject} so I can ${endSentence(reason)}`
      : `Waiting on ${endSentence(subject)}`;
  }

  const verb = phaseVerb(progress.phase);
  return reason
    ? `${verb} ${subject} so I can ${endSentence(reason)}`
    : `${verb} ${endSentence(subject)}`;
}

export function publicProgressFromOperationProgress(item: OperationProgressItem): GatewayPublicProgress | null {
  if (item.publicProgress) return item.publicProgress;

  if (item.metadata?.["source"] === "agent_timeline_activity_summary") {
    return {
      audience: "user",
      phase: "finalizing",
      importance: "milestone",
      verbosity: "summary",
      subject: "completed tool activity",
      reason: "keep the final response grounded in verified work",
      diagnosticRef: typeof item.id === "string" ? item.id : undefined,
    };
  }

  return {
    audience: "user",
    phase: OPERATION_KIND_PHASE[item.kind],
    importance: OPERATION_KIND_IMPORTANCE[item.kind],
    verbosity: "summary",
    subject: humanizeProtocolToken(item.operation),
    reason: OPERATION_KIND_REASON[item.kind],
    diagnosticRef: item.id,
  };
}

export function publicProgressFromActivityEvent(item: ActivityEvent): GatewayPublicProgress | null {
  if (item.presentation?.gatewayNarration) return item.presentation.gatewayNarration;
  return null;
}

export function publicProgressFromToolEvent(event: GatewayToolEvent): GatewayPublicProgress | null {
  const activity = event.activityCategory ?? "command";
  if (event.type === "tool_update" && event.status === "awaiting_approval") {
    return {
      audience: "user",
      phase: "waiting",
      importance: "action_required",
      verbosity: "summary",
      subject: "a tool action",
      reason: event.message,
    };
  }

  return {
    audience: "user",
    phase: phaseForActivity(activity, event.type === "tool_end"),
    importance: event.type === "tool_end" ? "milestone" : "heartbeat",
    verbosity: "summary",
    subject: ACTIVITY_SUBJECT[activity],
    reason: ACTIVITY_REASON[activity],
  };
}

export function publicProgressFromAgentTimelineItem(item: AgentTimelineItem): GatewayPublicProgress | null {
  switch (item.kind) {
    case "lifecycle":
    case "turn_context":
    case "model_request":
    case "compaction":
    case "final":
      return null;
    case "assistant_message":
      return item.phase === "final_candidate"
        ? {
          audience: "user",
          phase: "finalizing",
          importance: "heartbeat",
          verbosity: "summary",
          subject: "the final response",
          reason: "separate the answer from transient progress",
          diagnosticRef: item.sourceEventId,
        }
        : null;
    case "tool": {
      const activity = item.activityCategory ?? "command";
      return {
        audience: "user",
        phase: phaseForActivity(activity, item.status === "finished"),
        importance: item.status === "finished" ? "milestone" : "heartbeat",
        verbosity: "summary",
        subject: ACTIVITY_SUBJECT[activity],
        reason: ACTIVITY_REASON[activity],
        diagnosticRef: item.sourceEventId,
      };
    }
    case "tool_observation": {
      if (item.state !== "denied" && item.state !== "blocked") return null;
      return {
        audience: "user",
        phase: "blocked",
        importance: "blocked",
        verbosity: "summary",
        subject: "the requested tool action",
        reason: toolObservationBlockedReason(item),
        diagnosticRef: item.sourceEventId,
      };
    }
    case "plan":
      return {
        audience: "user",
        phase: "planning",
        importance: "milestone",
        verbosity: "summary",
        subject: "the plan",
        reason: "keep the next steps organized",
        diagnosticRef: item.sourceEventId,
      };
    case "approval":
      return {
        audience: "user",
        phase: "waiting",
        importance: item.status === "requested" ? "action_required" : "blocked",
        verbosity: "summary",
        subject: "a tool action",
        reason: item.reason,
        diagnosticRef: item.sourceEventId,
      };
    case "activity_summary":
      return {
        audience: "user",
        phase: "finalizing",
        importance: "milestone",
        verbosity: "summary",
        subject: "completed tool activity",
        reason: "keep the final response grounded in verified work",
        diagnosticRef: item.sourceEventId,
      };
    case "stopped":
      return item.reason === "completed"
        ? null
        : {
          audience: "user",
          phase: "blocked",
          importance: "blocked",
          verbosity: "summary",
          subject: "the run",
          reason: item.reasonDetail ?? item.reason,
          diagnosticRef: item.sourceEventId,
        };
  }
}

function phaseForActivity(
  activity: AgentTimelineActivityKind,
  complete: boolean
): GatewayPublicProgress["phase"] {
  if (complete) return activity === "test" ? "testing" : "finalizing";
  switch (activity) {
    case "search":
    case "read":
      return "checking";
    case "planning":
      return "planning";
    case "file_create":
    case "file_modify":
      return "editing";
    case "test":
      return "testing";
    case "approval":
      return "waiting";
    case "command":
      return "running_tool";
  }
}

function phaseVerb(phase: GatewayPublicProgress["phase"]): string {
  switch (phase) {
    case "checking":
      return "Checking";
    case "planning":
      return "Planning";
    case "running_tool":
      return "Running";
    case "editing":
      return "Editing";
    case "testing":
      return "Running";
    case "waiting":
      return "Waiting on";
    case "blocked":
      return "Blocked on";
    case "finalizing":
      return "Finalizing";
  }
}

function humanizeProtocolToken(value: string): string {
  const normalized = normalizePhrase(value.replace(/[_-]+/g, " "));
  return normalized || "the requested operation";
}

function toolObservationBlockedReason(item: Extract<AgentTimelineItem, { kind: "tool_observation" }>): string {
  const message = item.observation.execution?.message;
  if (message && normalizePhrase(message)) return message;
  const reason = item.observation.execution?.reason;
  if (reason) return humanizeProtocolToken(reason);
  return item.state === "denied"
    ? "the operator denied the action"
    : "the action is blocked";
}

function normalizePhrase(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/[.。]+$/u, "");
}

function endSentence(value: string): string {
  const normalized = normalizePhrase(value);
  if (!normalized) return "";
  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}

function formatElapsed(elapsedMs: number | undefined): string | null {
  if (elapsedMs === undefined || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  if (elapsedMs < 1_000) return "less than a second";
  const seconds = Math.round(elapsedMs / 1_000);
  if (seconds < 60) return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}
