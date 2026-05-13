import { describe, expect, it } from "vitest";
import type { SurfaceGateKind } from "../../../grounding/surface-contracts.js";
import {
  CoreCompanionMemoryEntrySchema,
  createCoreCompanionMemoryProjectionFromSurface,
  createCoreCompanionMemoryProjectionInputRef,
} from "../index.js";

const NOW = "2026-05-13T01:00:00.000Z";

function ownerRef(
  kind: "relationship_profile" | "profile_proposal" | "runtime_session" | "knowledge" | "soil" | "dream_seed" = "relationship_profile"
) {
  return {
    kind,
    store_ref: `${kind}:store`,
    record_ref: `${kind}:record-1`,
  };
}

function dependencyRef(memoryId: string, overrides: Record<string, unknown> = {}) {
  const lifecycle = typeof overrides.lifecycle === "string" ? overrides.lifecycle : "active";
  const correctionState = typeof overrides.correction_state === "string" ? overrides.correction_state : "current";
  const contentState = typeof overrides.content_state === "string" ? overrides.content_state : "materialized";
  const owningStoreRef = overrides.owning_store_ref ?? ownerRef();
  return {
    kind: "memory_record",
    ref: memoryId,
    owning_store_ref: owningStoreRef,
    content_state: contentState,
    lifecycle,
    correction_state: correctionState,
    superseded_by_memory_id: overrides.superseded_by_memory_id ?? null,
  };
}

function domainFields() {
  return {
    target: "companion collaboration",
    preference: "use terse operator updates",
    confidence: 0.92,
    scope: "PulSeed work",
    allowed_uses: ["runtime_grounding"],
    review_condition: "when corrected",
  };
}

function redactedDomainFields() {
  return {
    redaction_ref: "redaction:memory:deleted",
    reason: "deleted",
  };
}

function sourceRef(overrides: Record<string, unknown> = {}) {
  const memoryId = typeof overrides.memory_id === "string" ? overrides.memory_id : "memory-1";
  const owningStoreRef = overrides.owning_store_ref ?? ownerRef();
  const lifecycle = typeof overrides.lifecycle === "string" ? overrides.lifecycle : "active";
  const correctionState = typeof overrides.correction_state === "string" ? overrides.correction_state : "current";
  const contentState = typeof overrides.content_state === "string" ? overrides.content_state : "materialized";
  const supersededByMemoryId = overrides.superseded_by_memory_id ?? null;
  return {
    memory_id: memoryId,
    owning_store_ref: owningStoreRef,
    role: "relationship",
    record_kind: "preference",
    domain_fields: contentState === "redacted" ? redactedDomainFields() : domainFields(),
    allowed_uses: ["runtime_grounding", "user_facing_reference", "behavioral_inhibition", "goal_planning", "proactive_action_candidate", "surface_projection"],
    not_allowed_uses: ["side_effect_authorization", "stale_session_authorization"],
    lifecycle,
    correction_state: correctionState,
    superseded_by_memory_id: supersededByMemoryId,
    sensitivity: "private",
    content_state: contentState,
    dependency_ref: dependencyRef(memoryId, {
      owning_store_ref: owningStoreRef,
      lifecycle,
      correction_state: correctionState,
      superseded_by_memory_id: supersededByMemoryId,
      content_state: contentState,
    }),
    ...overrides,
  };
}

function gate(gateName: SurfaceGateKind, status: "passed" | "blocked" | "unknown" = "passed") {
  return {
    gate: gateName,
    status,
    reason_ref: `gate:${gateName}:${status}`,
    evaluated_at: NOW,
  };
}

function passedGates() {
  return [
    gate("scope"),
    gate("lifecycle"),
    gate("staleness"),
    gate("sensitivity"),
    gate("permission"),
    gate("allowed_use"),
    gate("forbidden_use"),
    gate("projection"),
    gate("audit"),
  ];
}

function permissionFor(source = sourceRef(), overrides: Record<string, unknown> = {}) {
  return {
    permission_id: `permission:${source.memory_id}`,
    context_scope: "PulSeed work",
    memory_role_scope: [source.role],
    observation_permission: "allowed",
    memory_use_permission: "allowed",
    speakability: "ask_first",
    proactive_permission: "ask_first",
    interruption_tolerance: "low",
    autonomy_level: "ask_first",
    confirmation_requirement: "before_action",
    emotional_language_boundary: "neutral",
    preferred_expression_modes: ["terse"],
    forbidden_moves: ["raw_prompt_injection", "side_effect_authorization"],
    valid_from: NOW,
    valid_to: null,
    source_refs: [{
      memory_id: source.memory_id,
      owning_store_ref: source.owning_store_ref,
    }],
    ...overrides,
  };
}

