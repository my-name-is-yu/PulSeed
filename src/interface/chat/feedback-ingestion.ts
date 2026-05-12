import type { AgentTimelineItem } from "../../orchestrator/execution/agent-loop/agent-timeline.js";
import {
  FeedbackIngestionInputSchema,
  type FeedbackIngestionInput,
  type FeedbackIngestionResult,
  type FeedbackIngestionSource,
} from "../../runtime/attention/index.js";
import { ref } from "../../runtime/attention/index.js";
import type { CompanionAutonomyRef } from "../../runtime/types/companion-autonomy.js";
import type { RuntimeControlReplyTarget } from "../../runtime/store/runtime-operation-schemas.js";
import type { ChatEvent } from "./chat-events.js";

export interface ChatFeedbackIngestionStore {
  ingest(input: FeedbackIngestionInput): Promise<FeedbackIngestionResult>;
}

export interface ChatFeedbackIngestionContext {
  store: ChatFeedbackIngestionStore;
  source: FeedbackIngestionSource;
  surfaceRef?: CompanionAutonomyRef;
}

export function feedbackIngestionSourceForReplyTarget(
  replyTarget: RuntimeControlReplyTarget | null | undefined
): FeedbackIngestionSource {
  const channel = (replyTarget?.channel ?? replyTarget?.surface ?? "").toLowerCase();
  const platform = (replyTarget?.platform
    ?? (typeof replyTarget?.metadata?.["platform"] === "string" ? replyTarget.metadata["platform"] : "")
  ).toLowerCase();
  if (channel === "telegram" || platform === "telegram") return "telegram";
  if (channel === "cli") return "cli";
  if (channel === "tui" || channel === "terminal") return "tui";
  if (channel === "chat" || channel === "") return "chat";
  return "gateway";
}

export function feedbackSurfaceRefForReplyTarget(
  source: FeedbackIngestionSource,
  replyTarget: RuntimeControlReplyTarget | null | undefined
): CompanionAutonomyRef | undefined {
  const target = replyTarget?.conversation_id
    ?? replyTarget?.response_channel
    ?? replyTarget?.identity_key
    ?? replyTarget?.message_id
    ?? null;
  return target ? ref("surface", `${source}:${target}`) : undefined;
}

export async function ingestFeedbackFromChatEvent(
  event: ChatEvent,
  context: ChatFeedbackIngestionContext
): Promise<FeedbackIngestionResult[]> {
  const inputs = feedbackInputsFromChatEvent(event, context);
  const results: FeedbackIngestionResult[] = [];
  for (const input of inputs) {
    results.push(await context.store.ingest(input));
  }
  return results;
}

export function feedbackInputsFromChatEvent(
  event: ChatEvent,
  context: Omit<ChatFeedbackIngestionContext, "store">
): FeedbackIngestionInput[] {
  if (event.type === "user_feedback") {
    return [FeedbackIngestionInputSchema.parse({
      ...event.feedback,
      source: event.feedback.source ?? context.source,
      recorded_at: event.feedback.recorded_at ?? event.createdAt,
      surface_ref: event.feedback.surface_ref ?? context.surfaceRef,
    })];
  }
  if (event.type !== "agent_timeline") return [];
  return feedbackInputsFromTimelineItem(event.item, {
    source: context.source,
    surfaceRef: context.surfaceRef,
  });
}

function feedbackInputsFromTimelineItem(
  item: AgentTimelineItem,
  context: Omit<ChatFeedbackIngestionContext, "store">
): FeedbackIngestionInput[] {
  if (item.kind === "approval" && item.status === "denied") {
    return [approvalDeniedInput({
      source: context.source,
      surfaceRef: context.surfaceRef,
      targetId: item.callId ?? `${item.turnId}:${item.toolName}`,
      recordedAt: item.createdAt,
      reason: item.reason,
    })];
  }
  if (item.kind === "tool" && item.status === "finished" && item.disposition === "approval_denied") {
    return [approvalDeniedInput({
      source: context.source,
      surfaceRef: context.surfaceRef,
      targetId: item.callId,
      recordedAt: item.createdAt,
      reason: item.outputPreview,
    })];
  }
  if (item.kind === "tool_observation" && (item.state === "denied" || item.state === "blocked")) {
    return [approvalDeniedInput({
      source: context.source,
      surfaceRef: context.surfaceRef,
      targetId: item.callId,
      recordedAt: item.createdAt,
      reason: item.observation.execution?.message ?? item.outputPreview,
    })];
  }
  if (item.kind === "final") {
    return [{
      source: context.source,
      feedback_kind: "runtime_outcome",
      outcome: item.success ? "runtime_success" : "runtime_failure",
      target: {
        kind: "runtime_operation",
        id: `${item.sessionId}:${item.turnId}`,
      },
      runtime_ref: `agent-loop:${item.sessionId}:${item.turnId}`,
      recorded_at: item.createdAt,
      reason: item.outputPreview || (item.success ? "Runtime turn completed." : "Runtime turn failed."),
      surface_ref: context.surfaceRef,
      follow_through_success: item.success,
    }];
  }
  return [];
}

function approvalDeniedInput(input: {
  source: FeedbackIngestionSource;
  surfaceRef?: CompanionAutonomyRef;
  targetId: string;
  recordedAt: string;
  reason?: string;
}): FeedbackIngestionInput {
  return {
    source: input.source,
    feedback_kind: "approval_denied",
    outcome: "approval_denied",
    target: {
      kind: "approval",
      id: input.targetId,
    },
    recorded_at: input.recordedAt,
    reason: input.reason || "Approval was denied.",
    approval_ref: input.targetId,
    surface_ref: input.surfaceRef,
    route: "request_approval",
  };
}
