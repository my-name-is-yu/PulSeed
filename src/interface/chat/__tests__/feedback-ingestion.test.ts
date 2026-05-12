import { describe, expect, it } from "vitest";
import { createFeedbackIngestion, feedbackEffectsToCompanionStateFeedbackRefs } from "../../../runtime/attention/index.js";
import type { ChatEvent } from "../chat-events.js";
import {
  feedbackInputsFromChatEvent,
  feedbackIngestionSourceForReplyTarget,
  feedbackSurfaceRefForReplyTarget,
  ingestFeedbackFromChatEvent,
} from "../feedback-ingestion.js";

const NOW = "2026-05-12T08:00:00.000Z";

function baseEvent(event: Record<string, unknown>): ChatEvent {
  return {
    runId: "run:feedback-chat-test",
    turnId: "turn:feedback-chat-test",
    createdAt: NOW,
    ...event,
  } as ChatEvent;
}

describe("chat feedback ingestion", () => {
  it("preserves typed surface corrections from Telegram-shaped user feedback events", async () => {
    const event = baseEvent({
      type: "user_feedback",
      feedback: {
        source: "telegram",
        feedback_kind: "surface_correction",
        outcome: "corrected",
        target: {
          kind: "surface",
          id: "telegram-thread",
        },
        reason: "That answer was for the wrong file.",
        route: "express_to_user",
      },
    });
    const ingested: unknown[] = [];
    const [result] = await ingestFeedbackFromChatEvent(event, {
      source: "telegram",
      store: {
        async ingest(input) {
          const result = createFeedbackIngestion(input);
          ingested.push(result.record);
          return result;
        },
      },
    });

    expect(ingested).toHaveLength(1);
    expect(result?.record).toMatchObject({
      source: "telegram",
      feedback_kind: "surface_correction",
      outcome: "corrected",
      target: {
        kind: "surface",
        id: "telegram-thread",
      },
    });
    expect(result?.effects.map((effect) => effect.effect_kind)).toEqual(expect.arrayContaining([
      "attention_cooldown",
      "surface_invalidation",
      "autonomy_feedback_signal",
    ]));
  });

  it("maps gateway approval denial timeline events into approval_denied feedback", () => {
    const event = baseEvent({
      type: "agent_timeline",
      item: {
        id: "agent-timeline:approval-denied",
        sourceEventId: "approval-denied",
        sourceType: "approval",
        sessionId: "agent-session:1",
        traceId: "trace:1",
        turnId: "turn:feedback-chat-test",
        goalId: "goal:chat",
        createdAt: NOW,
        visibility: "user",
        kind: "approval",
        status: "denied",
        callId: "call:write",
        toolName: "apply_patch",
        reason: "Operator denied write access.",
      },
    });

    expect(feedbackInputsFromChatEvent(event, { source: "gateway" })).toEqual([
      expect.objectContaining({
        source: "gateway",
        feedback_kind: "approval_denied",
        outcome: "approval_denied",
        target: {
          kind: "approval",
          id: "call:write",
        },
        route: "request_approval",
      }),
    ]);
  });

  it("maps runtime final events without cooling down successful turns", () => {
    const event = baseEvent({
      type: "agent_timeline",
      item: {
        id: "agent-timeline:final-success",
        sourceEventId: "final-success",
        sourceType: "final",
        sessionId: "agent-session:1",
        traceId: "trace:1",
        turnId: "turn:feedback-chat-test",
        goalId: "goal:chat",
        createdAt: NOW,
        visibility: "user",
        kind: "final",
        success: true,
        outputPreview: "Done.",
      },
    });
    const [input] = feedbackInputsFromChatEvent(event, { source: "tui" });
    const result = createFeedbackIngestion(input!);

    expect(input).toMatchObject({
      source: "tui",
      feedback_kind: "runtime_outcome",
      outcome: "runtime_success",
      target: {
        kind: "runtime_operation",
        id: "agent-session:1:turn:feedback-chat-test",
      },
    });
    expect(feedbackEffectsToCompanionStateFeedbackRefs(result.effects)).toEqual([]);
  });

  it("derives Telegram source and surface refs from reply targets", () => {
    const replyTarget = {
      surface: "gateway" as const,
      channel: "plugin_gateway" as const,
      platform: "telegram",
      conversation_id: "12345",
    };
    const source = feedbackIngestionSourceForReplyTarget(replyTarget);
    expect(source).toBe("telegram");
    expect(feedbackSurfaceRefForReplyTarget(source, replyTarget)).toEqual({
      kind: "surface",
      id: "telegram:12345",
    });
  });

  it("derives CLI source and surface refs from CLI reply targets", () => {
    const replyTarget = {
      surface: "cli" as const,
      channel: "cli" as const,
      conversation_id: "local-terminal",
    };
    const source = feedbackIngestionSourceForReplyTarget(replyTarget);
    expect(source).toBe("cli");
    expect(feedbackSurfaceRefForReplyTarget(source, replyTarget)).toEqual({
      kind: "surface",
      id: "cli:local-terminal",
    });
  });
});
