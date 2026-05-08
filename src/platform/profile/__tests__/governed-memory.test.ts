import { describe, expect, it } from "vitest";
import {
  GovernedMemoryCorrectionEventSchema,
  GovernedMemoryRecordKindSchema,
  GovernedMemoryRoleSchema,
  GovernedMemorySchema,
  GovernedMemoryUseAuditSchema,
  evaluateGovernedMemoryUse,
  requiredGovernedMemoryDomainFields,
  type GovernedMemoryRecordKind,
} from "../governed-memory.js";

const now = "2026-05-08T00:00:00.000Z";

function ownerRef(kind = "relationship_profile") {
  return {
    kind,
    store_ref: `${kind}:store`,
    record_ref: `${kind}:record-1`,
  };
}

function sourceRef(kind = "user_instruction") {
  return {
    kind,
    ref: `${kind}:source-1`,
    reliability: 0.9,
  };
}

function domainFields(kind: GovernedMemoryRecordKind): Record<string, unknown> {
  switch (kind) {
    case "stable_profile_fact":
      return {
        subject: "status reports",
        statement: "The user prefers concise progress updates.",
        provenance: "explicit instruction",
        confidence: 0.9,
        scope: "operator collaboration",
        validity: "until corrected",
        correction_state: "current",
      };
    case "preference":
      return {
        target: "status reports",
        preference: "concise",
        confidence: 0.9,
        scope: "operator collaboration",
        allowed_uses: ["runtime_grounding"],
        review_condition: "when corrected",
      };
    case "routine":
      return {
        trigger_or_cadence: "after PR publication",
        scope: "repo work",
        permission: "ask before scheduling",
        staleness_rule: "review each run",
        interruption_policy: "do not interrupt",
      };
    case "boundary":
      return {
        prohibited_use: "do not use private context for resident behavior",
        scope: "resident_behavior",
        authority_source: "explicit user boundary",
        override_rule: "requires explicit re-grant",
      };
    case "intervention_policy":
      return {
        allowed_routes: ["ask_for_confirmation"],
        forbidden_routes: ["proactive_trigger"],
        confirmation_requirement: "before_action",
        review_rule: "when scope changes",
      };
    case "episodic_event":
      return {
        event_time: now,
        source: "runtime session",
        subject: "issue triage",
        sensitivity: "private",
        allowed_future_uses: ["audit_only"],
      };
    case "promise":
      return {
        promisor: "PulSeed",
        statement: "Follow up on a release check.",
        scope: "repo work",
        fulfillment_condition: "release check completed",
        review_condition: "after next release",
      };
    case "correction":
      return {
        corrected_target: "memory-1",
        replacement_or_retraction: "retract",
        affected_uses: ["surface_projection"],
        invalidation_rule: "regate dependent Surface",
      };
    case "relationship_posture":
      return {
        context: "repo collaboration",
        permitted_posture: "direct",
        forbidden_posture: "overfamiliar",
        evidence: "user preference",
        confidence: 0.8,
        review_condition: "when corrected",
      };
    case "consent_scope":
      return {
        scope: "quiet monitoring",
        allowed_uses: ["attention_prioritization"],
        forbidden_uses: ["stale_session_authorization"],
        authority_source: "explicit consent",
        revocation_rule: "immediate",
      };
    case "work_commitment":
      return {
        statement: "Prepare a PR.",
        linked_refs: ["issue-1274"],
        authority: "current session",
        fulfillment_condition: "PR opened",
      };
    case "project_fact":
      return {
        project_scope: "PulSeed",
        statement: "Companion autonomy uses governed memory.",
        source: "design doc",
        confidence: 0.95,
        validity: "current design",
        supersession_rule: "replace on newer design",
      };
    case "knowledge_fact":
      return {
        domain: "PulSeed design",
        statement: "Surface is not permission.",
        source_reliability: 0.95,
        confidence: 0.95,
        validity: "current design",
        correction_rule: "invalidate Surface",
      };
    case "open_tension":
      return {
        statement: "PulSeed should feel alive without reducing user agency.",
        uncertainty_status: "open",
        allowed_reasoning_uses: ["design_grounding", "behavioral_inhibition"],
        forbidden_inference_uses: ["user_personality_labeling"],
      };
    case "anti_memory_rule":
      return {
        blocked_content_or_use: "do not infer personality labels from terse corrections",
        scope: "relationship",
        owner: "relationship_profile",
        enforcement_route: "Surface exclusion",
        review_condition: "when corrected",
      };
    case "seed_candidate":
      return {
        proposed_role: "relationship",
        proposed_record_kind: "preference",
        source_evidence: ["dream-ref-1"],
        confidence: 0.3,
        allowed_maturation_path: "profile proposal acceptance",
        rejection_rule: "discard if not confirmed",
      };
  }
}

