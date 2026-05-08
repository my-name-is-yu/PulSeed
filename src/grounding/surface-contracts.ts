import { z } from "zod";
import {
  GovernedMemoryAllowedUseClassSchema,
  GovernedMemoryBlockedUseClassSchema,
  GovernedMemoryCorrectionStateSchema,
  GovernedMemoryForbiddenUseClassSchema,
  GovernedMemoryLifecycleSchema,
  GovernedMemoryOwnerRefSchema,
  GovernedMemoryRecordKindSchema,
  GovernedMemoryRoleSchema,
  GovernedMemorySensitivitySchema,
  type GovernedMemoryLifecycle,
  type GovernedMemoryRole,
} from "../platform/profile/governed-memory.js";

export const SurfaceProjectionTargetSchema = z.enum([
  "chat",
  "tui",
  "cli",
  "daemon",
  "gateway",
  "gui",
  "agent_loop",
  "core_loop",
]);
export type SurfaceProjectionTarget = z.infer<typeof SurfaceProjectionTargetSchema>;

export const SurfaceRequestedUseSchema = z.union([
  GovernedMemoryAllowedUseClassSchema,
  GovernedMemoryForbiddenUseClassSchema,
]);
export type SurfaceRequestedUse = z.infer<typeof SurfaceRequestedUseSchema>;

export const SurfaceLaneSchema = z.enum([
  "knowledge",
  "work_memory",
  "relationship",
  "boundary",
  "promise",
  "tension",
  "anti_memory",
  "exclusion",
]);
export type SurfaceLane = z.infer<typeof SurfaceLaneSchema>;

export const SurfaceIncludedLaneSchema = z.enum([
  "knowledge",
  "work_memory",
  "relationship",
  "boundary",
  "promise",
  "tension",
  "anti_memory",
]);
export type SurfaceIncludedLane = z.infer<typeof SurfaceIncludedLaneSchema>;

