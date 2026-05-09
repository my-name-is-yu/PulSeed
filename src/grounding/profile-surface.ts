import type {
  RelationshipProfileConsentScope,
  RelationshipProfileItem,
} from "../platform/profile/relationship-profile.js";
import {
  loadRelationshipProfile,
  selectActiveRelationshipProfileItems,
} from "../platform/profile/relationship-profile.js";
import type {
  RelationshipProfileRetrievalContext,
} from "../platform/profile/retrieval-context.js";
import type { GovernedMemoryAllowedUseClass } from "../platform/profile/governed-memory.js";
import {
  createSurfaceInspectionAdapterPayload,
  SurfaceProjectionSchema,
  SURFACE_GATE_ORDER,
  type RelationshipPermission,
  type SurfaceGateKind,
  type SurfaceGateResult,
  type SurfaceMemorySourceRef,
  type SurfaceProjection,
  type SurfaceProjectionTarget,
} from "./surface-contracts.js";

export interface RelationshipProfileSurfaceContext {
  scope: RelationshipProfileConsentScope;
  includeSensitive: boolean;
  items: RelationshipProfileItem[];
}

type GroundingProfileSurfaceInput = {
  context: RelationshipProfileSurfaceContext;
  target: SurfaceProjectionTarget;
  scopeRef: string;
  purpose: string;
  requestedUse?: GovernedMemoryAllowedUseClass;
  now: string;
};

export async function loadRelationshipProfileSurfaceContext(params: {
  baseDir: string;
  scope: RelationshipProfileConsentScope;
  includeSensitive?: boolean;
}): Promise<RelationshipProfileSurfaceContext> {
  const includeSensitive = params.includeSensitive === true;
  const store = await loadRelationshipProfile(params.baseDir);
  return {
    scope: params.scope,
    includeSensitive,
    items: selectActiveRelationshipProfileItems(store, params.scope, { includeSensitive }),
  };
}

export function buildRelationshipProfileSurfaceProjection(
  input: GroundingProfileSurfaceInput
): SurfaceProjection | null {
  if (input.context.items.length === 0) return null;
  const requestedUse = input.requestedUse ?? "runtime_grounding";

  const sourceRefs = input.context.items.map((item) => surfaceSourceForProfileItem(item, input.context, requestedUse));
  const includedSources = input.context.items
    .map((item) => ({ item, source: surfaceSourceForProfileItem(item, input.context, requestedUse) }))
    .filter(({ item, source }) => (
      item.status === "active"
      && item.allowed_scopes.includes(input.context.scope)
      && item.sensitivity !== "sensitive"
      && source.allowed_uses.includes(requestedUse)
      && !source.not_allowed_uses.includes(requestedUse)
    ));
  const excludedSources = input.context.items
    .map((item) => ({ item, source: surfaceSourceForProfileItem(item, input.context, requestedUse) }))
    .filter(({ item, source }) => !includedSources.some((included) => included.source.memory_id === source.memory_id));
  const includedContext = includedSources.map(({ item, source }) => ({
    lane: source.role === "boundary" ? "boundary" as const : "relationship" as const,
    source_ref: source,
    use_class: requestedUse,
    excerpt: item.value,
    gates: SURFACE_GATE_ORDER.map((gate) => surfaceGate(gate, "passed", input.now)),
  }));
  const excludedContext = excludedSources.map(({ source }) => ({
    lane: "exclusion" as const,
    source_ref: source,
    requested_use: requestedUse,
    blocked_by: [surfaceGate(blockedGateForSource(source, requestedUse), "blocked", input.now)],
    ...(source.sensitivity === "sensitive" ? { redaction_ref: `redaction:${source.memory_id}:sensitive` } : {}),
  }));
  const relationshipPermissions = includedSources.map(({ source }) => relationshipPermissionForSource(source, input));
  const projectionId = [
    "surface",
    "relationship-profile",
    encodeSurfacePart(input.target),
    encodeSurfacePart(input.scopeRef),
    encodeSurfacePart(input.context.scope),
  ].join(":");

  return SurfaceProjectionSchema.parse({
    id: projectionId,
    version: 1,
    target: input.target,
    scope: {
      kind: "task",
      ref: input.scopeRef,
    },
    purpose: input.purpose,
    requested_use: requestedUse,
    store_scope: "selected_refs",
    source_refs: sourceRefs,
    relationship_permissions: relationshipPermissions,
    dependent_refs: {},
    included_context: includedContext,
    excluded_context: excludedContext,
    allowed_runtime_uses: Array.from(new Set([requestedUse, "surface_projection"])),
    not_allowed_runtime_uses: [
      "side_effect_authorization",
      "stale_session_authorization",
      "proactive_trigger",
      "raw_prompt_injection",
    ],
    gate_order: [...SURFACE_GATE_ORDER],
    staleness_checks: [`relationship-profile:${input.context.scope}:active-current`],
    sensitivity_checks: [`relationship-profile:${input.context.scope}:sensitivity`],
    rationale_entries: [
      ...includedSources.map(({ source }) => ({
        source_ref: source,
        decision: "included" as const,
        gate: "projection" as const,
        reason_ref: `surface-rationale:${source.memory_id}:included`,
        policy_refs: ["relationship-profile-surface-admission"],
      })),
      ...excludedSources.map(({ source }) => ({
        source_ref: source,
        decision: "excluded" as const,
        gate: blockedGateForSource(source, requestedUse),
        reason_ref: `surface-rationale:${source.memory_id}:excluded`,
        policy_refs: ["relationship-profile-surface-admission"],
        ...(source.sensitivity === "sensitive" ? { redaction_ref: `redaction:${source.memory_id}:sensitive` } : {}),
      })),
    ],
    metadata: {
      staleness: "fresh",
      sensitivity: includedSources.some(({ item }) => item.sensitivity === "private") ? "private" : "public",
      permission_state: includedContext.length > 0 ? "granted" : "blocked",
      invalidation_state: "valid",
      audit_refs: sourceRefs.map((source) => `audit:${source.memory_id}:surface-projection`),
    },
    created_at: input.now,
    expires_at: null,
  });
}

