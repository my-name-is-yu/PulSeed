import { z } from "zod";
import {
  CapabilityOperationKindEnum,
  CapabilityPrivacyProfileEnum,
  CapabilityReversibilityProfileEnum,
  CapabilityRiskProfileEnum,
  CapabilitySideEffectProfileEnum,
} from "../../platform/observation/types/capability.js";
import { AutonomyTtlMsSchema } from "./autonomy-ttl.js";

export const InternalAutonomyCapabilityFamilySchema = z.enum([
  "soil",
  "knowledge",
  "dream",
  "audit",
  "readiness",
]);
export type InternalAutonomyCapabilityFamily = z.infer<typeof InternalAutonomyCapabilityFamilySchema>;

export const InternalAutonomyOperationClassSchema = z.enum([
  "soil_retrieval",
  "soil_context_evaluation",
  "soil_projection",
  "soil_materialization",
  "knowledge_search",
  "knowledge_recall",
  "knowledge_consolidation",
  "knowledge_quarantine",
  "knowledge_learning_record",
  "knowledge_transfer_detection",
  "dream_hint_selection",
  "dream_reuse_tracking",
  "dream_demotion",
  "dream_confidence_update",
  "dream_candidate_capture",
  "audit_append",
  "readiness_observation",
  "protected_target_mutation",
  "external_publish",
  "external_open",
  "cross_scope_auto_apply",
  "deletion",
  "notification",
  "browser_or_desktop_operation",
  "side_effecting_mcp",
  "foreign_plugin_execution",
]);
export type InternalAutonomyOperationClass = z.infer<typeof InternalAutonomyOperationClassSchema>;

export const InternalAutonomyLocalitySchema = z.enum([
  "local_only",
  "not_local",
]);
export type InternalAutonomyLocality = z.infer<typeof InternalAutonomyLocalitySchema>;

export const InternalAutonomyTargetClassSchema = z.enum([
  "generated_cache",
  "generated_snapshot",
  "generated_review_area",
  "internal_quarantine",
  "internal_learning_store",
  "dream_playbook_metadata",
  "audit_log",
  "readiness_observation",
  "protected_public_docs",
  "protected_user_authored_memory",
  "protected_hand_maintained_file",
  "protected_published_artifact",
  "protected_user_authored_skill",
  "external_surface",
  "browser_or_desktop",
  "side_effecting_mcp",
  "foreign_plugin",
  "third_party_system",
]);
export type InternalAutonomyTargetClass = z.infer<typeof InternalAutonomyTargetClassSchema>;

export const InternalAutonomyMutationKindSchema = z.enum([
  "none",
  "read",
  "select",
  "project",
  "materialize",
  "record",
  "append",
  "create",
  "update",
  "overwrite",
  "delete",
  "publish",
  "send",
  "mutate",
  "run",
  "open",
  "auto_apply",
]);
export type InternalAutonomyMutationKind = z.infer<typeof InternalAutonomyMutationKindSchema>;

export const InternalAutonomyTargetDispositionSchema = z.enum([
  "allowed_internal",
  "quarantine",
  "proposal",
  "review",
  "approval_required",
  "blocked",
]);
export type InternalAutonomyTargetDisposition = z.infer<typeof InternalAutonomyTargetDispositionSchema>;

export const InternalAutonomyDefaultSchema = z.object({
  ref: z.string().min(1),
  result: z.enum(["eligible", "ineligible", "unknown"]),
  reason: z.string().min(1),
  capability_family: InternalAutonomyCapabilityFamilySchema,
  operation_class: InternalAutonomyOperationClassSchema,
  operation_id: z.string().min(1),
  capability_id: z.string().min(1).optional(),
  operation_kind: CapabilityOperationKindEnum,
  provider_ref: z.string().min(1),
  payload_class: z.string().min(1),
  locality: InternalAutonomyLocalitySchema,
  side_effect_profile: CapabilitySideEffectProfileEnum,
  reversibility: CapabilityReversibilityProfileEnum,
  scope: z.string().min(1),
  target_class: InternalAutonomyTargetClassSchema,
  target_disposition: InternalAutonomyTargetDispositionSchema,
  target_refs: z.array(z.string().min(1)).default([]),
  protected_target_refs: z.array(z.string().min(1)).default([]),
  external_effect_refs: z.array(z.string().min(1)).default([]),
  guardrail_refs: z.array(z.string().min(1)).default([]),
  epoch: z.string().min(1).optional(),
  expires_at: z.string().min(1).optional(),
}).strict();
export type InternalAutonomyDefault = z.infer<typeof InternalAutonomyDefaultSchema>;