export const SurfaceGateKindSchema = z.enum([
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
export type SurfaceGateKind = z.infer<typeof SurfaceGateKindSchema>;

export const SURFACE_GATE_ORDER: readonly SurfaceGateKind[] = [
  "scope",
  "lifecycle",
  "staleness",
  "sensitivity",
  "permission",
  "allowed_use",
  "forbidden_use",
  "projection",
  "audit",
];

export const SurfaceGateStatusSchema = z.enum(["passed", "blocked", "unknown"]);
export type SurfaceGateStatus = z.infer<typeof SurfaceGateStatusSchema>;

export const SurfaceDependencyKindSchema = z.enum([
  "memory_record",
  "permission_grant",
  "runtime_item",
  "agenda_item",
  "urge_candidate",
  "outcome_decision",
  "expression_decision",
  "memory_write_candidate",
  "session_resume_attempt",
  "audit_trace",
]);
export type SurfaceDependencyKind = z.infer<typeof SurfaceDependencyKindSchema>;

export const SurfaceDependencyRefSchema = z.object({
  kind: SurfaceDependencyKindSchema,
  ref: z.string().min(1),
  owning_store_ref: GovernedMemoryOwnerRefSchema.optional(),
  content_state: z.enum(["materialized", "redacted"]).default("materialized"),
  lifecycle: GovernedMemoryLifecycleSchema.optional(),
  correction_state: GovernedMemoryCorrectionStateSchema.optional(),
  superseded_by_memory_id: z.string().min(1).nullable().optional(),
  surface_ref: z.string().min(1).optional(),
}).strict();
export type SurfaceDependencyRef = z.infer<typeof SurfaceDependencyRefSchema>;

const SurfaceRedactedDomainFieldsSchema = z.object({
  redaction_ref: z.string().min(1),
  reason: z.enum(["sensitive", "tombstoned", "deleted", "permission_revoked", "scope_excluded"]),
}).strict();

export const SurfaceMemorySourceRefSchema = z.object({
  memory_id: z.string().min(1),
  owning_store_ref: GovernedMemoryOwnerRefSchema,
  role: GovernedMemoryRoleSchema,
  record_kind: GovernedMemoryRecordKindSchema,
  domain_fields: z.record(z.unknown()),
  allowed_uses: z.array(GovernedMemoryAllowedUseClassSchema).min(1),
  not_allowed_uses: z.array(GovernedMemoryBlockedUseClassSchema).default([]),
  lifecycle: GovernedMemoryLifecycleSchema,
  correction_state: GovernedMemoryCorrectionStateSchema.default("current"),
  superseded_by_memory_id: z.string().min(1).nullable().default(null),
  sensitivity: GovernedMemorySensitivitySchema,
  content_state: z.enum(["materialized", "redacted"]),
  dependency_ref: SurfaceDependencyRefSchema,
}).strict().superRefine((source, ctx) => {
  if (source.dependency_ref.kind !== "memory_record") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dependency_ref", "kind"],
      message: "Surface memory source refs must depend on a memory_record ref",
    });
  }

  if (source.dependency_ref.ref !== source.memory_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dependency_ref", "ref"],
      message: "Surface memory source dependency ref must match memory_id",
    });
  }

  if (!source.dependency_ref.owning_store_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dependency_ref", "owning_store_ref"],
      message: "Surface memory source dependency owner is required",
    });
  } else if (JSON.stringify(source.dependency_ref.owning_store_ref) !== JSON.stringify(source.owning_store_ref)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dependency_ref", "owning_store_ref"],
      message: "Surface memory source dependency owner must match owning_store_ref",
    });
  }

  if (!source.dependency_ref.lifecycle) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dependency_ref", "lifecycle"],
      message: "Surface memory source dependency lifecycle is required",
    });
  } else if (source.dependency_ref.lifecycle !== source.lifecycle) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dependency_ref", "lifecycle"],
      message: "Surface memory source dependency lifecycle must match source lifecycle",
    });
  }

  if (!source.dependency_ref.correction_state) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dependency_ref", "correction_state"],
      message: "Surface memory source dependency correction state is required",
    });
  } else if (source.dependency_ref.correction_state !== source.correction_state) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dependency_ref", "correction_state"],
      message: "Surface memory source dependency correction state must match source correction state",
    });
  }

  if (source.dependency_ref.superseded_by_memory_id !== source.superseded_by_memory_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dependency_ref", "superseded_by_memory_id"],
      message: "Surface memory source dependency supersession ref must match source supersession ref",
    });
  }

  if (source.dependency_ref.content_state !== source.content_state) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dependency_ref", "content_state"],
      message: "Surface memory source dependency content state must match source content state",
    });
  }

  if ((source.lifecycle === "tombstoned" || source.lifecycle === "deleted") && source.content_state !== "redacted") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content_state"],
      message: "deleted or tombstoned Surface source refs must be redacted",
    });
  }

  if (source.correction_state === "deleted" && source.content_state !== "redacted") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content_state"],
      message: "deleted correction-state Surface source refs must be redacted",
    });
  }

  const usesRedactedContent = source.content_state === "redacted"
    || source.lifecycle === "tombstoned"
    || source.lifecycle === "deleted"
    || source.correction_state === "deleted";
  if (usesRedactedContent && !SurfaceRedactedDomainFieldsSchema.safeParse(source.domain_fields).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["domain_fields"],
      message: "redacted, tombstoned, or deleted Surface source refs must expose only non-content redaction metadata",
    });
  }
});
export type SurfaceMemorySourceRef = z.infer<typeof SurfaceMemorySourceRefSchema>;

export const RelationshipPermissionSourceRefSchema = z.object({
  memory_id: z.string().min(1),
  owning_store_ref: GovernedMemoryOwnerRefSchema,
}).strict();
export type RelationshipPermissionSourceRef = z.infer<typeof RelationshipPermissionSourceRefSchema>;

export const SurfaceGateResultSchema = z.object({
  gate: SurfaceGateKindSchema,
  status: SurfaceGateStatusSchema,
  reason_ref: z.string().min(1).optional(),
  evaluated_at: z.string().datetime(),
}).strict();
export type SurfaceGateResult = z.infer<typeof SurfaceGateResultSchema>;

