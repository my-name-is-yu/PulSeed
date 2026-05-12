import { z } from "zod";
import {
  CapabilityOperationKindEnum,
  CapabilityPrivacyProfileEnum,
  CapabilityReadinessSnapshotSchema,
  CapabilityReversibilityProfileEnum,
  CapabilityRiskProfileEnum,
  CapabilitySideEffectProfileEnum,
  type CapabilityReadinessSnapshot,
} from "../../platform/observation/types/capability.js";
import {
  ProactiveInterventionOutcomeSchema,
  ProactiveOverreachIndicatorSchema,
} from "../store/proactive-intervention-store.js";
import {
  AdmissionAuthStateSchema,
  AdmissionPolicyEvaluationSchema,
  type AdmissionAuthState,
  type AdmissionPolicyEvaluation,
} from "./admission-policy.js";
import { AutonomyTtlMsSchema } from "./autonomy-ttl.js";
import {
  InternalAutonomyDefaultSchema,
  type InternalAutonomyDefault,
} from "./internal-autonomy-default.js";

export const AutonomyDecisionLevelSchema = z.enum([
  "advisory",
  "prepare_only",
  "user_directed_execute",
  "autonomous_low_risk",
  "approval_required",
  "prohibited",
]);
export type AutonomyDecisionLevel = z.infer<typeof AutonomyDecisionLevelSchema>;

export const AutonomyBlastRadiusSchema = z.enum([
  "local",
  "workspace",
  "project",
  "external",
  "high",
]);
export type AutonomyBlastRadius = z.infer<typeof AutonomyBlastRadiusSchema>;

export const AutonomyPrivacySensitivitySchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
]);
export type AutonomyPrivacySensitivity = z.infer<typeof AutonomyPrivacySensitivitySchema>;

export const AutonomyOperationPlanSchema = z.object({
  operation_id: z.string().min(1),
  capability_id: z.string().min(1).optional(),
  operation_kind: CapabilityOperationKindEnum,
  provider_ref: z.string().min(1),
  payload_class: z.string().min(1),
  side_effect_profile: CapabilitySideEffectProfileEnum,
  risk_class: CapabilityRiskProfileEnum.default("medium"),
  privacy_profile: CapabilityPrivacyProfileEnum.optional(),
  reversibility: CapabilityReversibilityProfileEnum.default("unknown"),
  external_action_authority: z.boolean().default(false),
  target_refs: z.array(z.string().min(1)).default([]),
  advisory_only: z.boolean().default(false),
  preparable_when_blocked: z.boolean().default(false),
  setup_guidance_ref: z.string().min(1).optional(),
  local_only: z.boolean().default(false),
  inspectable: z.boolean().default(false),
  expected_user_visible_effect: z.boolean().default(false),
}).strict();
export type AutonomyOperationPlan = z.infer<typeof AutonomyOperationPlanSchema>;
export type AutonomyOperationPlanInput = z.input<typeof AutonomyOperationPlanSchema>;

export const AutonomyPolicySignalResultSchema = z.enum([
  "allowed",
  "approval_required",
  "prepare_only",
  "prohibited",
  "suppressed",
  "downgraded",
]);
export type AutonomyPolicySignalResult = z.infer<typeof AutonomyPolicySignalResultSchema>;

export const AutonomyPolicySignalSchema = z.object({
  ref: z.string().min(1),
  result: AutonomyPolicySignalResultSchema,
  reason: z.string().min(1),
  epoch: z.string().min(1).optional(),
  expires_at: z.string().min(1).optional(),
}).strict();
export type AutonomyPolicySignal = z.infer<typeof AutonomyPolicySignalSchema>;

export const AutonomyRuntimeControlStateSchema = z.object({
  ref: z.string().min(1),
  state: z.enum(["available", "approval_required", "suspended", "prohibited"]),
  reason: z.string().min(1).optional(),
  epoch: z.string().min(1).optional(),
  expires_at: z.string().min(1).optional(),
}).strict();
export type AutonomyRuntimeControlState = z.infer<typeof AutonomyRuntimeControlStateSchema>;

export const AutonomyCompanionStateSchema = z.object({
  ref: z.string().min(1),
  mode: z.enum(["active", "quieted", "suspended", "holding_back"]),
  reason: z.string().min(1).optional(),
  epoch: z.string().min(1).optional(),
}).strict();
export type AutonomyCompanionState = z.infer<typeof AutonomyCompanionStateSchema>;

export const AutonomyTrustProfileSchema = z.object({
  ref: z.string().min(1),
  provider_ref: z.string().min(1),
  trust_level: z.enum(["unknown", "low", "medium", "high"]).default("unknown"),
  positive_feedback_refs: z.array(z.string().min(1)).default([]),
  negative_feedback_refs: z.array(z.string().min(1)).default([]),
  epoch: z.string().min(1).optional(),
}).strict();
export type AutonomyTrustProfile = z.infer<typeof AutonomyTrustProfileSchema>;

export const AutonomyVerificationProfileSchema = z.object({
  ref: z.string().min(1),
  provider_ref: z.string().min(1),
  verification_refs: z.array(z.string().min(1)).default([]),
  audit_refs: z.array(z.string().min(1)).default([]),
  epoch: z.string().min(1).optional(),
}).strict();
export type AutonomyVerificationProfile = z.infer<typeof AutonomyVerificationProfileSchema>;

export const AutonomyFeedbackSignalSchema = z.object({
  ref: z.string().min(1),
  outcome: ProactiveInterventionOutcomeSchema,
  reason: z.string().min(1).optional(),
  overreach_indicators: z.array(ProactiveOverreachIndicatorSchema).default([]),
  follow_through_success: z.boolean().nullable().default(null),
  recorded_at: z.string().min(1).optional(),
  policy_adjustment: z.enum([
    "reduce_frequency",
    "require_confirmation",
    "narrow_scope",
    "avoid_sensitive_context",
  ]).optional(),
}).strict();
export type AutonomyFeedbackSignal = z.infer<typeof AutonomyFeedbackSignalSchema>;

