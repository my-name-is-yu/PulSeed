import { z } from "zod";
import {
  GovernedMemoryAllowedUseClassSchema,
  GovernedMemoryBlockedUseClassSchema,
  GovernedMemoryCorrectionStateSchema,
  GovernedMemoryCorrectionEventSchema,
  GovernedMemoryForbiddenUseClassSchema,
  GovernedMemoryLifecycleSchema,
  GovernedMemoryOwnerRefSchema,
  GovernedMemoryRecordKindSchema,
  GovernedMemoryRoleSchema,
  GovernedMemorySensitivitySchema,
  type GovernedMemoryLifecycle,
  type GovernedMemoryRole,
  type GovernedMemoryCorrectionEvent,
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
export type SurfaceDerivedRuntimeRefInput = z.input<typeof SurfaceDerivedRuntimeRefSchema>;

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
export type SurfaceProjectionInput = z.input<typeof SurfaceProjectionSchema>;

export const SurfaceRuntimeOperationSchema = z.enum([
  "speech",
  "notification",
  "action",
  "session_resume",
  "surface_update",
  "memory_write",
]);
export type SurfaceRuntimeOperation = z.infer<typeof SurfaceRuntimeOperationSchema>;

export const SurfaceRuntimeAuthorizationBasisSchema = z.enum([
  "runtime_authority",
  "relationship_permission",
  "memory_only",
  "unknown",
]);
export type SurfaceRuntimeAuthorizationBasis = z.infer<typeof SurfaceRuntimeAuthorizationBasisSchema>;

export const SurfaceRuntimeAdmissionStatusSchema = z.enum(["admitted", "blocked"]);
export type SurfaceRuntimeAdmissionStatus = z.infer<typeof SurfaceRuntimeAdmissionStatusSchema>;

export const SurfaceRuntimeAdmissionReasonSchema = z.enum([
  "admitted",
  "missing_dependency_ref",
  "invalid_surface",
  "stale_surface",
  "permission_blocked",
  "allowed_use_missing",
  "forbidden_use",
  "memory_is_not_authority",
  "runtime_authority_required",
  "authority_unknown",
]);
export type SurfaceRuntimeAdmissionReason = z.infer<typeof SurfaceRuntimeAdmissionReasonSchema>;

export const SurfaceRuntimeAdmissionRequestSchema = z.object({
  projection: SurfaceProjectionSchema,
  derived_ref: SurfaceDerivedRuntimeRefSchema,
  operation: SurfaceRuntimeOperationSchema,
  authorization_basis: SurfaceRuntimeAuthorizationBasisSchema,
  runtime_authority_ref: z.string().min(1).optional(),
  audit_ref: z.string().min(1).optional(),
}).strict();
export type SurfaceRuntimeAdmissionRequest = z.infer<typeof SurfaceRuntimeAdmissionRequestSchema>;
export type SurfaceRuntimeAdmissionRequestInput = z.input<typeof SurfaceRuntimeAdmissionRequestSchema>;

export const SurfaceRuntimeAdmissionSchema = z.object({
  status: SurfaceRuntimeAdmissionStatusSchema,
  reason: SurfaceRuntimeAdmissionReasonSchema,
  operation: SurfaceRuntimeOperationSchema,
  dependent_ref: z.string().min(1),
  related_surface_refs: z.array(z.string().min(1)),
  related_memory_refs: z.array(z.string().min(1)),
  blocked_refs: z.array(z.string().min(1)).default([]),
  required_rechecks: z.array(SurfaceGateKindSchema).default([]),
  audit_refs: z.array(z.string().min(1)).default([]),
}).strict().superRefine((admission, ctx) => {
  if (admission.status === "admitted" && admission.reason !== "admitted") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reason"],
      message: "admitted Surface runtime admissions must use admitted reason",
    });
  }
  if (admission.status === "blocked" && admission.reason === "admitted") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reason"],
      message: "blocked Surface runtime admissions require a blocker reason",
    });
  }
});
export type SurfaceRuntimeAdmission = z.infer<typeof SurfaceRuntimeAdmissionSchema>;

export function createSurfaceDerivedRuntimeRef(input: SurfaceDerivedRuntimeRefInput): SurfaceDerivedRuntimeRef {
  return SurfaceDerivedRuntimeRefSchema.parse(input);
}

export function attachSurfaceDependencyRef(
  projectionInput: SurfaceProjectionInput,
  derivedRefInput: SurfaceDerivedRuntimeRefInput
): SurfaceProjection {
  const projection = SurfaceProjectionSchema.parse(projectionInput);
  const derivedRef = SurfaceDerivedRuntimeRefSchema.parse(derivedRefInput);
  const groupName = dependentRefGroupForKind(derivedRef.kind);
  return SurfaceProjectionSchema.parse({
    ...projection,
    dependent_refs: {
      ...projection.dependent_refs,
      [groupName]: upsertSurfaceDerivedRuntimeRef(projection.dependent_refs[groupName], derivedRef),
    },
  });
}

