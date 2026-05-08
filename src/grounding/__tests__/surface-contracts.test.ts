import { describe, expect, it } from "vitest";
import {
  SurfaceInvalidationEventSchema,
  SurfaceInvalidationPolicySchema,
  SurfaceProjectionSchema,
  attachSurfaceDependencyRef,
  createSurfaceDerivedRuntimeRef,
  createSurfaceInspectionAdapterPayload,
  createSurfaceInspectionView,
  evaluateSurfaceRuntimeAdmission,
  invalidateSurfaceProjectionFromMemoryCorrection,
  invalidateSurfaceProjectionFromPermissionChange,
  type SurfaceDerivedRuntimeRefInput,
  type SurfaceGateKind,
  type SurfaceMemorySourceRef,
  type SurfaceProjectionInput,
} from "../surface-contracts.js";

const now = "2026-05-08T00:00:00.000Z";

function ownerRef() {
  return {
    kind: "relationship_profile",
    store_ref: "relationship-profile.json",
    record_ref: "profile-item-1",
  };
}

function domainFields() {
  return {
    target: "status reports",
    preference: "concise",
    confidence: 0.9,
    scope: "operator collaboration",
    allowed_uses: ["surface_projection"],
    review_condition: "when corrected",
  };
}

function redactedDomainFields(reason: "sensitive" | "tombstoned" | "deleted" | "permission_revoked" | "scope_excluded" = "deleted") {
  return {
    redaction_ref: `redaction/${reason}/memory-1`,
    reason,
  };
}

function dependencyRef(overrides: Record<string, unknown> = {}) {
  return {
    kind: "memory_record",
    ref: "memory-1",
    owning_store_ref: ownerRef(),
    content_state: "materialized",
    lifecycle: "active",
    correction_state: "current",
    superseded_by_memory_id: null,
    ...overrides,
  };
}

function sourceRef(overrides: Record<string, unknown> = {}): SurfaceMemorySourceRef {
  const memoryId = typeof overrides.memory_id === "string" ? overrides.memory_id : "memory-1";
  const owningStoreRef = overrides.owning_store_ref ?? ownerRef();
  const lifecycle = typeof overrides.lifecycle === "string" ? overrides.lifecycle : "active";
  const contentState = typeof overrides.content_state === "string" ? overrides.content_state : "materialized";
  const correctionState = typeof overrides.correction_state === "string" ? overrides.correction_state : "current";
  const supersededByMemoryId = "superseded_by_memory_id" in overrides
    ? overrides.superseded_by_memory_id
    : null;
  const domainFieldValue = "domain_fields" in overrides
    ? overrides.domain_fields
    : contentState === "redacted"
      ? redactedDomainFields(lifecycle === "tombstoned" ? "tombstoned" : "deleted")
      : domainFields();

  return {
    memory_id: memoryId,
    owning_store_ref: owningStoreRef,
    role: "relationship",
    record_kind: "preference",
    domain_fields: domainFieldValue,
    allowed_uses: ["surface_projection", "user_facing_reference", "attention_prioritization"],
    not_allowed_uses: ["side_effect_authorization", "stale_session_authorization"],
    lifecycle,
    correction_state: correctionState,
    superseded_by_memory_id: supersededByMemoryId,
    sensitivity: "private",
    content_state: contentState,
    dependency_ref: dependencyRef({
      ref: memoryId,
      owning_store_ref: owningStoreRef,
      lifecycle,
      correction_state: correctionState,
      superseded_by_memory_id: supersededByMemoryId,
      content_state: contentState,
    }),
    ...overrides,
  } as SurfaceMemorySourceRef;
}

