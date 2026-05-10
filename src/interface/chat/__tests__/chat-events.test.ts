import { describe, expect, it } from "vitest";
import { applyChatEventToMessages } from "../chat-event-state.js";
import { createSeedyTurnPresence, createUserVisibleSeedyTurnPresence } from "../seedy-turn-presence.js";
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