export const RelationshipPermissionSchema = z.object({
  permission_id: z.string().min(1),
  context_scope: z.string().min(1),
  memory_role_scope: z.array(GovernedMemoryRoleSchema).min(1),
  observation_permission: z.enum(["allowed", "blocked", "unknown"]),
  memory_use_permission: z.enum(["allowed", "blocked", "unknown"]),
  speakability: z.enum(["allowed", "blocked", "ask_first"]),
  proactive_permission: z.enum(["allowed", "blocked", "ask_first"]),
  interruption_tolerance: z.enum(["none", "low", "medium", "high"]),
  autonomy_level: z.enum(["observe_only", "ask_first", "quiet_work", "act_within_scope"]),
  confirmation_requirement: z.enum(["none", "before_speech", "before_action", "before_resume"]),
  emotional_language_boundary: z.enum(["neutral", "warm", "avoid"]),
  preferred_expression_modes: z.array(z.string().min(1)).default([]),
  forbidden_moves: z.array(z.string().min(1)).default([]),
  valid_from: z.string().datetime(),
  valid_to: z.string().datetime().nullable().default(null),
  source_refs: z.array(RelationshipPermissionSourceRefSchema).min(1),
}).strict();
export type RelationshipPermission = z.infer<typeof RelationshipPermissionSchema>;

const SurfaceIncludedContextSchemaBase = z.object({
  lane: SurfaceLaneSchema,
  source_ref: SurfaceMemorySourceRefSchema,
  use_class: GovernedMemoryAllowedUseClassSchema,
  excerpt: z.string().min(1),
  gates: z.array(SurfaceGateResultSchema).min(1),
}).strict();

export const SurfaceIncludedContextSchema = SurfaceIncludedContextSchemaBase.superRefine((context, ctx) => {
  if (context.lane === "exclusion") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["lane"],
      message: "included Surface context cannot use the Exclusion lane",
    });
  }

  if (context.lane !== expectedLaneForRole(context.source_ref.role)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["lane"],
      message: "included Surface lane must match the governed memory role lane",
    });
  }

  if (context.source_ref.role === "seed") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source_ref", "role"],
      message: "seed memory cannot be included as Surface context before owner acceptance",
    });
  }

  if (!context.source_ref.allowed_uses.includes(context.use_class)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["use_class"],
      message: "included Surface context use_class must be allowed by the source ref",
    });
  }

  if (context.source_ref.content_state === "redacted") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["excerpt"],
      message: "included Surface context cannot expose redacted source content",
    });
  }

  if (context.source_ref.sensitivity === "sensitive") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source_ref", "sensitivity"],
      message: "sensitive source content must be excluded or represented as inhibition, not included directly",
    });
  }

  if (!isSurfaceProjectableLifecycle(context.source_ref.lifecycle)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source_ref", "lifecycle"],
      message: "included Surface context requires active or matured source lifecycle",
    });
  }

  if (context.source_ref.correction_state !== "current" || context.source_ref.superseded_by_memory_id !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source_ref", "correction_state"],
      message: "corrected, superseded, retracted, deleted, or replaced Surface sources cannot be included",
    });
  }

  const gateCounts = new Map<SurfaceGateKind, number>();
  const gateStatuses = new Map<SurfaceGateKind, SurfaceGateStatus>();
  for (const gate of context.gates) {
    gateCounts.set(gate.gate, (gateCounts.get(gate.gate) ?? 0) + 1);
    gateStatuses.set(gate.gate, gate.status);
  }

  const duplicateGate = SURFACE_GATE_ORDER.find((gateName) => (gateCounts.get(gateName) ?? 0) > 1);
  if (duplicateGate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["gates"],
      message: `included Surface context must not duplicate ${duplicateGate} gate results`,
    });
  }

  const nonPassedGate = context.gates.find((gate) => gate.status !== "passed");
  if (nonPassedGate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["gates"],
      message: `included Surface context cannot include ${nonPassedGate.status} ${nonPassedGate.gate} gate`,
    });
  }

  const missingGate = SURFACE_GATE_ORDER.find((gateName) => gateStatuses.get(gateName) !== "passed");
  if (missingGate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["gates"],
      message: `included Surface context requires passed ${missingGate} gate`,
    });
  }
});
export type SurfaceIncludedContext = z.infer<typeof SurfaceIncludedContextSchema>;