export const InternalAutonomyDefaultClassificationInputSchema = z.object({
  capability_family: InternalAutonomyCapabilityFamilySchema,
  operation_class: InternalAutonomyOperationClassSchema,
  operation_id: z.string().min(1),
  capability_id: z.string().min(1).optional(),
  operation_kind: CapabilityOperationKindEnum,
  provider_ref: z.string().min(1),
  payload_class: z.string().min(1),
  side_effect_profile: CapabilitySideEffectProfileEnum,
  risk_class: CapabilityRiskProfileEnum,
  privacy_profile: CapabilityPrivacyProfileEnum.optional(),
  reversibility: CapabilityReversibilityProfileEnum,
  external_action_authority: z.boolean().default(false),
  target_refs: z.array(z.string().min(1)).default([]),
  target_class: InternalAutonomyTargetClassSchema,
  mutation_kind: InternalAutonomyMutationKindSchema,
  locality: InternalAutonomyLocalitySchema.default("local_only"),
  inspectable: z.boolean().default(false),
  expected_user_visible_effect: z.boolean().default(false),
  scope: z.string().min(1).default("workspace"),
  policy_epoch: z.string().min(1).optional(),
  evaluated_at: z.string().min(1).optional(),
  expires_at: z.string().min(1).optional(),
  ttl_ms: AutonomyTtlMsSchema.optional(),
  ref: z.string().min(1).optional(),
}).strict();
export type InternalAutonomyDefaultClassificationInput = z.input<typeof InternalAutonomyDefaultClassificationInputSchema>;

const DEFAULT_INTERNAL_AUTONOMY_TTL_MS = 5 * 60 * 1000;

const FAMILY_ALLOWED_OPERATIONS: Record<InternalAutonomyCapabilityFamily, ReadonlySet<InternalAutonomyOperationClass>> = {
  soil: new Set([
    "soil_retrieval",
    "soil_context_evaluation",
    "soil_projection",
    "soil_materialization",
  ]),
  knowledge: new Set([
    "knowledge_search",
    "knowledge_recall",
    "knowledge_consolidation",
    "knowledge_quarantine",
    "knowledge_learning_record",
    "knowledge_transfer_detection",
  ]),
  dream: new Set([
    "dream_hint_selection",
    "dream_reuse_tracking",
    "dream_demotion",
    "dream_confidence_update",
    "dream_candidate_capture",
  ]),
  audit: new Set(["audit_append"]),
  readiness: new Set(["readiness_observation"]),
};

const SAFE_INTERNAL_TARGET_CLASSES = new Set<InternalAutonomyTargetClass>([
  "generated_cache",
  "generated_snapshot",
  "generated_review_area",
  "internal_quarantine",
  "internal_learning_store",
  "dream_playbook_metadata",
  "audit_log",
  "readiness_observation",
]);

const PROTECTED_TARGET_CLASSES = new Set<InternalAutonomyTargetClass>([
  "protected_public_docs",
  "protected_user_authored_memory",
  "protected_hand_maintained_file",
  "protected_published_artifact",
  "protected_user_authored_skill",
]);

const EXTERNAL_TARGET_CLASSES = new Set<InternalAutonomyTargetClass>([
  "external_surface",
  "browser_or_desktop",
  "side_effecting_mcp",
  "foreign_plugin",
  "third_party_system",
]);

const UNSAFE_OPERATION_CLASSES = new Set<InternalAutonomyOperationClass>([
  "protected_target_mutation",
  "external_publish",
  "external_open",
  "cross_scope_auto_apply",
  "deletion",
  "notification",
  "browser_or_desktop_operation",
  "side_effecting_mcp",
  "foreign_plugin_execution",
]);

