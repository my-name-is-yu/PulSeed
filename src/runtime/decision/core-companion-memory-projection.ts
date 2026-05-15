import { z } from "zod/v3";
import type { GroundingProfileId } from "../../grounding/contracts.js";
import {
  SurfaceIncludedLaneSchema,
  SurfaceMemorySourceRefSchema,
  SurfaceProjectionSchema,
  SurfaceRequestedUseSchema,
  type RelationshipPermission,
  type SurfaceExcludedContext,
  type SurfaceIncludedContext,
  type SurfaceMemorySourceRef,
  type SurfaceProjection,
  type SurfaceRequestedUse,
} from "../../grounding/surface-contracts.js";
import {
  GovernedMemoryAllowedUseClassSchema,
  GovernedMemoryBlockedUseClassSchema,
  GovernedMemoryOwnerKindSchema,
  type GovernedMemoryAllowedUseClass,
} from "../../platform/profile/governed-memory.js";
import {
  CognitionContextRefSchema,
  CognitionProjectionCallerPathKindSchema,
  type CognitionContextRef,
  type CognitionProjectionCallerPathKind,
} from "./companion-decision-contract.js";

export const CoreCompanionMemoryGroundingProfileIdSchema = z.enum([
  "chat/general_turn",
  "chat/handoff",
  "agent_loop/task_execution",
  "core_loop/verification",
]);
export type CoreCompanionMemoryGroundingProfileId = z.infer<typeof CoreCompanionMemoryGroundingProfileIdSchema>;

export const CoreCompanionMemorySourceKindSchema = z.enum([
  "relationship_profile",
  "profile_proposal",
  "runtime_session",
  "surface_projection",
  "knowledge_manager",
  "soil",
  "dream_seed",
  "correction_ledger",
  "grounding_profile",
  "grounding_bundle",
]);
export type CoreCompanionMemorySourceKind = z.infer<typeof CoreCompanionMemorySourceKindSchema>;

export const CoreCompanionMemoryProjectionSourceRefSchema = z.object({
  kind: CoreCompanionMemorySourceKindSchema,
  ref: z.string().min(1),
  owner_kind: GovernedMemoryOwnerKindSchema.optional(),
}).strict();
export type CoreCompanionMemoryProjectionSourceRef = z.infer<typeof CoreCompanionMemoryProjectionSourceRefSchema>;

export const CoreCompanionMemoryRestrictionReasonSchema = z.enum([
  "stale",
  "superseded",
  "corrected",
  "sensitive",
  "out_of_scope",
  "redacted",
  "lifecycle_ineligible",
  "permission_blocked",
  "forbidden_use",
  "not_allowed_for_requested_use",
  "stale_or_missing_surface",
]);
export type CoreCompanionMemoryRestrictionReason = z.infer<typeof CoreCompanionMemoryRestrictionReasonSchema>;

export const CoreCompanionMemoryAvailableContentSchema = z.object({
  state: z.literal("available"),
  excerpt: z.string().min(1),
}).strict();

export const CoreCompanionMemoryWithheldContentSchema = z.object({
  state: z.literal("withheld"),
  redaction_ref: z.string().min(1).optional(),
  reason_refs: z.array(z.string().min(1)).default([]),
}).strict();

export const CoreCompanionMemoryContentSchema = z.discriminatedUnion("state", [
  CoreCompanionMemoryAvailableContentSchema,
  CoreCompanionMemoryWithheldContentSchema,
]);
export type CoreCompanionMemoryContent = z.infer<typeof CoreCompanionMemoryContentSchema>;