export const SurfaceExcludedContextSchema = z.object({
  lane: z.literal("exclusion").default("exclusion"),
  source_ref: SurfaceMemorySourceRefSchema,
  requested_use: SurfaceRequestedUseSchema,
  blocked_by: z.array(SurfaceGateResultSchema).min(1),
  inhibition_ref: z.string().min(1).optional(),
  blocked_summary_ref: z.string().min(1).optional(),
  redaction_ref: z.string().min(1).optional(),
}).strict().superRefine((context, ctx) => {
  if (context.blocked_by.some((gate) => gate.status === "passed")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["blocked_by"],
      message: "excluded Surface context must be backed by blocked or unknown gates",
    });
  }

  if (context.source_ref.content_state === "redacted" && !context.redaction_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["redaction_ref"],
      message: "redacted excluded context must expose only a redaction ref",
    });
  }

  if ((context.source_ref.lifecycle === "tombstoned" || context.source_ref.lifecycle === "deleted") && !context.redaction_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["redaction_ref"],
      message: "deleted or tombstoned excluded context must expose only a redaction ref",
    });
  }
});
export type SurfaceExcludedContext = z.infer<typeof SurfaceExcludedContextSchema>;

export const SurfaceProjectionRationaleEntrySchema = z.object({
  source_ref: SurfaceMemorySourceRefSchema,
  decision: z.enum(["included", "excluded"]),
  gate: SurfaceGateKindSchema,
  reason_ref: z.string().min(1),
  policy_refs: z.array(z.string().min(1)).default([]),
  redaction_ref: z.string().min(1).optional(),
}).strict().superRefine((entry, ctx) => {
  const redactionRequired = entry.source_ref.content_state === "redacted"
    || entry.source_ref.lifecycle === "tombstoned"
    || entry.source_ref.lifecycle === "deleted";
  if (redactionRequired && !entry.redaction_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["redaction_ref"],
      message: "rationale for redacted or removed sources must use a redaction ref",
    });
  }
});
export type SurfaceProjectionRationaleEntry = z.infer<typeof SurfaceProjectionRationaleEntrySchema>;

export const SurfaceDerivedRuntimeRefSchema = z.object({
  kind: z.enum([
    "runtime_item",
    "agenda_item",
    "outcome_decision",
    "expression_decision",
    "memory_write_candidate",
    "session_resume_attempt",
  ]),
  ref: z.string().min(1),
  related_surface_refs: z.array(z.string().min(1)).min(1),
  related_memory_refs: z.array(z.string().min(1)).default([]),
  permission_check_refs: z.array(z.string().min(1)).default([]),
  staleness_check_refs: z.array(z.string().min(1)).default([]),
  use_class: SurfaceRequestedUseSchema,
  blocked_refs: z.array(SurfaceDependencyRefSchema).default([]),
  audit_refs: z.array(z.string().min(1)).default([]),
  missing_dependency_behavior: z.literal("fail_closed").default("fail_closed"),
}).strict();
export type SurfaceDerivedRuntimeRef = z.infer<typeof SurfaceDerivedRuntimeRefSchema>;