function gate(gateName: SurfaceGateKind, status: "passed" | "blocked" | "unknown" = "passed") {
  return {
    gate: gateName,
    status,
    reason_ref: `reason/${gateName}/${status}`,
    evaluated_at: now,
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

function relationshipPermission(overrides: Record<string, unknown> = {}) {
  return {
    permission_id: "permission-1",
    context_scope: "operator collaboration",
    memory_role_scope: ["relationship", "boundary", "promise", "tension"],
    observation_permission: "allowed",
    memory_use_permission: "allowed",
    speakability: "allowed",
    proactive_permission: "ask_first",
    interruption_tolerance: "low",
    autonomy_level: "ask_first",
    confirmation_requirement: "before_action",
    emotional_language_boundary: "neutral",
    preferred_expression_modes: ["concise"],
    forbidden_moves: ["overfamiliarity"],
    valid_from: now,
    source_refs: [permissionSourceRef()],
    ...overrides,
  };
}

function permissionSourceRef(source: ReturnType<typeof sourceRef> = sourceRef()) {
  return {
    memory_id: source.memory_id,
    owning_store_ref: source.owning_store_ref,
  };
}

function derivedRef(
  kind: SurfaceDerivedRuntimeRefInput["kind"] = "runtime_item",
  overrides: Partial<SurfaceDerivedRuntimeRefInput> = {}
): SurfaceDerivedRuntimeRefInput {
  return {
    kind,
    ref: `${kind}-1`,
    related_surface_refs: ["surface-1"],
    related_memory_refs: ["memory-1"],
    permission_check_refs: ["permission-1"],
    staleness_check_refs: ["staleness-1"],
    use_class: "surface_projection",
    audit_refs: ["audit/surface-1"],
    ...overrides,
  } as SurfaceDerivedRuntimeRefInput;
}

function projection(overrides: Record<string, unknown> = {}): SurfaceProjectionInput {
  const selected = sourceRef();
  return {
    id: "surface-1",
    version: 1,
    target: "gateway",
    scope: {
      kind: "task",
      ref: "issue-1274",
    },
    purpose: "task_execution",
    requested_use: "surface_projection",
    source_refs: [selected],
    relationship_permissions: [relationshipPermission()],
    included_context: [{
      lane: "relationship",
      source_ref: selected,
      use_class: "surface_projection",
      excerpt: "The user prefers concise status reports.",
      gates: passedGates(),
    }],
    excluded_context: [],
    allowed_runtime_uses: ["surface_projection", "runtime_grounding"],
    not_allowed_runtime_uses: ["side_effect_authorization"],
    staleness_checks: ["staleness-1"],
    sensitivity_checks: ["sensitivity-1"],
    rationale_entries: [{
      source_ref: selected,
      decision: "included",
      gate: "audit",
      reason_ref: "rationale/memory-1/included",
      policy_refs: ["policy/surface"],
    }],
    metadata: {
      staleness: "fresh",
      sensitivity: "private",
      permission_state: "granted",
      invalidation_state: "valid",
      audit_refs: ["audit/surface-1"],
    },
    created_at: now,
    ...overrides,
  } as SurfaceProjectionInput;
}

describe("SurfaceProjection contract", () => {
  it("models scoped selected source refs rather than a whole memory store", () => {
    const parsed = SurfaceProjectionSchema.parse(projection());

    expect(parsed.store_scope).toBe("selected_refs");
    expect(parsed.scope).toEqual({ kind: "task", ref: "issue-1274" });
    expect(parsed.source_refs).toHaveLength(1);
    expect("memory_store" in parsed).toBe(false);

    const withoutScope = { ...projection() };
    delete (withoutScope as { scope?: unknown }).scope;
    expect(SurfaceProjectionSchema.safeParse(withoutScope).success).toBe(false);

    expect(SurfaceProjectionSchema.safeParse({
      ...projection(),
      source_refs: [],
      included_context: [],
      rationale_entries: [],
    }).success).toBe(false);
  });

  it("requires canonical gates to pass in order before context is included", () => {
    const withoutPermissionGate = SurfaceProjectionSchema.safeParse(projection({
      included_context: [{
        lane: "relationship",
        source_ref: sourceRef(),
        use_class: "surface_projection",
        excerpt: "The user prefers concise status reports.",
        gates: passedGates().filter((candidate) => candidate.gate !== "permission"),
      }],
    }));
    expect(withoutPermissionGate.success).toBe(false);

    const blockedStaleness = SurfaceProjectionSchema.safeParse(projection({
      included_context: [{
        lane: "relationship",
        source_ref: sourceRef(),
        use_class: "surface_projection",
        excerpt: "A relevant but stale item must not be included.",
        gates: passedGates().map((candidate) =>
          candidate.gate === "staleness" ? gate("staleness", "blocked") : candidate
        ),
      }],
    }));
    expect(blockedStaleness.success).toBe(false);

    expect(SurfaceProjectionSchema.safeParse(projection({
      gate_order: ["permission", "scope", "lifecycle", "staleness", "sensitivity", "allowed_use", "forbidden_use", "projection", "audit"],
    })).success).toBe(false);
  });

  it("rejects relevant but superseded forbidden unpermitted or sensitive included memory", () => {
    const supersededSource = sourceRef({ lifecycle: "superseded" });
    expect(SurfaceProjectionSchema.safeParse(projection({
      source_refs: [supersededSource],
      included_context: [{
        lane: "relationship",
        source_ref: supersededSource,
        use_class: "surface_projection",
        excerpt: "Superseded memory must not be included.",
        gates: passedGates(),
      }],
      rationale_entries: [],
    })).success).toBe(false);

    const correctedSource = sourceRef({
      correction_state: "superseded",
      superseded_by_memory_id: "memory-2",
    });
    expect(SurfaceProjectionSchema.safeParse(projection({
      source_refs: [correctedSource],
      included_context: [{
        lane: "relationship",
        source_ref: correctedSource,
        use_class: "surface_projection",
        excerpt: "Corrected source refs must not be included as active Surface context.",
        gates: passedGates(),
      }],
      rationale_entries: [{
        source_ref: correctedSource,
        decision: "included",
        gate: "audit",
        reason_ref: "rationale/corrected-source",
      }],
    })).success).toBe(false);

    expect(SurfaceProjectionSchema.safeParse(projection({
      requested_use: "side_effect_authorization",
      included_context: [{
        lane: "relationship",
        source_ref: sourceRef(),
        use_class: "surface_projection",
        excerpt: "Forbidden side effect authorization must not be included.",
        gates: passedGates(),
      }],
    })).success).toBe(false);

    expect(SurfaceProjectionSchema.safeParse(projection({
      metadata: {
        staleness: "fresh",
        sensitivity: "sensitive",
        permission_state: "blocked",
        invalidation_state: "valid",
      },
    })).success).toBe(false);

    expect(SurfaceProjectionSchema.safeParse(projection({
      metadata: {
        staleness: "stale",
        sensitivity: "private",
        permission_state: "granted",
        invalidation_state: "valid",
      },
    })).success).toBe(false);

    expect(SurfaceProjectionSchema.safeParse(projection({
      metadata: {
        staleness: "fresh",
        sensitivity: "private",
        permission_state: "granted",
        invalidation_state: "invalid",
      },
    })).success).toBe(false);

    const sensitiveSource = sourceRef({ sensitivity: "sensitive" });
    expect(SurfaceProjectionSchema.safeParse(projection({
      source_refs: [sensitiveSource],
      included_context: [{
        lane: "relationship",
        source_ref: sensitiveSource,
        use_class: "surface_projection",
        excerpt: "Sensitive source content must not be included directly.",
        gates: passedGates(),
      }],
      rationale_entries: [{
        source_ref: sensitiveSource,
        decision: "included",
        gate: "sensitivity",
        reason_ref: "rationale/sensitive",
      }],
    })).success).toBe(false);

    expect(SurfaceProjectionSchema.safeParse(projection({
      requested_use: "user_facing_reference",
      included_context: [{
        lane: "relationship",
        source_ref: sourceRef(),
        use_class: "user_facing_reference",
        excerpt: "Speaking this memory is blocked by relationship permission.",
        gates: passedGates(),
      }],
      relationship_permissions: [relationshipPermission({ speakability: "blocked" })],
      allowed_runtime_uses: ["user_facing_reference"],
    })).success).toBe(false);

    expect(SurfaceProjectionSchema.safeParse(projection({
      requested_use: "user_facing_reference",
      included_context: [{
        lane: "relationship",
        source_ref: sourceRef(),
        use_class: "user_facing_reference",
        excerpt: "Projection-level allowed uses must admit this use.",
        gates: passedGates(),
      }],
      allowed_runtime_uses: ["surface_projection"],
    })).success).toBe(false);

    expect(SurfaceProjectionSchema.safeParse(projection({
      relationship_permissions: [relationshipPermission({
        source_refs: [{ memory_id: "different-memory", owning_store_ref: ownerRef() }],
      })],
    })).success).toBe(false);

    const sameIdDifferentOwner = sourceRef({
      owning_store_ref: {
        kind: "soil",
        store_ref: "soil.sqlite",
        record_ref: "soil-record-1",
      },
    });
    expect(SurfaceProjectionSchema.safeParse(projection({
      source_refs: [sameIdDifferentOwner],
      included_context: [{
        lane: "relationship",
        source_ref: sameIdDifferentOwner,
        use_class: "surface_projection",
        excerpt: "A same id from a different owner is not covered by profile permission.",
        gates: passedGates(),
      }],
      rationale_entries: [{
        source_ref: sameIdDifferentOwner,
        decision: "included",
        gate: "audit",
        reason_ref: "rationale/same-id-different-owner",
      }],
    })).success).toBe(false);
  });

  it("preserves Surface lanes and uses Exclusion for withheld context", () => {
    const boundarySource = sourceRef({
      memory_id: "memory-boundary",
      role: "boundary",
      record_kind: "boundary",
      domain_fields: {
        prohibited_use: "do not use private context for resident behavior",
        scope: "resident_behavior",
        authority_source: "explicit boundary",
        override_rule: "explicit re-grant",
      },
      dependency_ref: dependencyRef({ ref: "memory-boundary" }),
    });

    const parsed = SurfaceProjectionSchema.parse(projection({
      source_refs: [boundarySource],
      relationship_permissions: [relationshipPermission({ source_refs: [permissionSourceRef(boundarySource)] })],
      included_context: [{
        lane: "boundary",
        source_ref: boundarySource,
        use_class: "surface_projection",
        excerpt: "A boundary prevents resident behavior use.",
        gates: passedGates(),
      }],
      rationale_entries: [{
        source_ref: boundarySource,
        decision: "included",
        gate: "audit",
        reason_ref: "rationale/boundary",
      }],
    }));
    expect(parsed.included_context[0]?.lane).toBe("boundary");
    expect(parsed.included_context[0]?.source_ref.record_kind).toBe("boundary");
    expect(parsed.included_context[0]?.source_ref.domain_fields).toHaveProperty("prohibited_use");

    expect(SurfaceProjectionSchema.safeParse(projection({
      source_refs: [boundarySource],
      included_context: [{
        lane: "relationship",
        source_ref: boundarySource,
        use_class: "surface_projection",
        excerpt: "Wrong lane must fail.",
        gates: passedGates(),
      }],
      rationale_entries: [],
    })).success).toBe(false);

    const excluded = SurfaceProjectionSchema.parse(projection({
      requested_use: "side_effect_authorization",
      source_refs: [boundarySource],
      included_context: [],
      excluded_context: [{
        source_ref: boundarySource,
        requested_use: "side_effect_authorization",
        blocked_by: [gate("forbidden_use", "blocked")],
        inhibition_ref: "inhibition/boundary",
        blocked_summary_ref: "summary/boundary",
      }],
      rationale_entries: [{
        source_ref: boundarySource,
        decision: "excluded",
        gate: "forbidden_use",
        reason_ref: "rationale/boundary/excluded",
      }],
      metadata: {
        staleness: "fresh",
        sensitivity: "private",
        permission_state: "blocked",
        invalidation_state: "valid",
      },
    }));
    expect(excluded.excluded_context[0]?.lane).toBe("exclusion");
  });

  it("uses relationship permissions as projection input without turning memory into resume authority", () => {
    const watchOnlyGoal = sourceRef({
      memory_id: "goal-watch-1",
      role: "promise",
      record_kind: "work_commitment",
      domain_fields: {
        statement: "Watch the release quietly.",
        linked_refs: ["goal-1"],
        authority: "current session",
        fulfillment_condition: "release observed",
      },
      allowed_uses: ["attention_prioritization", "ask_for_confirmation"],
      not_allowed_uses: ["stale_session_authorization", "side_effect_authorization"],
      dependency_ref: dependencyRef({ ref: "goal-watch-1" }),
    });

    const parsed = SurfaceProjectionSchema.parse(projection({
      requested_use: "stale_session_authorization",
      source_refs: [watchOnlyGoal],
      included_context: [],
      excluded_context: [{
        source_ref: watchOnlyGoal,
        requested_use: "stale_session_authorization",
        blocked_by: [gate("permission", "blocked"), gate("forbidden_use", "blocked")],
        inhibition_ref: "inhibition/resume-blocked",
      }],
      relationship_permissions: [relationshipPermission({
        memory_role_scope: ["promise"],
        memory_use_permission: "allowed",
        confirmation_requirement: "before_resume",
      })],
      allowed_runtime_uses: ["attention_prioritization"],
      not_allowed_runtime_uses: ["stale_session_authorization"],
      rationale_entries: [{
        source_ref: watchOnlyGoal,
        decision: "excluded",
        gate: "permission",
        reason_ref: "rationale/watch-only/resume-blocked",
      }],
      metadata: {
        staleness: "fresh",
        sensitivity: "private",
        permission_state: "blocked",
        invalidation_state: "valid",
      },
    }));

    expect(parsed.excluded_context[0]?.inhibition_ref).toBe("inhibition/resume-blocked");
    expect(parsed.included_context).toHaveLength(0);
  });

  it("redacts deleted and tombstoned content across excluded context rationale and inspection", () => {
    const deletedSource = sourceRef({
      lifecycle: "deleted",
      content_state: "redacted",
      dependency_ref: dependencyRef({
        content_state: "redacted",
        lifecycle: "deleted",
      }),
    });

    const parsed = SurfaceProjectionSchema.parse(projection({
      source_refs: [deletedSource],
      included_context: [],
      excluded_context: [{
        source_ref: deletedSource,
        requested_use: "surface_projection",
        blocked_by: [gate("lifecycle", "blocked")],
        redaction_ref: "redaction/memory-1",
      }],
      rationale_entries: [{
        source_ref: deletedSource,
        decision: "excluded",
        gate: "lifecycle",
        reason_ref: "rationale/deleted",
        redaction_ref: "redaction/memory-1",
      }],
      metadata: {
        staleness: "unknown",
        sensitivity: "sensitive",
        permission_state: "blocked",
        invalidation_state: "invalid",
      },
    }));

    expect(parsed.excluded_context[0]?.redaction_ref).toBe("redaction/memory-1");

    const reconstructableDeletedSource = sourceRef({
      lifecycle: "deleted",
      content_state: "redacted",
      domain_fields: domainFields(),
      dependency_ref: dependencyRef({
        content_state: "redacted",
        lifecycle: "deleted",
      }),
    });
    expect(SurfaceProjectionSchema.safeParse(projection({
      source_refs: [reconstructableDeletedSource],
      included_context: [],
      excluded_context: [{
        source_ref: reconstructableDeletedSource,
        requested_use: "surface_projection",
        blocked_by: [gate("lifecycle", "blocked")],
        redaction_ref: "redaction/memory-1",
      }],
      rationale_entries: [{
        source_ref: reconstructableDeletedSource,
        decision: "excluded",
        gate: "lifecycle",
        reason_ref: "rationale/deleted",
        redaction_ref: "redaction/memory-1",
      }],
      metadata: {
        staleness: "unknown",
        sensitivity: "sensitive",
        permission_state: "blocked",
        invalidation_state: "invalid",
      },
    })).success).toBe(false);

    expect(SurfaceProjectionSchema.safeParse(projection({
      source_refs: [deletedSource],
      included_context: [],
      excluded_context: [{
        source_ref: deletedSource,
        requested_use: "surface_projection",
        blocked_by: [gate("lifecycle", "passed")],
        redaction_ref: "redaction/memory-1",
      }],
      rationale_entries: [{
        source_ref: deletedSource,
        decision: "excluded",
        gate: "lifecycle",
        reason_ref: "rationale/deleted",
        redaction_ref: "redaction/memory-1",
      }],
      metadata: {
        staleness: "unknown",
        sensitivity: "sensitive",
        permission_state: "blocked",
        invalidation_state: "invalid",
      },
    })).success).toBe(false);

    expect(SurfaceProjectionSchema.safeParse(projection({
      source_refs: [deletedSource],
      included_context: [{
        lane: "relationship",
        source_ref: deletedSource,
        use_class: "surface_projection",
        excerpt: "Deleted content must not appear here.",
        gates: passedGates(),
      }],
      rationale_entries: [],
    })).success).toBe(false);

    expect(SurfaceProjectionSchema.safeParse(projection({
      source_refs: [deletedSource],
      included_context: [],
      excluded_context: [{
        source_ref: deletedSource,
        requested_use: "surface_projection",
        blocked_by: [gate("lifecycle", "blocked")],
        redaction_ref: "redaction/memory-1",
      }],
      rationale_entries: [{
        source_ref: deletedSource,
        decision: "excluded",
        gate: "lifecycle",
        reason_ref: "rationale/deleted",
        text: "Deleted content copied into rationale.",
      }],
    })).success).toBe(false);
  });

  it("creates inspection views for multiple targets without prompt-dumping memory", () => {
    const parsed = SurfaceProjectionSchema.parse(projection());

    const chatInspection = createSurfaceInspectionView(parsed, "chat");
    const tuiInspection = createSurfaceInspectionView(parsed, "tui");
    const chatPayload = createSurfaceInspectionAdapterPayload(parsed, "chat");
    const tuiPayload = createSurfaceInspectionAdapterPayload(parsed, "tui");

    expect(chatInspection.surface_id).toBe(parsed.id);
    expect(tuiInspection.source_refs).toEqual(chatInspection.source_refs);
    expect(chatPayload.inspection).toEqual(chatInspection);
    expect(tuiPayload.inspection.source_refs).toEqual(chatPayload.inspection.source_refs);
    expect("prompt_dump" in chatPayload).toBe(false);
    expect(chatInspection.included_summaries[0]).toEqual({
      lane: "relationship",
      memory_id: "memory-1",
      record_kind: "preference",
      use_class: "surface_projection",
      summary_ref: "rationale/memory-1/included",
    });
    expect("excerpt" in chatInspection.included_summaries[0]!).toBe(false);
  });

  it("tracks Surface dependency refs for memory-derived runtime objects and fails closed when missing", () => {
    const runtimeRef = createSurfaceDerivedRuntimeRef(derivedRef("runtime_item"));
    let parsed = attachSurfaceDependencyRef(projection(), runtimeRef);
    for (const kind of [
      "agenda_item",
      "outcome_decision",
      "expression_decision",
      "memory_write_candidate",
      "session_resume_attempt",
    ] as const) {
      parsed = attachSurfaceDependencyRef(parsed, derivedRef(kind));
    }

    expect(parsed.dependent_refs.runtime_items[0]?.missing_dependency_behavior).toBe("fail_closed");
    expect(parsed.dependent_refs.session_resume_attempts[0]?.related_surface_refs).toContain("surface-1");

    expect(SurfaceProjectionSchema.safeParse(projection({
      dependent_refs: {
        runtime_items: [derivedRef("runtime_item", { related_surface_refs: ["different-surface"] })],
      },
    })).success).toBe(false);

    const incompleteRef = derivedRef("expression_decision", {
      ref: "expression_decision-missing-deps",
      related_memory_refs: [],
      permission_check_refs: [],
      staleness_check_refs: [],
      audit_refs: [],
    });
    const inspectableIncompleteProjection = attachSurfaceDependencyRef(parsed, incompleteRef);
    const missingDependencyAdmission = evaluateSurfaceRuntimeAdmission({
      projection: inspectableIncompleteProjection,
      derived_ref: incompleteRef,
      operation: "speech",
      authorization_basis: "runtime_authority",
      runtime_authority_ref: "runtime-authority:expression",
    });
    expect(missingDependencyAdmission).toMatchObject({
      status: "blocked",
      reason: "missing_dependency_ref",
      dependent_ref: "expression_decision-missing-deps",
    });
    expect(missingDependencyAdmission.blocked_refs).toEqual(expect.arrayContaining([
      "related_memory_refs",
      "permission_check_refs",
      "staleness_check_refs",
      "audit_refs",
    ]));

    const bogusRef = derivedRef("runtime_item", {
      ref: "runtime_item-bogus-deps",
      related_memory_refs: ["memory-bogus"],
      permission_check_refs: ["permission-bogus"],
      staleness_check_refs: ["staleness-bogus"],
      audit_refs: ["audit-bogus"],
    });
    const inspectableBogusProjection = attachSurfaceDependencyRef(parsed, bogusRef);
    const bogusDependencyAdmission = evaluateSurfaceRuntimeAdmission({
      projection: inspectableBogusProjection,
      derived_ref: bogusRef,
      operation: "action",
      authorization_basis: "runtime_authority",
      runtime_authority_ref: "runtime-authority:action",
    });
    expect(bogusDependencyAdmission).toMatchObject({
      status: "blocked",
      reason: "missing_dependency_ref",
      dependent_ref: "runtime_item-bogus-deps",
    });
    expect(bogusDependencyAdmission.blocked_refs).toEqual(expect.arrayContaining([
      "related_memory_refs:memory-bogus",
      "permission_check_refs:permission-bogus",
      "staleness_check_refs:staleness-bogus",
      "audit_refs:audit-bogus",
    ]));

    const disallowedUseRef = derivedRef("expression_decision", {
      ref: "expression_decision-disallowed-use",
      use_class: "user_facing_reference",
    });
    const disallowedUseProjection = attachSurfaceDependencyRef(parsed, disallowedUseRef);
    const disallowedUseAdmission = evaluateSurfaceRuntimeAdmission({
      projection: disallowedUseProjection,
      derived_ref: disallowedUseRef,
      operation: "speech",
      authorization_basis: "runtime_authority",
      runtime_authority_ref: "runtime-authority:speech",
    });
    expect(disallowedUseAdmission).toMatchObject({
      status: "blocked",
      reason: "allowed_use_missing",
      blocked_refs: ["user_facing_reference"],
    });

    const memoryOnlyAdmission = evaluateSurfaceRuntimeAdmission({
      projection: parsed,
      derived_ref: derivedRef("expression_decision"),
      operation: "speech",
      authorization_basis: "memory_only",
    });
    expect(memoryOnlyAdmission.status).toBe("blocked");
    expect(memoryOnlyAdmission.reason).toBe("memory_is_not_authority");
    expect(memoryOnlyAdmission.blocked_refs).toContain("memory-1");

    for (const operation of ["notification", "action", "session_resume", "surface_update", "memory_write"] as const) {
      const operationRef = derivedRef(
        operation === "session_resume"
          ? "session_resume_attempt"
          : operation === "memory_write"
            ? "memory_write_candidate"
            : "runtime_item",
        { ref: `${operation}-1` }
      );
      const operationProjection = attachSurfaceDependencyRef(parsed, operationRef);
      const admission = evaluateSurfaceRuntimeAdmission({
        projection: operationProjection,
        derived_ref: operationRef,
        operation,
        authorization_basis: "memory_only",
      });
      expect(admission.status, operation).toBe("blocked");
      expect(admission.reason, operation).toBe("memory_is_not_authority");
    }
  });

  it("requires memory source dependency refs to match top-level source refs", () => {
    expect(SurfaceProjectionSchema.safeParse(projection({
      source_refs: [sourceRef({
        dependency_ref: dependencyRef({
          ref: "different-memory",
        }),
      })],
      included_context: [],
      rationale_entries: [],
    })).success).toBe(false);

    expect(SurfaceProjectionSchema.safeParse(projection({
      source_refs: [sourceRef({
        dependency_ref: dependencyRef({
          content_state: "redacted",
        }),
      })],
      included_context: [],
      rationale_entries: [],
    })).success).toBe(false);
  });
});

describe("SurfaceInvalidation contract", () => {
  it("defaults missing and contradictory dependency behavior to fail closed and reruns canonical gates", () => {
    const parsed = SurfaceInvalidationPolicySchema.parse({
      id: "policy-memory-removal",
      surface_ref: "surface-1",
      source_refs: [dependencyRef()],
      triggers: ["memory_deletion", "permission_revocation", "surface_expired"],
      affected_dependency_policies: [
        { dependency_kind: "runtime_item", action: "regate" },
        { dependency_kind: "outcome_decision", action: "expire" },
        { dependency_kind: "expression_decision", action: "withdraw" },
        { dependency_kind: "memory_write_candidate", action: "reject" },
      ],
      audit_policy: {
        audit_ref: "audit/policy-memory-removal",
        redacts_deleted_content: true,
      },
    });

    expect(parsed.missing_dependency_behavior).toBe("fail_closed");
    expect(parsed.contradictory_dependency_behavior).toBe("fail_closed");
    expect(parsed.regeneration_policy.rerun_gates).toEqual([
      "scope",
      "lifecycle",
      "staleness",
      "sensitivity",
      "permission",
      "allowed_use",
      "forbidden_use",
      "projection",
      "audit",
    ]);
  });

  it("requires deletion and redaction policies plus events to carry redaction refs", () => {
    expect(SurfaceInvalidationPolicySchema.safeParse({
      id: "policy-bad-redaction",
      surface_ref: "surface-1",
      source_refs: [dependencyRef()],
      triggers: ["memory_deletion"],
      affected_dependency_policies: [{ dependency_kind: "runtime_item", action: "regate" }],
      audit_policy: {
        audit_ref: "audit/policy-bad-redaction",
        redacts_deleted_content: false,
      },
    }).success).toBe(false);

    const deletedSource = sourceRef({
      lifecycle: "deleted",
      content_state: "redacted",
      dependency_ref: dependencyRef({
        lifecycle: "deleted",
        content_state: "redacted",
      }),
    });

    expect(SurfaceInvalidationEventSchema.safeParse({
      id: "event-1",
      policy_ref: "policy-memory-removal",
      surface_ref: "surface-1",
      trigger: "memory_deletion",
      source_ref: deletedSource,
      affected_dependencies: [derivedRef("outcome_decision")],
      required_rechecks: ["scope", "lifecycle", "permission"],
      action: "redact",
      audit_ref: "audit/event-1",
      occurred_at: now,
    }).success).toBe(false);

    const parsed = SurfaceInvalidationEventSchema.parse({
      id: "event-1",
      policy_ref: "policy-memory-removal",
      surface_ref: "surface-1",
      trigger: "memory_deletion",
      source_ref: deletedSource,
      affected_dependencies: [derivedRef("outcome_decision")],
      required_rechecks: ["scope", "lifecycle", "permission"],
      action: "redact",
      redaction_ref: "redaction/memory-1",
      audit_ref: "audit/event-1",
      occurred_at: now,
    });
    expect(parsed.redaction_ref).toBe("redaction/memory-1");

    expect(SurfaceInvalidationEventSchema.safeParse({
      id: "event-2",
      policy_ref: "policy-memory-removal",
      surface_ref: "surface-1",
      trigger: "permission_revocation",
      source_ref: sourceRef(),
      affected_dependencies: [derivedRef("runtime_item", { related_surface_refs: ["different-surface"] })],
      required_rechecks: ["permission"],
      action: "regate",
      audit_ref: "audit/event-2",
      occurred_at: now,
    }).success).toBe(false);
  });

  it("starts from memory deletion and invalidates Surface history plus dependent runtime admissions", () => {
    const dependency = derivedRef("expression_decision");
    const parsed = SurfaceProjectionSchema.parse(projection({
      dependent_refs: {
        expression_decisions: [dependency],
      },
    }));
    const result = invalidateSurfaceProjectionFromMemoryCorrection({
      projection: parsed,
      correction_event: {
        event_id: "correction-delete-1",
        target_memory_ref: "memory-1",
        action: "delete",
        affected_use_classes: ["surface_projection", "user_facing_reference"],
        invalidation_ref: "surface-invalidation-delete-1",
        audit_ref: "audit/correction-delete-1",
        created_at: now,
      },
      occurred_at: now,
      redaction_ref: "redaction/memory-1/delete",
    });

    expect(result.event.trigger).toBe("memory_deletion");
    expect(result.event.redaction_ref).toBe("redaction/memory-1/delete");
    expect(result.projection.metadata.invalidation_state).toBe("invalid");
    expect(result.projection.included_context).toEqual([]);
    expect(result.projection.excluded_context[0]?.redaction_ref).toBe("redaction/memory-1/delete");
    expect(result.blocked_admissions[0]).toMatchObject({
      status: "blocked",
      reason: "invalid_surface",
      operation: "speech",
    });
    expect(JSON.stringify(result)).not.toContain("The user prefers concise status reports.");
  });

  it("starts from permission revocation and blocks expression or resume through the same Surface runner", () => {
    const expressionRef = derivedRef("expression_decision");
    const resumeRef = derivedRef("session_resume_attempt");
    const parsed = SurfaceProjectionSchema.parse(projection({
      dependent_refs: {
        expression_decisions: [expressionRef],
        session_resume_attempts: [resumeRef],
      },
    }));
    const result = invalidateSurfaceProjectionFromPermissionChange({
      projection: parsed,
      source_ref: sourceRef(),
      occurred_at: now,
      affected_dependencies: [expressionRef, resumeRef],
      audit_ref: "audit/permission-revoked",
    });

    expect(result.event.trigger).toBe("permission_revocation");
    expect(result.projection.metadata.permission_state).toBe("blocked");
    expect(result.projection.included_context).toHaveLength(0);
    expect(result.blocked_admissions.map((admission) => admission.operation)).toEqual([
      "speech",
      "session_resume",
    ]);
    expect(result.blocked_admissions.every((admission) => admission.reason === "invalid_surface")).toBe(true);
    expect(result.inspection.included_summaries).toEqual([]);
    expect(result.inspection.excluded_summaries[0]?.blocked_by).toContain("permission");
  });
});
