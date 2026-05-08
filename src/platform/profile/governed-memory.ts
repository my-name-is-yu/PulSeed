import { z } from "zod";

const requiredDomainValueSchema = z.unknown().refine((value) => {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
}, "required domain field must be present");

function domainFieldsSchema(fields: readonly string[]): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    shape[field] = requiredDomainValueSchema;
  }
  return z.object(shape).passthrough();
}

const redactedDomainFieldsSchema = z.object({
  redaction_ref: z.string().min(1),
  reason: z.enum(["sensitive", "tombstoned", "deleted", "permission_revoked", "scope_excluded"]),
}).strict();

export const GovernedMemoryOwnerKindSchema = z.enum([
  "relationship_profile",
  "profile_proposal",
  "runtime_session",
  "soil",
  "knowledge",
  "dream_seed",
]);
export type GovernedMemoryOwnerKind = z.infer<typeof GovernedMemoryOwnerKindSchema>;

export const GovernedMemoryOwnerRefSchema = z.object({
  kind: GovernedMemoryOwnerKindSchema,
  store_ref: z.string().min(1),
  record_ref: z.string().min(1),
  schema_version: z.number().int().positive().default(1),
}).strict();
export type GovernedMemoryOwnerRef = z.infer<typeof GovernedMemoryOwnerRefSchema>;

export const GovernedMemoryRoleSchema = z.enum([
  "knowledge",
  "work_memory",
  "relationship",
  "seed",
  "boundary",
  "promise",
  "anti_memory",
  "tension",
]);
export type GovernedMemoryRole = z.infer<typeof GovernedMemoryRoleSchema>;

export const GovernedMemoryRecordKindSchema = z.enum([
  "stable_profile_fact",
  "preference",
  "routine",
  "boundary",
  "intervention_policy",
  "episodic_event",
  "promise",
  "correction",
  "relationship_posture",
  "consent_scope",
  "work_commitment",
  "project_fact",
  "knowledge_fact",
  "open_tension",
  "anti_memory_rule",
  "seed_candidate",
]);
export type GovernedMemoryRecordKind = z.infer<typeof GovernedMemoryRecordKindSchema>;

export const GovernedMemoryLifecycleSchema = z.enum([
  "active",
  "planted",
  "matured",
  "decayed",
  "retired",
  "suppressed",
  "superseded",
  "retracted",
  "tombstoned",
  "deleted",
  "archived",
]);
export type GovernedMemoryLifecycle = z.infer<typeof GovernedMemoryLifecycleSchema>;

export const GovernedMemoryCorrectionStateSchema = z.enum([
  "current",
  "under_review",
  "corrected",
  "superseded",
  "retracted",
  "deleted",
]);
export type GovernedMemoryCorrectionState = z.infer<typeof GovernedMemoryCorrectionStateSchema>;

export const GovernedMemoryAllowedUseClassSchema = z.enum([
  "runtime_grounding",
  "design_grounding",
  "behavioral_inhibition",
  "attention_prioritization",
  "expression_mode_selection",
  "tone_adaptation",
  "goal_planning",
  "ask_for_confirmation",
  "proactive_action_candidate",
  "user_facing_reference",
  "memory_write_candidate",
  "surface_projection",
  "never_use_directly",
]);
export type GovernedMemoryAllowedUseClass = z.infer<typeof GovernedMemoryAllowedUseClassSchema>;

export const GovernedMemoryForbiddenUseClassSchema = z.enum([
  "user_personality_labeling",
  "diagnosis",
  "motivation_claim",
  "emotional_leverage",
  "engagement_optimization",
  "attachment_optimization",
  "proactive_trigger",
  "side_effect_authorization",
  "stale_session_authorization",
  "raw_prompt_injection",
  "cross_scope_reuse",
]);
export type GovernedMemoryForbiddenUseClass = z.infer<typeof GovernedMemoryForbiddenUseClassSchema>;

export const GovernedMemoryBlockedUseClassSchema = z.union([
  GovernedMemoryAllowedUseClassSchema,
  GovernedMemoryForbiddenUseClassSchema,
]);
export type GovernedMemoryBlockedUseClass = z.infer<typeof GovernedMemoryBlockedUseClassSchema>;

