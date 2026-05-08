import { z } from "zod";

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
  "relationship",
  "profile",
  "runtime_evidence",
  "knowledge_retrieval",
  "proposal_seed",
  "anti_memory",
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
  "seed_candidate",
  "active",
  "suppressed",
  "superseded",
  "retracted",
  "retired",
  "tombstoned",
  "deleted",
]);
export type GovernedMemoryLifecycle = z.infer<typeof GovernedMemoryLifecycleSchema>;

export const GovernedMemoryUseClassSchema = z.enum([
  "surface_projection",
  "memory_retrieval",
  "local_planning",
  "resident_behavior",
  "user_facing_review",
  "runtime_admission",
  "outcome_decision",
  "expression_decision",
  "session_resume",
  "memory_write_candidate",
  "audit_only",
]);
export type GovernedMemoryUseClass = z.infer<typeof GovernedMemoryUseClassSchema>;

export const GovernedMemoryEpistemicStatusSchema = z.enum([
  "observed",
  "inferred",
  "reported_by_user",
  "system_derived",
  "candidate",
  "contradicted",
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

export const GovernedMemoryProjectionPolicySchema = z.object({
  allowed_uses: z.array(GovernedMemoryUseClassSchema).min(1),
  forbidden_uses: z.array(GovernedMemoryUseClassSchema).default([]),
  requires_permission_gate: z.boolean().default(true),
  surface_eligible: z.boolean().default(true),
}).strict().superRefine((policy, ctx) => {
  const forbidden = new Set(policy.forbidden_uses);
  for (const use of policy.allowed_uses) {
    if (forbidden.has(use)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["forbidden_uses"],
        message: `use class cannot be both allowed and forbidden: ${use}`,
      });
    }
  }
});
export type GovernedMemoryProjectionPolicy = z.infer<typeof GovernedMemoryProjectionPolicySchema>;

const REQUIRED_DOMAIN_FIELDS: Record<GovernedMemoryRecordKind, readonly string[]> = {
  stable_profile_fact: ["stable_key", "fact"],
  preference: ["subject", "preference"],
  routine: ["routine_name", "cadence"],
  boundary: ["boundary", "scope"],
  intervention_policy: ["trigger", "policy"],
  episodic_event: ["event_ref", "occurred_at"],
  promise: ["promise", "due_state"],
  correction: ["target_ref", "correction"],
  relationship_posture: ["posture", "basis"],
  consent_scope: ["scope", "grant_state"],
  work_commitment: ["commitment", "status"],
  project_fact: ["project_ref", "fact"],
  knowledge_fact: ["knowledge_ref", "fact"],
  open_tension: ["tension", "status"],
  anti_memory_rule: ["rule", "forbidden_use"],
  seed_candidate: ["candidate_ref", "hypothesis"],
};

export function requiredGovernedMemoryDomainFields(kind: GovernedMemoryRecordKind): readonly string[] {
  return REQUIRED_DOMAIN_FIELDS[kind];
}

export const GovernedMemorySchema = z.object({
  id: z.string().min(1),
  owner_ref: GovernedMemoryOwnerRefSchema,
  role: GovernedMemoryRoleSchema,
  record_kind: GovernedMemoryRecordKindSchema,
  lifecycle: GovernedMemoryLifecycleSchema,
  domain_fields: z.record(z.unknown()),
  content: GovernedMemoryContentSchema,
  epistemic_status: GovernedMemoryEpistemicStatusSchema,
  confidence: z.number().min(0).max(1).nullable().default(null),
  source_reliability: z.number().min(0).max(1).nullable().default(null),
  sensitivity: GovernedMemorySensitivitySchema.default("private"),
  projection_policy: GovernedMemoryProjectionPolicySchema,
  supersedes: z.array(z.string().min(1)).default([]),
  superseded_by: z.string().min(1).nullable().default(null),
  audit_refs: z.array(z.string().min(1)).default([]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict().superRefine((record, ctx) => {
  for (const field of REQUIRED_DOMAIN_FIELDS[record.record_kind]) {
    if (record.domain_fields[field] === undefined || record.domain_fields[field] === null || record.domain_fields[field] === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["domain_fields", field],
        message: `${field} is required for ${record.record_kind}`,
      });
    }
  }

  if ((record.lifecycle === "tombstoned" || record.lifecycle === "deleted") && record.content.state !== "redacted") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content"],
      message: "tombstoned and deleted memory must use a redacted ref instead of reconstructable text",
    });
  }

  if (
    record.lifecycle !== "active"
    && (record.projection_policy.surface_eligible || record.projection_policy.allowed_uses.includes("surface_projection"))
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["projection_policy"],
      message: "only active governed memory can be eligible for normal Surface projection",
    });
  }

  if (
    record.lifecycle === "active"
    && record.content.state === "redacted"
    && (record.projection_policy.surface_eligible || record.projection_policy.allowed_uses.includes("surface_projection"))
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["projection_policy", "surface_eligible"],
      message: "active redacted memory cannot be eligible for normal Surface projection",
    });
  }
});
export type GovernedMemory = z.infer<typeof GovernedMemorySchema>;
export type GovernedMemoryInput = z.input<typeof GovernedMemorySchema>;