export const CoreCompanionMemoryUsePolicySchema = z.object({
  remembered: z.literal(true).default(true),
  usable: z.boolean(),
  speakable: z.boolean(),
  actionable: z.boolean(),
  inhibition_only: z.boolean(),
  planning_only: z.boolean(),
  forbidden: z.boolean(),
  memory_is_runtime_authority: z.literal(false).default(false),
  required_confirmation: z.enum(["none", "before_speech", "before_action", "before_resume"]).default("none"),
  requested_use: SurfaceRequestedUseSchema,
  allowed_use_classes: z.array(GovernedMemoryAllowedUseClassSchema).default([]),
  blocked_use_classes: z.array(GovernedMemoryBlockedUseClassSchema).default([]),
}).strict().superRefine((policy, ctx) => {
  if (policy.forbidden && (policy.usable || policy.speakable || policy.actionable || policy.inhibition_only || policy.planning_only)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["forbidden"],
      message: "forbidden memory may be remembered for governance but cannot be usable, speakable, actionable, inhibition-only, or planning-only",
    });
  }
  if ((policy.speakable || policy.actionable || policy.inhibition_only || policy.planning_only) && !policy.usable) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["usable"],
      message: "specific memory use modes require usable=true",
    });
  }
  if (policy.inhibition_only && (policy.speakable || policy.actionable)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["inhibition_only"],
      message: "inhibition-only memory cannot be speakable or actionable",
    });
  }
  if (policy.planning_only && (policy.speakable || policy.actionable)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["planning_only"],
      message: "planning-only memory cannot be speakable or actionable",
    });
  }
});
export type CoreCompanionMemoryUsePolicy = z.infer<typeof CoreCompanionMemoryUsePolicySchema>;

export const CoreCompanionMemoryEntrySchema = z.object({
  entry_id: z.string().min(1),
  lane: SurfaceIncludedLaneSchema,
  source_ref: SurfaceMemorySourceRefSchema,
  content: CoreCompanionMemoryContentSchema,
  use_policy: CoreCompanionMemoryUsePolicySchema,
  source_projection_ref: z.string().min(1),
  audit_refs: z.array(z.string().min(1)).default([]),
}).strict().superRefine((entry, ctx) => {
  if (entry.content.state !== "available") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content"],
      message: "included core companion memory entries must carry available Surface excerpt content",
    });
  }
  if (entry.source_ref.sensitivity === "sensitive") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source_ref", "sensitivity"],
      message: "sensitive memory cannot be included in core companion memory entries",
    });
  }
  if (entry.source_ref.content_state === "redacted") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source_ref", "content_state"],
      message: "redacted memory cannot be included in core companion memory entries",
    });
  }
  if (!isIncludedCoreMemoryLifecycle(entry.source_ref.lifecycle)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source_ref", "lifecycle"],
      message: "stale or inactive memory lifecycle cannot be included in core companion memory entries",
    });
  }
  if (entry.source_ref.correction_state !== "current" || entry.source_ref.superseded_by_memory_id !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source_ref", "correction_state"],
      message: "corrected or superseded memory cannot be included in core companion memory entries",
    });
  }
});
export type CoreCompanionMemoryEntry = z.infer<typeof CoreCompanionMemoryEntrySchema>;

export const CoreCompanionMemoryRestrictedEntrySchema = z.object({
  entry_id: z.string().min(1),
  source_ref: SurfaceMemorySourceRefSchema,
  requested_use: SurfaceRequestedUseSchema,
  restriction_reasons: z.array(CoreCompanionMemoryRestrictionReasonSchema).min(1),
  content: CoreCompanionMemoryWithheldContentSchema,
  use_policy: CoreCompanionMemoryUsePolicySchema,
  source_projection_ref: z.string().min(1),
  audit_refs: z.array(z.string().min(1)).default([]),
}).strict().superRefine((entry, ctx) => {
  if (!entry.use_policy.forbidden) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["use_policy", "forbidden"],
      message: "restricted core companion memory entries must be forbidden for the requested use",
    });
  }
  if (entry.source_ref.content_state === "redacted" && !entry.content.redaction_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content", "redaction_ref"],
      message: "restricted redacted memory must expose only a redaction ref",
    });
  }
});
export type CoreCompanionMemoryRestrictedEntry = z.infer<typeof CoreCompanionMemoryRestrictedEntrySchema>;