function includedSurface(requestedUse: string, overrides: Record<string, unknown> = {}) {
  const selected = (overrides.source ?? sourceRef()) as ReturnType<typeof sourceRef>;
  const permissionOverrides = (overrides.permissionOverrides ?? {}) as Record<string, unknown>;
  const lane = selected.role === "knowledge"
    ? "knowledge"
    : selected.role === "work_memory"
      ? "work_memory"
      : selected.role;
  return {
    id: `surface:${requestedUse}`,
    version: 1,
    target: "chat",
    scope: {
      kind: "conversation",
      ref: "conversation:1",
    },
    purpose: "general_turn",
    requested_use: requestedUse,
    source_refs: [selected],
    relationship_permissions: [permissionFor(selected, permissionOverrides)],
    included_context: [{
      lane,
      source_ref: selected,
      use_class: requestedUse,
      excerpt: "The user prefers terse operator updates.",
      gates: passedGates(),
    }],
    excluded_context: [],
    allowed_runtime_uses: [requestedUse, "surface_projection"],
    not_allowed_runtime_uses: ["side_effect_authorization", "stale_session_authorization", "raw_prompt_injection"],
    gate_order: ["scope", "lifecycle", "staleness", "sensitivity", "permission", "allowed_use", "forbidden_use", "projection", "audit"],
    staleness_checks: ["surface:fresh"],
    sensitivity_checks: ["surface:sensitivity"],
    rationale_entries: [{
      source_ref: selected,
      decision: "included",
      gate: "projection",
      reason_ref: `rationale:${selected.memory_id}:included`,
      policy_refs: ["core-memory-projection-test"],
    }],
    metadata: {
      staleness: "fresh",
      sensitivity: "private",
      permission_state: "granted",
      invalidation_state: "valid",
      audit_refs: ["audit:surface"],
    },
    created_at: NOW,
    expires_at: null,
  };
}

function restrictedSurface(sources: Array<{ source: ReturnType<typeof sourceRef>; blockedGate: SurfaceGateKind; redactionRef?: string }>) {
  return {
    id: "surface:restricted",
    version: 1,
    target: "chat",
    scope: {
      kind: "conversation",
      ref: "conversation:1",
    },
    purpose: "general_turn",
    requested_use: "runtime_grounding",
    source_refs: sources.map((entry) => entry.source),
    relationship_permissions: [],
    included_context: [],
    excluded_context: sources.map((entry) => ({
      lane: "exclusion",
      source_ref: entry.source,
      requested_use: "runtime_grounding",
      blocked_by: [gate(entry.blockedGate, "blocked")],
      ...(entry.redactionRef ? { redaction_ref: entry.redactionRef } : {}),
    })),
    allowed_runtime_uses: ["runtime_grounding"],
    not_allowed_runtime_uses: ["side_effect_authorization", "stale_session_authorization", "raw_prompt_injection"],
    gate_order: ["scope", "lifecycle", "staleness", "sensitivity", "permission", "allowed_use", "forbidden_use", "projection", "audit"],
    staleness_checks: ["surface:fresh"],
    sensitivity_checks: ["surface:sensitivity"],
    rationale_entries: sources.map((entry) => ({
      source_ref: entry.source,
      decision: "excluded",
      gate: entry.blockedGate,
      reason_ref: `rationale:${entry.source.memory_id}:excluded`,
      policy_refs: ["core-memory-projection-test"],
      ...(entry.redactionRef ? { redaction_ref: entry.redactionRef } : {}),
    })),
    metadata: {
      staleness: "fresh",
      sensitivity: "private",
      permission_state: "blocked",
      invalidation_state: "valid",
      audit_refs: ["audit:surface:restricted"],
    },
    created_at: NOW,
    expires_at: null,
  };
}