export function evaluateSurfaceRuntimeAdmission(
  input: SurfaceRuntimeAdmissionRequestInput
): SurfaceRuntimeAdmission {
  const request = SurfaceRuntimeAdmissionRequestSchema.parse(input);
  const missingDependencyRefs = missingRuntimeDependencyRefs(request.projection, request.derived_ref);
  if (missingDependencyRefs.length > 0) {
    return buildSurfaceRuntimeAdmission(request, "blocked", "missing_dependency_ref", missingDependencyRefs);
  }
  if (request.projection.metadata.invalidation_state !== "valid") {
    return buildSurfaceRuntimeAdmission(request, "blocked", "invalid_surface", [request.projection.id]);
  }
  if (request.projection.metadata.staleness !== "fresh") {
    return buildSurfaceRuntimeAdmission(request, "blocked", "stale_surface", [
      request.projection.id,
      `metadata.staleness:${request.projection.metadata.staleness}`,
    ]);
  }
  if (request.projection.metadata.permission_state !== "granted") {
    return buildSurfaceRuntimeAdmission(request, "blocked", "permission_blocked", [
      request.projection.id,
      `metadata.permission_state:${request.projection.metadata.permission_state}`,
    ]);
  }
  if (!request.projection.allowed_runtime_uses.includes(request.derived_ref.use_class as z.infer<typeof GovernedMemoryAllowedUseClassSchema>)) {
    return buildSurfaceRuntimeAdmission(request, "blocked", "allowed_use_missing", [request.derived_ref.use_class]);
  }
  if (
    isForbiddenRequestedUse(request.derived_ref.use_class)
    || request.projection.not_allowed_runtime_uses.includes(request.derived_ref.use_class)
  ) {
    return buildSurfaceRuntimeAdmission(request, "blocked", "forbidden_use", [
      ...request.derived_ref.related_memory_refs,
      ...request.derived_ref.blocked_refs.map((ref) => ref.ref),
    ]);
  }
  if (request.authorization_basis === "memory_only") {
    return buildSurfaceRuntimeAdmission(request, "blocked", "memory_is_not_authority", request.derived_ref.related_memory_refs);
  }
  if (request.authorization_basis === "unknown") {
    return buildSurfaceRuntimeAdmission(request, "blocked", "authority_unknown", request.derived_ref.related_memory_refs);
  }
  if (request.authorization_basis !== "runtime_authority" && requiresRuntimeAuthority(request.operation)) {
    return buildSurfaceRuntimeAdmission(request, "blocked", "runtime_authority_required", request.derived_ref.related_memory_refs);
  }
  if (request.authorization_basis === "runtime_authority" && !request.runtime_authority_ref) {
    return buildSurfaceRuntimeAdmission(request, "blocked", "runtime_authority_required", request.derived_ref.related_memory_refs);
  }
  return buildSurfaceRuntimeAdmission(request, "admitted", "admitted", []);
}

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

export const SurfaceInspectionAdapterPayloadSchema = z.object({
  target: SurfaceProjectionTargetSchema,
  inspection: SurfaceInspectionViewSchema,
  prompt_dump: z.never().optional(),
}).strict();
export type SurfaceInspectionAdapterPayload = z.infer<typeof SurfaceInspectionAdapterPayloadSchema>;

