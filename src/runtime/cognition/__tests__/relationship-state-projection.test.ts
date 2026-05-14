import { describe, expect, it } from "vitest";
import {
  CognitionMemoryResultSchema,
  RelationshipSurfaceFactSchema,
  createRelationshipStateProjectionV2,
  type CognitionMemoryResult,
} from "../index.js";

const QUERY_REF = {
  ref: "chat:event:1",
  source_store: "chat_history" as const,
  source_event_type: "user_input",
  schema_version: 1,
  source_epoch: "turn:1",
  redaction_policy: "metadata_only" as const,
};

describe("relationship state projection v2", () => {
  it("resolves preference and boundary conflicts boundary-first without exposing raw memory content", () => {
    const result = makeMemoryResult({
      included: [
        memorySource("relationship-profile:pref", {
          role: "preference",
          sourceEventType: "preference",
          excerpt: "Prefer highly enthusiastic long replies.",
          allowedUses: ["runtime_grounding"],
        }),
        memorySource("relationship-profile:boundary", {
          role: "boundary",
          sourceEventType: "boundary",
          excerpt: "Avoid escalating emotional closeness.",
          allowedUses: ["behavioral_inhibition"],
        }),
      ],
    });

    const projection = createRelationshipStateProjectionV2({
      projectionId: "relationship:turn:1",
      turnRef: { kind: "chat_turn", ref: "turn:1" },
      callerPath: "chat_user_turn",
      memoryResult: result,
    });

    expect(projection.posture).toBe("boundary_first");
    expect(projection.conflict_refs.map((ref) => ref.ref)).toEqual([
      "relationship-profile:pref",
      "relationship-profile:boundary",
    ]);
    expect(projection.included).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "boundary",
        allowed_surface_use: "behavioral_inhibition",
      }),
      expect.objectContaining({
        role: "preference",
        allowed_surface_use: "tone_adaptation",
      }),
    ]));
    expect(JSON.stringify(projection.included)).not.toContain("Avoid escalating emotional closeness.");
    expect(JSON.stringify(projection.included)).not.toContain("Prefer highly enthusiastic long replies.");
    expect(projection.normal_surface_debug_visible).toBe(false);
  });

  it("keeps low-confidence open tension as confirmation posture instead of a stable profile fact", () => {
    const projection = createRelationshipStateProjectionV2({
      projectionId: "relationship:turn:tension",
      turnRef: { kind: "gateway_turn", ref: "turn:tension" },
      callerPath: "chat_user_turn",
      memoryResult: makeMemoryResult({
        included: [
          memorySource("relationship-profile:tension", {
            role: "open_tension",
            sourceEventType: "open_tension",
            confidence: 0.35,
            allowedUses: ["user_facing_reference"],
            excerpt: "The user might depend on the assistant as a sole support.",
          }),
        ],
      }),
    });

    expect(projection.posture).toBe("careful");
    expect(projection.overreach_risk).toBe("medium");
    expect(projection.included).toEqual([expect.objectContaining({
      role: "open_tension",
      allowed_surface_use: "ask_for_confirmation",
      confidence: 0.35,
    })]);
    expect(projection.included[0]?.user_readable_reason).toContain("ask or stay neutral");
    expect(projection.relationship_refs[0]?.memory_ref.source_event_type).toBe("open_tension");
    expect(projection.relationship_refs[0]?.memory_ref.source_event_type).not.toBe("stable_profile_fact");
  });

  it("renders sensitive or stale memory only as withheld normal-surface reasons and repair paths", () => {
    const projection = createRelationshipStateProjectionV2({
      projectionId: "relationship:turn:withheld",
      turnRef: { kind: "chat_turn", ref: "turn:withheld" },
      callerPath: "chat_user_turn",
      memoryResult: makeMemoryResult({
        withheld: [
          memorySource("relationship-profile:sensitive", {
            role: "preference",
            sensitivity: "sensitive",
            withheldReason: "sensitive",
            excerpt: "Sensitive value must not render.",
          }),
        ],
      }),
    });

    expect(projection.included).toHaveLength(0);
    expect(projection.withheld).toEqual([expect.objectContaining({
      memory_ref: "relationship-profile:sensitive",
      withheld_reason: "sensitive",
      sensitivity: "sensitive",
      repair_paths: expect.arrayContaining(["correct", "suppress", "forget"]),
    })]);
    expect(projection.withheld[0]?.user_readable_reason).toContain("sensitive records are not shown");
    expect(JSON.stringify(projection.withheld)).not.toContain("Sensitive value must not render.");
  });

  it("preserves computed low or none overreach risk instead of defaulting normal chat to unknown", () => {
    const privatePreference = createRelationshipStateProjectionV2({
      projectionId: "relationship:turn:private-low",
      turnRef: { kind: "chat_turn", ref: "turn:private-low" },
      callerPath: "chat_user_turn",
      memoryResult: makeMemoryResult({
        included: [
          memorySource("relationship-profile:private-preference", {
            role: "preference",
            sourceEventType: "preference",
            sensitivity: "private",
            allowedUses: ["runtime_grounding"],
          }),
        ],
      }),
    });
    const publicPreference = createRelationshipStateProjectionV2({
      projectionId: "relationship:turn:public-none",
      turnRef: { kind: "chat_turn", ref: "turn:public-none" },
      callerPath: "chat_user_turn",
      memoryResult: makeMemoryResult({
        included: [
          memorySource("relationship-profile:public-preference", {
            role: "preference",
            sourceEventType: "preference",
            sensitivity: "public",
            allowedUses: ["runtime_grounding"],
          }),
        ],
      }),
    });

    expect(privatePreference.overreach_risk).toBe("low");
    expect(publicPreference.overreach_risk).toBe("none");
  });

  it("rejects direct low-confidence user-facing reference bypasses", () => {
    expect(RelationshipSurfaceFactSchema.safeParse({
      memory_ref: "relationship-profile:low-confidence",
      role: "preference",
      user_readable_reason: "Unsafe direct bypass.",
      allowed_surface_use: "user_facing_reference",
      confidence: 0.2,
      sensitivity: "private",
      repair_paths: ["correct"],
    }).success).toBe(false);
    expect(RelationshipSurfaceFactSchema.safeParse({
      memory_ref: "relationship-profile:boundary-reference",
      role: "boundary",
      user_readable_reason: "Unsafe direct boundary display.",
      allowed_surface_use: "user_facing_reference",
      confidence: 0.9,
      sensitivity: "private",
      repair_paths: ["correct"],
    }).success).toBe(false);
  });
});