export function contextFromRelationshipProfileSurfaceProjection(
  context: RelationshipProfileRetrievalContext,
  projection: SurfaceProjection | null
): RelationshipProfileRetrievalContext {
  if (!projection) return { ...context, items: [] };
  const includedMemoryIds = new Set(projection.included_context.map((entry) => entry.source_ref.memory_id));
  return {
    ...context,
    items: context.items.filter((item) => includedMemoryIds.has(surfaceMemoryIdForProfileItem(item))),
  };
}

export function formatRelationshipProfileSurfaceContext(
  projection: SurfaceProjection | null,
  options: { title?: string } = {}
): string {
  if (!projection || projection.included_context.length === 0) return "";
  const title = options.title ?? "Relationship profile retrieval context Surface";
  return [
    `${title} (surface_id=${projection.id}; requested_use=${projection.requested_use})`,
    "- Use only Surface-included relationship context below.",
    "- Excluded relationship memories may appear in inspection metadata, not prompt content.",
    ...projection.included_context.map((entry) => {
      const fields = entry.source_ref.domain_fields;
      const stableKey = typeof fields.stable_key === "string" ? fields.stable_key : entry.source_ref.memory_id;
      const kind = typeof fields.profile_kind === "string" ? fields.profile_kind : entry.source_ref.record_kind;
      const confidence = typeof fields.confidence === "number" ? fields.confidence.toFixed(2) : "unknown";
      const version = typeof fields.version === "number" ? fields.version : "unknown";
      return `- [${kind}] ${stableKey}: ${entry.excerpt} (confidence=${confidence}; sensitivity=${entry.source_ref.sensitivity}; version=${version})`;
    }),
  ].join("\n");
}

export function relationshipProfileSurfaceInspectionMetadata(
  projection: SurfaceProjection | null,
  target: SurfaceProjectionTarget
): Record<string, unknown> | null {
  if (!projection) return null;
  return createSurfaceInspectionAdapterPayload(projection, target);
}