export function createSurfaceInspectionAdapterPayload(
  projectionInput: SurfaceProjectionInput,
  target: SurfaceProjectionTarget
): SurfaceInspectionAdapterPayload {
  const projection = SurfaceProjectionSchema.parse(projectionInput);
  return SurfaceInspectionAdapterPayloadSchema.parse({
    target,
    inspection: createSurfaceInspectionView(projection, target),
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

export const SurfaceMemoryWriteCandidateStatusSchema = z.enum([
  "pending",
  "needs_revalidation",
  "accepted",
  "rejected",
]);
export type SurfaceMemoryWriteCandidateStatus = z.infer<typeof SurfaceMemoryWriteCandidateStatusSchema>;

export const SurfaceMemoryWriteCandidateSchema = z.object({
  schema_version: z.literal("surface-memory-write-candidate-v1").default("surface-memory-write-candidate-v1"),
  candidate_id: z.string().min(1),
  source_surface_ref: z.string().min(1),
  proposed_owner_ref: GovernedMemoryOwnerRefSchema,
  provenance_refs: z.array(SurfaceDependencyRefSchema).min(1),
  source_dependency_refs: z.array(SurfaceDependencyRefSchema).min(1),
  permission_check_refs: z.array(z.string().min(1)).min(1),
  deletion_check_refs: z.array(z.string().min(1)).min(1),
  source_evidence_check_refs: z.array(z.string().min(1)).min(1),
  status: SurfaceMemoryWriteCandidateStatusSchema.default("pending"),
  content_state: z.enum(["materialized", "redacted"]).default("materialized"),
  redaction_ref: z.string().min(1).optional(),
  audit_refs: z.array(z.string().min(1)).default([]),
}).strict().superRefine((candidate, ctx) => {
  const removedSource = candidate.source_dependency_refs.find(dependencyContentWasRemoved);
  if (candidate.content_state === "redacted" && !candidate.redaction_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["redaction_ref"],
      message: "redacted memory-write candidates must carry a redaction ref",
    });
  }
  if (removedSource && candidate.content_state !== "redacted") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content_state"],
      message: "memory-write candidates from deleted or tombstoned Surface sources must not retain reconstructable content",
    });
  }
  if (removedSource && candidate.status === "accepted") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "memory-write candidates from deleted or tombstoned Surface sources cannot be accepted",
    });
  }
});
export type SurfaceMemoryWriteCandidate = z.infer<typeof SurfaceMemoryWriteCandidateSchema>;
export type SurfaceMemoryWriteCandidateInput = z.input<typeof SurfaceMemoryWriteCandidateSchema>;

export const SurfaceMemoryWriteCandidateFreshCheckKindSchema = z.enum([
  "owner",
  "provenance",
  "permission",
  "deletion",
  "source_evidence",
]);
export type SurfaceMemoryWriteCandidateFreshCheckKind =
  z.infer<typeof SurfaceMemoryWriteCandidateFreshCheckKindSchema>;

export const SurfaceMemoryWriteCandidateFreshCheckStatusSchema = z.enum(["passed", "failed", "unknown"]);
export type SurfaceMemoryWriteCandidateFreshCheckStatus =
  z.infer<typeof SurfaceMemoryWriteCandidateFreshCheckStatusSchema>;

export const SurfaceMemoryWriteCandidateFreshCheckSchema = z.object({
  kind: SurfaceMemoryWriteCandidateFreshCheckKindSchema,
  status: SurfaceMemoryWriteCandidateFreshCheckStatusSchema,
  ref: z.string().min(1),
  reason: z.string().min(1),
  evidence_refs: z.array(SurfaceDependencyRefSchema).default([]),
}).strict();
export type SurfaceMemoryWriteCandidateFreshCheck =
  z.infer<typeof SurfaceMemoryWriteCandidateFreshCheckSchema>;
export type SurfaceMemoryWriteCandidateFreshCheckInput =
  z.input<typeof SurfaceMemoryWriteCandidateFreshCheckSchema>;

const MEMORY_WRITE_REVALIDATION_CHECK_KINDS = [
  "owner",
  "provenance",
  "permission",
  "deletion",
  "source_evidence",
] as const satisfies readonly SurfaceMemoryWriteCandidateFreshCheckKind[];

export const SurfaceMemoryWriteCandidateRevalidationStatusSchema = z.enum([
  "accepted",
  "needs_revalidation",
  "rejected",
  "not_affected",
]);
export type SurfaceMemoryWriteCandidateRevalidationStatus =
  z.infer<typeof SurfaceMemoryWriteCandidateRevalidationStatusSchema>;

export const SurfaceMemoryWriteCandidateRevalidationResultSchema = z.object({
  candidate: SurfaceMemoryWriteCandidateSchema,
  event_ref: z.string().min(1),
  surface_ref: z.string().min(1),
  status: SurfaceMemoryWriteCandidateRevalidationStatusSchema,
  required_check_kinds: z.array(SurfaceMemoryWriteCandidateFreshCheckKindSchema).min(1),
  missing_check_kinds: z.array(SurfaceMemoryWriteCandidateFreshCheckKindSchema).default([]),
  failed_check_kinds: z.array(SurfaceMemoryWriteCandidateFreshCheckKindSchema).default([]),
  fresh_checks: z.array(SurfaceMemoryWriteCandidateFreshCheckSchema).default([]),
  required_rechecks: z.array(SurfaceGateKindSchema).min(1),
  redaction_ref: z.string().min(1).optional(),
  audit_refs: z.array(z.string().min(1)).default([]),
  occurred_at: z.string().datetime(),
}).strict().superRefine((result, ctx) => {
  if (result.status === "accepted" && (result.missing_check_kinds.length > 0 || result.failed_check_kinds.length > 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "accepted memory-write candidate revalidation requires all fresh checks to pass",
    });
  }
  if (result.status === "rejected" && result.candidate.content_state === "redacted" && !result.redaction_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["redaction_ref"],
      message: "rejected redacted memory-write candidate revalidation must carry a redaction ref",
    });
  }
});
export type SurfaceMemoryWriteCandidateRevalidationResult =
  z.infer<typeof SurfaceMemoryWriteCandidateRevalidationResultSchema>;

