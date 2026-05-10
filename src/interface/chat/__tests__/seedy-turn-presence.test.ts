import { describe, expect, it } from "vitest";
import {
  SEEDY_TURN_PRESENCE_SCHEMA_VERSION,
  SeedyTurnPresenceSchema,
  createSeedyTurnPresence,
  createUserVisibleSeedyTurnPresence,
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
});