export const CoreCompanionMemoryOrdinarySurfacePolicySchema = z.object({
  raw_memory_dump_visible: z.literal(false).default(false),
  raw_correction_state_visible: z.literal(false).default(false),
  ordinary_surface_receives_only_allowed_entries: z.literal(true).default(true),
}).strict();
export type CoreCompanionMemoryOrdinarySurfacePolicy = z.infer<typeof CoreCompanionMemoryOrdinarySurfacePolicySchema>;

export const CoreCompanionMemoryProjectionSummarySchema = z.object({
  included_count: z.number().int().nonnegative(),
  restricted_count: z.number().int().nonnegative(),
  remembered_count: z.number().int().nonnegative(),
  usable_count: z.number().int().nonnegative(),
  speakable_count: z.number().int().nonnegative(),
  actionable_count: z.number().int().nonnegative(),
  inhibition_only_count: z.number().int().nonnegative(),
  planning_only_count: z.number().int().nonnegative(),
  forbidden_count: z.number().int().nonnegative(),
}).strict();
export type CoreCompanionMemoryProjectionSummary = z.infer<typeof CoreCompanionMemoryProjectionSummarySchema>;

export const CoreCompanionMemoryProjectionSchema = z.object({
  schema_version: z.literal("core-companion-memory-projection/v1"),
  projection_id: z.string().min(1),
  created_at: z.string().datetime(),
  caller_path: CognitionProjectionCallerPathKindSchema,
  grounding_profile_id: CoreCompanionMemoryGroundingProfileIdSchema.optional(),
  grounding_bundle_ref: z.string().min(1).optional(),
  cognition_ref: z.string().min(1).optional(),
  source_refs: z.array(CoreCompanionMemoryProjectionSourceRefSchema).min(1),
  surface_ref: z.string().min(1),
  requested_use: SurfaceRequestedUseSchema,
  included_entries: z.array(CoreCompanionMemoryEntrySchema).default([]),
  restricted_entries: z.array(CoreCompanionMemoryRestrictedEntrySchema).default([]),
  ordinary_surface_policy: CoreCompanionMemoryOrdinarySurfacePolicySchema.default({}),
  summary: CoreCompanionMemoryProjectionSummarySchema,
  prompt_dump: z.never().optional(),
}).strict().superRefine((projection, ctx) => {
  const includedCount = projection.included_entries.length;
  const restrictedCount = projection.restricted_entries.length;
  if (projection.summary.included_count !== includedCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["summary", "included_count"],
      message: "included_count must match included_entries length",
    });
  }
  if (projection.summary.restricted_count !== restrictedCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["summary", "restricted_count"],
      message: "restricted_count must match restricted_entries length",
    });
  }
});
export type CoreCompanionMemoryProjection = z.infer<typeof CoreCompanionMemoryProjectionSchema>;

export interface CreateCoreCompanionMemoryProjectionFromSurfaceInput {
  surfaceProjection: unknown;
  callerPath: CognitionProjectionCallerPathKind;
  projectionId?: string;
  groundingProfileId?: GroundingProfileId;
  groundingBundleRef?: string;
  cognitionRef?: string;
  correctionEventRefs?: string[];
  createdAt?: string;
}