export const AutonomyContextAuthorityEvidenceSchema = z.object({
  ref: z.string().min(1),
  kind: z.enum([
    "dream_hint",
    "memory",
    "route_config",
    "past_execution",
    "auth_session",
    "mcp_enabled",
    "notification_subscription",
  ]),
  epoch: z.string().min(1).optional(),
}).strict();
export type AutonomyContextAuthorityEvidence = z.infer<typeof AutonomyContextAuthorityEvidenceSchema>;

export const AutonomyCacheInvalidationEvidenceSchema = z.object({
  kind: z.enum([
    "revocation",
    "correction",
    "tombstone",
    "quieting",
    "suspend",
    "policy_downgrade",
  ]),
  ref: z.string().min(1),
  reason: z.string().min(1),
  epoch: z.string().min(1).optional(),
}).strict();
export type AutonomyCacheInvalidationEvidence = z.infer<typeof AutonomyCacheInvalidationEvidenceSchema>;

export const AutonomyInvalidationBindingSchema = z.object({
  kind: z.enum([
    "admission",
    "auth",
    "backpressure",
    "companion_state",
    "feedback",
    "guardrail",
    "invalidation_evidence",
    "policy",
    "provider",
    "readiness",
    "runtime_control",
    "target",
    "trust",
    "verification",
  ]),
  ref: z.string().min(1),
  epoch: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
}).strict();
export type AutonomyInvalidationBinding = z.infer<typeof AutonomyInvalidationBindingSchema>;

export const AutonomyDecisionInputSchema = z.object({
  operation_plan: AutonomyOperationPlanSchema,
  readiness_snapshots: z.array(CapabilityReadinessSnapshotSchema).default([]),
  admission_evaluation: AdmissionPolicyEvaluationSchema,
  internal_autonomy_default: InternalAutonomyDefaultSchema.optional(),
  user_directed: z.boolean().default(false),
  explicit_user_instruction_ref: z.string().min(1).optional(),
  active_surface_ref: z.string().min(1).optional(),
  relationship_permissions: z.array(AutonomyPolicySignalSchema).default([]),
  quieting_policy: z.array(AutonomyPolicySignalSchema).default([]),
  privacy_context: z.array(AutonomyPolicySignalSchema).default([]),
  runtime_control_state: AutonomyRuntimeControlStateSchema.optional(),
  companion_state: AutonomyCompanionStateSchema.optional(),
  auth_state: AdmissionAuthStateSchema.optional(),
  guardrail_state: z.array(AutonomyPolicySignalSchema).default([]),
  backpressure_state: z.array(AutonomyPolicySignalSchema).default([]),
  trust_profile: AutonomyTrustProfileSchema.optional(),
  verification_profile: AutonomyVerificationProfileSchema.optional(),
  recent_feedback: z.array(AutonomyFeedbackSignalSchema).default([]),
  context_authority_evidence: z.array(AutonomyContextAuthorityEvidenceSchema).default([]),
  invalidation_evidence: z.array(AutonomyCacheInvalidationEvidenceSchema).default([]),
  blast_radius: AutonomyBlastRadiusSchema.default("workspace"),
  reversibility: CapabilityReversibilityProfileEnum.optional(),
  external_side_effect: z.boolean().optional(),
  privacy_sensitivity: AutonomyPrivacySensitivitySchema.default("medium"),
  evaluated_at: z.string().min(1).optional(),
  expires_at: z.string().min(1).optional(),
  ttl_ms: AutonomyTtlMsSchema.optional(),
  decision_id: z.string().min(1).optional(),
}).strict();
export type AutonomyDecisionInput = z.input<typeof AutonomyDecisionInputSchema>;
type ParsedAutonomyDecisionInput = z.infer<typeof AutonomyDecisionInputSchema>;

export const AutonomyDecisionSchema = z.object({
  schema_version: z.literal("autonomy-decision/v1"),
  decision_id: z.string().min(1),
  operation_id: z.string().min(1),
  capability_id: z.string().min(1).optional(),
  evaluated_at: z.string().min(1),
  level: AutonomyDecisionLevelSchema,
  rationale: z.array(z.string().min(1)),
  allowed_steps: z.array(z.string().min(1)).default([]),
  blocked_steps: z.array(z.string().min(1)).default([]),
  required_user_approval: z.boolean(),
  required_confirmation_text: z.string().min(1).optional(),
  suppression_reason: z.string().min(1).optional(),
  audit_refs: z.array(z.string().min(1)).default([]),
  expires_at: z.string().min(1),
  invalidation_bindings: z.array(AutonomyInvalidationBindingSchema).default([]),
  cache_key: z.string().min(1),
  metadata: z.object({
    admission_evaluation_ref: z.string().min(1),
    readiness_refs: z.array(z.string().min(1)).default([]),
    user_directed: z.boolean(),
    external_side_effect: z.boolean(),
    blast_radius: AutonomyBlastRadiusSchema,
    privacy_sensitivity: AutonomyPrivacySensitivitySchema,
    context_authority_evidence_refs: z.array(z.string().min(1)).default([]),
  }).strict(),
}).strict();
export type AutonomyDecision = z.infer<typeof AutonomyDecisionSchema>;

type AutonomyFinding = {
  level: "prepare_only" | "approval_required" | "prohibited";
  rationale: string;
  blocked_step?: string;
  confirmationText?: string;
  suppressionReason?: string;
};

const DEFAULT_AUTONOMY_TTL_MS = 5 * 60 * 1000;
const EXTERNAL_OR_MUTATING_EFFECTS = new Set(["send", "publish", "delete", "mutate"]);
const DESTRUCTIVE_OPERATION_KINDS = new Set(["delete", "publish", "mutate"]);
const NEGATIVE_FEEDBACK_OUTCOMES = new Set(["ignored", "dismissed", "corrected", "overreach"]);
const POLICY_TO_BINDING_KIND: Record<string, AutonomyInvalidationBinding["kind"]> = {
  relationship_permissions: "policy",
  quieting_policy: "policy",
  privacy_context: "policy",
  guardrail_state: "guardrail",
  backpressure_state: "backpressure",
};