const EXTERNAL_OR_MUTATING_MUTATIONS = new Set<InternalAutonomyMutationKind>([
  "send",
  "publish",
  "delete",
  "mutate",
  "run",
  "open",
  "auto_apply",
]);

export function classifyInternalAutonomyDefault(
  input: InternalAutonomyDefaultClassificationInput
): InternalAutonomyDefault {
  const parsed = InternalAutonomyDefaultClassificationInputSchema.parse(input);
  const evaluatedAt = parsed.evaluated_at ?? new Date().toISOString();
  const expiresAt = parsed.expires_at
    ?? new Date(Date.parse(evaluatedAt) + (parsed.ttl_ms ?? DEFAULT_INTERNAL_AUTONOMY_TTL_MS)).toISOString();
  const targetDisposition = targetDispositionFor(parsed);
  const blockers = internalAutonomyBlockers(parsed, targetDisposition);
  const result = blockers.length === 0 ? "eligible" : "ineligible";

  return InternalAutonomyDefaultSchema.parse({
    ref: parsed.ref ?? internalAutonomyDefaultRef(parsed),
    result,
    reason: result === "eligible"
      ? `Default-autonomous internal metabolism is eligible for ${parsed.capability_family}:${parsed.operation_class}.`
      : blockers.join(" "),
    capability_family: parsed.capability_family,
    operation_class: parsed.operation_class,
    operation_id: parsed.operation_id,
    ...(parsed.capability_id ? { capability_id: parsed.capability_id } : {}),
    operation_kind: parsed.operation_kind,
    provider_ref: parsed.provider_ref,
    payload_class: parsed.payload_class,
    locality: parsed.locality,
    side_effect_profile: parsed.side_effect_profile,
    reversibility: parsed.reversibility,
    scope: parsed.scope,
    target_class: parsed.target_class,
    target_disposition: targetDisposition,
    target_refs: parsed.target_refs,
    protected_target_refs: PROTECTED_TARGET_CLASSES.has(parsed.target_class) ? parsed.target_refs : [],
    external_effect_refs: externalEffectRefs(parsed),
    guardrail_refs: guardrailRefs(parsed, targetDisposition),
    ...(parsed.policy_epoch ? { epoch: parsed.policy_epoch } : {}),
    expires_at: expiresAt,
  });
}

function internalAutonomyBlockers(
  input: z.infer<typeof InternalAutonomyDefaultClassificationInputSchema>,
  disposition: InternalAutonomyTargetDisposition
): string[] {
  const blockers: string[] = [];
  if (!FAMILY_ALLOWED_OPERATIONS[input.capability_family].has(input.operation_class)) {
    blockers.push(`${input.operation_class} is not in the ${input.capability_family} default-autonomous internal class.`);
  }
  if (UNSAFE_OPERATION_CLASSES.has(input.operation_class)) {
    blockers.push(`${input.operation_class} is outside the default-autonomous internal class.`);
  }
  if (input.locality !== "local_only") {
    blockers.push("Default-autonomous internal metabolism requires local-only operation scope.");
  }
  if (!input.inspectable) {
    blockers.push("Default-autonomous internal metabolism requires inspectable records.");
  }
  if (input.expected_user_visible_effect) {
    blockers.push("Default-autonomous internal metabolism cannot create user-visible effects.");
  }
  if (input.external_action_authority) {
    blockers.push("Default-autonomous internal metabolism cannot grant external action authority.");
  }
  if (input.risk_class !== "low") {
    blockers.push("Default-autonomous internal metabolism is limited to low-risk operations.");
  }
  if (input.privacy_profile === "external_service" || input.privacy_profile === "user_visible") {
    blockers.push("Default-autonomous internal metabolism cannot target external-service or user-visible privacy classes.");
  }
  if (!safeReversibility(input.reversibility)) {
    blockers.push("Default-autonomous internal metabolism requires reversible, append-only, or draft-only effects.");
  }
  if (!safeInternalSideEffect(input.side_effect_profile, input.reversibility)) {
    blockers.push("Default-autonomous internal metabolism only allows internal read, no-op, or safe write effects.");
  }
  if (!safeMutationForTarget(input)) {
    blockers.push(`${input.mutation_kind} is not allowed for ${input.target_class} in the internal default.`);
  }
  if (disposition !== "allowed_internal") {
    blockers.push(`${input.target_class} is routed to ${disposition}, not direct default autonomy.`);
  }
  return blockers;
}