export type SurfaceMemoryWriteCandidateRevalidationInput = {
  candidate: SurfaceMemoryWriteCandidateInput;
  event: SurfaceInvalidationEvent | z.input<typeof SurfaceInvalidationEventSchema>;
  occurred_at: string;
  fresh_checks?: SurfaceMemoryWriteCandidateFreshCheckInput[];
  audit_ref?: string;
  redaction_ref?: string;
};

export function revalidateSurfaceMemoryWriteCandidateAfterInvalidation(
  input: SurfaceMemoryWriteCandidateRevalidationInput
): SurfaceMemoryWriteCandidateRevalidationResult {
  const candidate = SurfaceMemoryWriteCandidateSchema.parse(input.candidate);
  const event = SurfaceInvalidationEventSchema.parse(input.event);
  const freshChecks = z.array(SurfaceMemoryWriteCandidateFreshCheckSchema).parse(input.fresh_checks ?? []);
  const affected = memoryWriteCandidateAffectedByInvalidation(candidate, event);
  const removedAffectedSource = affected
    && (triggerRequiresRedaction(event.trigger) || dependencyContentWasRemoved(event.source_ref.dependency_ref));
  const checkKinds = new Set(freshChecks.map((check) => check.kind));
  const missingCheckKinds = MEMORY_WRITE_REVALIDATION_CHECK_KINDS.filter((kind) => !checkKinds.has(kind));
  const failedCheckKinds = freshChecks
    .filter((check) => check.status === "failed")
    .map((check) => check.kind);
  const unknownCheckKinds = freshChecks
    .filter((check) => check.status === "unknown")
    .map((check) => check.kind);
  const unboundCheckKinds = freshChecks
    .filter((check) => check.status === "passed" && !freshCheckBindsToCandidate(candidate, check))
    .map((check) => check.kind);
  const status: SurfaceMemoryWriteCandidateRevalidationStatus = !affected
    ? "not_affected"
    : removedAffectedSource || failedCheckKinds.length > 0 || unboundCheckKinds.length > 0
      ? "rejected"
      : missingCheckKinds.length > 0 || unknownCheckKinds.length > 0
        ? "needs_revalidation"
        : "accepted";
  const redactionRef = removedAffectedSource
    ? input.redaction_ref ?? event.redaction_ref ?? `redaction:${event.id}:${candidate.candidate_id}`
    : candidate.redaction_ref;
  const updatedCandidate = SurfaceMemoryWriteCandidateSchema.parse({
    ...candidate,
    source_dependency_refs: removedAffectedSource
      ? candidate.source_dependency_refs.map((dependency) =>
          dependencyMatchesInvalidatedSource(dependency, event)
            ? event.source_ref.dependency_ref
            : dependency
        )
      : candidate.source_dependency_refs,
    status: status === "not_affected" ? candidate.status : status,
    content_state: removedAffectedSource ? "redacted" : candidate.content_state,
    redaction_ref: redactionRef,
    audit_refs: uniqueStrings([
      ...candidate.audit_refs,
      event.audit_ref,
      ...(input.audit_ref ? [input.audit_ref] : []),
    ]),
  });

  return SurfaceMemoryWriteCandidateRevalidationResultSchema.parse({
    candidate: updatedCandidate,
    event_ref: event.id,
    surface_ref: event.surface_ref,
    status,
    required_check_kinds: [...MEMORY_WRITE_REVALIDATION_CHECK_KINDS],
    missing_check_kinds: status === "not_affected" ? [] : missingCheckKinds,
    failed_check_kinds: status === "not_affected"
      ? []
      : uniqueStrings([...failedCheckKinds, ...unknownCheckKinds, ...unboundCheckKinds]),
    fresh_checks: freshChecks,
    required_rechecks: event.required_rechecks,
    redaction_ref: redactionRef,
    audit_refs: updatedCandidate.audit_refs,
    occurred_at: input.occurred_at,
  });
}

export const SurfaceInvalidationRunResultSchema = z.object({
  projection: SurfaceProjectionSchema,
  event: SurfaceInvalidationEventSchema,
  inspection: SurfaceInspectionViewSchema,
  blocked_admissions: z.array(SurfaceRuntimeAdmissionSchema),
}).strict();
export type SurfaceInvalidationRunResult = z.infer<typeof SurfaceInvalidationRunResultSchema>;