export function evaluateAutonomyDecision(input: AutonomyDecisionInput): AutonomyDecision {
  const parsed = AutonomyDecisionInputSchema.parse(input);
  const evaluatedAt = parsed.evaluated_at ?? new Date().toISOString();
  const nowMs = Date.parse(evaluatedAt);
  const ttlMs = parsed.ttl_ms ?? DEFAULT_AUTONOMY_TTL_MS;
  const expiresAt = parsed.expires_at ?? new Date(nowMs + ttlMs).toISOString();
  const findings: AutonomyFinding[] = [];
  const admission = parsed.admission_evaluation;
  const matchingReadiness = parsed.readiness_snapshots.filter((snapshot) =>
    readinessMatchesOperation(snapshot, parsed.operation_plan)
  );
  const invalidation = invalidationBindings(parsed, matchingReadiness);

  applyOperationAdmission(findings, {
    operation: parsed.operation_plan,
    admission,
    activeSurfaceRef: parsed.active_surface_ref,
    authState: parsed.auth_state,
    evaluatedAt,
  });
  applyReadiness(findings, parsed.operation_plan, parsed.readiness_snapshots, matchingReadiness);
  applyAuthState(findings, parsed.auth_state, evaluatedAt);
  applyPolicySignals(findings, parsed.relationship_permissions, "relationship policy", evaluatedAt);
  applyPolicySignals(findings, parsed.quieting_policy, "quieting policy", evaluatedAt);
  applyPolicySignals(findings, parsed.privacy_context, "privacy context", evaluatedAt);
  applyPolicySignals(findings, parsed.guardrail_state, "guardrail state", evaluatedAt);
  applyPolicySignals(findings, parsed.backpressure_state, "backpressure state", evaluatedAt);
  applyRuntimeControlState(findings, parsed.runtime_control_state, evaluatedAt);
  applyCompanionState(findings, parsed.companion_state);
  applyInternalAutonomyDefault(findings, parsed.operation_plan, parsed.internal_autonomy_default, evaluatedAt);
  applyInvalidationEvidence(findings, parsed.invalidation_evidence);
  applyFeedback(findings, parsed.recent_feedback);
  applyOperationRisk(findings, parsed);

  const level = resolveAutonomyLevel(findings, parsed);
  const rationale = findings.length > 0
    ? findings.map((finding) => finding.rationale)
    : [positiveRationale(level, parsed)];
  const confirmationText = findings.find((finding) => finding.confirmationText)?.confirmationText;
  const suppressionReason = findings.find((finding) => finding.suppressionReason)?.suppressionReason;

  return AutonomyDecisionSchema.parse({
    schema_version: "autonomy-decision/v1",
    decision_id: parsed.decision_id ?? autonomyDecisionId(parsed.operation_plan.operation_id, admission.evaluation_id, evaluatedAt),
    operation_id: parsed.operation_plan.operation_id,
    ...(parsed.operation_plan.capability_id ? { capability_id: parsed.operation_plan.capability_id } : {}),
    evaluated_at: evaluatedAt,
    level,
    rationale,
    allowed_steps: allowedStepsFor(level, parsed),
    blocked_steps: blockedStepsFor(level, findings, parsed),
    required_user_approval: level === "approval_required",
    ...(confirmationText ? { required_confirmation_text: confirmationText } : {}),
    ...(suppressionReason ? { suppression_reason: suppressionReason } : {}),
    audit_refs: auditRefs(parsed, matchingReadiness).sort(),
    expires_at: expiresAt,
    invalidation_bindings: invalidation,
    cache_key: autonomyCacheKey(parsed, matchingReadiness, invalidation),
    metadata: {
      admission_evaluation_ref: admission.evaluation_id,
      readiness_refs: matchingReadiness.map((snapshot) => snapshot.snapshot_id).sort(),
      user_directed: parsed.user_directed,
      external_side_effect: externalSideEffect(parsed),
      blast_radius: parsed.blast_radius,
      privacy_sensitivity: parsed.privacy_sensitivity,
      context_authority_evidence_refs: parsed.context_authority_evidence.map((evidence) => evidence.ref).sort(),
    },
  });
}

function applyOperationAdmission(findings: AutonomyFinding[], input: {
  operation: AutonomyOperationPlan;
  admission: AdmissionPolicyEvaluation;
  activeSurfaceRef: string | undefined;
  authState: AdmissionAuthState | undefined;
  evaluatedAt: string;
}): void {
  const { operation, admission, activeSurfaceRef, authState, evaluatedAt } = input;
  if (
    operation.operation_id !== admission.operation_id
    || operation.provider_ref !== admission.provider_ref
    || operation.payload_class !== admission.payload_class
    || operation.operation_kind !== admission.metadata.operation_kind
    || operation.side_effect_profile !== admission.metadata.side_effect_profile
    || (operation.capability_id !== undefined && admission.capability_id !== operation.capability_id)
    || !sameStringSet(operation.target_refs, admission.target_refs)
  ) {
    findings.push({
      level: "prohibited",
      rationale: "Admission evaluation does not match this autonomy operation scope.",
      blocked_step: "execute",
    });
    return;
  }
  if (operation.capability_id === undefined && admission.capability_id !== undefined) {
    findings.push({
      level: "prohibited",
      rationale: "Admission evaluation capability binding does not match this autonomy operation scope.",
      blocked_step: "execute",
    });
    return;
  }
  if (admission.expires_at <= evaluatedAt) {
    findings.push({
      level: "approval_required",
      rationale: `Admission evaluation ${admission.evaluation_id} expired before autonomy evaluation.`,
      blocked_step: "execute",
    });
    return;
  }
  if (activeSurfaceRef === undefined || activeSurfaceRef !== admission.surface_ref) {
    findings.push({
      level: "prohibited",
      rationale: "Admission evaluation surface binding does not match this autonomy operation scope.",
      blocked_step: "execute",
    });
    return;
  }
  if (authState?.ref !== admission.auth_state_ref) {
    findings.push({
      level: "prohibited",
      rationale: "Admission evaluation auth binding does not match this autonomy operation scope.",
      blocked_step: "execute",
    });
    return;
  }
  if (admission.result === "prohibited") {
    findings.push({
      level: "prohibited",
      rationale: `Admission evaluation ${admission.evaluation_id} prohibited this operation.`,
      blocked_step: "execute",
    });
    return;
  }
  if (admission.result === "suppressed") {
    findings.push({
      level: "prohibited",
      rationale: `Admission evaluation ${admission.evaluation_id} suppressed this operation.`,
      blocked_step: "initiate",
      suppressionReason: "Admission policy suppressed the operation.",
    });
    return;
  }
  if (admission.result === "approval_required") {
    findings.push({
      level: "approval_required",
      rationale: `Admission evaluation ${admission.evaluation_id} requires approval before initiation.`,
      blocked_step: "initiate",
    });
  }
}

