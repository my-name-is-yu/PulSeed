import { describe, expect, it } from "vitest";

import { createSeedyTurnPresence, createUserVisibleSeedyTurnPresence } from "../../../interface/chat/seedy-turn-presence.js";
import {
  renderSeedyPresenceFallbackAck,
  renderSeedyPresenceStatusText,
} from "../seedy-presence-rendering.js";

describe("seedy presence rendering", () => {
  it("renders compact status without leaking runtime internals from presence metadata", () => {
    const presence = createSeedyTurnPresence({
      turn_id: "turn-raw-metadata",
      phase: "acting",
      audience: "user",
      importance: "status",
      subject: "Calling model openai/gpt-5.5 with tool catalog",
      reason: "Raw command output, trace id trace-123, and compaction details are available.",
      last_activity_label: "model_request: openai/gpt-5.5",
      diagnostic_ref: "trace:trace-123",
      started_at: "2026-05-10T00:00:00.000Z",
      updated_at: "2026-05-10T00:00:00.000Z",
    });

    const status = renderSeedyPresenceStatusText(presence);

    expect(status).toBe("Working on it.");
    expect(status).not.toMatch(/openai|gpt|model|tool catalog|command output|trace|compaction/i);
  });

  it("uses renderer-owned fallback acknowledgement text instead of raw presence fields", () => {
    const presence = createSeedyTurnPresence({
      turn_id: "turn-fallback",
      phase: "thinking",
      audience: "user",
      importance: "ephemeral",
      subject: "Provider request queued for model_request",
      reason: "Trace buffer contains raw tool output.",
      diagnostic_ref: "trace:model-request",
      started_at: "2026-05-10T00:00:00.000Z",
      updated_at: "2026-05-10T00:00:00.000Z",
    });

    const fallback = renderSeedyPresenceFallbackAck(presence);

    expect(fallback).toBe("I'm checking this.");
    expect(fallback).not.toMatch(/provider|model_request|trace|tool output/i);
  });

  it("suppresses diagnostic and internal presence on default gateway surfaces", () => {
    const now = "2026-05-10T00:00:00.000Z";
    const diagnostic = createSeedyTurnPresence({
      turn_id: "turn-diagnostic",
      phase: "waiting",
      audience: "diagnostic",
      importance: "status",
      subject: "Provider trace is still pending",
      started_at: now,
      updated_at: now,
    });
    const internal = createSeedyTurnPresence({
      turn_id: "turn-internal",
      phase: "acting",
      audience: "internal",
      importance: "status",
      subject: "Internal runtime planning state",
      started_at: now,
      updated_at: now,
    });

    expect(renderSeedyPresenceStatusText(diagnostic)).toBeNull();
    expect(renderSeedyPresenceFallbackAck(diagnostic)).toBeNull();
    expect(renderSeedyPresenceStatusText(internal)).toBeNull();
    expect(renderSeedyPresenceFallbackAck(internal)).toBeNull();
  });

  it("renders action-required waiting as a user input request", () => {
    const presence = createUserVisibleSeedyTurnPresence({
      turn_id: "turn-approval",
      phase: "waiting",
      importance: "action_required",
      expected_next: "approval",
    });

    expect(renderSeedyPresenceStatusText(presence)).toBe("I need your input to continue.");
  });
});