export function surfaceInvalidationEventsToRuntimeStateRefs(
  events: readonly (SurfaceInvalidationEvent | z.input<typeof SurfaceInvalidationEventSchema>)[]
): string[] {
  return uniqueStrings(events.map((event) => SurfaceInvalidationEventSchema.parse(event).surface_ref));
}

export type SurfaceMemoryCorrectionInvalidationInput = {
  projection: SurfaceProjectionInput;
  correction_event: GovernedMemoryCorrectionEvent | z.input<typeof GovernedMemoryCorrectionEventSchema>;
  occurred_at: string;
  redaction_ref?: string;
  affected_dependencies?: SurfaceDerivedRuntimeRefInput[];
  audit_ref?: string;
  policy_ref?: string;
};

export type SurfacePermissionInvalidationInput = {
  projection: SurfaceProjectionInput;
  source_ref: SurfaceMemorySourceRef;
  occurred_at: string;
  affected_dependencies?: SurfaceDerivedRuntimeRefInput[];
  audit_ref?: string;
  policy_ref?: string;
};

export function invalidateSurfaceProjectionFromMemoryCorrection(
  input: SurfaceMemoryCorrectionInvalidationInput
): SurfaceInvalidationRunResult {
  const projection = SurfaceProjectionSchema.parse(input.projection);
  const correctionEvent = GovernedMemoryCorrectionEventSchema.parse(input.correction_event);
  const source = projection.source_refs.find((candidate) => candidate.memory_id === correctionEvent.target_memory_ref);
  if (!source) {
    throw new Error(`SurfaceProjection ${projection.id} does not include corrected memory ${correctionEvent.target_memory_ref}`);
  }
  const trigger = triggerForMemoryCorrection(correctionEvent);
  const redactionRef = input.redaction_ref ?? redactionRefForCorrection(correctionEvent, trigger);
  return invalidateSurfaceProjection({
    projection,
    source_ref: source,
    trigger,
    occurred_at: input.occurred_at,
    redaction_ref: redactionRef,
    affected_dependencies: input.affected_dependencies,
    audit_ref: input.audit_ref ?? correctionEvent.audit_ref,
    policy_ref: input.policy_ref ?? correctionEvent.invalidation_ref ?? `surface:${projection.id}:policy:${trigger}`,
  });
}

export function invalidateSurfaceProjectionFromPermissionChange(
  input: SurfacePermissionInvalidationInput
): SurfaceInvalidationRunResult {
  const projection = SurfaceProjectionSchema.parse(input.projection);
  const sourceRef = SurfaceMemorySourceRefSchema.parse(input.source_ref);
  return invalidateSurfaceProjection({
    projection,
    source_ref: sourceRef,
    trigger: "permission_revocation",
    occurred_at: input.occurred_at,
    affected_dependencies: input.affected_dependencies,
    audit_ref: input.audit_ref ?? `audit:${sourceRef.memory_id}:permission-revocation`,
    policy_ref: input.policy_ref ?? `surface:${projection.id}:policy:permission_revocation`,
  });
}

type SurfaceInvalidationRunnerInput = {
  projection: SurfaceProjection;
  source_ref: SurfaceMemorySourceRef;
  trigger: SurfaceInvalidationTrigger;
  occurred_at: string;
  redaction_ref?: string;
  affected_dependencies?: SurfaceDerivedRuntimeRefInput[];
  audit_ref: string;
  policy_ref: string;
};

function invalidateSurfaceProjection(input: SurfaceInvalidationRunnerInput): SurfaceInvalidationRunResult {
  const sourceRef = SurfaceMemorySourceRefSchema.parse(input.source_ref);
  const affectedDependencies = resolveAffectedDependencies(input.projection, input.affected_dependencies);
  const invalidatedProjection = buildInvalidatedSurfaceProjection(input.projection, sourceRef, input.trigger, input.redaction_ref);
  const event = SurfaceInvalidationEventSchema.parse({
    id: `surface-invalidation:${input.projection.id}:${input.trigger}:${sourceRef.memory_id}`,
    policy_ref: input.policy_ref,
    surface_ref: input.projection.id,
    trigger: input.trigger,
    source_ref: redactedSourceForTrigger(sourceRef, input.trigger, input.redaction_ref),
    affected_dependencies: affectedDependencies,
    required_rechecks: [...SURFACE_GATE_ORDER],
    action: actionForInvalidationTrigger(input.trigger),
    redaction_ref: input.redaction_ref,
    audit_ref: input.audit_ref,
    occurred_at: input.occurred_at,
  });
  const blockedAdmissions = affectedDependencies.map((dependency) =>
    evaluateSurfaceRuntimeAdmission({
      projection: invalidatedProjection,
      derived_ref: dependency,
      operation: operationForDerivedRuntimeKind(dependency.kind),
      authorization_basis: "runtime_authority",
      runtime_authority_ref: `runtime-authority:${dependency.ref}`,
      audit_ref: input.audit_ref,
    })
  );

  return SurfaceInvalidationRunResultSchema.parse({
    projection: invalidatedProjection,
    event,
    inspection: createSurfaceInspectionView(invalidatedProjection, "daemon"),
    blocked_admissions: blockedAdmissions,
  });
}