function redactedDomainFields(reason: "sensitive" | "tombstoned" | "deleted" | "permission_revoked" | "scope_excluded" = "deleted") {
  return {
    redaction_ref: `redaction/${reason}/memory-1`,
    reason,
  };
}

function makeMemory(overrides: Record<string, unknown> = {}) {
  return {
    memory_id: "memory-1",
    logical_key: "preference:status-reports",
    version: 1,
    owning_store_ref: ownerRef(),
    role: "relationship",
    record_kind: "preference",
    statement: "The user prefers concise status reports.",
    scope: "operator collaboration",
    subject_refs: ["user"],
    domain_fields: domainFields("preference"),
    source_refs: [sourceRef()],
    content: {
      state: "materialized",
      text: "The user prefers concise status reports.",
    },
    epistemic_status: "explicit_user_instruction",
    confidence: 0.9,
    source_reliability: 0.9,
    sensitivity: "private",
    allowed_uses: ["surface_projection", "runtime_grounding"],
    not_allowed_uses: ["side_effect_authorization"],
    lifecycle: "active",
    correction_state: "current",
    projection_policy: {
      surface_eligible: true,
      requires_permission_gate: true,
      inspection_visibility: "visible",
      stale_behavior: "exclude",
    },
    audit_refs: ["audit/memory-1"],
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("GovernedMemory contract", () => {
  it("keeps MemoryRole separate from RecordKind and rejects collapsed vocabulary", () => {
    expect(GovernedMemoryRoleSchema.options).toEqual([
      "knowledge",
      "work_memory",
      "relationship",
      "seed",
      "boundary",
      "promise",
      "anti_memory",
      "tension",
    ]);
    expect(GovernedMemoryRecordKindSchema.options).toContain("stable_profile_fact");
    expect(GovernedMemoryRecordKindSchema.options).toContain("seed_candidate");

    const relationshipPreference = GovernedMemorySchema.parse(makeMemory({
      memory_id: "memory-pref",
      logical_key: "source-1:relationship-preference",
      role: "relationship",
      record_kind: "preference",
      domain_fields: domainFields("preference"),
    }));
    const boundaryFromSameSource = GovernedMemorySchema.parse(makeMemory({
      memory_id: "memory-boundary",
      logical_key: "source-1:boundary",
      role: "boundary",
      record_kind: "boundary",
      domain_fields: domainFields("boundary"),
      statement: "Do not use private context for resident behavior.",
      content: {
        state: "materialized",
        text: "Do not use private context for resident behavior.",
      },
    }));

    expect(relationshipPreference.source_refs[0]?.ref).toBe(boundaryFromSameSource.source_refs[0]?.ref);
    expect(relationshipPreference.role).not.toBe(boundaryFromSameSource.role);
    expect(relationshipPreference.record_kind).not.toBe(boundaryFromSameSource.record_kind);
    expect(GovernedMemorySchema.safeParse(makeMemory({ role: "preference" })).success).toBe(false);
  });

  it("validates record-kind-specific domain fields, especially high-risk kinds", () => {
    const highRiskKinds: GovernedMemoryRecordKind[] = [
      "boundary",
      "intervention_policy",
      "correction",
      "anti_memory_rule",
      "seed_candidate",
    ];

    for (const kind of highRiskKinds) {
      expect(requiredGovernedMemoryDomainFields(kind).length, kind).toBeGreaterThan(0);
      expect(GovernedMemorySchema.safeParse(makeMemory({
        role: kind === "seed_candidate" ? "seed" : "relationship",
        record_kind: kind,
        lifecycle: kind === "seed_candidate" ? "planted" : "active",
        domain_fields: domainFields(kind),
        allowed_uses: kind === "seed_candidate" ? ["never_use_directly"] : ["surface_projection"],
        projection_policy: {
          surface_eligible: kind !== "seed_candidate",
          requires_permission_gate: true,
        },
        owning_store_ref: kind === "seed_candidate" ? ownerRef("dream_seed") : ownerRef(),
      })).success, kind).toBe(true);

      expect(GovernedMemorySchema.safeParse(makeMemory({
        role: kind === "seed_candidate" ? "seed" : "relationship",
        record_kind: kind,
        domain_fields: { statement: "generic prose is not a contract" },
      })).success, kind).toBe(false);
    }
  });

  it("requires explicit owning_store_ref and preserves profile proposal runtime and Soil ownership bridges", () => {
    expect(GovernedMemorySchema.parse(makeMemory()).owning_store_ref.kind).toBe("relationship_profile");

    const withoutOwner = { ...makeMemory() };
    delete (withoutOwner as { owning_store_ref?: unknown }).owning_store_ref;
    expect(GovernedMemorySchema.safeParse(withoutOwner).success).toBe(false);

    const proposalSeed = GovernedMemorySchema.parse(makeMemory({
      memory_id: "seed-1",
      logical_key: "seed:preference",
      owning_store_ref: ownerRef("profile_proposal"),
      role: "seed",
      record_kind: "seed_candidate",
      lifecycle: "planted",
      statement: "The user may prefer quiet release checks.",
      domain_fields: domainFields("seed_candidate"),
      allowed_uses: ["never_use_directly"],
      projection_policy: {
        surface_eligible: false,
        requires_permission_gate: true,
      },
    }));
    expect(proposalSeed.owning_store_ref.kind).toBe("profile_proposal");

    const runtimeEvidence = GovernedMemorySchema.parse(makeMemory({
      memory_id: "runtime-event-1",
      logical_key: "runtime:episodic-event",
      owning_store_ref: ownerRef("runtime_session"),
      role: "work_memory",
      record_kind: "episodic_event",
      domain_fields: domainFields("episodic_event"),
      statement: "A session observed issue triage.",
      allowed_uses: ["runtime_grounding", "memory_write_candidate"],
      lifecycle: "active",
      projection_policy: {
        surface_eligible: false,
        requires_permission_gate: true,
      },
    }));
    expect(runtimeEvidence.owning_store_ref.kind).toBe("runtime_session");

    const soilKnowledge = GovernedMemorySchema.parse(makeMemory({
      memory_id: "soil-knowledge-1",
      logical_key: "soil:knowledge",
      owning_store_ref: ownerRef("soil"),
      role: "knowledge",
      record_kind: "knowledge_fact",
      domain_fields: domainFields("knowledge_fact"),
      statement: "Surface is not permission.",
      source_refs: [sourceRef("soil_record")],
      allowed_uses: ["design_grounding", "surface_projection"],
      lifecycle: "matured",
    }));
    expect(soilKnowledge.owning_store_ref.kind).toBe("soil");

    expect(GovernedMemorySchema.safeParse(makeMemory({
      owning_store_ref: ownerRef("dream_seed"),
      role: "relationship",
      record_kind: "preference",
      domain_fields: domainFields("preference"),
      allowed_uses: ["surface_projection"],
      projection_policy: { surface_eligible: true },
    })).success).toBe(false);
  });

  it("preserves uncertainty without turning design or relationship tensions into stable profile facts", () => {
    const designTension = GovernedMemorySchema.parse(makeMemory({
      memory_id: "tension-1",
      logical_key: "tension:alive-with-agency",
      role: "tension",
      record_kind: "open_tension",
      statement: "PulSeed should feel alive without reducing user agency.",
      domain_fields: domainFields("open_tension"),
      epistemic_status: "design_tension",
      allowed_uses: ["design_grounding", "behavioral_inhibition"],
      not_allowed_uses: ["user_personality_labeling", "user_facing_reference"],
      lifecycle: "active",
      projection_policy: {
        surface_eligible: false,
        requires_permission_gate: true,
      },
    }));
    expect(designTension.not_allowed_uses).toContain("user_personality_labeling");

    expect(GovernedMemorySchema.safeParse(makeMemory({
      role: "relationship",
      record_kind: "stable_profile_fact",
      domain_fields: domainFields("stable_profile_fact"),
      epistemic_status: "relationship_tension",
      confidence: 0.4,
    })).success).toBe(false);
  });

  it("treats forbidden uses as hard blockers even when broad grounding uses are allowed", () => {
    const parsed = GovernedMemorySchema.parse(makeMemory({
      allowed_uses: ["design_grounding", "behavioral_inhibition", "surface_projection"],
      not_allowed_uses: [
        "user_facing_reference",
        "proactive_trigger",
        "side_effect_authorization",
        "stale_session_authorization",
      ],
    }));

    expect(parsed.allowed_uses).toContain("design_grounding");
    expect(parsed.not_allowed_uses).toContain("side_effect_authorization");
    expect(parsed.not_allowed_uses).toContain("stale_session_authorization");

    expect(GovernedMemorySchema.safeParse(makeMemory({
      allowed_uses: ["surface_projection", "design_grounding"],
      not_allowed_uses: ["surface_projection"],
    })).success).toBe(false);
  });

  it("excludes retired suppressed superseded retracted tombstoned deleted and archived records from normal Surface projection", () => {
    for (const lifecycle of ["retired", "suppressed", "superseded", "retracted", "tombstoned", "deleted", "archived"] as const) {
      expect(GovernedMemorySchema.safeParse(makeMemory({
        lifecycle,
        content: lifecycle === "tombstoned" || lifecycle === "deleted"
          ? { state: "redacted", redaction_ref: `redaction/${lifecycle}`, reason: lifecycle }
          : { state: "materialized", text: "Historical content." },
        statement: lifecycle === "tombstoned" || lifecycle === "deleted" ? undefined : "Historical content.",
        allowed_uses: ["surface_projection"],
        projection_policy: {
          surface_eligible: true,
          requires_permission_gate: true,
        },
      })).success, lifecycle).toBe(false);
    }

    expect(GovernedMemorySchema.safeParse(makeMemory({
      lifecycle: "active",
      correction_state: "superseded",
      superseded_by_memory_id: "memory-2",
      allowed_uses: ["surface_projection"],
      projection_policy: {
        surface_eligible: true,
        requires_permission_gate: true,
      },
    })).success).toBe(false);

    expect(GovernedMemorySchema.safeParse(makeMemory({
      lifecycle: "active",
      correction_state: "deleted",
      content: {
        state: "materialized",
        text: "Deleted-by-correction content must not remain readable.",
      },
      allowed_uses: ["never_use_directly"],
      projection_policy: {
        surface_eligible: false,
        requires_permission_gate: true,
      },
    })).success).toBe(false);

    expect(GovernedMemorySchema.safeParse(makeMemory({
      lifecycle: "deleted",
      statement: undefined,
      content: {
        state: "redacted",
        redaction_ref: "redaction/memory-1",
        reason: "deleted",
      },
      allowed_uses: ["never_use_directly"],
      projection_policy: {
        surface_eligible: false,
        requires_permission_gate: true,
      },
    })).success).toBe(false);

    const auditOnlyDeleted = GovernedMemorySchema.parse(makeMemory({
      lifecycle: "deleted",
      statement: undefined,
      domain_fields: redactedDomainFields("deleted"),
      content: {
        state: "redacted",
        redaction_ref: "redaction/memory-1",
        reason: "deleted",
      },
      allowed_uses: ["never_use_directly"],
      projection_policy: {
        surface_eligible: false,
        requires_permission_gate: true,
        inspection_visibility: "redacted",
      },
    }));
    expect(auditOnlyDeleted.content.state).toBe("redacted");
  });

  it("emits typed correction events that can drive Surface invalidation and audit", () => {
    expect(GovernedMemoryCorrectionEventSchema.safeParse({
      event_id: "correction-1",
      target_memory_ref: "memory-1",
      action: "supersede",
      affected_use_classes: ["surface_projection"],
      audit_ref: "audit/correction-1",
      created_at: now,
    }).success).toBe(false);

    const parsed = GovernedMemoryCorrectionEventSchema.parse({
      event_id: "correction-1",
      target_memory_ref: "memory-1",
      action: "supersede",
      replacement_memory_ref: "memory-2",
      affected_use_classes: ["surface_projection", "user_facing_reference"],
      invalidation_ref: "surface-invalidation-1",
      audit_ref: "audit/correction-1",
      created_at: now,
    });

    expect(parsed.invalidation_ref).toBe("surface-invalidation-1");
  });

  it("audits consideration inclusion exclusion and non-use without exposing removed content", () => {
    const audit = GovernedMemoryUseAuditSchema.parse({
      audit_id: "audit-memory-1",
      memory_ref: "memory-1",
      lifecycle: "active",
      content_state: "materialized",
      requested_use: "behavioral_inhibition",
      outcome: "included",
      influenced: ["notice", "inhibition"],
      gate_ref: "gate/surface-1",
      repair_paths: ["correct", "suppress", "revoke", "forget"],
      created_at: now,
    });
    expect(audit.influenced).toContain("inhibition");

    expect(GovernedMemoryUseAuditSchema.safeParse({
      audit_id: "audit-deleted",
      memory_ref: "memory-deleted",
      lifecycle: "deleted",
      content_state: "redacted",
      requested_use: "surface_projection",
      outcome: "non_use",
      repair_paths: ["forget"],
      created_at: now,
    }).success).toBe(false);
  });

  it("evaluates memory-use decisions with typed audits instead of letting memory authorize runtime effects", () => {
    const blockedSpeech = evaluateGovernedMemoryUse({
      memory: makeMemory({
        allowed_uses: ["design_grounding", "behavioral_inhibition"],
        not_allowed_uses: ["user_facing_reference", "proactive_trigger"],
      }),
      requested_use: "user_facing_reference",
      audit_id: "audit-memory-speech-blocked",
      created_at: now,
      influenced: ["expression"],
      gate_ref: "gate/surface/user-facing",
    });
    expect(blockedSpeech.status).toBe("blocked");
    expect(blockedSpeech.blocked_by).toContain("allowed_use");
    expect(blockedSpeech.blocked_by).toContain("forbidden_use");
    expect(blockedSpeech.audit.outcome).toBe("blocked");
    expect(blockedSpeech.audit.repair_paths).toEqual(expect.arrayContaining(["suppress", "revoke"]));

    const deletedNonUse = evaluateGovernedMemoryUse({
      memory: makeMemory({
        lifecycle: "deleted",
        statement: undefined,
        domain_fields: redactedDomainFields("deleted"),
        content: {
          state: "redacted",
          redaction_ref: "redaction/memory-1",
          reason: "deleted",
        },
        allowed_uses: ["never_use_directly"],
        projection_policy: {
          surface_eligible: false,
          requires_permission_gate: true,
          inspection_visibility: "redacted",
        },
      }),
      requested_use: "side_effect_authorization",
      audit_id: "audit-memory-deleted-non-use",
      created_at: now,
      influenced: ["action"],
    });
    expect(deletedNonUse.status).toBe("blocked");
    expect(deletedNonUse.audit.outcome).toBe("non_use");
    expect(deletedNonUse.audit.redaction_ref).toBe("redaction/memory-1");
    expect(JSON.stringify(deletedNonUse)).not.toContain("The user prefers concise status reports.");
  });
});