function applyReadiness(
  findings: AutonomyFinding[],
  operation: AutonomyOperationPlan,
  allReadiness: CapabilityReadinessSnapshot[],
  matchingReadiness: CapabilityReadinessSnapshot[]
): void {
  if (allReadiness.length === 0 && !operation.advisory_only && operation.operation_kind !== "hint") {
    findings.push({
      level: operation.preparable_when_blocked ? "prepare_only" : "approval_required",
      rationale: "No readiness snapshot was supplied for this autonomy operation scope.",
      blocked_step: "execute",
    });
    return;
  }
  if (allReadiness.length > 0 && matchingReadiness.length === 0) {
    findings.push({
      level: "approval_required",
      rationale: "Supplied readiness snapshots do not match this operation scope.",
      blocked_step: "execute",
    });
    return;
  }

  for (const snapshot of matchingReadiness) {
    if (snapshot.state === "blocked") {
      if (operation.preparable_when_blocked || snapshot.missing_auth_refs.length > 0 || snapshot.missing_config_refs.length > 0) {
        findings.push({
          level: "prepare_only",
          rationale: `Readiness ${snapshot.snapshot_id} is blocked; only setup or preparation is allowed.`,
          blocked_step: "execute",
        });
      } else {
        findings.push({
          level: "prohibited",
          rationale: `Readiness ${snapshot.snapshot_id} is blocked for this operation.`,
          blocked_step: "execute",
        });
      }
      continue;
    }
    if (snapshot.state === "degraded") {
      findings.push({
        level: "approval_required",
        rationale: `Readiness ${snapshot.snapshot_id} is degraded, so autonomous initiation is narrowed.`,
        blocked_step: "autonomous_initiate",
      });
      continue;
    }
    if (snapshot.state !== "executable_verified") {
      findings.push({
        level: operation.preparable_when_blocked ? "prepare_only" : "approval_required",
        rationale: `Readiness ${snapshot.snapshot_id} is ${snapshot.state}, not executable_verified.`,
        blocked_step: "execute",
      });
    }
  }
}

function applyAuthState(
  findings: AutonomyFinding[],
  authState: AdmissionAuthState | undefined,
  evaluatedAt: string
): void {
  if (!authState) return;
  if (authState.expires_at && authState.expires_at <= evaluatedAt) {
    findings.push({
      level: "approval_required",
      rationale: `Auth state ${authState.ref} expired before autonomy evaluation.`,
      blocked_step: "execute",
    });
    return;
  }
  if (authState.status === "revoked") {
    findings.push({
      level: "prohibited",
      rationale: `Auth state ${authState.ref} is revoked.`,
      blocked_step: "execute",
    });
    return;
  }
  if (authState.status !== "valid") {
    findings.push({
      level: "approval_required",
      rationale: `Auth state ${authState.ref} is ${authState.status}.`,
      blocked_step: "execute",
    });
  }
}

function applyPolicySignals(
  findings: AutonomyFinding[],
  signals: AutonomyPolicySignal[],
  label: string,
  evaluatedAt: string
): void {
  for (const signal of signals) {
    if (signal.expires_at && signal.expires_at <= evaluatedAt) {
      findings.push({
        level: "approval_required",
        rationale: `${label} ${signal.ref} expired before autonomy evaluation.`,
        blocked_step: "initiate",
      });
      continue;
    }
    switch (signal.result) {
      case "allowed":
        break;
      case "prepare_only":
        findings.push({
          level: "prepare_only",
          rationale: `${label} ${signal.ref}: ${signal.reason}`,
          blocked_step: "execute",
        });
        break;
      case "approval_required":
      case "downgraded":
        findings.push({
          level: "approval_required",
          rationale: `${label} ${signal.ref}: ${signal.reason}`,
          blocked_step: "initiate",
        });
        break;
      case "suppressed":
        findings.push({
          level: "prohibited",
          rationale: `${label} ${signal.ref}: ${signal.reason}`,
          blocked_step: "initiate",
          suppressionReason: signal.reason,
        });
        break;
      case "prohibited":
        findings.push({
          level: "prohibited",
          rationale: `${label} ${signal.ref}: ${signal.reason}`,
          blocked_step: "execute",
        });
        break;
    }
  }
}