export const GovernedMemoryUseClassSchema = GovernedMemoryAllowedUseClassSchema;
export type GovernedMemoryUseClass = GovernedMemoryAllowedUseClass;

export const GovernedMemoryEpistemicStatusSchema = z.enum([
  "explicit_user_instruction",
  "explicit_promise",
  "explicit_boundary",
  "observed_behavior",
  "repeated_pattern",
  "inferred_preference",
  "design_tension",
  "relationship_tension",
  "low_confidence_hypothesis",
  "corrected_assumption",
  "superseded_understanding",
]);
export type GovernedMemoryEpistemicStatus = z.infer<typeof GovernedMemoryEpistemicStatusSchema>;

export const GovernedMemorySensitivitySchema = z.enum(["public", "private", "sensitive"]);
export type GovernedMemorySensitivity = z.infer<typeof GovernedMemorySensitivitySchema>;

export const GovernedMemoryMaterializedContentSchema = z.object({
  state: z.literal("materialized"),
  text: z.string().min(1),
}).strict();

export const GovernedMemoryRedactedContentSchema = z.object({
  state: z.literal("redacted"),
  redaction_ref: z.string().min(1),
  reason: z.enum(["sensitive", "tombstoned", "deleted", "permission_revoked", "scope_excluded"]),
}).strict();

export const GovernedMemoryContentSchema = z.discriminatedUnion("state", [
  GovernedMemoryMaterializedContentSchema,
  GovernedMemoryRedactedContentSchema,
]);
export type GovernedMemoryContent = z.infer<typeof GovernedMemoryContentSchema>;

export const GovernedMemorySourceRefSchema = z.object({
  kind: z.enum(["user_instruction", "runtime_event", "soil_record", "knowledge_record", "dream_proposal", "correction_event"]),
  ref: z.string().min(1),
  observed_at: z.string().datetime().optional(),
  reliability: z.number().min(0).max(1).nullable().default(null),
}).strict();
export type GovernedMemorySourceRef = z.infer<typeof GovernedMemorySourceRefSchema>;

export const GovernedMemoryProjectionPolicySchema = z.object({
  surface_eligible: z.boolean().default(true),
  requires_permission_gate: z.boolean().default(true),
  inspection_visibility: z.enum(["visible", "redacted", "hidden"]).default("visible"),
  stale_behavior: z.enum(["exclude", "inhibit", "ask_for_confirmation"]).default("exclude"),
}).strict();
export type GovernedMemoryProjectionPolicy = z.infer<typeof GovernedMemoryProjectionPolicySchema>;

const REQUIRED_DOMAIN_FIELDS: Record<GovernedMemoryRecordKind, readonly string[]> = {
  stable_profile_fact: ["subject", "statement", "provenance", "confidence", "scope", "validity", "correction_state"],
  preference: ["target", "preference", "confidence", "scope", "allowed_uses", "review_condition"],
  routine: ["trigger_or_cadence", "scope", "permission", "staleness_rule", "interruption_policy"],
  boundary: ["prohibited_use", "scope", "authority_source", "override_rule"],
  intervention_policy: ["allowed_routes", "forbidden_routes", "confirmation_requirement", "review_rule"],
  episodic_event: ["event_time", "source", "subject", "sensitivity", "allowed_future_uses"],
  promise: ["promisor", "statement", "scope", "fulfillment_condition", "review_condition"],
  correction: ["corrected_target", "replacement_or_retraction", "affected_uses", "invalidation_rule"],
  relationship_posture: ["context", "permitted_posture", "forbidden_posture", "evidence", "confidence", "review_condition"],
  consent_scope: ["scope", "allowed_uses", "forbidden_uses", "authority_source", "revocation_rule"],
  work_commitment: ["statement", "linked_refs", "authority", "fulfillment_condition"],
  project_fact: ["project_scope", "statement", "source", "confidence", "validity", "supersession_rule"],
  knowledge_fact: ["domain", "statement", "source_reliability", "confidence", "validity", "correction_rule"],
  open_tension: ["statement", "uncertainty_status", "allowed_reasoning_uses", "forbidden_inference_uses"],
  anti_memory_rule: ["blocked_content_or_use", "scope", "owner", "enforcement_route", "review_condition"],
  seed_candidate: [
    "proposed_role",
    "proposed_record_kind",
    "source_evidence",
    "confidence",
    "allowed_maturation_path",
    "rejection_rule",
  ],
};