function targetDispositionFor(
  input: z.infer<typeof InternalAutonomyDefaultClassificationInputSchema>
): InternalAutonomyTargetDisposition {
  if (SAFE_INTERNAL_TARGET_CLASSES.has(input.target_class)) return "allowed_internal";
  if (PROTECTED_TARGET_CLASSES.has(input.target_class)) {
    switch (input.mutation_kind) {
      case "create":
        return "proposal";
      case "append":
        return "quarantine";
      case "update":
        return "review";
      case "overwrite":
      case "publish":
        return "approval_required";
      case "delete":
        return "blocked";
      default:
        return "review";
    }
  }
  if (EXTERNAL_TARGET_CLASSES.has(input.target_class) || EXTERNAL_OR_MUTATING_MUTATIONS.has(input.mutation_kind)) {
    return "blocked";
  }
  return "blocked";
}

function safeMutationForTarget(input: z.infer<typeof InternalAutonomyDefaultClassificationInputSchema>): boolean {
  if (!SAFE_INTERNAL_TARGET_CLASSES.has(input.target_class)) return false;
  switch (input.mutation_kind) {
    case "none":
    case "read":
    case "select":
    case "project":
    case "materialize":
    case "record":
    case "append":
      return true;
    case "update":
      return input.reversibility === "reversible"
        && (
          input.target_class === "dream_playbook_metadata"
          || input.target_class === "internal_learning_store"
          || input.target_class === "generated_cache"
          || input.target_class === "readiness_observation"
        );
    default:
      return false;
  }
}

function safeReversibility(reversibility: z.infer<typeof CapabilityReversibilityProfileEnum>): boolean {
  return reversibility === "reversible"
    || reversibility === "append_only"
    || reversibility === "draft_only";
}

function safeInternalSideEffect(
  sideEffect: z.infer<typeof CapabilitySideEffectProfileEnum>,
  reversibility: z.infer<typeof CapabilityReversibilityProfileEnum>
): boolean {
  if (sideEffect === "none" || sideEffect === "read") return true;
  return sideEffect === "write" && safeReversibility(reversibility);
}

function externalEffectRefs(input: z.infer<typeof InternalAutonomyDefaultClassificationInputSchema>): string[] {
  if (
    input.external_action_authority
    || EXTERNAL_TARGET_CLASSES.has(input.target_class)
    || EXTERNAL_OR_MUTATING_MUTATIONS.has(input.mutation_kind)
    || input.side_effect_profile === "send"
    || input.side_effect_profile === "publish"
    || input.side_effect_profile === "delete"
    || input.side_effect_profile === "mutate"
  ) {
    return input.target_refs;
  }
  return [];
}

function guardrailRefs(
  input: z.infer<typeof InternalAutonomyDefaultClassificationInputSchema>,
  disposition: InternalAutonomyTargetDisposition
): string[] {
  const refs = new Set<string>();
  if (PROTECTED_TARGET_CLASSES.has(input.target_class)) refs.add(`protected-target:${input.target_class}`);
  if (EXTERNAL_TARGET_CLASSES.has(input.target_class)) refs.add(`external-target:${input.target_class}`);
  if (UNSAFE_OPERATION_CLASSES.has(input.operation_class)) refs.add(`unsafe-operation:${input.operation_class}`);
  if (disposition !== "allowed_internal") refs.add(`target-disposition:${disposition}`);
  return [...refs].sort();
}

function internalAutonomyDefaultRef(
  input: z.infer<typeof InternalAutonomyDefaultClassificationInputSchema>
): string {
  return [
    "internal-autonomy-default",
    input.capability_family,
    input.operation_class,
    input.operation_id,
    input.capability_id ?? "no-capability",
    input.provider_ref,
    input.payload_class,
    input.target_class,
    input.mutation_kind,
  ].join(":");
}