export const SurfaceProjectionSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().default(1),
  target: SurfaceProjectionTargetSchema,
  scope: z.object({
    kind: z.enum(["conversation", "task", "runtime_item", "inspection", "session_resume"]),
    ref: z.string().min(1),
  }).strict(),
  purpose: z.string().min(1),
  requested_use: SurfaceRequestedUseSchema,
  store_scope: z.literal("selected_refs").default("selected_refs"),
  source_refs: z.array(SurfaceMemorySourceRefSchema).min(1),
  relationship_permissions: z.array(RelationshipPermissionSchema).default([]),
  dependent_refs: z.object({
    runtime_items: z.array(SurfaceDerivedRuntimeRefSchema).default([]),
    agenda_items: z.array(SurfaceDerivedRuntimeRefSchema).default([]),
    outcome_decisions: z.array(SurfaceDerivedRuntimeRefSchema).default([]),
    expression_decisions: z.array(SurfaceDerivedRuntimeRefSchema).default([]),
    memory_write_candidates: z.array(SurfaceDerivedRuntimeRefSchema).default([]),
    session_resume_attempts: z.array(SurfaceDerivedRuntimeRefSchema).default([]),
  }).strict().default({}),
  included_context: z.array(SurfaceIncludedContextSchema).default([]),
  excluded_context: z.array(SurfaceExcludedContextSchema).default([]),
  allowed_runtime_uses: z.array(GovernedMemoryAllowedUseClassSchema).min(1),
  not_allowed_runtime_uses: z.array(GovernedMemoryBlockedUseClassSchema).default([]),
  gate_order: z.array(SurfaceGateKindSchema).default([...SURFACE_GATE_ORDER]),
  staleness_checks: z.array(z.string().min(1)).default([]),
  sensitivity_checks: z.array(z.string().min(1)).default([]),
  rationale_entries: z.array(SurfaceProjectionRationaleEntrySchema).default([]),
  metadata: z.object({
    staleness: z.enum(["fresh", "stale", "unknown"]),
    sensitivity: GovernedMemorySensitivitySchema,
    permission_state: z.enum(["granted", "blocked", "unknown"]),
    invalidation_state: z.enum(["valid", "invalid", "unknown"]),
    audit_refs: z.array(z.string().min(1)).default([]),
  }).strict(),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime().nullable().default(null),
}).strict().superRefine((projection, ctx) => {
  const selectedSourceKeys = new Set(projection.source_refs.map(surfaceSourceRefKey));
  validateContextSourcesSelected(projection.included_context, selectedSourceKeys, "included_context", ctx);
  validateContextSourcesSelected(projection.excluded_context, selectedSourceKeys, "excluded_context", ctx);
  validateRationaleSourcesSelected(projection.rationale_entries, selectedSourceKeys, ctx);

  if (projection.gate_order.join("\u0000") !== SURFACE_GATE_ORDER.join("\u0000")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["gate_order"],
      message: "Surface gates must stay in canonical scope-to-audit order",
    });
  }

  if (projection.included_context.length + projection.excluded_context.length > projection.source_refs.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source_refs"],
      message: "Surface projection context cannot exceed selected source refs",
    });
  }

  if (projection.included_context.length > 0 && projection.metadata.permission_state !== "granted") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["metadata", "permission_state"],
      message: "included Surface context requires granted projection permission metadata",
    });
  }

  if (projection.included_context.length > 0 && projection.metadata.staleness !== "fresh") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["metadata", "staleness"],
      message: "included Surface context requires fresh projection metadata",
    });
  }

  if (projection.included_context.length > 0 && projection.metadata.invalidation_state !== "valid") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["metadata", "invalidation_state"],
      message: "included Surface context requires valid projection metadata",
    });
  }

  if (projection.included_context.length > 0 && projection.metadata.sensitivity === "sensitive") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["metadata", "sensitivity"],
      message: "sensitive projection metadata cannot carry included context directly",
    });
  }

  if (projection.included_context.length > 0 && projection.relationship_permissions.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["relationship_permissions"],
      message: "included Surface context requires an explicit relationship permission input",
    });
  }

  if (isForbiddenRequestedUse(projection.requested_use) && projection.included_context.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["requested_use"],
      message: "forbidden requested uses can only produce excluded Surface context",
    });
  }

  if (
    projection.included_context.length > 0
    && !projection.allowed_runtime_uses.includes(projection.requested_use as z.infer<typeof GovernedMemoryAllowedUseClassSchema>)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowed_runtime_uses"],
      message: "included Surface context requires requested_use to be allowed by the projection",
    });
  }

  for (let index = 0; index < projection.included_context.length; index += 1) {
    const context = projection.included_context[index];
    if (!context) {
      continue;
    }

    if (context.use_class !== projection.requested_use) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["included_context", index, "use_class"],
        message: "included context use_class must match the Surface requested_use",
      });
    }

    if (!hasRationaleForSource(projection, context.source_ref, "included")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["included_context", index, "source_ref"],
        message: "included context requires a projection rationale entry",
      });
    }

    if (projection.not_allowed_runtime_uses.includes(projection.requested_use)
      || context.source_ref.not_allowed_uses.includes(projection.requested_use)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["included_context", index, "source_ref", "not_allowed_uses"],
        message: "forbidden-use policy wins over Surface inclusion",
      });
    }

    const permission = projection.relationship_permissions.find((candidate) =>
      candidate.memory_role_scope.includes(context.source_ref.role)
      && candidate.source_refs.some((sourceRef) => relationshipPermissionSourceMatches(sourceRef, context.source_ref))
    );
    if (projection.relationship_permissions.length > 0 && !permission) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["included_context", index, "source_ref", "role"],
        message: "included context requires relationship permission for its role lane and memory source",
      });
    } else if (permission) {
      if (permission.memory_use_permission !== "allowed") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["relationship_permissions"],
          message: "relationship permission must allow memory use for included context",
        });
      }
      if (context.use_class === "user_facing_reference" && permission.speakability === "blocked") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["relationship_permissions"],
          message: "relationship permission blocks speaking this memory",
        });
      }
      if (context.use_class === "proactive_action_candidate" && permission.proactive_permission === "blocked") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["relationship_permissions"],
          message: "relationship permission blocks proactive use of this memory",
        });
      }
    }
  }

  for (let index = 0; index < projection.excluded_context.length; index += 1) {
    const context = projection.excluded_context[index];
    if (context && !hasRationaleForSource(projection, context.source_ref, "excluded")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["excluded_context", index, "source_ref"],
        message: "excluded context requires a projection rationale entry",
      });
    }
  }

  for (const [groupName, refs] of Object.entries(projection.dependent_refs)) {
    for (let index = 0; index < refs.length; index += 1) {
      const ref = refs[index];
      if (ref && !ref.related_surface_refs.includes(projection.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dependent_refs", groupName, index, "related_surface_refs"],
          message: "Surface-derived runtime refs must point back to the SurfaceProjection they used",
        });
      }
    }
  }
});
export type SurfaceProjection = z.infer<typeof SurfaceProjectionSchema>;