export function createCoreCompanionMemoryProjectionFromSurface(
  input: CreateCoreCompanionMemoryProjectionFromSurfaceInput
): CoreCompanionMemoryProjection {
  const surface = SurfaceProjectionSchema.parse(input.surfaceProjection);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const projectionId = input.projectionId ?? `core-memory:${surface.id}`;
  const includedEntries = surface.included_context.map((context) =>
    coreMemoryEntryFromSurfaceContext(context, surface)
  );
  const restrictedEntries = surface.excluded_context.map((context) =>
    restrictedCoreMemoryEntryFromSurfaceContext(context, surface)
  );
  const allPolicies = [
    ...includedEntries.map((entry) => entry.use_policy),
    ...restrictedEntries.map((entry) => entry.use_policy),
  ];

  return CoreCompanionMemoryProjectionSchema.parse({
    schema_version: "core-companion-memory-projection/v1",
    projection_id: projectionId,
    created_at: createdAt,
    caller_path: input.callerPath,
    ...(input.groundingProfileId ? { grounding_profile_id: input.groundingProfileId } : {}),
    ...(input.groundingBundleRef ? { grounding_bundle_ref: input.groundingBundleRef } : {}),
    ...(input.cognitionRef ? { cognition_ref: input.cognitionRef } : {}),
    source_refs: projectionSourceRefs(surface, input),
    surface_ref: surface.id,
    requested_use: surface.requested_use,
    included_entries: includedEntries,
    restricted_entries: restrictedEntries,
    ordinary_surface_policy: {},
    summary: {
      included_count: includedEntries.length,
      restricted_count: restrictedEntries.length,
      remembered_count: allPolicies.filter((policy) => policy.remembered).length,
      usable_count: allPolicies.filter((policy) => policy.usable).length,
      speakable_count: allPolicies.filter((policy) => policy.speakable).length,
      actionable_count: allPolicies.filter((policy) => policy.actionable).length,
      inhibition_only_count: allPolicies.filter((policy) => policy.inhibition_only).length,
      planning_only_count: allPolicies.filter((policy) => policy.planning_only).length,
      forbidden_count: allPolicies.filter((policy) => policy.forbidden).length,
    },
  });
}

export function createCoreCompanionMemoryProjectionCognitionRef(
  projection: Pick<CoreCompanionMemoryProjection, "projection_id">
): CognitionContextRef {
  return CognitionContextRefSchema.parse({
    kind: "memory_projection",
    ref: projection.projection_id,
    role: "context",
    freshness: "current",
  });
}

function coreMemoryEntryFromSurfaceContext(
  context: SurfaceIncludedContext,
  surface: SurfaceProjection,
): CoreCompanionMemoryEntry {
  const permission = findRelationshipPermission(surface, context.source_ref);
  return CoreCompanionMemoryEntrySchema.parse({
    entry_id: `core-memory-entry:${surface.id}:${context.source_ref.memory_id}`,
    lane: context.lane,
    source_ref: context.source_ref,
    content: {
      state: "available",
      excerpt: context.excerpt,
    },
    use_policy: usePolicyForIncludedSource(context.source_ref, surface.requested_use, permission),
    source_projection_ref: surface.id,
    audit_refs: auditRefsForSource(surface, context.source_ref),
  });
}

function restrictedCoreMemoryEntryFromSurfaceContext(
  context: SurfaceExcludedContext,
  surface: SurfaceProjection,
): CoreCompanionMemoryRestrictedEntry {
  const restrictionReasons = restrictionReasonsForExcludedContext(context);
  return CoreCompanionMemoryRestrictedEntrySchema.parse({
    entry_id: `core-memory-restricted:${surface.id}:${context.source_ref.memory_id}`,
    source_ref: context.source_ref,
    requested_use: context.requested_use,
    restriction_reasons: restrictionReasons,
    content: {
      state: "withheld",
      ...(context.redaction_ref ? { redaction_ref: context.redaction_ref } : {}),
      reason_refs: context.blocked_by.flatMap((gate) => gate.reason_ref ? [gate.reason_ref] : []),
    },
    use_policy: forbiddenUsePolicy(context.source_ref, context.requested_use),
    source_projection_ref: surface.id,
    audit_refs: auditRefsForSource(surface, context.source_ref),
  });
}

