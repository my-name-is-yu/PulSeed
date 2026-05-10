import { describe, expect, it } from "vitest";
import type { CapabilityReadinessSnapshot } from "../../../platform/observation/types/capability.js";
import { evaluateAdmissionPolicy } from "../admission-policy.js";
import { MAX_AUTONOMY_TTL_MS } from "../autonomy-ttl.js";
import {
  evaluateAutonomyDecision,
  type AutonomyDecisionInput,
  type AutonomyOperationPlanInput,
} from "../autonomy-governor.js";
import {
  classifyInternalAutonomyDefault,
  type InternalAutonomyDefault,
  type InternalAutonomyDefaultClassificationInput,
} from "../internal-autonomy-default.js";

const NOW = "2026-05-09T00:00:00.000Z";

function actor() {
  return {
    surface: "chat" as const,
    platform: "slack",
    conversation_id: "conversation:inbound",
    identity_key: "user:yu",
    user_id: "user:yu",
  };
}

function notificationOperation(overrides: Partial<AutonomyOperationPlanInput> = {}): AutonomyOperationPlanInput {
  return {
    operation_id: "notify.send",
    capability_id: "capability:notify",
    operation_kind: "send",
    provider_ref: "asset:notifier/slack",
    payload_class: "notification_payload",
    side_effect_profile: "send",
    risk_class: "medium",
    privacy_profile: "user_visible",
    reversibility: "unknown",
    external_action_authority: true,
    target_refs: ["conversation:outbound"],
    ...overrides,
  };
}

function internalOperation(overrides: Partial<AutonomyOperationPlanInput> = {}): AutonomyOperationPlanInput {
  return {
    operation_id: "knowledge.quarantine.append",
    capability_id: "capability:knowledge",
    operation_kind: "write",
    provider_ref: "runtime:knowledge",
    payload_class: "internal_learning_record",
    side_effect_profile: "write",
    risk_class: "low",
    privacy_profile: "local_private",
    reversibility: "append_only",
    external_action_authority: false,
    target_refs: ["runtime:knowledge:quarantine"],
    local_only: true,
    inspectable: true,
    ...overrides,
  };
}

function readiness(
  operation: AutonomyOperationPlanInput,
  overrides: Partial<CapabilityReadinessSnapshot> = {}
): CapabilityReadinessSnapshot {
  const state = overrides.state ?? "executable_verified";
  return {
    schema_version: "capability-readiness-snapshot/v1",
    snapshot_id: `readiness:${operation.operation_id}`,
    capability_id: operation.capability_id ?? `capability:${operation.operation_id}`,
    provider_ref: operation.provider_ref,
    asset_ref: operation.provider_ref,
    operation_id: operation.operation_id,
    operation_kind: operation.operation_kind,
    tool_name: operation.operation_id,
    payload_class: operation.payload_class,
    risk_class: operation.risk_class ?? "medium",
    side_effect_profile: operation.side_effect_profile,
    evaluated_at: NOW,
    state,
    passed_gates: state === "executable_verified"
      ? ["stored", "discoverable", "loadable", "compatible", "configured", "authenticated", "executable_verified"]
      : [],
    failed_gates: state === "blocked" ? ["blocked"] : [],
    degraded_gates: state === "degraded" ? ["degraded"] : [],
    missing_config_refs: [],
    missing_auth_refs: [],
    verification_refs: [`verify:${operation.operation_id}`],
    evidence_refs: [`audit:${operation.operation_id}`],
    stale_refs: [],
    safe_user_visible_label: state === "blocked"
      ? "Blocked"
      : state === "degraded"
        ? "Degraded"
        : "Execution substrate verified",
    metadata: {},
    ...overrides,
  };
}

function allowedAdmission(operation: AutonomyOperationPlanInput, options: { bindAuth?: boolean } = {}) {
  return evaluateAdmissionPolicy({
    operation: {
      operation_id: operation.operation_id,
      capability_id: operation.capability_id,
      operation_kind: operation.operation_kind,
      provider_ref: operation.provider_ref,
      payload_class: operation.payload_class,
      side_effect_profile: operation.side_effect_profile,
      external_action_authority: operation.external_action_authority,
      required_permission_capabilities: [],
      target_refs: operation.target_refs,
    },
    actor: actor(),
    surface: {
      surface_ref: "surface:chat:slack",
      channel: "chat",
      platform: "slack",
      session_ref: "session:chat",
    },
    notificationPolicy: operation.operation_kind === "send" || operation.external_action_authority
      ? [{
          ref: "notification:allowed",
          result: "allowed",
          reason: "Notification policy allowed this operation after admission.",
        }]
      : [],
    ...(options.bindAuth === false
      ? {}
      : {
          authState: {
            ref: "auth:current",
            status: "valid" as const,
          },
        }),
    evaluatedAt: NOW,
  });
}