function buildInvalidatedSurfaceProjection(
  projection: SurfaceProjection,
  sourceRef: SurfaceMemorySourceRef,
  trigger: SurfaceInvalidationTrigger,
  redactionRef?: string
): SurfaceProjection {
  const affectedSource = redactedSourceForTrigger(sourceRef, trigger, redactionRef);
  const redactionRequired = triggerRequiresRedaction(trigger);
  const blockedGate = trigger === "permission_revocation" || trigger === "permission_scope_narrowed"
    ? "permission"
    : "lifecycle";
  return SurfaceProjectionSchema.parse({
    ...projection,
    version: projection.version + 1,
    source_refs: projection.source_refs.map((candidate) =>
      surfaceMemorySourceMatches(candidate, sourceRef) ? affectedSource : candidate
    ),
    included_context: [],
    excluded_context: [{
      source_ref: affectedSource,
      requested_use: projection.requested_use,
      blocked_by: [{
        gate: blockedGate,
        status: "blocked",
        reason_ref: `surface:${projection.id}:${trigger}:${blockedGate}`,
        evaluated_at: projection.created_at,
      }],
      redaction_ref: redactionRequired ? redactionRef : undefined,
      inhibition_ref: trigger === "permission_revocation" ? `inhibition:${sourceRef.memory_id}:permission` : undefined,
      blocked_summary_ref: `summary:${projection.id}:${sourceRef.memory_id}:${trigger}`,
    }],
    rationale_entries: [{
      source_ref: affectedSource,
      decision: "excluded",
      gate: blockedGate,
      reason_ref: `rationale:${projection.id}:${sourceRef.memory_id}:${trigger}`,
      policy_refs: [`policy:${trigger}`],
      redaction_ref: redactionRequired ? redactionRef : undefined,
    }],
    metadata: {
      ...projection.metadata,
      staleness: "unknown",
      sensitivity: redactionRequired ? "sensitive" : projection.metadata.sensitivity,
      permission_state: trigger === "permission_revocation" || trigger === "permission_scope_narrowed"
        ? "blocked"
        : projection.metadata.permission_state,
      invalidation_state: "invalid",
      audit_refs: uniqueStrings([...projection.metadata.audit_refs, `audit:${projection.id}:${trigger}`]),
    },
  });
}

function redactedSourceForTrigger(
  sourceRef: SurfaceMemorySourceRef,
  trigger: SurfaceInvalidationTrigger,
  redactionRef?: string
): SurfaceMemorySourceRef {
  if (!triggerRequiresRedaction(trigger)) return sourceRef;
  if (!redactionRef) {
    throw new Error(`${trigger} requires a redaction_ref`);
  }
  const lifecycle = trigger === "memory_tombstone" ? "tombstoned" : "deleted";
  const reason = lifecycle === "tombstoned" ? "tombstoned" : "deleted";
  return SurfaceMemorySourceRefSchema.parse({
    ...sourceRef,
    domain_fields: {
      redaction_ref: redactionRef,
      reason,
    },
    allowed_uses: ["never_use_directly"],
    not_allowed_uses: uniqueBlockedUseClasses([...sourceRef.not_allowed_uses, ...sourceRef.allowed_uses]),
    lifecycle,
    correction_state: lifecycle === "deleted" ? "deleted" : sourceRef.correction_state,
    content_state: "redacted",
    dependency_ref: {
      ...sourceRef.dependency_ref,
      content_state: "redacted",
      lifecycle,
      correction_state: lifecycle === "deleted" ? "deleted" : sourceRef.correction_state,
    },
  });
}

function triggerRequiresRedaction(trigger: SurfaceInvalidationTrigger): boolean {
  return trigger === "memory_tombstone" || trigger === "memory_deletion" || trigger === "source_redaction";
}

function triggerForMemoryCorrection(event: GovernedMemoryCorrectionEvent): SurfaceInvalidationTrigger {
  if (event.action === "delete") return "memory_deletion";
  if (event.action === "retract") return "memory_retraction";
  if (event.action === "supersede") return "memory_supersession";
  return "memory_correction";
}

