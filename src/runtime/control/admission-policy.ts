import { z } from "zod";
import type { CapabilityReadinessSnapshot } from "../../platform/observation/types/capability.js";
import {
  CapabilityOperationKindEnum,
  CapabilitySideEffectProfileEnum,
} from "../../platform/observation/types/capability.js";
import type {
  PermissionGrantCapability,
  PermissionGrantRecord,
} from "../store/permission-grant-store.js";
import {
  isPermissionGrantCurrentlyActive,
  PermissionGrantCapabilitySchema,
  PermissionGrantRecordSchema,
} from "../store/permission-grant-store.js";
import {
  RuntimeControlActorSchema,
  RuntimeControlReplyTargetSchema,
} from "../store/runtime-operation-schemas.js";

export const AdmissionPolicyResultSchema = z.enum([
  "allowed",
  "approval_required",
  "suppressed",
  "prohibited",
]);
export type AdmissionPolicyResult = z.infer<typeof AdmissionPolicyResultSchema>;

export const AdmissionPolicySignalSchema = z.object({
  ref: z.string().min(1),
  result: AdmissionPolicyResultSchema,
  reason: z.string().min(1),
  epoch: z.string().min(1).optional(),
  expires_at: z.string().min(1).optional(),
}).strict();
export type AdmissionPolicySignal = z.infer<typeof AdmissionPolicySignalSchema>;

export const AdmissionAuthStateSchema = z.object({
  ref: z.string().min(1),
  status: z.enum(["valid", "missing", "expired", "stale", "revoked"]),
  epoch: z.string().min(1).optional(),
  expires_at: z.string().min(1).optional(),
}).strict();
export type AdmissionAuthState = z.infer<typeof AdmissionAuthStateSchema>;

export const AdmissionOperationScopeSchema = z.object({
  operation_id: z.string().min(1),
  capability_id: z.string().min(1).optional(),
  operation_kind: CapabilityOperationKindEnum,
  provider_ref: z.string().min(1),
  asset_ref: z.string().min(1).optional(),
  tool_name: z.string().min(1).optional(),
  payload_class: z.string().min(1),
  payload_epoch: z.string().min(1).optional(),
  side_effect_profile: CapabilitySideEffectProfileEnum,
  external_action_authority: z.boolean().default(false),
  requires_runtime_control: z.boolean().default(false),
  required_permission_capabilities: z.array(PermissionGrantCapabilitySchema).default([]),
  target_refs: z.array(z.string().min(1)).default([]),
  target_epoch_refs: z.record(z.string(), z.string()).default({}),
  provider_epoch: z.string().min(1).optional(),
}).strict();
export type AdmissionOperationScope = z.infer<typeof AdmissionOperationScopeSchema>;
export type AdmissionOperationScopeInput = z.input<typeof AdmissionOperationScopeSchema>;

export const AdmissionSurfaceScopeSchema = z.object({
  surface_ref: z.string().min(1),
  channel: z.string().min(1).optional(),
  platform: z.string().min(1).optional(),
  reply_target: RuntimeControlReplyTargetSchema.optional(),
  inbound_permission_refs: z.array(z.string().min(1)).default([]),
  turn_ref: z.string().min(1).optional(),
  run_ref: z.string().min(1).optional(),
  goal_ref: z.string().min(1).optional(),
  session_ref: z.string().min(1).optional(),
  workspace_root: z.string().min(1).optional(),
  project_ref: z.string().min(1).optional(),
  epoch: z.string().min(1).optional(),
}).strict();
export type AdmissionSurfaceScope = z.infer<typeof AdmissionSurfaceScopeSchema>;
export type AdmissionSurfaceScopeInput = z.input<typeof AdmissionSurfaceScopeSchema>;

export const AdmissionPermissionGrantBindingSchema = z.object({
  operation_id: z.string().min(1),
  provider_ref: z.string().min(1),
  payload_class: z.string().min(1),
  auth_state_ref: z.string().min(1),
  surface_ref: z.string().min(1),
  target_refs: z.array(z.string().min(1)).default([]),
  capabilities: z.array(PermissionGrantCapabilitySchema).default([]),
}).strict();
export type AdmissionPermissionGrantBinding = z.infer<typeof AdmissionPermissionGrantBindingSchema>;