export const SurfaceInspectionViewSchema = z.object({
  surface_id: z.string().min(1),
  version: z.number().int().positive(),
  target: SurfaceProjectionTargetSchema,
  scope: z.object({
    kind: z.enum(["conversation", "task", "runtime_item", "inspection", "session_resume"]),
    ref: z.string().min(1),
  }).strict(),
  source_refs: z.array(SurfaceDependencyRefSchema),
  gate_outcomes: z.array(SurfaceGateResultSchema),
  included_summaries: z.array(z.object({
    lane: SurfaceIncludedLaneSchema,
    memory_id: z.string().min(1),
    record_kind: GovernedMemoryRecordKindSchema,
    use_class: GovernedMemoryAllowedUseClassSchema,
    summary_ref: z.string().min(1),
  }).strict()).default([]),
  excluded_summaries: z.array(z.object({
    lane: z.literal("exclusion"),
    memory_id: z.string().min(1),
    requested_use: SurfaceRequestedUseSchema,
    blocked_by: z.array(SurfaceGateKindSchema).min(1),
    redaction_ref: z.string().min(1).optional(),
    inhibition_ref: z.string().min(1).optional(),
  }).strict()).default([]),
  redacted_audit_refs: z.array(z.string().min(1)).default([]),
  invalidation_state: z.enum(["valid", "invalid", "unknown"]),
}).strict();
export type SurfaceInspectionView = z.infer<typeof SurfaceInspectionViewSchema>;