function usePolicyForIncludedSource(
  source: SurfaceMemorySourceRef,
  requestedUse: SurfaceRequestedUse,
  permission: RelationshipPermission | undefined,
): CoreCompanionMemoryUsePolicy {
  const requestedUseAllowed = GovernedMemoryAllowedUseClassSchema.safeParse(requestedUse).success;
  const blocked = !requestedUseAllowed
    || source.not_allowed_uses.includes(requestedUse)
    || !source.allowed_uses.includes(requestedUse as GovernedMemoryAllowedUseClass);
  if (blocked) {
    return forbiddenUsePolicy(source, requestedUse);
  }

  const speakable = requestedUse === "user_facing_reference" && permission?.speakability === "allowed";
  const actionable = requestedUse === "proactive_action_candidate" && permission?.proactive_permission === "allowed";
  const inhibitionOnly = requestedUse === "behavioral_inhibition";
  const planningOnly = !inhibitionOnly && (
    requestedUse === "goal_planning"
    || requestedUse === "design_grounding"
    || requestedUse === "attention_prioritization"
    || requestedUse === "ask_for_confirmation"
    || (requestedUse === "proactive_action_candidate" && !actionable)
  );

  return CoreCompanionMemoryUsePolicySchema.parse({
    remembered: true,
    usable: true,
    speakable,
    actionable,
    inhibition_only: inhibitionOnly,
    planning_only: planningOnly,
    forbidden: false,
    memory_is_runtime_authority: false,
    required_confirmation: requiredConfirmationForUse(requestedUse, permission),
    requested_use: requestedUse,
    allowed_use_classes: source.allowed_uses,
    blocked_use_classes: source.not_allowed_uses,
  });
}

function forbiddenUsePolicy(
  source: SurfaceMemorySourceRef,
  requestedUse: SurfaceRequestedUse,
): CoreCompanionMemoryUsePolicy {
  return CoreCompanionMemoryUsePolicySchema.parse({
    remembered: true,
    usable: false,
    speakable: false,
    actionable: false,
    inhibition_only: false,
    planning_only: false,
    forbidden: true,
    memory_is_runtime_authority: false,
    required_confirmation: "none",
    requested_use: requestedUse,
    allowed_use_classes: source.allowed_uses,
    blocked_use_classes: source.not_allowed_uses,
  });
}

function requiredConfirmationForUse(
  requestedUse: SurfaceRequestedUse,
  permission: RelationshipPermission | undefined,
): CoreCompanionMemoryUsePolicy["required_confirmation"] {
  if (requestedUse === "user_facing_reference" && permission?.speakability === "ask_first") {
    return "before_speech";
  }
  if (
    requestedUse === "proactive_action_candidate"
    && (permission?.proactive_permission === "ask_first" || permission?.confirmation_requirement === "before_action")
  ) {
    return "before_action";
  }
  if (permission?.confirmation_requirement === "before_resume") {
    return "before_resume";
  }
  return "none";
}

function restrictionReasonsForExcludedContext(
  context: SurfaceExcludedContext,
): CoreCompanionMemoryRestrictionReason[] {
  const reasons = new Set<CoreCompanionMemoryRestrictionReason>();
  for (const gate of context.blocked_by) {
    if (gate.gate === "scope") reasons.add("out_of_scope");
    if (gate.gate === "sensitivity") reasons.add("sensitive");
    if (gate.gate === "permission") reasons.add("permission_blocked");
    if (gate.gate === "forbidden_use") reasons.add("forbidden_use");
    if (gate.gate === "allowed_use") reasons.add("not_allowed_for_requested_use");
    if (gate.gate === "staleness") reasons.add("stale");
    if (gate.gate === "lifecycle") reasons.add("lifecycle_ineligible");
    if (gate.gate === "projection" || gate.gate === "audit") reasons.add("stale_or_missing_surface");
  }
  if (context.source_ref.lifecycle === "decayed" || context.source_ref.lifecycle === "retired" || context.source_ref.lifecycle === "archived") {
    reasons.add("stale");
  }
  if (context.source_ref.lifecycle === "superseded" || context.source_ref.superseded_by_memory_id !== null) {
    reasons.add("superseded");
  }
  if (context.source_ref.correction_state !== "current") {
    reasons.add(context.source_ref.correction_state === "superseded" ? "superseded" : "corrected");
  }
  if (context.source_ref.sensitivity === "sensitive") {
    reasons.add("sensitive");
  }
  if (context.source_ref.content_state === "redacted") {
    reasons.add("redacted");
  }
  if (context.source_ref.not_allowed_uses.includes("cross_scope_reuse")) {
    reasons.add("out_of_scope");
  }
  return reasons.size > 0 ? [...reasons] : ["not_allowed_for_requested_use"];
}