export const AdmissionPermissionGrantEvidenceSchema = z.object({
  grant: PermissionGrantRecordSchema,
  binding: AdmissionPermissionGrantBindingSchema,
}).strict();
export type AdmissionPermissionGrantEvidence = z.infer<typeof AdmissionPermissionGrantEvidenceSchema>;
export type AdmissionPermissionGrantEvidenceInput = z.input<typeof AdmissionPermissionGrantEvidenceSchema>;

export const AdmissionInvalidationBindingSchema = z.object({
  kind: z.enum(["target", "provider", "auth", "payload", "policy", "surface"]),
  ref: z.string().min(1),
  epoch: z.string().min(1).optional(),
}).strict();
export type AdmissionInvalidationBinding = z.infer<typeof AdmissionInvalidationBindingSchema>;

export const AdmissionPolicyEvaluationSchema = z.object({
  schema_version: z.literal("admission-policy-evaluation/v1"),
  evaluation_id: z.string().min(1),
  operation_id: z.string().min(1),
  capability_id: z.string().min(1).optional(),
  evaluated_at: z.string().min(1),
  actor_ref: z.string().min(1),
  surface_ref: z.string().min(1),
  provider_ref: z.string().min(1),
  payload_class: z.string().min(1),
  target_refs: z.array(z.string().min(1)).default([]),
  permission_grant_refs: z.array(z.string().min(1)).default([]),
  rejected_permission_grant_refs: z.array(z.string().min(1)).default([]),
  relationship_policy_refs: z.array(z.string().min(1)).default([]),
  quieting_policy_refs: z.array(z.string().min(1)).default([]),
  privacy_policy_refs: z.array(z.string().min(1)).default([]),
  runtime_control_refs: z.array(z.string().min(1)).default([]),
  notification_policy_refs: z.array(z.string().min(1)).default([]),
  auth_state_ref: z.string().min(1).optional(),
  readiness_ref: z.string().min(1).optional(),
  result: AdmissionPolicyResultSchema,
  rationale: z.array(z.string().min(1)),
  expires_at: z.string().min(1),
  invalidation_bindings: z.array(AdmissionInvalidationBindingSchema).default([]),
  metadata: z.object({
    operation_kind: CapabilityOperationKindEnum,
    side_effect_profile: CapabilitySideEffectProfileEnum,
    required_permission_capabilities: z.array(PermissionGrantCapabilitySchema).default([]),
    considered_permission_grant_refs: z.array(z.string().min(1)).default([]),
  }).strict(),
}).strict();
export type AdmissionPolicyEvaluation = z.infer<typeof AdmissionPolicyEvaluationSchema>;

export interface EvaluateAdmissionPolicyInput {
  operation: AdmissionOperationScopeInput;
  actor: z.infer<typeof RuntimeControlActorSchema>;
  surface: AdmissionSurfaceScopeInput;
  authState?: AdmissionAuthState;
  readiness?: CapabilityReadinessSnapshot;
  permissionGrants?: AdmissionPermissionGrantEvidenceInput[];
  relationshipPolicy?: AdmissionPolicySignal[];
  quietingPolicy?: AdmissionPolicySignal[];
  privacyPolicy?: AdmissionPolicySignal[];
  runtimeControlPolicy?: AdmissionPolicySignal[];
  notificationPolicy?: AdmissionPolicySignal[];
  evaluatedAt?: string;
  expiresAt?: string;
  ttlMs?: number;
  evaluationId?: string;
}

type AdmissionReason = {
  result: AdmissionPolicyResult;
  rationale: string;
};

const DEFAULT_ADMISSION_TTL_MS = 5 * 60 * 1000;