export function createSurfaceInspectionView(
  projection: SurfaceProjection,
  target: SurfaceProjectionTarget,
): SurfaceInspectionView {
  return SurfaceInspectionViewSchema.parse({
    surface_id: projection.id,
    version: projection.version,
    target,
    scope: projection.scope,
    source_refs: projection.source_refs.map((source) => source.dependency_ref),
    gate_outcomes: [
      ...projection.included_context.flatMap((context) => context.gates),
      ...projection.excluded_context.flatMap((context) => context.blocked_by),
    ],
    included_summaries: projection.included_context.map((context) => ({
      lane: context.lane,
      memory_id: context.source_ref.memory_id,
      record_kind: context.source_ref.record_kind,
      use_class: context.use_class,
      summary_ref: rationaleRefForSource(projection, context.source_ref, "included"),
    })),
    excluded_summaries: projection.excluded_context.map((context) => ({
      lane: "exclusion",
      memory_id: context.source_ref.memory_id,
      requested_use: context.requested_use,
      blocked_by: context.blocked_by.map((gate) => gate.gate),
      redaction_ref: context.redaction_ref,
      inhibition_ref: context.inhibition_ref,
    })),
    redacted_audit_refs: projection.metadata.audit_refs,
    invalidation_state: projection.metadata.invalidation_state,
  });
}

export const SurfaceInvalidationTriggerSchema = z.enum([
  "memory_correction",
  "memory_retraction",
  "memory_supersession",
  "memory_tombstone",
  "memory_deletion",
  "permission_revocation",
  "permission_scope_narrowed",
  "boundary_change",
  "intervention_policy_changed",
  "stale_session",
  "runtime_item_stale",
  "source_redaction",
  "goal_scope_changed",
  "surface_expired",
]);
export type SurfaceInvalidationTrigger = z.infer<typeof SurfaceInvalidationTriggerSchema>;

export const SurfaceInvalidationActionSchema = z.enum([
  "hold",
  "expire",
  "reject",
  "regate",
  "redact",
  "withdraw",
  "needs_review",
]);
export type SurfaceInvalidationAction = z.infer<typeof SurfaceInvalidationActionSchema>;

export const SurfaceInvalidationPolicySchema = z.object({
  id: z.string().min(1),
  surface_ref: z.string().min(1),
  source_refs: z.array(SurfaceDependencyRefSchema).min(1),
  triggers: z.array(SurfaceInvalidationTriggerSchema).min(1),
  affected_dependency_policies: z.array(z.object({
    dependency_kind: SurfaceDependencyKindSchema,
    action: SurfaceInvalidationActionSchema,
  }).strict()).min(1),
  missing_dependency_behavior: z.literal("fail_closed").default("fail_closed"),
  contradictory_dependency_behavior: z.literal("fail_closed").default("fail_closed"),
  regeneration_policy: z.object({
    rerun_gates: z.array(SurfaceGateKindSchema).default([...SURFACE_GATE_ORDER]),
    copy_included_context_forward: z.literal(false).default(false),
    ambiguous_trigger_behavior: z.literal("fail_closed").default("fail_closed"),
  }).strict().default({}),
  audit_policy: z.object({
    audit_ref: z.string().min(1),
    redacts_deleted_content: z.boolean().default(true),
  }).strict(),
}).strict().superRefine((policy, ctx) => {
  const contentRemoval = policy.triggers.some((trigger) =>
    trigger === "memory_tombstone" || trigger === "memory_deletion" || trigger === "source_redaction"
  );
  if (contentRemoval && !policy.audit_policy.redacts_deleted_content) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["audit_policy", "redacts_deleted_content"],
      message: "content-removal invalidation policies must redact deleted content",
    });
  }

  if (policy.regeneration_policy.rerun_gates.join("\u0000") !== SURFACE_GATE_ORDER.join("\u0000")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["regeneration_policy", "rerun_gates"],
      message: "Surface regeneration must rerun the full canonical gate order",
    });
  }
});
export type SurfaceInvalidationPolicy = z.infer<typeof SurfaceInvalidationPolicySchema>;