function findRelationshipPermission(
  surface: SurfaceProjection,
  source: SurfaceMemorySourceRef,
): RelationshipPermission | undefined {
  return surface.relationship_permissions.find((permission) =>
    permission.source_refs.some((permissionSource) =>
      permissionSource.memory_id === source.memory_id
      && JSON.stringify(permissionSource.owning_store_ref) === JSON.stringify(source.owning_store_ref)
    )
  );
}

function auditRefsForSource(surface: SurfaceProjection, source: SurfaceMemorySourceRef): string[] {
  const rationaleRefs = surface.rationale_entries
    .filter((entry) => entry.source_ref.memory_id === source.memory_id)
    .map((entry) => entry.reason_ref);
  return [...new Set([...surface.metadata.audit_refs, ...rationaleRefs])];
}

function projectionSourceRefs(
  surface: SurfaceProjection,
  input: CreateCoreCompanionMemoryProjectionFromSurfaceInput,
): CoreCompanionMemoryProjectionSourceRef[] {
  const refs = new Map<string, CoreCompanionMemoryProjectionSourceRef>();
  addProjectionSourceRef(refs, { kind: "surface_projection", ref: surface.id });
  if (input.groundingProfileId) {
    addProjectionSourceRef(refs, { kind: "grounding_profile", ref: input.groundingProfileId });
  }
  if (input.groundingBundleRef) {
    addProjectionSourceRef(refs, { kind: "grounding_bundle", ref: input.groundingBundleRef });
  }
  for (const source of surface.source_refs) {
    addProjectionSourceRef(refs, {
      kind: projectionSourceKindForOwner(source.owning_store_ref.kind),
      ref: source.owning_store_ref.store_ref,
      owner_kind: source.owning_store_ref.kind,
    });
  }
  for (const correctionRef of input.correctionEventRefs ?? []) {
    addProjectionSourceRef(refs, { kind: "correction_ledger", ref: correctionRef });
  }
  return [...refs.values()];
}

function addProjectionSourceRef(
  refs: Map<string, CoreCompanionMemoryProjectionSourceRef>,
  ref: CoreCompanionMemoryProjectionSourceRef,
): void {
  refs.set(`${ref.kind}:${ref.ref}:${ref.owner_kind ?? ""}`, CoreCompanionMemoryProjectionSourceRefSchema.parse(ref));
}

function projectionSourceKindForOwner(ownerKind: SurfaceMemorySourceRef["owning_store_ref"]["kind"]): CoreCompanionMemorySourceKind {
  if (ownerKind === "relationship_profile") {
    return "relationship_profile";
  }
  if (ownerKind === "profile_proposal") {
    return "profile_proposal";
  }
  if (ownerKind === "runtime_session") {
    return "runtime_session";
  }
  if (ownerKind === "knowledge") {
    return "knowledge_manager";
  }
  if (ownerKind === "soil") {
    return "soil";
  }
  return "dream_seed";
}

function isIncludedCoreMemoryLifecycle(lifecycle: SurfaceMemorySourceRef["lifecycle"]): boolean {
  return lifecycle === "active" || lifecycle === "matured";
}