const DOMAIN_FIELD_SCHEMAS = GovernedMemoryRecordKindSchema.options.reduce(
  (schemas, kind) => {
    schemas[kind] = domainFieldsSchema(REQUIRED_DOMAIN_FIELDS[kind]);
    return schemas;
  },
  {} as Record<GovernedMemoryRecordKind, z.ZodTypeAny>,
);

const SURFACE_PROJECTABLE_LIFECYCLES: readonly GovernedMemoryLifecycle[] = ["active", "matured"];
const PROPOSAL_OWNER_KINDS: readonly GovernedMemoryOwnerKind[] = ["profile_proposal", "dream_seed"];
const TENSION_STATUSES: readonly GovernedMemoryEpistemicStatus[] = [
  "design_tension",
  "relationship_tension",
  "low_confidence_hypothesis",
];

export function requiredGovernedMemoryDomainFields(kind: GovernedMemoryRecordKind): readonly string[] {
  return REQUIRED_DOMAIN_FIELDS[kind];
}

export const GovernedMemorySchema = z.object({
  memory_id: z.string().min(1),
  logical_key: z.string().min(1),
  version: z.number().int().positive().default(1),
  owning_store_ref: GovernedMemoryOwnerRefSchema,
  role: GovernedMemoryRoleSchema,
  record_kind: GovernedMemoryRecordKindSchema,
  statement: z.string().min(1).optional(),
  scope: z.string().min(1),
  subject_refs: z.array(z.string().min(1)).default([]),
  domain_fields: z.record(z.unknown()),
  source_refs: z.array(GovernedMemorySourceRefSchema).min(1),
  content: GovernedMemoryContentSchema,
  epistemic_status: GovernedMemoryEpistemicStatusSchema,
  confidence: z.number().min(0).max(1).nullable().default(null),
  source_reliability: z.number().min(0).max(1).nullable().default(null),
  sensitivity: GovernedMemorySensitivitySchema.default("private"),
  allowed_uses: z.array(GovernedMemoryAllowedUseClassSchema).min(1),
  not_allowed_uses: z.array(GovernedMemoryBlockedUseClassSchema).default([]),
  lifecycle: GovernedMemoryLifecycleSchema,
  correction_state: GovernedMemoryCorrectionStateSchema.default("current"),
  projection_policy: GovernedMemoryProjectionPolicySchema,
  supersedes_memory_ids: z.array(z.string().min(1)).default([]),
  superseded_by_memory_id: z.string().min(1).nullable().default(null),
  correction_event_refs: z.array(z.string().min(1)).default([]),
  audit_refs: z.array(z.string().min(1)).default([]),
  valid_from: z.string().datetime().optional(),
  valid_to: z.string().datetime().nullable().default(null),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict().superRefine((record, ctx) => {
  const usesRedactedContent = record.content.state === "redacted"
    || record.lifecycle === "tombstoned"
    || record.lifecycle === "deleted"
    || record.correction_state === "deleted";
  const domainResult = usesRedactedContent
    ? redactedDomainFieldsSchema.safeParse(record.domain_fields)
    : DOMAIN_FIELD_SCHEMAS[record.record_kind].safeParse(record.domain_fields);
  if (!domainResult.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["domain_fields"],
      message: usesRedactedContent
        ? "redacted, tombstoned, or deleted memory domain_fields must expose only non-content redaction metadata"
        : `${record.record_kind} domain_fields do not satisfy the required contract`,
    });
  }

  if (record.content.state === "materialized" && !record.statement) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["statement"],
      message: "materialized memory requires a statement",
    });
  }

  if (record.content.state === "redacted" && record.statement) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["statement"],
      message: "redacted memory must not retain a reconstructable statement",
    });
  }

  if ((record.lifecycle === "tombstoned" || record.lifecycle === "deleted") && record.content.state !== "redacted") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content"],
      message: "tombstoned and deleted memory must use a redacted ref instead of reconstructable text",
    });
  }

  const surfaceUseAllowed = record.allowed_uses.includes("surface_projection");
  const asksForNormalSurface = record.projection_policy.surface_eligible || surfaceUseAllowed;
  const allowedUseSet = new Set<string>(record.allowed_uses);
  const overlappingUse = record.not_allowed_uses.find((use) => allowedUseSet.has(use));
  if (overlappingUse) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["not_allowed_uses"],
      message: `use class cannot be both allowed and not allowed: ${overlappingUse}`,
    });
  }

  if (record.allowed_uses.includes("never_use_directly") && record.allowed_uses.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowed_uses"],
      message: "never_use_directly cannot be combined with direct allowed uses",
    });
  }

  if (
    asksForNormalSurface
    && (record.correction_state !== "current" || record.superseded_by_memory_id !== null)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["correction_state"],
      message: "corrected, superseded, retracted, deleted, or replaced memory cannot enter normal Surface projection",
    });
  }

  if (record.correction_state === "deleted" && record.content.state !== "redacted") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content"],
      message: "deleted correction state must use a redacted ref instead of reconstructable text",
    });
  }

  if (asksForNormalSurface && !SURFACE_PROJECTABLE_LIFECYCLES.includes(record.lifecycle)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["lifecycle"],
      message: "only active or matured governed memory can be eligible for normal Surface projection",
    });
  }

  if (record.content.state === "redacted" && asksForNormalSurface) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["projection_policy", "surface_eligible"],
      message: "redacted memory cannot be eligible for normal Surface projection",
    });
  }

  if (record.record_kind === "seed_candidate" && record.role !== "seed") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["role"],
      message: "seed_candidate records must remain in the seed role until accepted by an owning store",
    });
  }

  if (record.record_kind === "seed_candidate" && asksForNormalSurface) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["projection_policy"],
      message: "seed candidates cannot enter normal Surface projection before owner acceptance",
    });
  }

  if (PROPOSAL_OWNER_KINDS.includes(record.owning_store_ref.kind) && asksForNormalSurface) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["owning_store_ref", "kind"],
      message: "proposal and Dream-owned candidates cannot enter normal Surface projection",
    });
  }

  if (TENSION_STATUSES.includes(record.epistemic_status) && record.record_kind === "stable_profile_fact") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["record_kind"],
      message: "tension or low-confidence records cannot be projected as stable profile facts",
    });
  }

  if (record.record_kind === "stable_profile_fact" && record.confidence !== null && record.confidence < 0.5) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["confidence"],
      message: "low-confidence records cannot be stable profile facts",
    });
  }
});
export type GovernedMemory = z.infer<typeof GovernedMemorySchema>;
export type GovernedMemoryInput = z.input<typeof GovernedMemorySchema>;