export function evaluateAdmissionPolicy(input: EvaluateAdmissionPolicyInput): AdmissionPolicyEvaluation {
  const operation = AdmissionOperationScopeSchema.parse(input.operation);
  const actor = RuntimeControlActorSchema.parse(input.actor);
  const surface = AdmissionSurfaceScopeSchema.parse(input.surface);
  const authState = input.authState ? AdmissionAuthStateSchema.parse(input.authState) : undefined;
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
  const nowMs = Date.parse(evaluatedAt);
  const ttlMs = input.ttlMs ?? DEFAULT_ADMISSION_TTL_MS;
  const expiresAt = input.expiresAt ?? new Date(nowMs + ttlMs).toISOString();
  const permissionGrants = (input.permissionGrants ?? []).map((grant) =>
    AdmissionPermissionGrantEvidenceSchema.parse(grant)
  );
  const relationshipPolicy = parseSignals(input.relationshipPolicy);
  const quietingPolicy = parseSignals(input.quietingPolicy);
  const privacyPolicy = parseSignals(input.privacyPolicy);
  const runtimeControlPolicy = parseSignals(input.runtimeControlPolicy);
  const notificationPolicy = parseSignals(input.notificationPolicy);

  const reasons: AdmissionReason[] = [];
  const grantMatch = matchingPermissionGrantRefs({
    operation,
    actor,
    surface,
    authState,
    grants: permissionGrants,
    nowMs,
  });
  if (operation.required_permission_capabilities.length > 0) {
    for (const reason of grantMatch.rejectionReasons) {
      reasons.push({
        result: "approval_required",
        rationale: reason,
      });
    }
  }

  if (operation.required_permission_capabilities.length > 0 && grantMatch.matchedRefs.length === 0) {
    reasons.push({
      result: "approval_required",
      rationale: `No active PermissionGrant covers ${operation.required_permission_capabilities.join(", ")} for this exact operation scope.`,
    });
  }

  applyAuthState(reasons, authState, evaluatedAt);
  applySignals(reasons, relationshipPolicy, "relationship policy", evaluatedAt);
  applySignals(reasons, quietingPolicy, "quieting policy", evaluatedAt);
  applySignals(reasons, privacyPolicy, "privacy policy", evaluatedAt);
  applySignals(reasons, runtimeControlPolicy, "runtime control policy", evaluatedAt);
  applySignals(reasons, notificationPolicy, "notification policy", evaluatedAt);

  if (operation.requires_runtime_control && !hasAllowedSignal(runtimeControlPolicy, evaluatedAt)) {
    reasons.push({
      result: "approval_required",
      rationale: "Runtime control admission is required for this operation scope.",
    });
  }

  if (requiresNotificationAdmission(operation) && notificationPolicy.length === 0) {
    reasons.push({
      result: "approval_required",
      rationale: "Outbound notification or external action requires a notification policy decision.",
    });
  }

  const result = strongestResult(reasons.map((reason) => reason.result));
  const rationale = reasons.length > 0
    ? reasons.map((reason) => reason.rationale)
    : ["All supplied admission policy inputs allow this exact operation scope."];

  return AdmissionPolicyEvaluationSchema.parse({
    schema_version: "admission-policy-evaluation/v1",
    evaluation_id: input.evaluationId ?? admissionEvaluationId(operation.operation_id, actorRef(actor), surface.surface_ref, evaluatedAt),
    operation_id: operation.operation_id,
    ...(operation.capability_id ? { capability_id: operation.capability_id } : {}),
    evaluated_at: evaluatedAt,
    actor_ref: actorRef(actor),
    surface_ref: surface.surface_ref,
    provider_ref: operation.provider_ref,
    payload_class: operation.payload_class,
    target_refs: [...operation.target_refs].sort(),
    permission_grant_refs: grantMatch.matchedRefs,
    rejected_permission_grant_refs: grantMatch.rejectedRefs,
    relationship_policy_refs: relationshipPolicy.map((signal) => signal.ref).sort(),
    quieting_policy_refs: quietingPolicy.map((signal) => signal.ref).sort(),
    privacy_policy_refs: privacyPolicy.map((signal) => signal.ref).sort(),
    runtime_control_refs: runtimeControlPolicy.map((signal) => signal.ref).sort(),
    notification_policy_refs: notificationPolicy.map((signal) => signal.ref).sort(),
    ...(authState ? { auth_state_ref: authState.ref } : {}),
    ...(input.readiness ? { readiness_ref: input.readiness.snapshot_id } : {}),
    result,
    rationale,
    expires_at: expiresAt,
    invalidation_bindings: invalidationBindings({
      operation,
      surface,
      authState,
      policies: [
        ...relationshipPolicy,
        ...quietingPolicy,
        ...privacyPolicy,
        ...runtimeControlPolicy,
        ...notificationPolicy,
      ],
    }),
    metadata: {
      operation_kind: operation.operation_kind,
      side_effect_profile: operation.side_effect_profile,
      required_permission_capabilities: operation.required_permission_capabilities,
      considered_permission_grant_refs: permissionGrants.map((grant) => grant.grant.grant_id).sort(),
    },
  });
}

