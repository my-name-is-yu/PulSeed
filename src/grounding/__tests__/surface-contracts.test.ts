import { describe, expect, it } from "vitest";
import {
  SurfaceInvalidationEventSchema,
  SurfaceInvalidationPolicySchema,
  SurfaceProjectionSchema,
  type SurfaceGateKind,
} from "../surface-contracts.js";

const now = "2026-05-08T00:00:00.000Z";

function ownerRef() {
  return {
    kind: "relationship_profile",
    store_ref: "relationship-profile.json",
    record_ref: "profile-item-1",
  };
}

function dependencyRef(overrides: Record<string, unknown> = {}) {
  return {
    kind: "memory_record",
    ref: "memory-1",
    owner_ref: ownerRef(),
    content_state: "materialized",
    lifecycle: "active",
    ...overrides,
  };
}

function sourceRef(overrides: Record<string, unknown> = {}) {
  return {
    memory_id: "memory-1",
    owner_ref: ownerRef(),
    record_kind: "preference",
    lifecycle: "active",
    sensitivity: "private",
    content_state: "materialized",
    dependency_ref: dependencyRef(),
    ...overrides,
  };
}

function gate(gateName: SurfaceGateKind, status: "passed" | "blocked" | "unknown" = "passed") {
  return {
    gate: gateName,
    status,
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

describe("SurfaceProjection contract", () => {
  it("models selected source refs rather than a whole memory store", () => {
    const parsed = SurfaceProjectionSchema.parse({
      id: "surface-1",
      target: "gateway",
      purpose: "task_execution",
      source_refs: [sourceRef()],
      included_context: [{
        source_ref: sourceRef(),
        use_class: "surface_projection",
        excerpt: "The user prefers concise status reports.",
        gates: passedGates(),
      }],
      metadata: {
        staleness: "fresh",
        sensitivity: "private",
        permission_state: "granted",
        invalidation_state: "valid",
        audit_refs: ["audit/surface-1"],
      },
      created_at: now,
    });

    expect(parsed.store_scope).toBe("selected_refs");
    expect(parsed.source_refs).toHaveLength(1);
    expect("memory_store" in parsed).toBe(false);
  });

  it("requires explicit permission gates for included context", () => {
    const withoutPermissionGate = SurfaceProjectionSchema.safeParse({
      id: "surface-1",
      target: "chat",
      purpose: "general_turn",
      source_refs: [sourceRef()],
      included_context: [{
        source_ref: sourceRef(),
        use_class: "surface_projection",
        excerpt: "The user prefers concise status reports.",
        gates: passedGates().filter((candidate) => candidate.gate !== "permission"),
      }],
      metadata: {
        staleness: "fresh",
        sensitivity: "private",
        permission_state: "granted",
        invalidation_state: "valid",
      },
      created_at: now,
    });

    expect(withoutPermissionGate.success).toBe(false);
  });

  it("requires every canonical gate to pass before context is included", () => {
    const blockedLifecycle = SurfaceProjectionSchema.safeParse({
      id: "surface-blocked-lifecycle",
      target: "chat",
      purpose: "general_turn",
      source_refs: [sourceRef()],
      included_context: [{
        source_ref: sourceRef(),
        use_class: "surface_projection",
        excerpt: "This stale item must not be included.",
        gates: passedGates().map((candidate) =>
          candidate.gate === "lifecycle" ? gate("lifecycle", "blocked") : candidate
        ),
      }],
      metadata: {
        staleness: "fresh",
        sensitivity: "private",
        permission_state: "granted",
        invalidation_state: "valid",
      },
      created_at: now,
    });

    expect(blockedLifecycle.success).toBe(false);
  });

  it("rejects duplicate gates and non-active source refs for included context", () => {
    const duplicatePermission = SurfaceProjectionSchema.safeParse({
      id: "surface-duplicate-gate",
      target: "chat",
      purpose: "general_turn",
      source_refs: [sourceRef()],
      included_context: [{
        source_ref: sourceRef(),
        use_class: "surface_projection",
        excerpt: "Duplicate gates must not hide blocked decisions.",
        gates: [...passedGates(), gate("permission", "blocked")],
      }],
      metadata: {
        staleness: "fresh",
        sensitivity: "private",
        permission_state: "granted",
        invalidation_state: "valid",
      },
      created_at: now,
    });
    expect(duplicatePermission.success).toBe(false);

    const supersededSource = sourceRef({ lifecycle: "superseded" });
    const nonActiveIncluded = SurfaceProjectionSchema.safeParse({
      id: "surface-superseded-included",
      target: "chat",
      purpose: "general_turn",
      source_refs: [supersededSource],
      included_context: [{
        source_ref: supersededSource,
        use_class: "surface_projection",
        excerpt: "Superseded memory must not be included.",
        gates: passedGates(),
      }],
      metadata: {
        staleness: "fresh",
        sensitivity: "private",
        permission_state: "granted",
        invalidation_state: "valid",
      },
      created_at: now,
    });
    expect(nonActiveIncluded.success).toBe(false);
  });

  it("requires included and excluded context source refs to come from selected refs", () => {
    const selected = sourceRef({ memory_id: "memory-selected" });
    const unselected = sourceRef({
      memory_id: "memory-unselected",
      dependency_ref: dependencyRef({ ref: "memory-unselected" }),
    });

    const parsed = SurfaceProjectionSchema.safeParse({
      id: "surface-unselected",
      target: "gateway",
      purpose: "task_execution",
      source_refs: [selected],
      included_context: [{
        source_ref: unselected,
        use_class: "surface_projection",
        excerpt: "Unselected memory must not appear in context.",
        gates: passedGates(),
      }],
      metadata: {
        staleness: "fresh",
        sensitivity: "private",
        permission_state: "granted",
        invalidation_state: "valid",
      },
      created_at: now,
    });

    expect(parsed.success).toBe(false);

    const materiallyChanged = SurfaceProjectionSchema.safeParse({
      id: "surface-materially-changed-ref",
      target: "gateway",
      purpose: "task_execution",
      source_refs: [selected],
      included_context: [{
        source_ref: {
          ...selected,
          sensitivity: "sensitive",
        },
        use_class: "surface_projection",
        excerpt: "Selected refs must match the full source ref.",
        gates: passedGates(),
      }],
      metadata: {
        staleness: "fresh",
        sensitivity: "private",
        permission_state: "granted",
        invalidation_state: "valid",
      },
      created_at: now,
    });
    expect(materiallyChanged.success).toBe(false);
  });

  it("rejects non-canonical gate order at the contract boundary", () => {
    const reordered = SurfaceProjectionSchema.safeParse({
      id: "surface-reordered",
      target: "gateway",
      purpose: "task_execution",
      source_refs: [sourceRef()],
      gate_order: ["permission", "scope", "lifecycle", "staleness", "sensitivity", "allowed_use", "forbidden_use", "projection", "audit"],
      metadata: {
        staleness: "fresh",
        sensitivity: "private",
        permission_state: "unknown",
        invalidation_state: "valid",
      },
      created_at: now,
    });

    expect(reordered.success).toBe(false);
  });

  it("represents deleted and tombstoned content as redacted excluded refs", () => {
    const deletedSource = sourceRef({
      lifecycle: "deleted",
      content_state: "redacted",
      dependency_ref: dependencyRef({
        content_state: "redacted",
        lifecycle: "deleted",
      }),
    });

    const parsed = SurfaceProjectionSchema.parse({
      id: "surface-redacted",
      target: "daemon",
      purpose: "resident_behavior",
      source_refs: [deletedSource],
      excluded_context: [{
        source_ref: deletedSource,
        blocked_by: [gate("lifecycle", "blocked")],
        redaction_ref: "redaction/memory-1",
      }],
      metadata: {
        staleness: "unknown",
        sensitivity: "sensitive",
        permission_state: "blocked",
        invalidation_state: "invalid",
      },
      created_at: now,
    });

    expect(parsed.excluded_context[0]?.redaction_ref).toBe("redaction/memory-1");

    const reconstructableDeletedSource = SurfaceProjectionSchema.safeParse({
      id: "surface-bad",
      target: "daemon",
      purpose: "resident_behavior",
      source_refs: [sourceRef({ lifecycle: "deleted", content_state: "materialized" })],
      metadata: {
        staleness: "unknown",
        sensitivity: "sensitive",
        permission_state: "blocked",
        invalidation_state: "invalid",
      },
      created_at: now,
    });
    expect(reconstructableDeletedSource.success).toBe(false);
  });

  it("requires memory source dependency refs to match the top-level source ref", () => {
    expect(SurfaceProjectionSchema.safeParse({
      id: "surface-mismatched-dependency",
      target: "gateway",
      purpose: "task_execution",
      source_refs: [sourceRef({
        dependency_ref: dependencyRef({
          ref: "different-memory",
        }),
      })],
      metadata: {
        staleness: "fresh",
        sensitivity: "private",
        permission_state: "unknown",
        invalidation_state: "valid",
      },
      created_at: now,
    }).success).toBe(false);

    expect(SurfaceProjectionSchema.safeParse({
      id: "surface-mismatched-dependency-state",
      target: "gateway",
      purpose: "task_execution",
      source_refs: [sourceRef({
        dependency_ref: dependencyRef({
          content_state: "redacted",
        }),
      })],
      metadata: {
        staleness: "fresh",
        sensitivity: "private",
        permission_state: "unknown",
        invalidation_state: "valid",
      },
      created_at: now,
    }).success).toBe(false);

    expect(SurfaceProjectionSchema.safeParse({
      id: "surface-missing-dependency-owner-lifecycle",
      target: "gateway",
      purpose: "task_execution",
      source_refs: [sourceRef({
        dependency_ref: {
          kind: "memory_record",
          ref: "memory-1",
          content_state: "materialized",
        },
      })],
      metadata: {
        staleness: "fresh",
        sensitivity: "private",
        permission_state: "unknown",
        invalidation_state: "valid",
      },
      created_at: now,
    }).success).toBe(false);
  });
});

describe("SurfaceInvalidation contract", () => {
  it("defaults missing and contradictory dependency behavior to fail closed", () => {
    const parsed = SurfaceInvalidationPolicySchema.parse({
      id: "policy-memory-removal",
      triggers: ["memory_deletion", "permission_revocation"],
      dependency_kinds: ["runtime_item", "outcome_decision", "expression_decision", "session_resume_attempt"],
      default_action: "regate",
      redacts_deleted_content: true,
    });

    expect(parsed.missing_dependency_behavior).toBe("fail_closed");
    expect(parsed.contradictory_dependency_behavior).toBe("fail_closed");
  });

  it("requires deletion and redaction policies to redact deleted content", () => {
    const parsed = SurfaceInvalidationPolicySchema.safeParse({
      id: "policy-bad-redaction",
      triggers: ["memory_deletion"],
      dependency_kinds: ["runtime_item"],
      default_action: "regate",
      redacts_deleted_content: false,
    });

    expect(parsed.success).toBe(false);
  });

  it("requires redaction refs for content-removal invalidation events", () => {
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
      trigger: "memory_deletion",
      source_ref: deletedSource,
      affected_dependencies: [dependencyRef({ kind: "outcome_decision", ref: "outcome-1" })],
      action: "redact",
      occurred_at: now,
    }).success).toBe(false);

    const parsed = SurfaceInvalidationEventSchema.parse({
      id: "event-1",
      policy_ref: "policy-memory-removal",
      trigger: "memory_deletion",
      source_ref: deletedSource,
      affected_dependencies: [dependencyRef({ kind: "outcome_decision", ref: "outcome-1" })],
      action: "redact",
      redaction_ref: "redaction/memory-1",
      occurred_at: now,
    });
    expect(parsed.redaction_ref).toBe("redaction/memory-1");
  });
});