export const SurfaceInvalidationEventSchema = z.object({
  id: z.string().min(1),
  policy_ref: z.string().min(1),
  surface_ref: z.string().min(1),
  trigger: SurfaceInvalidationTriggerSchema,
  source_ref: SurfaceMemorySourceRefSchema,
  affected_dependencies: z.array(SurfaceDerivedRuntimeRefSchema).min(1),
  required_rechecks: z.array(SurfaceGateKindSchema).min(1),
  action: SurfaceInvalidationActionSchema,
  redaction_ref: z.string().min(1).optional(),
  audit_ref: z.string().min(1),
  occurred_at: z.string().datetime(),
}).strict().superRefine((event, ctx) => {
  if (
    (event.trigger === "memory_tombstone" || event.trigger === "memory_deletion" || event.trigger === "source_redaction")
    && !event.redaction_ref
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["redaction_ref"],
      message: "content-removal invalidation events must carry a redaction ref",
    });
  }

  if (
    (event.source_ref.lifecycle === "tombstoned" || event.source_ref.lifecycle === "deleted")
    && event.source_ref.content_state !== "redacted"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source_ref", "content_state"],
      message: "deleted or tombstoned invalidation sources must be redacted",
    });
  }

  for (let index = 0; index < event.affected_dependencies.length; index += 1) {
    const dependency = event.affected_dependencies[index];
    if (dependency && !dependency.related_surface_refs.includes(event.surface_ref)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["affected_dependencies", index, "related_surface_refs"],
        message: "affected dependencies must point back to the invalidated SurfaceProjection",
      });
    }
  }
});
export type SurfaceInvalidationEvent = z.infer<typeof SurfaceInvalidationEventSchema>;

function surfaceSourceRefKey(source: SurfaceMemorySourceRef): string {
  return JSON.stringify(source);
}

function isSurfaceProjectableLifecycle(lifecycle: GovernedMemoryLifecycle): boolean {
  return lifecycle === "active" || lifecycle === "matured";
}

function expectedLaneForRole(role: GovernedMemoryRole): SurfaceLane {
  return role === "seed" ? "knowledge" : role;
}

function isForbiddenRequestedUse(use: SurfaceRequestedUse): boolean {
  return GovernedMemoryForbiddenUseClassSchema.safeParse(use).success;
}

function relationshipPermissionSourceMatches(
  permissionSource: RelationshipPermissionSourceRef,
  memorySource: SurfaceMemorySourceRef,
): boolean {
  return permissionSource.memory_id === memorySource.memory_id
    && JSON.stringify(permissionSource.owning_store_ref) === JSON.stringify(memorySource.owning_store_ref);
}

function validateContextSourcesSelected(
  contexts: readonly (SurfaceIncludedContext | SurfaceExcludedContext)[],
  selectedSourceKeys: Set<string>,
  path: "included_context" | "excluded_context",
  ctx: z.RefinementCtx,
): void {
  for (let index = 0; index < contexts.length; index += 1) {
    const context = contexts[index];
    if (context && !selectedSourceKeys.has(surfaceSourceRefKey(context.source_ref))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path, index, "source_ref"],
        message: `${path} source_ref must be selected in source_refs`,
      });
    }
  }
}

function validateRationaleSourcesSelected(
  entries: readonly SurfaceProjectionRationaleEntry[],
  selectedSourceKeys: Set<string>,
  ctx: z.RefinementCtx,
): void {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry && !selectedSourceKeys.has(surfaceSourceRefKey(entry.source_ref))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rationale_entries", index, "source_ref"],
        message: "rationale entry source_ref must be selected in source_refs",
      });
    }
  }
}

function rationaleRefForSource(
  projection: SurfaceProjection,
  source: SurfaceMemorySourceRef,
  decision: "included" | "excluded",
): string {
  return projection.rationale_entries.find((entry) =>
    entry.decision === decision && surfaceSourceRefKey(entry.source_ref) === surfaceSourceRefKey(source)
  )?.reason_ref ?? `surface:${projection.id}:rationale:${source.memory_id}:${decision}`;
}

function hasRationaleForSource(
  projection: SurfaceProjection,
  source: SurfaceMemorySourceRef,
  decision: "included" | "excluded",
): boolean {
  return projection.rationale_entries.some((entry) =>
    entry.decision === decision && surfaceSourceRefKey(entry.source_ref) === surfaceSourceRefKey(source)
  );
}