function matchingPermissionGrantRefs(input: {
  operation: AdmissionOperationScope;
  actor: z.infer<typeof RuntimeControlActorSchema>;
  surface: AdmissionSurfaceScope;
  authState: AdmissionAuthState | undefined;
  grants: AdmissionPermissionGrantEvidence[];
  nowMs: number;
}): { matchedRefs: string[]; rejectedRefs: string[]; rejectionReasons: string[] } {
  const matchedRefs: string[] = [];
  const rejectedRefs: string[] = [];
  const rejectionReasons: string[] = [];

  for (const { grant, binding } of input.grants) {
    const rejection = permissionGrantRejectionReason({
      operation: input.operation,
      actor: input.actor,
      surface: input.surface,
      authState: input.authState,
      grant,
      binding,
      nowMs: input.nowMs,
    });
    if (rejection) {
      rejectedRefs.push(grant.grant_id);
      rejectionReasons.push(rejection);
    } else {
      matchedRefs.push(grant.grant_id);
    }
  }

  return {
    matchedRefs: matchedRefs.sort(),
    rejectedRefs: rejectedRefs.sort(),
    rejectionReasons: rejectionReasons.sort(),
  };
}

function permissionGrantRejectionReason(input: {
  operation: AdmissionOperationScope;
  actor: z.infer<typeof RuntimeControlActorSchema>;
  surface: AdmissionSurfaceScope;
  authState: AdmissionAuthState | undefined;
  grant: PermissionGrantRecord;
  binding: AdmissionPermissionGrantBinding;
  nowMs: number;
}): string | null {
  const { operation, actor, surface, authState, grant, binding, nowMs } = input;
  if (!isPermissionGrantCurrentlyActive(grant, nowMs)) {
    return `PermissionGrant ${grant.grant_id} is not active for this admission evaluation.`;
  }
  if (!grantSubjectMatchesActor(grant, actor)) {
    return `PermissionGrant ${grant.grant_id} subject does not match the requesting actor.`;
  }
  if (!grantOriginMatchesActorAndSurface(grant, actor, surface)) {
    return `PermissionGrant ${grant.grant_id} origin does not match the requesting actor or surface.`;
  }
  if (!grantScopeMatchesSurface(grant, surface)) {
    return `PermissionGrant ${grant.grant_id} scope does not match the current admission context.`;
  }
  if (!coversCapabilities(grant, binding, operation.required_permission_capabilities)) {
    return `PermissionGrant ${grant.grant_id} does not cover the required operation capabilities.`;
  }
  if (binding.provider_ref !== operation.provider_ref) {
    return `PermissionGrant ${grant.grant_id} provider binding does not match this operation.`;
  }
  if (binding.payload_class !== operation.payload_class) {
    return `PermissionGrant ${grant.grant_id} payload binding does not match this operation.`;
  }
  if (!sameStringSet(binding.target_refs, operation.target_refs)) {
    return `PermissionGrant ${grant.grant_id} target binding does not match this operation.`;
  }
  if (binding.operation_id !== operation.operation_id) {
    return `PermissionGrant ${grant.grant_id} operation binding does not match this operation.`;
  }
  if (binding.surface_ref !== surface.surface_ref) {
    return `PermissionGrant ${grant.grant_id} surface binding does not match this admission surface.`;
  }
  if (authState === undefined) {
    return `PermissionGrant ${grant.grant_id} is bound to auth state ${binding.auth_state_ref}, but no current auth state was supplied.`;
  }
  if (authState.status !== "valid") {
    return `PermissionGrant ${grant.grant_id} is bound to non-valid auth state ${authState.ref}.`;
  }
  if (binding.auth_state_ref !== authState.ref) {
    return `PermissionGrant ${grant.grant_id} auth binding does not match this admission auth state.`;
  }
  return null;
}

