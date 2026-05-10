import { describe, expect, it } from "vitest";
import {
  SEEDY_TURN_PRESENCE_SCHEMA_VERSION,
  SeedyTurnPresenceSchema,
  createSeedyActiveTurnStatus,
  createSeedyTurnPresence,
  createUserVisibleSeedyTurnPresence,
  formatSeedyActiveTurnStatus,
  isUserVisibleSeedyTurnPresence,
} from "../seedy-turn-presence.js";

const NOW = "2026-05-10T05:00:00.000Z";

describe("SeedyTurnPresence", () => {
  it("constructs safe user-visible turn presence with stable schema values", () => {
    const presence = createUserVisibleSeedyTurnPresence({
      turn_id: "turn-1",
      ingress_id: "telegram:message-1",
      phase: "received",
      started_at: NOW,
    });

    expect(presence).toEqual({
      schema_version: SEEDY_TURN_PRESENCE_SCHEMA_VERSION,
      turn_id: "turn-1",
      ingress_id: "telegram:message-1",
      audience: "user",
      phase: "received",
      importance: "ephemeral",
      started_at: NOW,
      updated_at: NOW,
    });
    expect(isUserVisibleSeedyTurnPresence(presence)).toBe(true);
  });

  it("represents diagnostic and internal presence without making them user-visible defaults", () => {
    const diagnostic = createSeedyTurnPresence({
      turn_id: "turn-1",
      audience: "diagnostic",
      phase: "acting",
      importance: "status",
      started_at: NOW,
      updated_at: NOW,
      diagnostic_ref: "trace:abc",
    });
    const internal = createSeedyTurnPresence({
      turn_id: "turn-1",
      audience: "internal",
      phase: "orienting",
      importance: "ephemeral",
      started_at: NOW,
      updated_at: NOW,
    });

    expect(diagnostic.audience).toBe("diagnostic");
    expect(internal.audience).toBe("internal");
    expect(isUserVisibleSeedyTurnPresence(diagnostic)).toBe(false);
    expect(isUserVisibleSeedyTurnPresence(internal)).toBe(false);

    const userDefault = createUserVisibleSeedyTurnPresence({
      turn_id: "turn-1",
      phase: "thinking",
      started_at: NOW,
    });
    expect(userDefault.audience).toBe("user");
  });

  it("rejects unknown phases and unknown fields at the runtime schema boundary", () => {
    expect(SeedyTurnPresenceSchema.safeParse({
      schema_version: SEEDY_TURN_PRESENCE_SCHEMA_VERSION,
      turn_id: "turn-1",
      audience: "user",
      phase: "routing",
      importance: "ephemeral",
      started_at: NOW,
      updated_at: NOW,
    }).success).toBe(false);

    expect(SeedyTurnPresenceSchema.safeParse({
      schema_version: SEEDY_TURN_PRESENCE_SCHEMA_VERSION,
      turn_id: "turn-1",
      audience: "user",
      phase: "received",
      importance: "ephemeral",
      started_at: NOW,
      updated_at: NOW,
      raw_model_name: "debug-only",
    }).success).toBe(false);
  });

  it("formats active status from typed presence without raw diagnostic fields", () => {
    const presence = createUserVisibleSeedyTurnPresence({
      turn_id: "turn-1",
      phase: "waiting",
      importance: "action_required",
      subject: "Waiting for approval",
      reason: "A tool request needs approval before the turn can continue.",
      started_at: NOW,
      updated_at: "2026-05-10T05:00:10.000Z",
      last_activity_at: NOW,
      last_activity_label: "approval requested",
      expected_next: "approval",
    });

    const status = createSeedyActiveTurnStatus(presence, {
      now: "2026-05-10T05:00:45.000Z",
    });

    expect(status).toMatchObject({
      active: true,
      phase: "waiting",
      action_required: true,
      waiting: true,
      elapsed_since_last_activity_ms: 45_000,
    });
    expect(formatSeedyActiveTurnStatus(status))
      .toBe("Seedy needs input to continue: Waiting for approval. Last visible activity: approval requested 45 seconds ago.");
    expect(formatSeedyActiveTurnStatus(createSeedyActiveTurnStatus(null)))
      .toBe("Seedy is not handling an active turn right now.");
  });
});