function approvalRequiredAdmission(operation: AutonomyOperationPlanInput, options: { bindAuth?: boolean } = {}) {
  return evaluateAdmissionPolicy({
    operation: {
      operation_id: operation.operation_id,
      capability_id: operation.capability_id,
      operation_kind: operation.operation_kind,
      provider_ref: operation.provider_ref,
      payload_class: operation.payload_class,
      side_effect_profile: operation.side_effect_profile,
      external_action_authority: operation.external_action_authority,
      required_permission_capabilities: ["notify_user"],
      target_refs: operation.target_refs,
    },
    actor: actor(),
    surface: {
      surface_ref: "surface:chat:slack",
      channel: "chat",
      platform: "slack",
      session_ref: "session:chat",
    },
    notificationPolicy: [{
      ref: "notification:allowed",
      result: "allowed",
      reason: "Notification policy allowed this operation after admission.",
    }],
    ...(options.bindAuth === false
      ? {}
      : {
          authState: {
            ref: "auth:current",
            status: "valid" as const,
          },
        }),
    evaluatedAt: NOW,
  });
}

function baseInput(operation: AutonomyOperationPlanInput): AutonomyDecisionInput {
  return {
    operation_plan: operation,
    readiness_snapshots: [readiness(operation)],
    admission_evaluation: allowedAdmission(operation),
    auth_state: {
      ref: "auth:current",
      status: "valid",
    },
    active_surface_ref: "surface:chat:slack",
    blast_radius: "local",
    privacy_sensitivity: "low",
    external_side_effect: false,
    evaluated_at: NOW,
  };
}

function internalDefault(
  operation: AutonomyOperationPlanInput,
  overrides: Partial<InternalAutonomyDefaultClassificationInput> = {}
): InternalAutonomyDefault {
  return classifyInternalAutonomyDefault({
    capability_family: "knowledge",
    operation_class: "knowledge_quarantine",
    operation_id: operation.operation_id,
    capability_id: operation.capability_id,
    operation_kind: operation.operation_kind,
    provider_ref: operation.provider_ref,
    payload_class: operation.payload_class,
    side_effect_profile: operation.side_effect_profile,
    risk_class: operation.risk_class ?? "medium",
    privacy_profile: operation.privacy_profile,
    reversibility: operation.reversibility ?? "unknown",
    external_action_authority: operation.external_action_authority ?? false,
    target_refs: operation.target_refs ?? [],
    target_class: "internal_quarantine",
    mutation_kind: "append",
    locality: operation.local_only === true ? "local_only" : "not_local",
    inspectable: operation.inspectable === true,
    expected_user_visible_effect: operation.expected_user_visible_effect === true,
    scope: "workspace",
    evaluated_at: NOW,
    ref: "internal-default:knowledge-quarantine",
    ...overrides,
  });
}