function coversCapabilities(
  grant: PermissionGrantRecord,
  binding: AdmissionPermissionGrantBinding,
  required: PermissionGrantCapability[]
): boolean {
  const grantCapabilities = new Set(grant.capabilities);
  const bindingCapabilities = new Set(binding.capabilities);
  return required.every((capability) =>
    grantCapabilities.has(capability) && bindingCapabilities.has(capability)
  );
}

function grantSubjectMatchesActor(
  grant: PermissionGrantRecord,
  actor: z.infer<typeof RuntimeControlActorSchema>
): boolean {
  if (grant.subject.kind === "system") return actor.surface === "cli";
  if (grant.subject.kind === "agent") return grant.subject.id === actor.identity_key;
  return grant.subject.id === actor.user_id || grant.subject.id === actor.identity_key;
}

function grantOriginMatchesActorAndSurface(
  grant: PermissionGrantRecord,
  actor: z.infer<typeof RuntimeControlActorSchema>,
  surface: AdmissionSurfaceScope
): boolean {
  if (grant.origin.channel !== surface.channel && grant.origin.channel !== surface.reply_target?.channel) {
    return false;
  }
  if (grant.origin.platform && grant.origin.platform !== actor.platform && grant.origin.platform !== surface.platform) {
    return false;
  }
  if (grant.duration.kind !== "standing" && grant.origin.session_id && grant.origin.session_id !== surface.session_ref) {
    return false;
  }
  if (grant.origin.conversation_id) {
    const conversations = [
      actor.conversation_id,
      surface.reply_target?.conversation_id,
    ].filter((value): value is string => value !== undefined);
    if (!conversations.includes(grant.origin.conversation_id)) return false;
  }
  if (grant.origin.user_id) {
    const users = [
      actor.user_id,
      actor.identity_key,
      surface.reply_target?.user_id,
      surface.reply_target?.identity_key,
    ].filter((value): value is string => value !== undefined);
    if (!users.includes(grant.origin.user_id)) return false;
  }
  return true;
}

function grantScopeMatchesSurface(grant: PermissionGrantRecord, surface: AdmissionSurfaceScope): boolean {
  switch (grant.scope.kind) {
    case "turn":
      return grant.scope.turn_id === surface.turn_ref;
    case "run":
      return grant.scope.run_id === surface.run_ref;
    case "goal":
      return grant.scope.goal_id === surface.goal_ref;
    case "session":
      return grant.scope.session_id === surface.session_ref;
    case "workspace":
      return grant.scope.workspace_root === surface.workspace_root;
    case "project":
      return grant.scope.project_id === surface.project_ref;
    case "global":
      return grant.duration.kind === "standing";
  }
}

function applyAuthState(reasons: AdmissionReason[], authState: AdmissionAuthState | undefined, evaluatedAt: string): void {
  if (!authState) return;
  if (authState.expires_at && authState.expires_at <= evaluatedAt) {
    reasons.push({
      result: "approval_required",
      rationale: `Auth state ${authState.ref} expired before admission evaluation.`,
    });
    return;
  }
  if (authState.status === "revoked") {
    reasons.push({
      result: "prohibited",
      rationale: `Auth state ${authState.ref} is revoked.`,
    });
    return;
  }
  if (authState.status !== "valid") {
    reasons.push({
      result: "approval_required",
      rationale: `Auth state ${authState.ref} is ${authState.status}.`,
    });
  }
}