describe("CoreCompanionMemoryProjection", () => {
  it("turns a governed Surface into a decision-frame input without prompt dumping or new memory ownership", () => {
    const soilSource = sourceRef({
      memory_id: "soil-memory-1",
      owning_store_ref: ownerRef("soil"),
      role: "knowledge",
      record_kind: "knowledge_fact",
    });
    const projection = createCoreCompanionMemoryProjectionFromSurface({
      surfaceProjection: includedSurface("runtime_grounding", { source: soilSource }),
      callerPath: "chat_native_agent_loop",
      projectionId: "core-memory:chat:1",
      groundingProfileId: "chat/general_turn",
      groundingBundleRef: "grounding:bundle:1",
      decisionFrameRef: "frame:1",
      correctionEventRefs: ["correction:ledger:1"],
      createdAt: NOW,
    });
    const inputRef = createCoreCompanionMemoryProjectionInputRef(projection);

    expect(projection.source_refs.map((ref) => ref.kind)).toEqual(expect.arrayContaining([
      "surface_projection",
      "soil",
      "grounding_profile",
      "grounding_bundle",
      "correction_ledger",
    ]));
    expect(projection.included_entries[0]?.use_policy).toMatchObject({
      remembered: true,
      usable: true,
      speakable: false,
      actionable: false,
      memory_is_runtime_authority: false,
    });
    expect(projection.ordinary_surface_policy.raw_memory_dump_visible).toBe(false);
    expect(projection).not.toHaveProperty("prompt_dump");
    expect(inputRef).toMatchObject({
      kind: "memory_projection",
      ref: "core-memory:chat:1",
      role: "context",
      freshness: "current",
    });
  });

  it("preserves non-Surface owner provenance instead of collapsing memory stores into surface refs", () => {
    const runtimeSource = sourceRef({
      memory_id: "runtime-memory-1",
      owning_store_ref: ownerRef("runtime_session"),
      role: "work_memory",
      record_kind: "episodic_event",
    });
    const restrictedDreamSeed = sourceRef({
      memory_id: "dream-seed-1",
      owning_store_ref: ownerRef("dream_seed"),
      role: "seed",
      record_kind: "seed_candidate",
      lifecycle: "planted",
      allowed_uses: ["never_use_directly"],
    });
    const runtimeProjection = createCoreCompanionMemoryProjectionFromSurface({
      surfaceProjection: includedSurface("runtime_grounding", { source: runtimeSource }),
      callerPath: "task_agent_loop",
      createdAt: NOW,
    });
    const restrictedProjection = createCoreCompanionMemoryProjectionFromSurface({
      surfaceProjection: restrictedSurface([{ source: restrictedDreamSeed, blockedGate: "lifecycle" }]),
      callerPath: "resident_attention_cycle",
      createdAt: NOW,
    });

    expect(runtimeProjection.source_refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "runtime_session", owner_kind: "runtime_session" }),
    ]));
    expect(restrictedProjection.source_refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "dream_seed", owner_kind: "dream_seed" }),
    ]));
    expect(runtimeProjection.source_refs.filter((ref) => ref.kind === "surface_projection")).toHaveLength(1);
  });

  it("separates remembered, usable, speakable, actionable, inhibition-only, and planning-only memory use", () => {
    const speakable = createCoreCompanionMemoryProjectionFromSurface({
      surfaceProjection: includedSurface("user_facing_reference", {
        permissionOverrides: { speakability: "allowed", confirmation_requirement: "none" },
      }),
      callerPath: "chat_native_agent_loop",
      createdAt: NOW,
    });
    const actionable = createCoreCompanionMemoryProjectionFromSurface({
      surfaceProjection: includedSurface("proactive_action_candidate", {
        permissionOverrides: { proactive_permission: "allowed", confirmation_requirement: "none" },
      }),
      callerPath: "resident_attention_cycle",
      createdAt: NOW,
    });
    const askFirstAction = createCoreCompanionMemoryProjectionFromSurface({
      surfaceProjection: includedSurface("proactive_action_candidate", {
        permissionOverrides: { proactive_permission: "ask_first", confirmation_requirement: "before_action" },
      }),
      callerPath: "resident_attention_cycle",
      createdAt: NOW,
    });
    const inhibition = createCoreCompanionMemoryProjectionFromSurface({
      surfaceProjection: includedSurface("behavioral_inhibition"),
      callerPath: "chat_native_agent_loop",
      createdAt: NOW,
    });
    const planning = createCoreCompanionMemoryProjectionFromSurface({
      surfaceProjection: includedSurface("goal_planning"),
      callerPath: "task_agent_loop",
      createdAt: NOW,
    });

    expect(speakable.summary.speakable_count).toBe(1);
    expect(speakable.included_entries[0]?.use_policy.actionable).toBe(false);
    expect(actionable.summary.actionable_count).toBe(1);
    expect(actionable.included_entries[0]?.use_policy.memory_is_runtime_authority).toBe(false);
    expect(askFirstAction.included_entries[0]?.use_policy).toMatchObject({
      actionable: false,
      planning_only: true,
      required_confirmation: "before_action",
    });
    expect(inhibition.included_entries[0]?.use_policy).toMatchObject({
      usable: true,
      inhibition_only: true,
      speakable: false,
      actionable: false,
    });
    expect(planning.included_entries[0]?.use_policy).toMatchObject({
      usable: true,
      planning_only: true,
      speakable: false,
      actionable: false,
    });
  });

  it("keeps stale, superseded, corrected, sensitive, out-of-scope, and deleted sources restricted before decision use", () => {
    const deletedSource = sourceRef({
      memory_id: "deleted-memory",
      lifecycle: "deleted",
      correction_state: "deleted",
      content_state: "redacted",
    });
    const projection = createCoreCompanionMemoryProjectionFromSurface({
      surfaceProjection: restrictedSurface([
        {
          source: sourceRef({
            memory_id: "stale-memory",
            lifecycle: "decayed",
          }),
          blockedGate: "staleness",
        },
        {
          source: sourceRef({
            memory_id: "superseded-memory",
            lifecycle: "superseded",
            correction_state: "superseded",
            superseded_by_memory_id: "current-memory",
          }),
          blockedGate: "lifecycle",
        },
        {
          source: sourceRef({
            memory_id: "corrected-memory",
            correction_state: "corrected",
          }),
          blockedGate: "lifecycle",
        },
        {
          source: sourceRef({
            memory_id: "sensitive-memory",
            sensitivity: "sensitive",
          }),
          blockedGate: "sensitivity",
        },
        {
          source: sourceRef({
            memory_id: "out-of-scope-memory",
            not_allowed_uses: ["cross_scope_reuse", "runtime_grounding"],
          }),
          blockedGate: "scope",
        },
        {
          source: deletedSource,
          blockedGate: "lifecycle",
          redactionRef: "redaction:memory:deleted",
        },
      ]),
      callerPath: "chat_native_agent_loop",
      createdAt: NOW,
    });

    expect(projection.included_entries).toHaveLength(0);
    expect(projection.summary.forbidden_count).toBe(6);
    expect(projection.restricted_entries.map((entry) => entry.restriction_reasons)).toEqual(expect.arrayContaining([
      expect.arrayContaining(["stale"]),
      expect.arrayContaining(["superseded"]),
      expect.arrayContaining(["corrected"]),
      expect.arrayContaining(["sensitive"]),
      expect.arrayContaining(["out_of_scope"]),
      expect.arrayContaining(["redacted"]),
    ]));
    expect(JSON.stringify(projection.restricted_entries)).not.toContain("The user prefers terse operator updates.");
    expect(projection.restricted_entries.every((entry) => entry.content.state === "withheld")).toBe(true);
  });

  it("rejects direct included-entry bypasses for sensitive or corrected memory", () => {
    const baseSurface = includedSurface("runtime_grounding");
    const baseEntry = {
      entry_id: "core-memory-entry:bypass",
      lane: "relationship",
      source_ref: sourceRef({ sensitivity: "sensitive" }),
      content: {
        state: "available",
        excerpt: "Sensitive memory should not be projected.",
      },
      use_policy: {
        remembered: true,
        usable: true,
        speakable: false,
        actionable: false,
        inhibition_only: false,
        planning_only: false,
        forbidden: false,
        memory_is_runtime_authority: false,
        required_confirmation: "none",
        requested_use: "runtime_grounding",
        allowed_use_classes: ["runtime_grounding"],
        blocked_use_classes: [],
      },
      source_projection_ref: baseSurface.id,
      audit_refs: ["audit:bypass"],
    };

    expect(CoreCompanionMemoryEntrySchema.safeParse(baseEntry).success).toBe(false);
    expect(CoreCompanionMemoryEntrySchema.safeParse({
      ...baseEntry,
      source_ref: sourceRef({ correction_state: "corrected" }),
    }).success).toBe(false);
    expect(CoreCompanionMemoryEntrySchema.safeParse({
      ...baseEntry,
      source_ref: sourceRef({ lifecycle: "decayed" }),
    }).success).toBe(false);
  });
});