describe("AutonomyGovernor", () => {
  it("bounds autonomy ttl inputs before computing expiry timestamps", () => {
    const operation = internalOperation();
    const maxTtlExpiresAt = "2026-05-10T00:00:00.000Z";
    const internalDefaultAtMaxTtl = internalDefault(operation, { ttl_ms: MAX_AUTONOMY_TTL_MS });
    expect(internalDefaultAtMaxTtl.expires_at).toBe(maxTtlExpiresAt);

    const decisionAtMaxTtl = evaluateAutonomyDecision({
      ...baseInput(operation),
      internal_autonomy_default: internalDefault(operation),
      ttl_ms: MAX_AUTONOMY_TTL_MS,
    });
    expect(decisionAtMaxTtl.expires_at).toBe(maxTtlExpiresAt);

    const invalidTtls = [
      0,
      1.5,
      MAX_AUTONOMY_TTL_MS + 1,
      Number.MAX_SAFE_INTEGER + 1,
      Number.POSITIVE_INFINITY,
    ];
    for (const ttl_ms of invalidTtls) {
      expect(() => internalDefault(operation, { ttl_ms })).toThrow();
      expect(() => evaluateAutonomyDecision({
        ...baseInput(operation),
        ttl_ms,
      })).toThrow();
    }
  });

  it("requires approval for autonomous external notification even with executable readiness and positive feedback", () => {
    const operation = notificationOperation();
    const decision = evaluateAutonomyDecision({
      ...baseInput(operation),
      blast_radius: "external",
      privacy_sensitivity: "medium",
      external_side_effect: true,
      trust_profile: {
        ref: "trust:slack-high",
        provider_ref: "asset:notifier/slack",
        trust_level: "high",
        positive_feedback_refs: ["feedback:accepted"],
      },
      recent_feedback: [{
        ref: "feedback:accepted",
        outcome: "accepted",
        follow_through_success: true,
      }],
    });

    expect(decision.level).toBe("approval_required");
    expect(decision.required_user_approval).toBe(true);
    expect(decision.allowed_steps).toEqual(["prepare", "request_user_approval"]);
    expect(decision.blocked_steps).toEqual(expect.arrayContaining(["autonomous_initiate", "execute_without_approval"]));
    expect(decision.audit_refs).toContain("feedback:accepted");
  });

  it("allows only explicit internal-autonomy low-risk work, and negative feedback narrows it to confirmation", () => {
    const operation = internalOperation();
    const allowed = evaluateAutonomyDecision({
      ...baseInput(operation),
      internal_autonomy_default: internalDefault(operation),
    });
    expect(allowed.level).toBe("autonomous_low_risk");

    const corrected = evaluateAutonomyDecision({
      ...baseInput(operation),
      internal_autonomy_default: internalDefault(operation),
      recent_feedback: [{
        ref: "feedback:corrected",
        outcome: "corrected",
        reason: "The user corrected this autonomous learning path.",
        policy_adjustment: "require_confirmation",
      }],
    });

    expect(corrected.level).toBe("approval_required");
    expect(corrected.required_confirmation_text).toBe("The user corrected this autonomous learning path.");
    expect(corrected.blocked_steps).toEqual(expect.arrayContaining(["autonomous_initiate"]));
  });

  it("classifies safe Soil, Knowledge, Dream, audit, and readiness metabolism as autonomous low risk", () => {
    const cases = [
      {
        name: "soil retrieval",
        operation: internalOperation({
          operation_id: "soil.retrieval.search",
          capability_id: "capability:soil",
          operation_kind: "search",
          provider_ref: "runtime:soil",
          payload_class: "soil_query",
          side_effect_profile: "read",
          reversibility: "reversible",
          target_refs: ["runtime:soil:generated-cache"],
        }),
        classifier: {
          capability_family: "soil",
          operation_class: "soil_retrieval",
          target_class: "generated_cache",
          mutation_kind: "read",
          ref: "internal-default:soil-retrieval",
        },
      },
      {
        name: "soil projection",
        operation: internalOperation({
          operation_id: "soil.projection.materialize",
          capability_id: "capability:soil",
          operation_kind: "write",
          provider_ref: "runtime:soil",
          payload_class: "soil_projection",
          side_effect_profile: "write",
          reversibility: "reversible",
          target_refs: ["runtime:soil:generated-snapshot"],
        }),
        classifier: {
          capability_family: "soil",
          operation_class: "soil_projection",
          target_class: "generated_snapshot",
          mutation_kind: "materialize",
          ref: "internal-default:soil-projection",
        },
      },
      {
        name: "knowledge consolidation",
        operation: internalOperation({
          operation_id: "knowledge.consolidation.record",
          capability_id: "capability:knowledge",
          operation_kind: "write",
          provider_ref: "runtime:knowledge",
          payload_class: "internal_learning_record",
          side_effect_profile: "write",
          reversibility: "append_only",
          target_refs: ["runtime:knowledge:learning-store"],
        }),
        classifier: {
          capability_family: "knowledge",
          operation_class: "knowledge_consolidation",
          target_class: "internal_learning_store",
          mutation_kind: "append",
          ref: "internal-default:knowledge-consolidation",
        },
      },
      {
        name: "dream confidence update",
        operation: internalOperation({
          operation_id: "dream.playbook.confidence.update",
          capability_id: "capability:dream",
          operation_kind: "write",
          provider_ref: "runtime:dream",
          payload_class: "dream_hint_feedback",
          side_effect_profile: "write",
          reversibility: "reversible",
          target_refs: ["runtime:dream:playbook-metadata"],
        }),
        classifier: {
          capability_family: "dream",
          operation_class: "dream_confidence_update",
          target_class: "dream_playbook_metadata",
          mutation_kind: "update",
          ref: "internal-default:dream-confidence",
        },
      },
      {
        name: "audit append",
        operation: internalOperation({
          operation_id: "capability.audit.append",
          capability_id: "capability:audit",
          operation_kind: "write",
          provider_ref: "runtime:audit",
          payload_class: "capability_audit_record",
          side_effect_profile: "write",
          reversibility: "append_only",
          target_refs: ["runtime:audit:capability"],
        }),
        classifier: {
          capability_family: "audit",
          operation_class: "audit_append",
          target_class: "audit_log",
          mutation_kind: "append",
          ref: "internal-default:audit-append",
        },
      },
      {
        name: "readiness observation",
        operation: internalOperation({
          operation_id: "capability.readiness.observe",
          capability_id: "capability:readiness",
          operation_kind: "write",
          provider_ref: "runtime:readiness",
          payload_class: "readiness_observation",
          side_effect_profile: "write",
          reversibility: "append_only",
          target_refs: ["runtime:readiness:observation"],
        }),
        classifier: {
          capability_family: "readiness",
          operation_class: "readiness_observation",
          target_class: "readiness_observation",
          mutation_kind: "record",
          ref: "internal-default:readiness-observation",
        },
      },
    ] as const;

    for (const item of cases) {
      const defaultEvidence = internalDefault(item.operation, item.classifier);
      const decision = evaluateAutonomyDecision({
        ...baseInput(item.operation),
        internal_autonomy_default: defaultEvidence,
      });

      expect(defaultEvidence.result, item.name).toBe("eligible");
      expect(defaultEvidence.target_disposition, item.name).toBe("allowed_internal");
      expect(decision.level, item.name).toBe("autonomous_low_risk");
      expect(decision.invalidation_bindings).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "policy", ref: defaultEvidence.ref }),
      ]));
    }
  });

  it("routes protected target mutations away from the internal default", () => {
    const cases = [
      ["create", "protected_public_docs", "proposal", "write", "write", "draft_only"],
      ["append", "protected_user_authored_memory", "quarantine", "write", "write", "append_only"],
      ["update", "protected_hand_maintained_file", "review", "write", "write", "reversible"],
      ["overwrite", "protected_published_artifact", "approval_required", "mutate", "mutate", "irreversible"],
      ["delete", "protected_user_authored_skill", "blocked", "delete", "delete", "irreversible"],
      ["publish", "protected_public_docs", "approval_required", "publish", "publish", "irreversible"],
    ] as const;

    for (const [mutationKind, targetClass, disposition, operationKind, sideEffect, reversibility] of cases) {
      const operation = internalOperation({
        operation_id: `protected.${mutationKind}`,
        operation_kind: operationKind,
        side_effect_profile: sideEffect,
        reversibility,
        target_refs: [`target:${targetClass}`],
      });
      const defaultEvidence = internalDefault(operation, {
        operation_class: "protected_target_mutation",
        target_class: targetClass,
        mutation_kind: mutationKind,
        ref: `internal-default:protected:${mutationKind}`,
      });
      const decision = evaluateAutonomyDecision({
        ...baseInput(operation),
        internal_autonomy_default: defaultEvidence,
      });

      expect(defaultEvidence.result).toBe("ineligible");
      expect(defaultEvidence.target_disposition).toBe(disposition);
      expect(defaultEvidence.protected_target_refs).toEqual([`target:${targetClass}`]);
      expect(decision.level).not.toBe("autonomous_low_risk");
      expect(decision.blocked_steps).toEqual(expect.arrayContaining([
        disposition === "blocked" ? "execute" : "autonomous_initiate",
      ]));
    }
  });

  it("does not reuse safe internal-default evidence for a protected target operation", () => {
    const safeOperation = internalOperation({
      operation_id: "knowledge.generated.append",
      target_refs: ["runtime:knowledge:generated-cache"],
    });
    const protectedOperation = internalOperation({
      operation_id: "knowledge.generated.append",
      target_refs: ["protected:user-authored-memory"],
    });
    const safeEvidence = internalDefault(safeOperation, {
      operation_class: "knowledge_learning_record",
      target_class: "generated_cache",
      mutation_kind: "append",
      ref: "internal-default:generated-cache",
    });
    const decision = evaluateAutonomyDecision({
      ...baseInput(protectedOperation),
      internal_autonomy_default: safeEvidence,
    });

    expect(safeEvidence.result).toBe("eligible");
    expect(decision.level).toBe("prohibited");
    expect(decision.rationale).toContain(
      "Internal autonomy default internal-default:generated-cache does not match this operation scope."
    );
    expect(decision.blocked_steps).toEqual(expect.arrayContaining(["autonomous_initiate"]));
  });

  it("does not pass external side effects through the internal default", () => {
    const cases = [
      ["external_publish", "external_surface", "publish", "publish", "publish"],
      ["external_open", "external_surface", "open", "run", "mutate"],
      ["notification", "third_party_system", "send", "send", "send"],
      ["browser_or_desktop_operation", "browser_or_desktop", "run", "run", "mutate"],
      ["side_effecting_mcp", "side_effecting_mcp", "mutate", "mutate", "mutate"],
      ["foreign_plugin_execution", "foreign_plugin", "run", "run", "mutate"],
    ] as const;

    for (const [operationClass, targetClass, mutationKind, operationKind, sideEffect] of cases) {
      const operation = internalOperation({
        operation_id: `external.${operationClass}`,
        operation_kind: operationKind,
        provider_ref: `runtime:${operationClass}`,
        payload_class: "external_effect",
        side_effect_profile: sideEffect,
        reversibility: "irreversible",
        external_action_authority: true,
        target_refs: [`target:${targetClass}`],
      });
      const defaultEvidence = internalDefault(operation, {
        capability_family: "soil",
        operation_class: operationClass,
        target_class: targetClass,
        mutation_kind: mutationKind,
        ref: `internal-default:${operationClass}`,
      });
      const decision = evaluateAutonomyDecision({
        ...baseInput(operation),
        internal_autonomy_default: defaultEvidence,
        blast_radius: "external",
        external_side_effect: true,
      });

      expect(defaultEvidence.result).toBe("ineligible");
      expect(defaultEvidence.target_disposition).toBe("blocked");
      expect(defaultEvidence.external_effect_refs).toEqual([`target:${targetClass}`]);
      expect(decision.level).not.toBe("autonomous_low_risk");
      expect(decision.blocked_steps).toEqual(expect.arrayContaining(["autonomous_initiate"]));
    }
  });

  it("does not reuse admission for a different typed operation kind or side-effect profile", () => {
    const operation = notificationOperation();
    const admission = allowedAdmission(operation);
    const decision = evaluateAutonomyDecision({
      ...baseInput(operation),
      admission_evaluation: {
        ...admission,
        metadata: {
          ...admission.metadata,
          operation_kind: "read",
          side_effect_profile: "none",
        },
      },
      user_directed: true,
    });

    expect(decision.level).toBe("prohibited");
    expect(decision.rationale).toContain("Admission evaluation does not match this autonomy operation scope.");
    expect(decision.blocked_steps).toEqual(expect.arrayContaining(["execute", "initiate"]));
  });

  it("does not reuse admission across capability, surface, or auth boundaries", () => {
    const operation = notificationOperation();
    const admission = allowedAdmission(operation);

    const wrongCapability = evaluateAutonomyDecision({
      ...baseInput(operation),
      admission_evaluation: {
        ...admission,
        capability_id: "capability:other",
      },
      user_directed: true,
    });
    expect(wrongCapability.level).toBe("prohibited");

    const wrongSurface = evaluateAutonomyDecision({
      ...baseInput(operation),
      active_surface_ref: "surface:chat:discord",
      admission_evaluation: admission,
      user_directed: true,
    });
    expect(wrongSurface.level).toBe("prohibited");
    expect(wrongSurface.rationale).toContain(
      "Admission evaluation surface binding does not match this autonomy operation scope."
    );

    const wrongAuth = evaluateAutonomyDecision({
      ...baseInput(operation),
      admission_evaluation: {
        ...admission,
        auth_state_ref: "auth:other",
      },
      auth_state: {
        ref: "auth:current",
        status: "valid",
      },
      user_directed: true,
    });
    expect(wrongAuth.level).toBe("prohibited");
    expect(wrongAuth.rationale).toContain(
      "Admission evaluation auth binding does not match this autonomy operation scope."
    );

    const noAuthAdmission = evaluateAutonomyDecision({
      ...baseInput(operation),
      admission_evaluation: allowedAdmission(operation, { bindAuth: false }),
      auth_state: {
        ref: "auth:current",
        status: "valid",
      },
      user_directed: true,
    });
    expect(noAuthAdmission.level).toBe("prohibited");
    expect(noAuthAdmission.rationale).toContain(
      "Admission evaluation auth binding does not match this autonomy operation scope."
    );
  });

  it("does not grant internal autonomy from an expired classifier decision", () => {
    const operation = internalOperation();
    const decision = evaluateAutonomyDecision({
      ...baseInput(operation),
      internal_autonomy_default: internalDefault(operation, {
        expires_at: "2026-05-08T00:00:00.000Z",
      }),
    });

    expect(decision.level).toBe("approval_required");
    expect(decision.rationale).toContain(
      "Internal autonomy default internal-default:knowledge-quarantine expired before autonomy evaluation."
    );
    expect(decision.blocked_steps).toContain("autonomous_initiate");
  });

  it("returns prepare_only or prohibited for blocked readiness depending on setup guidance safety", () => {
    const preparable = notificationOperation({
      preparable_when_blocked: true,
      setup_guidance_ref: "setup:slack-auth",
    });
    const prepareOnly = evaluateAutonomyDecision({
      ...baseInput(preparable),
      operation_plan: preparable,
      readiness_snapshots: [readiness(preparable, {
        state: "blocked",
        missing_auth_refs: ["auth:slack"],
      })],
      blast_radius: "local",
      external_side_effect: false,
      privacy_sensitivity: "low",
      user_directed: true,
    });
    expect(prepareOnly.level).toBe("prepare_only");
    expect(prepareOnly.allowed_steps).toEqual(["prepare", "collect_setup_guidance"]);

    const blocked = notificationOperation({
      operation_id: "notify.delete-route",
      operation_kind: "delete",
      side_effect_profile: "delete",
      external_action_authority: false,
      preparable_when_blocked: false,
    });
    const prohibited = evaluateAutonomyDecision({
      ...baseInput(blocked),
      operation_plan: blocked,
      admission_evaluation: allowedAdmission(blocked),
      readiness_snapshots: [readiness(blocked, { state: "blocked" })],
      user_directed: true,
    });
    expect(prohibited.level).toBe("prohibited");
    expect(prohibited.blocked_steps).toEqual(expect.arrayContaining(["execute", "initiate"]));
  });

  it("requires approval for degraded readiness and privacy-sensitive high-blast-radius work", () => {
    const operation = internalOperation({
      operation_id: "knowledge.private-search",
      operation_kind: "read",
      side_effect_profile: "read",
      reversibility: "reversible",
    });
    const decision = evaluateAutonomyDecision({
      ...baseInput(operation),
      readiness_snapshots: [readiness(operation, { state: "degraded" })],
      blast_radius: "high",
      privacy_sensitivity: "high",
      internal_autonomy_default: internalDefault(operation, {
        ref: "internal-default:knowledge-private-search",
        operation_class: "knowledge_recall",
        target_class: "internal_learning_store",
        mutation_kind: "read",
      }),
    });

    expect(decision.level).toBe("approval_required");
    expect(decision.rationale).toEqual(expect.arrayContaining([
      "Privacy-sensitive operation requires approval before autonomous initiation.",
      "High or external blast radius requires approval before autonomous initiation.",
    ]));
  });

  it("does not treat admission alone as autonomous authority when readiness evidence is absent", () => {
    const operation = internalOperation();
    const decision = evaluateAutonomyDecision({
      ...baseInput(operation),
      readiness_snapshots: [],
      internal_autonomy_default: internalDefault(operation),
    });

    expect(decision.level).toBe("approval_required");
    expect(decision.rationale).toContain("No readiness snapshot was supplied for this autonomy operation scope.");
    expect(decision.blocked_steps).toContain("execute");
  });

  it("does not reuse readiness from a different capability", () => {
    const operation = internalOperation();
    const decision = evaluateAutonomyDecision({
      ...baseInput(operation),
      readiness_snapshots: [readiness(operation, {
        capability_id: "capability:other",
        snapshot_id: "readiness:other-capability",
      })],
      internal_autonomy_default: internalDefault(operation),
    });

    expect(decision.level).toBe("approval_required");
    expect(decision.rationale).toContain("Supplied readiness snapshots do not match this operation scope.");
    expect(decision.metadata.readiness_refs).toEqual([]);
  });

  it("does not reuse readiness across risk-class boundaries", () => {
    const operation = internalOperation({ risk_class: "medium" });
    const decision = evaluateAutonomyDecision({
      ...baseInput(operation),
      readiness_snapshots: [readiness(operation, {
        risk_class: "low",
        snapshot_id: "readiness:low-risk-only",
      })],
      internal_autonomy_default: internalDefault(operation),
    });

    expect(decision.level).toBe("approval_required");
    expect(decision.rationale).toContain("Supplied readiness snapshots do not match this operation scope.");
    expect(decision.metadata.readiness_refs).toEqual([]);
  });

  it("keeps decision-driving risk context in the autonomy cache key", () => {
    const operation = internalOperation();
    const lowRisk = evaluateAutonomyDecision({
      ...baseInput(operation),
      internal_autonomy_default: internalDefault(operation),
    });
    const highRisk = evaluateAutonomyDecision({
      ...baseInput(operation),
      blast_radius: "high",
      privacy_sensitivity: "high",
      external_side_effect: true,
      internal_autonomy_default: internalDefault(operation),
    });

    expect(lowRisk.level).toBe("autonomous_low_risk");
    expect(highRisk.level).toBe("approval_required");
    expect(lowRisk.cache_key).not.toBe(highRisk.cache_key);
    expect(lowRisk.cache_key).toContain("risk_class:low");
    expect(highRisk.cache_key).toContain("blast_radius:high");
    expect(highRisk.cache_key).toContain("privacy_sensitivity:high");
    expect(highRisk.cache_key).toContain("external_side_effect:true");
  });

  it("keeps operation risk class in cache key when all other decision refs match", () => {
    const lowRiskOperation = internalOperation();
    const mediumRiskOperation = internalOperation({ risk_class: "medium" });
    const lowRisk = evaluateAutonomyDecision({
      ...baseInput(lowRiskOperation),
      internal_autonomy_default: internalDefault(lowRiskOperation),
    });
    const mediumRisk = evaluateAutonomyDecision({
      ...baseInput(mediumRiskOperation),
      readiness_snapshots: [readiness(mediumRiskOperation, {
        snapshot_id: "readiness:knowledge.quarantine.append",
      })],
      admission_evaluation: {
        ...allowedAdmission(mediumRiskOperation),
        evaluation_id: allowedAdmission(lowRiskOperation).evaluation_id,
      },
      internal_autonomy_default: internalDefault(mediumRiskOperation),
    });

    expect(lowRisk.level).toBe("autonomous_low_risk");
    expect(mediumRisk.level).toBe("prepare_only");
    expect(lowRisk.cache_key).not.toBe(mediumRisk.cache_key);
    expect(mediumRisk.cache_key).toContain("risk_class:medium");
  });

  it("keeps policy result and auth status changes in the autonomy cache key", () => {
    const operation = internalOperation();
    const allowedPolicy = evaluateAutonomyDecision({
      ...baseInput(operation),
      internal_autonomy_default: internalDefault(operation),
      quieting_policy: [{
        ref: "quiet:same-ref",
        result: "allowed",
        reason: "Same policy ref and reason with different result.",
      }],
    });
    const prohibitedPolicy = evaluateAutonomyDecision({
      ...baseInput(operation),
      internal_autonomy_default: internalDefault(operation),
      quieting_policy: [{
        ref: "quiet:same-ref",
        result: "prohibited",
        reason: "Same policy ref and reason with different result.",
      }],
    });

    expect(allowedPolicy.level).toBe("autonomous_low_risk");
    expect(prohibitedPolicy.level).toBe("prohibited");
    expect(allowedPolicy.cache_key).not.toBe(prohibitedPolicy.cache_key);
    expect(allowedPolicy.cache_key).toContain("quieting:quiet:same-ref:allowed");
    expect(prohibitedPolicy.cache_key).toContain("quieting:quiet:same-ref:prohibited");

    const validAuth = evaluateAutonomyDecision({
      ...baseInput(operation),
      user_directed: true,
    });
    const revokedAuth = evaluateAutonomyDecision({
      ...baseInput(operation),
      auth_state: {
        ref: "auth:current",
        status: "revoked",
      },
      user_directed: true,
    });

    expect(validAuth.level).toBe("user_directed_execute");
    expect(revokedAuth.level).toBe("prohibited");
    expect(validAuth.cache_key).not.toBe(revokedAuth.cache_key);
    expect(validAuth.cache_key).toContain("auth_status:valid");
    expect(revokedAuth.cache_key).toContain("auth_status:revoked");
  });

  it("keeps blocked-readiness missing setup refs in the autonomy cache key", () => {
    const operation = internalOperation();
    const blockedWithSetup = evaluateAutonomyDecision({
      ...baseInput(operation),
      readiness_snapshots: [readiness(operation, {
        state: "blocked",
        snapshot_id: "readiness:blocked-same-ref",
        missing_auth_refs: ["auth:knowledge"],
      })],
    });
    const blockedWithoutSetup = evaluateAutonomyDecision({
      ...baseInput(operation),
      readiness_snapshots: [readiness(operation, {
        state: "blocked",
        snapshot_id: "readiness:blocked-same-ref",
        missing_auth_refs: [],
        missing_config_refs: [],
      })],
    });

    expect(blockedWithSetup.level).toBe("prepare_only");
    expect(blockedWithoutSetup.level).toBe("prohibited");
    expect(blockedWithSetup.cache_key).not.toBe(blockedWithoutSetup.cache_key);
    expect(blockedWithSetup.cache_key).toContain("missing_auth:auth:knowledge");
    expect(blockedWithoutSetup.cache_key).toContain("missing_auth:");
  });

  it("does not infer permission from memory, route config, past execution, auth, MCP enablement, or notification subscription", () => {
    const operation = notificationOperation();
    const decision = evaluateAutonomyDecision({
      ...baseInput(operation),
      admission_evaluation: approvalRequiredAdmission(operation),
      context_authority_evidence: [
        { ref: "memory:last-success", kind: "memory" },
        { ref: "route:notify", kind: "route_config" },
        { ref: "execution:previous", kind: "past_execution" },
        { ref: "auth:slack-session", kind: "auth_session" },
        { ref: "mcp:slack", kind: "mcp_enabled" },
        { ref: "subscription:notify", kind: "notification_subscription" },
      ],
      blast_radius: "external",
      external_side_effect: true,
    });

    expect(decision.level).toBe("approval_required");
    expect(decision.metadata.context_authority_evidence_refs).toEqual([
      "auth:slack-session",
      "execution:previous",
      "mcp:slack",
      "memory:last-success",
      "route:notify",
      "subscription:notify",
    ]);
    expect(decision.blocked_steps).toEqual(expect.arrayContaining([
      "infer_permission_from_auth_session",
      "infer_permission_from_mcp_enabled",
      "infer_permission_from_memory",
      "infer_permission_from_notification_subscription",
      "infer_permission_from_past_execution",
      "infer_permission_from_route_config",
    ]));
  });

  it("records cache invalidation evidence and fails closed for revocation, tombstone, quieting, suspend, correction, and policy downgrade", () => {
    const operation = internalOperation();
    const decision = evaluateAutonomyDecision({
      ...baseInput(operation),
      internal_autonomy_default: internalDefault(operation, {
        policy_epoch: "default-v1",
      }),
      invalidation_evidence: [
        { kind: "revocation", ref: "grant:revoked", reason: "Permission was revoked.", epoch: "revocation-v1" },
        { kind: "correction", ref: "feedback:correction", reason: "User correction requires confirmation.", epoch: "correction-v1" },
        { kind: "tombstone", ref: "memory:tombstone", reason: "Source content was tombstoned.", epoch: "tombstone-v1" },
        { kind: "quieting", ref: "quiet:night", reason: "Quieting policy is active.", epoch: "quiet-v1" },
        { kind: "suspend", ref: "companion:suspend", reason: "Companion is suspended.", epoch: "suspend-v1" },
        { kind: "policy_downgrade", ref: "policy:downgrade", reason: "Policy was downgraded.", epoch: "policy-v1" },
      ],
    });

    expect(decision.level).toBe("prohibited");
    expect(decision.suppression_reason).toBe("Quieting policy is active.");
    expect(decision.blocked_steps).toContain("reuse_cached_decision");
    expect(decision.invalidation_bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "invalidation_evidence", ref: "grant:revoked", epoch: "revocation-v1" }),
      expect.objectContaining({ kind: "invalidation_evidence", ref: "feedback:correction", epoch: "correction-v1" }),
      expect.objectContaining({ kind: "invalidation_evidence", ref: "memory:tombstone", epoch: "tombstone-v1" }),
      expect.objectContaining({ kind: "invalidation_evidence", ref: "quiet:night", epoch: "quiet-v1" }),
      expect.objectContaining({ kind: "invalidation_evidence", ref: "companion:suspend", epoch: "suspend-v1" }),
      expect.objectContaining({ kind: "invalidation_evidence", ref: "policy:downgrade", epoch: "policy-v1" }),
    ]));
  });
});