function applyRuntimeControlState(
  findings: AutonomyFinding[],
  runtimeControlState: AutonomyRuntimeControlState | undefined,
  evaluatedAt: string
): void {
  if (!runtimeControlState) return;
  if (runtimeControlState.expires_at && runtimeControlState.expires_at <= evaluatedAt) {
    findings.push({
      level: "approval_required",
      rationale: `Runtime control state ${runtimeControlState.ref} expired before autonomy evaluation.`,
      blocked_step: "execute",
    });
    return;
  }
  if (runtimeControlState.state === "suspended" || runtimeControlState.state === "prohibited") {
    findings.push({
      level: "prohibited",
      rationale: `Runtime control state ${runtimeControlState.ref} is ${runtimeControlState.state}.`,
      blocked_step: "execute",
    });
    return;
  }
  if (runtimeControlState.state === "approval_required") {
    findings.push({
      level: "approval_required",
      rationale: `Runtime control state ${runtimeControlState.ref} requires approval.`,
      blocked_step: "execute",
    });
  }
}

function applyCompanionState(
  findings: AutonomyFinding[],
  companionState: AutonomyCompanionState | undefined
): void {
  if (!companionState || companionState.mode === "active") return;
  if (companionState.mode === "suspended") {
    findings.push({
      level: "prohibited",
      rationale: `Companion state ${companionState.ref} is suspended.`,
      blocked_step: "initiate",
      suppressionReason: companionState.reason ?? "Companion state is suspended.",
    });
    return;
  }
  findings.push({
    level: "prohibited",
    rationale: `Companion state ${companionState.ref} is ${companionState.mode}.`,
    blocked_step: "initiate",
    suppressionReason: companionState.reason ?? `Companion state is ${companionState.mode}.`,
  });
}

function applyInternalAutonomyDefault(
  findings: AutonomyFinding[],
  operation: AutonomyOperationPlan,
  internalDefault: InternalAutonomyDefault | undefined,
  evaluatedAt: string
): void {
  if (!internalDefault) return;
  if (internalDefault.expires_at && internalDefault.expires_at <= evaluatedAt) {
    findings.push({
      level: "approval_required",
      rationale: `Internal autonomy default ${internalDefault.ref} expired before autonomy evaluation.`,
      blocked_step: "autonomous_initiate",
      confirmationText: internalDefault.reason,
    });
    return;
  }
  if (!internalDefaultMatchesOperation(internalDefault, operation)) {
    findings.push({
      level: "prohibited",
      rationale: `Internal autonomy default ${internalDefault.ref} does not match this operation scope.`,
      blocked_step: "autonomous_initiate",
      suppressionReason: internalDefault.reason,
    });
    return;
  }
  if (internalDefault.target_disposition !== "allowed_internal") {
    findings.push({
      level: internalDefault.target_disposition === "blocked" ? "prohibited" : "approval_required",
      rationale: `Internal autonomy default ${internalDefault.ref} routes ${internalDefault.target_class} to ${internalDefault.target_disposition}.`,
      blocked_step: internalDefault.protected_target_refs.length > 0
        ? "mutate_protected_target"
        : "autonomous_initiate",
      confirmationText: internalDefault.target_disposition === "blocked" ? undefined : internalDefault.reason,
      suppressionReason: internalDefault.target_disposition === "blocked" ? internalDefault.reason : undefined,
    });
  }
}

function applyInvalidationEvidence(
  findings: AutonomyFinding[],
  evidence: AutonomyCacheInvalidationEvidence[]
): void {
  for (const item of evidence) {
    switch (item.kind) {
      case "revocation":
      case "tombstone":
      case "quieting":
      case "suspend":
        findings.push({
          level: "prohibited",
          rationale: `${item.kind} evidence ${item.ref}: ${item.reason}`,
          blocked_step: "reuse_cached_decision",
          suppressionReason: item.kind === "quieting" || item.kind === "suspend" ? item.reason : undefined,
        });
        break;
      case "correction":
      case "policy_downgrade":
        findings.push({
          level: "approval_required",
          rationale: `${item.kind} evidence ${item.ref}: ${item.reason}`,
          blocked_step: "reuse_cached_decision",
          confirmationText: item.reason,
        });
        break;
    }
  }
}

function applyFeedback(findings: AutonomyFinding[], feedback: AutonomyFeedbackSignal[]): void {
  for (const item of feedback) {
    if (!NEGATIVE_FEEDBACK_OUTCOMES.has(item.outcome)) continue;
    const confirmationText = item.policy_adjustment === "require_confirmation"
      || item.outcome === "corrected"
      || item.outcome === "overreach"
      ? item.reason ?? "Recent feedback requires confirmation before this autonomy path is reused."
      : undefined;
    findings.push({
      level: "approval_required",
      rationale: `Recent feedback ${item.ref} (${item.outcome}) narrows autonomy for this operation.`,
      blocked_step: "autonomous_initiate",
      confirmationText,
    });
  }
}

function applyOperationRisk(findings: AutonomyFinding[], input: ParsedAutonomyDecisionInput): void {
  if (input.user_directed) return;
  const operation = input.operation_plan;
  if (operation.external_action_authority || externalSideEffect(input)) {
    findings.push({
      level: "approval_required",
      rationale: "External action or side effect requires user approval for autonomous initiation.",
      blocked_step: "autonomous_initiate",
    });
  }
  if (destructiveAction(operation)) {
    findings.push({
      level: "approval_required",
      rationale: "Destructive or publishing action requires user approval for autonomous initiation.",
      blocked_step: "destructive_action",
    });
  }
  if (input.privacy_sensitivity === "high" || operation.privacy_profile === "external_service") {
    findings.push({
      level: "approval_required",
      rationale: "Privacy-sensitive operation requires approval before autonomous initiation.",
      blocked_step: "read_private_context",
    });
  }
  if (input.blast_radius === "external" || input.blast_radius === "high") {
    findings.push({
      level: "approval_required",
      rationale: "High or external blast radius requires approval before autonomous initiation.",
      blocked_step: "autonomous_initiate",
    });
  }
  const reversibility = input.reversibility ?? operation.reversibility;
  if ((reversibility === "irreversible" || reversibility === "unknown") && operation.side_effect_profile !== "none") {
    findings.push({
      level: "approval_required",
      rationale: "Irreversible or unknown-reversibility side effects require approval before autonomous initiation.",
      blocked_step: "execute",
    });
  }
}

