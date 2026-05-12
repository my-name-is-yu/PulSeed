import { describe, expect, it } from "vitest";
import { applyChatEventToMessages } from "../chat-event-state.js";
import { createSeedyTurnPresence, createUserVisibleSeedyTurnPresence } from "../seedy-turn-presence.js";
import { SurfaceDeliveryProjectionSchema, ref } from "../../../runtime/attention/index.js";
import type { ChatEvent } from "../chat-events.js";

const NOW = "2026-05-10T05:00:00.000Z";

describe("ChatEvent presence_update", () => {
  it("accepts typed Seedy turn presence as a chat event", () => {
    const event: ChatEvent = {
      type: "presence_update",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: NOW,
      presence: createUserVisibleSeedyTurnPresence({
        turn_id: "turn-1",
        phase: "received",
        started_at: NOW,
      }),
    };

    expect(event.presence.phase).toBe("received");
  });

  it("does not render diagnostic or internal presence into the default transcript", () => {
    const diagnostic: ChatEvent = {
      type: "presence_update",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: NOW,
      presence: createSeedyTurnPresence({
        turn_id: "turn-1",
        audience: "diagnostic",
        phase: "acting",
        importance: "status",
        started_at: NOW,
        updated_at: NOW,
        diagnostic_ref: "trace:abc",
      }),
    };
    const internal: ChatEvent = {
      type: "presence_update",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: NOW,
      presence: createSeedyTurnPresence({
        turn_id: "turn-1",
        audience: "internal",
        phase: "orienting",
        importance: "ephemeral",
        started_at: NOW,
        updated_at: NOW,
      }),
    };

    expect(applyChatEventToMessages([], diagnostic, 20)).toEqual([]);
    expect(applyChatEventToMessages([], internal, 20)).toEqual([]);
  });
});

describe("ChatEvent surface_delivery", () => {
  it("renders the admitted shared delivery projection into chat state", () => {
    const event: ChatEvent = {
      type: "surface_delivery",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: NOW,
      projection: SurfaceDeliveryProjectionSchema.parse({
        schema_version: "surface-delivery-projection-v1",
        delivery_id: "surface-delivery:chat:express",
        rendered_at: NOW,
        surface_class: "gateway",
        delivery_kind: "express_to_user",
        delivery_mode: "body_message",
        outcome_decision_ref: ref("outcome_decision", "outcome:chat:express"),
        admission_status: "admitted",
        should_render: true,
        user_facing_text: "Shared delivery text",
        audit_refs: [],
      }),
    };

    expect(applyChatEventToMessages([], event, 20)).toMatchObject([
      {
        id: "surface-delivery:chat:express",
        role: "pulseed",
        text: "Shared delivery text",
        messageType: "info",
      },
    ]);
  });

  it("does not render quiet shared delivery projections into chat state", () => {
    const event: ChatEvent = {
      type: "surface_delivery",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: NOW,
      projection: SurfaceDeliveryProjectionSchema.parse({
        schema_version: "surface-delivery-projection-v1",
        delivery_id: "surface-delivery:chat:silent",
        rendered_at: NOW,
        surface_class: "gateway",
        delivery_kind: "silence",
        delivery_mode: "quiet_audit",
        outcome_decision_ref: ref("outcome_decision", "outcome:chat:silent"),
        admission_status: "admitted",
        should_render: false,
        quiet_audit_reason: "admitted outcome intentionally stays silent",
        audit_refs: [],
      }),
    };

    expect(applyChatEventToMessages([], event, 20)).toEqual([]);
  });
});
