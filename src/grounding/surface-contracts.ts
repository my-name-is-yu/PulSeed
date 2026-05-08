import { z } from "zod";
import {
  GovernedMemoryLifecycleSchema,
  GovernedMemoryOwnerRefSchema,
  GovernedMemoryRecordKindSchema,
  GovernedMemorySensitivitySchema,
  GovernedMemoryUseClassSchema,
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
  owner_ref: GovernedMemoryOwnerRefSchema.optional(),
  content_state: z.enum(["materialized", "redacted"]).default("materialized"),
  lifecycle: GovernedMemoryLifecycleSchema.optional(),
}).strict();
export type SurfaceDependencyRef = z.infer<typeof SurfaceDependencyRefSchema>;

export const SurfaceMemorySourceRefSchema = z.object({
  memory_id: z.string().min(1),
  owner_ref: GovernedMemoryOwnerRefSchema,
  record_kind: GovernedMemoryRecordKindSchema,
  lifecycle: GovernedMemoryLifecycleSchema,
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

  if (!source.dependency_ref.owner_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dependency_ref", "owner_ref"],
      message: "Surface memory source dependency owner is required",
    });
  } else if (JSON.stringify(source.dependency_ref.owner_ref) !== JSON.stringify(source.owner_ref)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dependency_ref", "owner_ref"],
      message: "Surface memory source dependency owner must match owner_ref",
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
});
export type SurfaceMemorySourceRef = z.infer<typeof SurfaceMemorySourceRefSchema>;

export const SurfaceGateResultSchema = z.object({
  gate: SurfaceGateKindSchema,
  status: SurfaceGateStatusSchema,
  reason_ref: z.string().min(1).optional(),
  evaluated_at: z.string().datetime(),
}).strict();
export type SurfaceGateResult = z.infer<typeof SurfaceGateResultSchema>;

export const SurfaceIncludedContextSchema = z.object({
  source_ref: SurfaceMemorySourceRefSchema,
  use_class: GovernedMemoryUseClassSchema,
  excerpt: z.string().min(1),
  gates: z.array(SurfaceGateResultSchema).min(1),
}).strict().superRefine((context, ctx) => {
  if (context.source_ref.content_state === "redacted") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["excerpt"],
      message: "included Surface context cannot expose redacted source content",
    });
  }

  if (context.source_ref.lifecycle !== "active") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source_ref", "lifecycle"],
      message: "included Surface context requires an active source lifecycle",
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
  source_ref: SurfaceMemorySourceRefSchema,
  blocked_by: z.array(SurfaceGateResultSchema).min(1),
  inhibition_ref: z.string().min(1).optional(),
  redaction_ref: z.string().min(1).optional(),
}).strict().superRefine((context, ctx) => {
  if (context.source_ref.content_state === "redacted" && !context.redaction_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["redaction_ref"],
      message: "redacted excluded context must expose only a redaction ref",
    });
  }
});
export type SurfaceExcludedContext = z.infer<typeof SurfaceExcludedContextSchema>;

export const SurfaceProjectionSchema = z.object({
  id: z.string().min(1),
  target: SurfaceProjectionTargetSchema,
  purpose: z.string().min(1),
  store_scope: z.literal("selected_refs").default("selected_refs"),
  source_refs: z.array(SurfaceMemorySourceRefSchema).min(1),
  included_context: z.array(SurfaceIncludedContextSchema).default([]),
  excluded_context: z.array(SurfaceExcludedContextSchema).default([]),
  gate_order: z.array(SurfaceGateKindSchema).default([...SURFACE_GATE_ORDER]),
  metadata: z.object({
    staleness: z.enum(["fresh", "stale", "unknown"]),
    sensitivity: GovernedMemorySensitivitySchema,
    permission_state: z.enum(["granted", "blocked", "unknown"]),
    invalidation_state: z.enum(["valid", "invalid", "unknown"]),
    audit_refs: z.array(z.string().min(1)).default([]),
  }).strict(),
  created_at: z.string().datetime(),
}).strict().superRefine((projection, ctx) => {
  const selectedSourceKeys = new Set(projection.source_refs.map(surfaceSourceRefKey));
  for (let index = 0; index < projection.included_context.length; index += 1) {
    const context = projection.included_context[index];
    if (context && !selectedSourceKeys.has(surfaceSourceRefKey(context.source_ref))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["included_context", index, "source_ref"],
        message: "included context source_ref must be selected in source_refs",
      });
    }
  }
  for (let index = 0; index < projection.excluded_context.length; index += 1) {
    const context = projection.excluded_context[index];
    if (context && !selectedSourceKeys.has(surfaceSourceRefKey(context.source_ref))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["excluded_context", index, "source_ref"],
        message: "excluded context source_ref must be selected in source_refs",
      });
    }
  }

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
});
export type SurfaceProjection = z.infer<typeof SurfaceProjectionSchema>;

function surfaceSourceRefKey(source: SurfaceMemorySourceRef): string {
  return JSON.stringify(source);
}

export const SurfaceInvalidationTriggerSchema = z.enum([
  "memory_correction",
  "memory_retraction",
  "memory_supersession",
  "memory_tombstone",
  "memory_deletion",
  "permission_revocation",
  "boundary_change",
  "stale_session",
  "source_redaction",
]);
export type SurfaceInvalidationTrigger = z.infer<typeof SurfaceInvalidationTriggerSchema>;

export const SurfaceInvalidationActionSchema = z.enum([
  "hold",
  "expire",
  "reject",
  "regate",
  "redact",
  "withdraw",
]);
export type SurfaceInvalidationAction = z.infer<typeof SurfaceInvalidationActionSchema>;

export const SurfaceInvalidationPolicySchema = z.object({
  id: z.string().min(1),
  triggers: z.array(SurfaceInvalidationTriggerSchema).min(1),
  dependency_kinds: z.array(SurfaceDependencyKindSchema).min(1),
  missing_dependency_behavior: z.literal("fail_closed").default("fail_closed"),
  contradictory_dependency_behavior: z.literal("fail_closed").default("fail_closed"),
  default_action: SurfaceInvalidationActionSchema,
  redacts_deleted_content: z.boolean().default(true),
  audit_refs: z.array(z.string().min(1)).default([]),
}).strict().superRefine((policy, ctx) => {
  if (
    policy.triggers.some((trigger) =>
      trigger === "memory_tombstone" || trigger === "memory_deletion" || trigger === "source_redaction"
    )
    && !policy.redacts_deleted_content
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["redacts_deleted_content"],
      message: "content-removal invalidation policies must redact deleted content",
    });
  }
});
export type SurfaceInvalidationPolicy = z.infer<typeof SurfaceInvalidationPolicySchema>;

export const SurfaceInvalidationEventSchema = z.object({
  id: z.string().min(1),
  policy_ref: z.string().min(1),
  trigger: SurfaceInvalidationTriggerSchema,
  source_ref: SurfaceMemorySourceRefSchema,
  affected_dependencies: z.array(SurfaceDependencyRefSchema).min(1),
  action: SurfaceInvalidationActionSchema,
  redaction_ref: z.string().min(1).optional(),
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
});
export type SurfaceInvalidationEvent = z.infer<typeof SurfaceInvalidationEventSchema>;