function resolveAutonomyLevel(
  findings: AutonomyFinding[],
  input: ParsedAutonomyDecisionInput
): AutonomyDecisionLevel {
  if (findings.some((finding) => finding.level === "prohibited")) return "prohibited";
  if (findings.some((finding) => finding.level === "approval_required")) return "approval_required";
  if (findings.some((finding) => finding.level === "prepare_only")) return "prepare_only";
  if (input.operation_plan.advisory_only || input.operation_plan.operation_kind === "hint") return "advisory";
  if (input.user_directed) return "user_directed_execute";
  if (input.internal_autonomy_default?.result === "eligible" && lowRiskInternalOperation(input)) {
    return "autonomous_low_risk";
  }
  return "prepare_only";
}

function allowedStepsFor(level: AutonomyDecisionLevel, input: ParsedAutonomyDecisionInput): string[] {
  switch (level) {
    case "advisory":
      return ["advise"];
    case "prepare_only":
      return input.operation_plan.setup_guidance_ref
        ? ["prepare", "collect_setup_guidance"]
        : ["prepare"];
    case "user_directed_execute":
      return ["user_directed_execute"];
    case "autonomous_low_risk":
      return ["autonomous_low_risk_execute", "record_audit"];
    case "approval_required":
      return ["prepare", "request_user_approval"];
    case "prohibited":
      return [];
  }
}

function blockedStepsFor(
  level: AutonomyDecisionLevel,
  findings: AutonomyFinding[],
  input: ParsedAutonomyDecisionInput
): string[] {
  const blocked = new Set(findings.map((finding) => finding.blocked_step).filter((step): step is string => step !== undefined));
  if (level === "approval_required" || level === "prepare_only") {
    blocked.add("autonomous_initiate");
    blocked.add("execute_without_approval");
  }
  if (level === "prohibited") {
    blocked.add("initiate");
    blocked.add("execute");
  }
  for (const evidence of input.context_authority_evidence) {
    blocked.add(`infer_permission_from_${evidence.kind}`);
  }
  return [...blocked].sort();
}

function invalidationBindings(
  input: ParsedAutonomyDecisionInput,
  matchingReadiness: CapabilityReadinessSnapshot[]
): AutonomyInvalidationBinding[] {
  const bindings: AutonomyInvalidationBinding[] = [
    {
      kind: "admission",
      ref: input.admission_evaluation.evaluation_id,
    },
    {
      kind: "provider",
      ref: input.operation_plan.provider_ref,
    },
    ...input.operation_plan.target_refs.map((ref) => ({
      kind: "target" as const,
      ref,
    })),
    ...matchingReadiness.map((snapshot) => ({
      kind: "readiness" as const,
      ref: snapshot.snapshot_id,
    })),
    ...input.admission_evaluation.invalidation_bindings.map((binding) => ({
      kind: binding.kind === "payload" || binding.kind === "surface" ? "admission" as const : binding.kind,
      ref: binding.ref,
      ...(binding.epoch ? { epoch: binding.epoch } : {}),
    })),
    ...policyBindings("relationship_permissions", input.relationship_permissions),
    ...policyBindings("quieting_policy", input.quieting_policy),
    ...policyBindings("privacy_context", input.privacy_context),
    ...policyBindings("guardrail_state", input.guardrail_state),
    ...policyBindings("backpressure_state", input.backpressure_state),
    ...input.recent_feedback.map((feedback) => ({
      kind: "feedback" as const,
      ref: feedback.ref,
      reason: feedback.reason,
    })),
    ...input.invalidation_evidence.map((evidence) => ({
      kind: "invalidation_evidence" as const,
      ref: evidence.ref,
      ...(evidence.epoch ? { epoch: evidence.epoch } : {}),
      reason: evidence.reason,
    })),
  ];
  if (input.auth_state) {
    bindings.push({
      kind: "auth",
      ref: input.auth_state.ref,
      ...(input.auth_state.epoch ? { epoch: input.auth_state.epoch } : {}),
    });
  }
  if (input.runtime_control_state) {
    bindings.push({
      kind: "runtime_control",
      ref: input.runtime_control_state.ref,
      ...(input.runtime_control_state.epoch ? { epoch: input.runtime_control_state.epoch } : {}),
    });
  }
  if (input.companion_state) {
    bindings.push({
      kind: "companion_state",
      ref: input.companion_state.ref,
      ...(input.companion_state.epoch ? { epoch: input.companion_state.epoch } : {}),
    });
  }
  if (input.trust_profile) {
    bindings.push({
      kind: "trust",
      ref: input.trust_profile.ref,
      ...(input.trust_profile.epoch ? { epoch: input.trust_profile.epoch } : {}),
    });
  }
  if (input.verification_profile) {
    bindings.push({
      kind: "verification",
      ref: input.verification_profile.ref,
      ...(input.verification_profile.epoch ? { epoch: input.verification_profile.epoch } : {}),
    });
  }
  if (input.internal_autonomy_default) {
    bindings.push({
      kind: "policy",
      ref: input.internal_autonomy_default.ref,
      ...(input.internal_autonomy_default.epoch ? { epoch: input.internal_autonomy_default.epoch } : {}),
      ...(input.internal_autonomy_default.expires_at
        ? { reason: `expires_at:${input.internal_autonomy_default.expires_at}` }
        : {}),
    });
  }
  return uniqueBindings(bindings);
}

function policyBindings(
  source: keyof typeof POLICY_TO_BINDING_KIND,
  signals: AutonomyPolicySignal[]
): AutonomyInvalidationBinding[] {
  return signals.map((signal) => ({
    kind: POLICY_TO_BINDING_KIND[source],
    ref: signal.ref,
    ...(signal.epoch ? { epoch: signal.epoch } : {}),
    reason: signal.reason,
  }));
}