function surfaceSourceForProfileItem(
  item: RelationshipProfileItem,
  context: RelationshipProfileSurfaceContext,
  requestedUse: GovernedMemoryAllowedUseClass,
): SurfaceMemorySourceRef {
  const memoryId = surfaceMemoryIdForProfileItem(item);
  const owner = {
    kind: "relationship_profile" as const,
    store_ref: "relationship-profile",
    record_ref: item.id,
    schema_version: 1,
  };
  const lifecycle = item.status === "active" ? "active" as const : item.status === "superseded" ? "superseded" as const : "retracted" as const;
  const correctionState = item.status === "active" ? "current" as const : item.status;
  const inScope = item.allowed_scopes.includes(context.scope);
  const allowedUses = inScope ? Array.from(new Set([requestedUse, "surface_projection"] as const)) : ["never_use_directly" as const];
  return {
    memory_id: memoryId,
    owning_store_ref: owner,
    role: profileRole(item),
    record_kind: profileRecordKind(item),
    domain_fields: {
      stable_key: item.stable_key,
      profile_kind: item.kind,
      confidence: item.confidence,
      version: item.version,
      allowed_scopes: item.allowed_scopes,
    },
    allowed_uses: allowedUses,
    not_allowed_uses: [
      "side_effect_authorization",
      "stale_session_authorization",
      "proactive_trigger",
      "raw_prompt_injection",
      ...(inScope ? [] : [requestedUse, "cross_scope_reuse" as const]),
    ],
    lifecycle,
    correction_state: correctionState,
    superseded_by_memory_id: item.superseded_by ? `relationship-profile:${item.superseded_by}` : null,
    sensitivity: item.sensitivity,
    content_state: "materialized",
    dependency_ref: {
      kind: "memory_record",
      ref: memoryId,
      owning_store_ref: owner,
      content_state: "materialized",
      lifecycle,
      correction_state: correctionState,
      superseded_by_memory_id: item.superseded_by ? `relationship-profile:${item.superseded_by}` : null,
    },
  };
}

function blockedGateForSource(source: SurfaceMemorySourceRef, requestedUse: GovernedMemoryAllowedUseClass): SurfaceGateKind {
  if (source.lifecycle !== "active" || source.correction_state !== "current") return "lifecycle";
  if (source.not_allowed_uses.includes("cross_scope_reuse")) return "scope";
  if (source.sensitivity === "sensitive") return "sensitivity";
  if (source.not_allowed_uses.includes(requestedUse)) return "forbidden_use";
  if (!source.allowed_uses.includes(requestedUse)) return "allowed_use";
  return "projection";
}

function relationshipPermissionForSource(
  source: SurfaceMemorySourceRef,
  input: GroundingProfileSurfaceInput
): RelationshipPermission {
  return {
    permission_id: `relationship-permission:${source.memory_id}:${input.context.scope}`,
    context_scope: input.scopeRef,
    memory_role_scope: [source.role],
    observation_permission: "allowed",
    memory_use_permission: "allowed",
    speakability: "ask_first",
    proactive_permission: "ask_first",
    interruption_tolerance: "low",
    autonomy_level: "observe_only",
    confirmation_requirement: "before_action",
    emotional_language_boundary: "neutral",
    preferred_expression_modes: [],
    forbidden_moves: ["side_effect_authorization", "raw_prompt_injection"],
    valid_from: input.now,
    valid_to: null,
    source_refs: [{
      memory_id: source.memory_id,
      owning_store_ref: source.owning_store_ref,
    }],
  };
}

function surfaceGate(gate: SurfaceGateKind, status: SurfaceGateResult["status"], now: string): SurfaceGateResult {
  return {
    gate,
    status,
    reason_ref: `surface-gate:${gate}:${status}`,
    evaluated_at: now,
  };
}

function profileRole(item: RelationshipProfileItem): SurfaceMemorySourceRef["role"] {
  if (item.kind === "boundary" || item.kind === "intervention_policy" || item.kind === "notification_preference") {
    return "boundary";
  }
  return "relationship";
}

function profileRecordKind(item: RelationshipProfileItem): SurfaceMemorySourceRef["record_kind"] {
  switch (item.kind) {
    case "boundary":
      return "boundary";
    case "intervention_policy":
    case "notification_preference":
      return "intervention_policy";
    case "preference":
    case "dislike":
    case "communication_style":
      return "preference";
    case "identity_fact":
    case "value":
    case "long_term_goal":
    case "life_context":
      return "stable_profile_fact";
  }
}

function surfaceMemoryIdForProfileItem(item: RelationshipProfileItem): string {
  return `relationship-profile:${item.id}`;
}

function encodeSurfacePart(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "_");
}