export const GovernedMemoryCorrectionActionSchema = z.enum([
  "change_statement",
  "narrow_scope",
  "revoke_use",
  "suppress_projection",
  "mark_stale",
  "supersede",
  "retract",
  "delete",
]);
export type GovernedMemoryCorrectionAction = z.infer<typeof GovernedMemoryCorrectionActionSchema>;

export const GovernedMemoryCorrectionEventSchema = z.object({
  event_id: z.string().min(1),
  target_memory_ref: z.string().min(1),
  action: GovernedMemoryCorrectionActionSchema,
  replacement_memory_ref: z.string().min(1).optional(),
  affected_use_classes: z.array(z.union([
    GovernedMemoryAllowedUseClassSchema,
    GovernedMemoryForbiddenUseClassSchema,
  ])).min(1),
  invalidation_ref: z.string().min(1).optional(),
  audit_ref: z.string().min(1),
  created_at: z.string().datetime(),
}).strict().superRefine((event, ctx) => {
  if ((event.action === "change_statement" || event.action === "supersede") && !event.replacement_memory_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["replacement_memory_ref"],
      message: `${event.action} correction events require a replacement memory ref`,
    });
  }

  if (["revoke_use", "suppress_projection", "mark_stale", "supersede", "retract", "delete"].includes(event.action)
    && !event.invalidation_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["invalidation_ref"],
      message: `${event.action} correction events must be available to Surface invalidation`,
    });
  }
});
export type GovernedMemoryCorrectionEvent = z.infer<typeof GovernedMemoryCorrectionEventSchema>;