function auditRefs(input: ParsedAutonomyDecisionInput, readiness: CapabilityReadinessSnapshot[]): string[] {
  return [
    input.admission_evaluation.evaluation_id,
    ...input.admission_evaluation.permission_grant_refs,
    ...input.admission_evaluation.runtime_control_refs,
    ...input.admission_evaluation.notification_policy_refs,
    ...readiness.flatMap((snapshot) => [snapshot.snapshot_id, ...snapshot.verification_refs, ...snapshot.evidence_refs]),
    ...(input.trust_profile ? [input.trust_profile.ref] : []),
    ...(input.verification_profile ? [input.verification_profile.ref, ...input.verification_profile.audit_refs] : []),
    ...input.recent_feedback.map((feedback) => feedback.ref),
  ];
}

function readinessMatchesOperation(snapshot: CapabilityReadinessSnapshot, operation: AutonomyOperationPlan): boolean {
  return operation.capability_id !== undefined
    && snapshot.capability_id === operation.capability_id
    && snapshot.operation_id === operation.operation_id
    && snapshot.provider_ref === operation.provider_ref
    && snapshot.payload_class === operation.payload_class
    && snapshot.operation_kind === operation.operation_kind
    && snapshot.side_effect_profile === operation.side_effect_profile
    && snapshot.risk_class === operation.risk_class;
}

function externalSideEffect(input: ParsedAutonomyDecisionInput): boolean {
  return input.external_side_effect === true
    || input.operation_plan.external_action_authority
    || EXTERNAL_OR_MUTATING_EFFECTS.has(input.operation_plan.side_effect_profile)
    || EXTERNAL_OR_MUTATING_EFFECTS.has(input.operation_plan.operation_kind);
}

function destructiveAction(operation: AutonomyOperationPlan): boolean {
  return operation.side_effect_profile === "delete"
    || DESTRUCTIVE_OPERATION_KINDS.has(operation.operation_kind);
}

function lowRiskInternalOperation(input: ParsedAutonomyDecisionInput): boolean {
  const operation = input.operation_plan;
  const internalDefault = input.internal_autonomy_default;
  if (
    !internalDefault
    || internalDefault.result !== "eligible"
    || internalDefault.target_disposition !== "allowed_internal"
    || !internalDefaultMatchesOperation(internalDefault, operation)
    || internalDefault.protected_target_refs.length > 0
    || internalDefault.external_effect_refs.length > 0
  ) {
    return false;
  }
  const reversibility = input.reversibility ?? operation.reversibility;
  const safeReversibility = reversibility === "reversible"
    || reversibility === "append_only"
    || reversibility === "draft_only";
  const sideEffectIsInternal = operation.side_effect_profile === "none"
    || operation.side_effect_profile === "read"
    || (operation.side_effect_profile === "write" && safeReversibility);
  return operation.local_only
    && operation.inspectable
    && !operation.external_action_authority
    && !externalSideEffect(input)
    && !destructiveAction(operation)
    && sideEffectIsInternal
    && safeReversibility
    && operation.risk_class === "low"
    && (input.privacy_sensitivity === "none" || input.privacy_sensitivity === "low")
    && (input.blast_radius === "local" || input.blast_radius === "workspace");
}

function internalDefaultMatchesOperation(
  internalDefault: InternalAutonomyDefault,
  operation: AutonomyOperationPlan
): boolean {
  return internalDefault.operation_id === operation.operation_id
    && internalDefault.capability_id === operation.capability_id
    && internalDefault.operation_kind === operation.operation_kind
    && internalDefault.provider_ref === operation.provider_ref
    && internalDefault.payload_class === operation.payload_class
    && internalDefault.locality === (operation.local_only ? "local_only" : "not_local")
    && internalDefault.side_effect_profile === operation.side_effect_profile
    && internalDefault.reversibility === operation.reversibility
    && sameStringSet(internalDefault.target_refs, operation.target_refs);
}

function positiveRationale(level: AutonomyDecisionLevel, input: ParsedAutonomyDecisionInput): string {
  if (level === "autonomous_low_risk") {
    return `Internal autonomy default ${input.internal_autonomy_default?.ref} permits this local low-risk operation.`;
  }
  if (level === "user_directed_execute") {
    return "User-directed execution passed supplied admission, readiness, and policy gates.";
  }
  if (level === "advisory") {
    return "Operation is advisory only.";
  }
  return "No autonomous execution authority was supplied; preparation only is allowed.";
}

function autonomyDecisionId(operationId: string, admissionId: string, evaluatedAt: string): string {
  return `autonomy:${operationId}:${admissionId}:${evaluatedAt}`;
}

function autonomyCacheKey(
  input: ParsedAutonomyDecisionInput,
  readiness: CapabilityReadinessSnapshot[],
  invalidation: AutonomyInvalidationBinding[]
): string {
  return [
    input.operation_plan.operation_id,
    input.operation_plan.capability_id ?? "no-capability",
    input.operation_plan.provider_ref,
    input.operation_plan.payload_class,
    input.operation_plan.operation_kind,
    input.operation_plan.side_effect_profile,
    `risk_class:${input.operation_plan.risk_class}`,
    ...cacheAdmissionParts(input.admission_evaluation),
    ...cacheReadinessParts(readiness),
    ...cacheAuthStateParts(input.auth_state),
    ...cacheRuntimeControlStateParts(input.runtime_control_state),
    ...cacheCompanionStateParts(input.companion_state),
    ...cacheInternalAutonomyDefaultParts(input.internal_autonomy_default),
    ...cachePolicySignalParts("relationship", input.relationship_permissions),
    ...cachePolicySignalParts("quieting", input.quieting_policy),
    ...cachePolicySignalParts("privacy", input.privacy_context),
    ...cachePolicySignalParts("guardrail", input.guardrail_state),
    ...cachePolicySignalParts("backpressure", input.backpressure_state),
    ...cacheFeedbackParts(input.recent_feedback),
    `user_directed:${input.user_directed}`,
    `blast_radius:${input.blast_radius}`,
    `privacy_sensitivity:${input.privacy_sensitivity}`,
    `external_side_effect:${externalSideEffect(input)}`,
    `reversibility:${input.reversibility ?? input.operation_plan.reversibility}`,
    ...invalidation.map((binding) => `${binding.kind}:${binding.ref}:${binding.epoch ?? ""}:${binding.reason ?? ""}`),
  ].join("|");
}