function applySignals(
  reasons: AdmissionReason[],
  signals: AdmissionPolicySignal[],
  label: string,
  evaluatedAt: string
): void {
  for (const signal of signals) {
    if (signal.expires_at && signal.expires_at <= evaluatedAt) {
      reasons.push({
        result: "approval_required",
        rationale: `${label} ${signal.ref} expired before admission evaluation.`,
      });
      continue;
    }
    if (signal.result === "allowed") continue;
    reasons.push({
      result: signal.result,
      rationale: `${label} ${signal.ref}: ${signal.reason}`,
    });
  }
}

function hasAllowedSignal(signals: AdmissionPolicySignal[], evaluatedAt: string): boolean {
  return signals.some((signal) =>
    signal.result === "allowed"
    && (signal.expires_at === undefined || signal.expires_at > evaluatedAt)
  );
}

function requiresNotificationAdmission(operation: AdmissionOperationScope): boolean {
  return operation.operation_kind === "send"
    || operation.side_effect_profile === "send"
    || operation.external_action_authority;
}

function strongestResult(results: AdmissionPolicyResult[]): AdmissionPolicyResult {
  if (results.some((result) => result === "prohibited")) return "prohibited";
  if (results.some((result) => result === "suppressed")) return "suppressed";
  if (results.some((result) => result === "approval_required")) return "approval_required";
  return "allowed";
}

function invalidationBindings(input: {
  operation: AdmissionOperationScope;
  surface: AdmissionSurfaceScope;
  authState: AdmissionAuthState | undefined;
  policies: AdmissionPolicySignal[];
}): AdmissionInvalidationBinding[] {
  const bindings: AdmissionInvalidationBinding[] = [
    {
      kind: "provider",
      ref: input.operation.provider_ref,
      ...(input.operation.provider_epoch ? { epoch: input.operation.provider_epoch } : {}),
    },
    {
      kind: "payload",
      ref: input.operation.payload_class,
      ...(input.operation.payload_epoch ? { epoch: input.operation.payload_epoch } : {}),
    },
    {
      kind: "surface",
      ref: input.surface.surface_ref,
      ...(input.surface.epoch ? { epoch: input.surface.epoch } : {}),
    },
    ...input.operation.target_refs.map((ref) => ({
      kind: "target" as const,
      ref,
      ...(input.operation.target_epoch_refs[ref] ? { epoch: input.operation.target_epoch_refs[ref] } : {}),
    })),
    ...(input.authState
      ? [{
          kind: "auth" as const,
          ref: input.authState.ref,
          ...(input.authState.epoch ? { epoch: input.authState.epoch } : {}),
        }]
      : []),
    ...input.policies.map((policy) => ({
      kind: "policy" as const,
      ref: policy.ref,
      ...(policy.epoch ? { epoch: policy.epoch } : {}),
    })),
  ];
  return bindings.sort((a, b) =>
    `${a.kind}:${a.ref}`.localeCompare(`${b.kind}:${b.ref}`)
  );
}

function parseSignals(signals: AdmissionPolicySignal[] | undefined): AdmissionPolicySignal[] {
  return (signals ?? []).map((signal) => AdmissionPolicySignalSchema.parse(signal));
}

function actorRef(actor: z.infer<typeof RuntimeControlActorSchema>): string {
  return [
    actor.surface,
    actor.platform ?? "unknown-platform",
    actor.conversation_id ?? "unknown-conversation",
    actor.identity_key ?? actor.user_id ?? "unknown-actor",
  ].join(":");
}

function admissionEvaluationId(
  operationId: string,
  actor: string,
  surfaceRef: string,
  evaluatedAt: string
): string {
  return `admission:${operationId}:${actor}:${surfaceRef}:${evaluatedAt}`;
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightValues = new Set(right);
  return left.every((value) => rightValues.has(value));
}