export const GovernedMemoryAuditOutcomeSchema = z.enum([
  "considered",
  "included",
  "excluded",
  "allowed",
  "blocked",
  "stale",
  "superseded",
  "sensitive",
  "non_use",
]);
export type GovernedMemoryAuditOutcome = z.infer<typeof GovernedMemoryAuditOutcomeSchema>;

export const GovernedMemoryInfluenceClassSchema = z.enum([
  "notice",
  "urge",
  "inhibition",
  "expression",
  "work",
  "action",
]);
export type GovernedMemoryInfluenceClass = z.infer<typeof GovernedMemoryInfluenceClassSchema>;

export const GovernedMemoryRepairPathSchema = z.enum(["correct", "suppress", "revoke", "forget"]);
export type GovernedMemoryRepairPath = z.infer<typeof GovernedMemoryRepairPathSchema>;

export const GovernedMemoryUseAuditSchema = z.object({
  audit_id: z.string().min(1),
  memory_ref: z.string().min(1),
  lifecycle: GovernedMemoryLifecycleSchema,
  content_state: z.enum(["materialized", "redacted"]),
  requested_use: z.union([GovernedMemoryAllowedUseClassSchema, GovernedMemoryForbiddenUseClassSchema]),
  outcome: GovernedMemoryAuditOutcomeSchema,
  influenced: z.array(GovernedMemoryInfluenceClassSchema).default([]),
  gate_ref: z.string().min(1).optional(),
  redaction_ref: z.string().min(1).optional(),
  repair_paths: z.array(GovernedMemoryRepairPathSchema).default([]),
  created_at: z.string().datetime(),
}).strict().superRefine((audit, ctx) => {
  const mustBeRedacted = audit.content_state === "redacted"
    || audit.lifecycle === "tombstoned"
    || audit.lifecycle === "deleted";
  if (mustBeRedacted && !audit.redaction_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["redaction_ref"],
      message: "redacted, tombstoned, and deleted memory audit must expose only a redaction ref",
    });
  }
});
export type GovernedMemoryUseAudit = z.infer<typeof GovernedMemoryUseAuditSchema>;

export const GovernedMemoryUseDecisionStatusSchema = z.enum(["allowed", "blocked"]);
export type GovernedMemoryUseDecisionStatus = z.infer<typeof GovernedMemoryUseDecisionStatusSchema>;

export const GovernedMemoryUseBlockerSchema = z.enum([
  "allowed_use",
  "forbidden_use",
  "lifecycle",
  "correction_state",
  "redaction",
  "sensitivity",
]);
export type GovernedMemoryUseBlocker = z.infer<typeof GovernedMemoryUseBlockerSchema>;

export const GovernedMemoryUseDecisionSchema = z.object({
  memory_ref: z.string().min(1),
  requested_use: z.union([GovernedMemoryAllowedUseClassSchema, GovernedMemoryForbiddenUseClassSchema]),
  status: GovernedMemoryUseDecisionStatusSchema,
  outcome: GovernedMemoryAuditOutcomeSchema,
  blocked_by: z.array(GovernedMemoryUseBlockerSchema).default([]),
  audit: GovernedMemoryUseAuditSchema,
}).strict();
export type GovernedMemoryUseDecision = z.infer<typeof GovernedMemoryUseDecisionSchema>;