function cacheAdmissionParts(admission: AdmissionPolicyEvaluation): string[] {
  return [
    `admission:${admission.evaluation_id}`,
    `admission_result:${admission.result}`,
    `admission_expires_at:${admission.expires_at}`,
    `admission_surface:${admission.surface_ref}`,
    `admission_auth:${admission.auth_state_ref ?? "no-auth"}`,
    `admission_capability:${admission.capability_id ?? "no-capability"}`,
    `admission_kind:${admission.metadata.operation_kind}`,
    `admission_side_effect:${admission.metadata.side_effect_profile}`,
  ];
}

function cacheReadinessParts(readiness: CapabilityReadinessSnapshot[]): string[] {
  return readiness.map((snapshot) => [
    "readiness",
    snapshot.snapshot_id,
    snapshot.capability_id,
    snapshot.state,
    snapshot.risk_class,
    snapshot.evaluated_at,
    `missing_auth:${snapshot.missing_auth_refs.join(",")}`,
    `missing_config:${snapshot.missing_config_refs.join(",")}`,
    `failed:${snapshot.failed_gates.join(",")}`,
    `degraded:${snapshot.degraded_gates.join(",")}`,
    `stale:${snapshot.stale_refs.join(",")}`,
  ].join(":")).sort();
}

function cacheAuthStateParts(authState: AdmissionAuthState | undefined): string[] {
  if (!authState) return ["auth:no-auth"];
  return [
    `auth:${authState.ref}`,
    `auth_status:${authState.status}`,
    `auth_epoch:${authState.epoch ?? ""}`,
    `auth_expires_at:${authState.expires_at ?? ""}`,
  ];
}

function cacheRuntimeControlStateParts(state: AutonomyRuntimeControlState | undefined): string[] {
  if (!state) return ["runtime_control:no-state"];
  return [
    `runtime_control:${state.ref}`,
    `runtime_control_state:${state.state}`,
    `runtime_control_epoch:${state.epoch ?? ""}`,
    `runtime_control_expires_at:${state.expires_at ?? ""}`,
    `runtime_control_reason:${state.reason ?? ""}`,
  ];
}

function cacheCompanionStateParts(state: AutonomyCompanionState | undefined): string[] {
  if (!state) return ["companion_state:no-state"];
  return [
    `companion_state:${state.ref}`,
    `companion_state_mode:${state.mode}`,
    `companion_state_epoch:${state.epoch ?? ""}`,
    `companion_state_reason:${state.reason ?? ""}`,
  ];
}

function cacheInternalAutonomyDefaultParts(internalDefault: InternalAutonomyDefault | undefined): string[] {
  if (!internalDefault) return ["internal_default:no-state"];
  return [
    `internal_default:${internalDefault.ref}`,
    `internal_default_result:${internalDefault.result}`,
    `internal_default_family:${internalDefault.capability_family}`,
    `internal_default_operation_class:${internalDefault.operation_class}`,
    `internal_default_operation_id:${internalDefault.operation_id}`,
    `internal_default_capability:${internalDefault.capability_id ?? "no-capability"}`,
    `internal_default_operation_kind:${internalDefault.operation_kind}`,
    `internal_default_provider:${internalDefault.provider_ref}`,
    `internal_default_payload:${internalDefault.payload_class}`,
    `internal_default_locality:${internalDefault.locality}`,
    `internal_default_side_effect:${internalDefault.side_effect_profile}`,
    `internal_default_reversibility:${internalDefault.reversibility}`,
    `internal_default_scope:${internalDefault.scope}`,
    `internal_default_target_class:${internalDefault.target_class}`,
    `internal_default_target_disposition:${internalDefault.target_disposition}`,
    `internal_default_targets:${internalDefault.target_refs.join(",")}`,
    `internal_default_protected_targets:${internalDefault.protected_target_refs.join(",")}`,
    `internal_default_external_effects:${internalDefault.external_effect_refs.join(",")}`,
    `internal_default_guardrails:${internalDefault.guardrail_refs.join(",")}`,
    `internal_default_epoch:${internalDefault.epoch ?? ""}`,
    `internal_default_expires_at:${internalDefault.expires_at ?? ""}`,
    `internal_default_reason:${internalDefault.reason}`,
  ];
}

function cachePolicySignalParts(label: string, signals: AutonomyPolicySignal[]): string[] {
  return signals.map((signal) => [
    label,
    signal.ref,
    signal.result,
    signal.epoch ?? "",
    signal.expires_at ?? "",
    signal.reason,
  ].join(":")).sort();
}

function cacheFeedbackParts(feedback: AutonomyFeedbackSignal[]): string[] {
  return feedback.map((item) => [
    "feedback",
    item.ref,
    item.outcome,
    item.policy_adjustment ?? "",
    item.follow_through_success === null ? "null" : String(item.follow_through_success),
    item.recorded_at ?? "",
    item.reason ?? "",
    ...item.overreach_indicators,
  ].join(":")).sort();
}

function uniqueBindings(bindings: AutonomyInvalidationBinding[]): AutonomyInvalidationBinding[] {
  const seen = new Set<string>();
  const result: AutonomyInvalidationBinding[] = [];
  for (const binding of bindings) {
    const key = `${binding.kind}:${binding.ref}:${binding.epoch ?? ""}:${binding.reason ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(binding);
  }
  return result.sort((a, b) =>
    `${a.kind}:${a.ref}:${a.epoch ?? ""}`.localeCompare(`${b.kind}:${b.ref}:${b.epoch ?? ""}`)
  );
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightValues = new Set(right);
  return left.every((value) => rightValues.has(value));
}