function redactionRefForCorrection(
  event: GovernedMemoryCorrectionEvent,
  trigger: SurfaceInvalidationTrigger
): string | undefined {
  if (!triggerRequiresRedaction(trigger)) return undefined;
  return event.invalidation_ref ? `${event.invalidation_ref}:redaction` : undefined;
}

function actionForInvalidationTrigger(trigger: SurfaceInvalidationTrigger): SurfaceInvalidationAction {
  if (triggerRequiresRedaction(trigger)) return "redact";
  if (trigger === "permission_revocation" || trigger === "permission_scope_narrowed") return "regate";
  if (trigger === "surface_expired") return "expire";
  return "regate";
}

function operationForDerivedRuntimeKind(kind: SurfaceDerivedRuntimeRef["kind"]): SurfaceRuntimeOperation {
  switch (kind) {
    case "expression_decision":
      return "speech";
    case "session_resume_attempt":
      return "session_resume";
    case "memory_write_candidate":
      return "memory_write";
    case "agenda_item":
    case "outcome_decision":
    case "runtime_item":
      return "action";
  }
}

function dependentRefGroupForKind(kind: SurfaceDerivedRuntimeRef["kind"]): keyof SurfaceProjection["dependent_refs"] {
  switch (kind) {
    case "runtime_item":
      return "runtime_items";
    case "agenda_item":
      return "agenda_items";
    case "outcome_decision":
      return "outcome_decisions";
    case "expression_decision":
      return "expression_decisions";
    case "memory_write_candidate":
      return "memory_write_candidates";
    case "session_resume_attempt":
      return "session_resume_attempts";
  }
}

function upsertSurfaceDerivedRuntimeRef(
  refs: SurfaceDerivedRuntimeRef[],
  nextRef: SurfaceDerivedRuntimeRef
): SurfaceDerivedRuntimeRef[] {
  return [...refs.filter((candidate) => candidate.ref !== nextRef.ref), nextRef];
}

function missingRuntimeDependencyRefs(
  projection: SurfaceProjection,
  derivedRef: SurfaceDerivedRuntimeRef
): string[] {
  const missing: string[] = [];
  const groupName = dependentRefGroupForKind(derivedRef.kind);
  const projectionRef = projection.dependent_refs[groupName].find((candidate) => candidate.ref === derivedRef.ref);
  const selectedMemoryRefs = new Set(projection.source_refs.map((source) => source.memory_id));
  const selectedPermissionRefs = new Set(projection.relationship_permissions.map((permission) => permission.permission_id));
  const selectedStalenessRefs = new Set(projection.staleness_checks);
  const selectedAuditRefs = new Set(projection.metadata.audit_refs);
  if (!projectionRef) missing.push(`dependent_refs.${groupName}:${derivedRef.ref}`);
  if (!derivedRef.related_surface_refs.includes(projection.id)) missing.push(`related_surface_refs:${projection.id}`);
  if (derivedRef.related_memory_refs.length === 0) missing.push("related_memory_refs");
  if (derivedRef.permission_check_refs.length === 0) missing.push("permission_check_refs");
  if (derivedRef.staleness_check_refs.length === 0) missing.push("staleness_check_refs");
  if (derivedRef.audit_refs.length === 0) missing.push("audit_refs");
  for (const ref of derivedRef.related_memory_refs) {
    if (!selectedMemoryRefs.has(ref)) missing.push(`related_memory_refs:${ref}`);
  }
  for (const ref of derivedRef.permission_check_refs) {
    if (!selectedPermissionRefs.has(ref)) missing.push(`permission_check_refs:${ref}`);
  }
  for (const ref of derivedRef.staleness_check_refs) {
    if (!selectedStalenessRefs.has(ref)) missing.push(`staleness_check_refs:${ref}`);
  }
  for (const ref of derivedRef.audit_refs) {
    if (!selectedAuditRefs.has(ref)) missing.push(`audit_refs:${ref}`);
  }
  return uniqueStrings(missing);
}

function memoryWriteCandidateAffectedByInvalidation(
  candidate: SurfaceMemoryWriteCandidate,
  event: SurfaceInvalidationEvent
): boolean {
  return candidate.source_surface_ref === event.surface_ref
    || event.affected_dependencies.some((dependency) =>
      dependency.kind === "memory_write_candidate" && dependency.ref === candidate.candidate_id
    )
    || candidate.source_dependency_refs.some((dependency) => dependencyMatchesInvalidatedSource(dependency, event));
}

function dependencyMatchesInvalidatedSource(
  dependency: SurfaceDependencyRef,
  event: SurfaceInvalidationEvent
): boolean {
  return dependency.ref === event.source_ref.memory_id
    || dependency.ref === event.source_ref.dependency_ref.ref;
}