export type GovernedMemoryUseDecisionInput = {
  memory: unknown;
  requested_use: GovernedMemoryAllowedUseClass | GovernedMemoryForbiddenUseClass;
  audit_id: string;
  created_at: string;
  influenced?: GovernedMemoryInfluenceClass[];
  gate_ref?: string;
  redaction_ref?: string;
};

export function evaluateGovernedMemoryUse(input: GovernedMemoryUseDecisionInput): GovernedMemoryUseDecision {
  const memory = GovernedMemorySchema.parse(input.memory);
  const requestedUse = z.union([
    GovernedMemoryAllowedUseClassSchema,
    GovernedMemoryForbiddenUseClassSchema,
  ]).parse(input.requested_use);
  const blockedBy: GovernedMemoryUseBlocker[] = [];

  if (!memory.allowed_uses.includes(requestedUse as GovernedMemoryAllowedUseClass)) {
    blockedBy.push("allowed_use");
  }
  if (memory.not_allowed_uses.includes(requestedUse)) {
    blockedBy.push("forbidden_use");
  }
  if (GovernedMemoryForbiddenUseClassSchema.safeParse(requestedUse).success) {
    blockedBy.push("forbidden_use");
  }
  if (!SURFACE_PROJECTABLE_LIFECYCLES.includes(memory.lifecycle)) {
    blockedBy.push("lifecycle");
  }
  if (memory.correction_state !== "current" || memory.superseded_by_memory_id !== null) {
    blockedBy.push("correction_state");
  }
  if (memory.content.state === "redacted") {
    blockedBy.push("redaction");
  }
  if (memory.sensitivity === "sensitive" && requestedUse === "user_facing_reference") {
    blockedBy.push("sensitivity");
  }

  const blocked = blockedBy.length > 0;
  const redactionRef = input.redaction_ref
    ?? (memory.content.state === "redacted" ? memory.content.redaction_ref : undefined);
  const outcome = deriveGovernedMemoryUseOutcome(memory, blockedBy);
  const audit = GovernedMemoryUseAuditSchema.parse({
    audit_id: input.audit_id,
    memory_ref: memory.memory_id,
    lifecycle: memory.lifecycle,
    content_state: memory.content.state,
    requested_use: requestedUse,
    outcome,
    influenced: input.influenced ?? [],
    gate_ref: input.gate_ref,
    redaction_ref: redactionRef,
    repair_paths: deriveGovernedMemoryRepairPaths(memory, blockedBy),
    created_at: input.created_at,
  });

  return GovernedMemoryUseDecisionSchema.parse({
    memory_ref: memory.memory_id,
    requested_use: requestedUse,
    status: blocked ? "blocked" : "allowed",
    outcome,
    blocked_by: [...new Set(blockedBy)],
    audit,
  });
}

function deriveGovernedMemoryUseOutcome(
  memory: GovernedMemory,
  blockedBy: readonly GovernedMemoryUseBlocker[]
): GovernedMemoryAuditOutcome {
  if (!blockedBy.length) return "allowed";
  if (
    memory.lifecycle === "deleted"
    || memory.lifecycle === "tombstoned"
    || memory.content.state === "redacted"
  ) {
    return "non_use";
  }
  if (memory.lifecycle === "superseded" || memory.correction_state === "superseded") return "superseded";
  if (blockedBy.includes("sensitivity")) return "sensitive";
  if (blockedBy.includes("lifecycle") || memory.lifecycle === "decayed") return "stale";
  return "blocked";
}

function deriveGovernedMemoryRepairPaths(
  memory: GovernedMemory,
  blockedBy: readonly GovernedMemoryUseBlocker[]
): GovernedMemoryRepairPath[] {
  if (memory.lifecycle === "deleted" || memory.lifecycle === "tombstoned") return ["forget"];
  const repairPaths = new Set<GovernedMemoryRepairPath>(["correct", "suppress"]);
  if (blockedBy.includes("forbidden_use") || blockedBy.includes("allowed_use")) {
    repairPaths.add("revoke");
  }
  if (blockedBy.includes("redaction") || blockedBy.includes("lifecycle")) {
    repairPaths.add("forget");
  }
  return [...repairPaths];
}