function makeMemoryResult(input: {
  included?: ReturnType<typeof memorySource>[];
  withheld?: ReturnType<typeof memorySource>[];
}): CognitionMemoryResult {
  return CognitionMemoryResultSchema.parse({
    request_id: "memory-request:relationship-test",
    surface_projection_ref: {
      kind: "surface_projection",
      ref: "surface:relationship-test",
    },
    core_memory_projection_ref: {
      kind: "memory_projection",
      ref: "core-memory:relationship-test",
    },
    included: input.included ?? [],
    withheld: input.withheld ?? [],
    audit_refs: [QUERY_REF],
    model_visible_without_cloud_gate: false,
  });
}

function memorySource(memoryId: string, input: {
  role?: "preference" | "boundary" | "promise" | "intervention_policy" | "notification_preference" | "open_tension";
  sourceEventType?: string;
  confidence?: number;
  sensitivity?: "public" | "private" | "sensitive";
  allowedUses?: Array<"runtime_grounding" | "user_facing_reference" | "behavioral_inhibition" | "ask_for_confirmation">;
  withheldReason?: "sensitive" | "stale" | "superseded" | "corrected" | "deleted" | "quarantined" | "forbidden_use" | "missing_surface_projection";
  excerpt?: string;
}) {
  const sensitivity = input.sensitivity ?? "private";
  const source = {
    memory_ref: {
      ...QUERY_REF,
      ref: memoryId,
      source_store: "profile" as const,
      source_event_type: input.sourceEventType ?? "preference",
    },
    source_kind: "semantic" as const,
    allowed_uses: input.allowedUses ?? ["runtime_grounding"],
    forbidden_uses: [],
    sensitivity,
    lifecycle: "active" as const,
    correction_state: "current" as const,
    confidence: input.confidence ?? 0.9,
    surface_projection_ref: "surface:relationship-test",
    relationship_role: input.role ?? "preference",
    ...(input.excerpt ? { excerpt: input.excerpt } : {}),
  };
  if (!input.withheldReason) return source;
  return {
    ...source,
    sensitivity,
    withheld_reason: input.withheldReason,
  };
}