function dependencyContentWasRemoved(dependency: SurfaceDependencyRef): boolean {
  return dependency.content_state === "redacted"
    || dependency.lifecycle === "tombstoned"
    || dependency.lifecycle === "deleted"
    || dependency.correction_state === "deleted";
}

function freshCheckBindsToCandidate(
  candidate: SurfaceMemoryWriteCandidate,
  check: SurfaceMemoryWriteCandidateFreshCheck
): boolean {
  if (check.evidence_refs.length === 0) return false;
  switch (check.kind) {
    case "owner":
      return check.ref === ownerRefKey(candidate.proposed_owner_ref)
        && check.evidence_refs.some((evidence) =>
          evidence.owning_store_ref
            ? ownerRefsEqual(evidence.owning_store_ref, candidate.proposed_owner_ref)
            : false
        );
    case "provenance":
      return candidate.provenance_refs.some((dependency) => dependency.ref === check.ref)
        && check.evidence_refs.some((evidence) =>
          candidate.provenance_refs.some((dependency) => surfaceDependencyRefsEqual(dependency, evidence))
        );
    case "permission":
      return candidate.permission_check_refs.includes(check.ref)
        && check.evidence_refs.some((evidence) =>
          evidence.kind === "permission_grant" && evidence.ref === check.ref
        );
    case "deletion":
      return candidate.deletion_check_refs.includes(check.ref)
        && check.evidence_refs.some((evidence) =>
          candidate.source_dependency_refs.some((dependency) => surfaceDependencyRefsEqual(dependency, evidence))
        );
    case "source_evidence":
      return candidate.source_evidence_check_refs.includes(check.ref)
        && check.evidence_refs.some((evidence) =>
          candidate.source_dependency_refs.some((dependency) => surfaceDependencyRefsEqual(dependency, evidence))
        );
  }
}

function ownerRefKey(ownerRef: z.infer<typeof GovernedMemoryOwnerRefSchema>): string {
  return `${ownerRef.kind}:${ownerRef.store_ref}:${ownerRef.record_ref}:${ownerRef.schema_version}`;
}

function ownerRefsEqual(
  left: z.infer<typeof GovernedMemoryOwnerRefSchema>,
  right: z.infer<typeof GovernedMemoryOwnerRefSchema>
): boolean {
  return ownerRefKey(left) === ownerRefKey(right);
}

function surfaceDependencyRefsEqual(left: SurfaceDependencyRef, right: SurfaceDependencyRef): boolean {
  return left.kind === right.kind && left.ref === right.ref;
}

function buildSurfaceRuntimeAdmission(
  request: SurfaceRuntimeAdmissionRequest,
  status: SurfaceRuntimeAdmissionStatus,
  reason: SurfaceRuntimeAdmissionReason,
  blockedRefs: string[]
): SurfaceRuntimeAdmission {
  return SurfaceRuntimeAdmissionSchema.parse({
    status,
    reason,
    operation: request.operation,
    dependent_ref: request.derived_ref.ref,
    related_surface_refs: request.derived_ref.related_surface_refs,
    related_memory_refs: request.derived_ref.related_memory_refs,
    blocked_refs: uniqueStrings(blockedRefs),
    required_rechecks: status === "blocked" ? [...SURFACE_GATE_ORDER] : [],
    audit_refs: uniqueStrings([
      ...request.derived_ref.audit_refs,
      ...(request.audit_ref ? [request.audit_ref] : []),
    ]),
  });
}

function requiresRuntimeAuthority(operation: SurfaceRuntimeOperation): boolean {
  return operation === "notification"
    || operation === "action"
    || operation === "session_resume"
    || operation === "surface_update"
    || operation === "memory_write";
}

function resolveAffectedDependencies(
  projection: SurfaceProjection,
  affectedDependencies?: SurfaceDerivedRuntimeRefInput[]
): SurfaceDerivedRuntimeRef[] {
  const dependencies = affectedDependencies === undefined
    ? Object.values(projection.dependent_refs).flat()
    : affectedDependencies.map((dependency) => SurfaceDerivedRuntimeRefSchema.parse(dependency));
  return z.array(SurfaceDerivedRuntimeRefSchema).min(1).parse(dependencies);
}

function surfaceMemorySourceMatches(left: SurfaceMemorySourceRef, right: SurfaceMemorySourceRef): boolean {
  return left.memory_id === right.memory_id
    && JSON.stringify(left.owning_store_ref) === JSON.stringify(right.owning_store_ref);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueBlockedUseClasses(
  values: Array<z.infer<typeof GovernedMemoryBlockedUseClassSchema>>
): Array<z.infer<typeof GovernedMemoryBlockedUseClassSchema>> {
  return [...new Set(values)];
}

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
