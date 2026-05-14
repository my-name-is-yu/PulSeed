import { z } from "zod";
import {
  CloudAdmittedRefVersionSchema,
  CloudComputeRequestSchema,
  CognitionMemorySourceSchema,
  CognitionEventRefSchema,
  CognitionRefSchema,
  ExternalDataScopeGrantSchema,
  type CloudComputeRequest,
  type CloudAdmittedRefVersion,
  type CognitionMemorySource,
  type CognitionEventRef,
  type CognitionRef,
  type ExternalDataScopeGrant,
} from "./contracts.js";

export const CloudBoundaryModeSchema = z.enum([
  "local_only",
  "gated_external_service",
]);
export type CloudBoundaryMode = z.infer<typeof CloudBoundaryModeSchema>;

export const CloudBoundaryCallerPathSchema = z.enum([
  "chat_user_turn",
  "long_running_task_turn",
  "gui_gateway_projection",
]);
export type CloudBoundaryCallerPath = z.infer<typeof CloudBoundaryCallerPathSchema>;

export const CloudRefClassSchema = z.enum([
  "LocalOnlyRef",
  "RedactedProjectionRef",
  "ModelVisibleContextRef",
  "ExternalToolPayloadRef",
  "AuditOnlyRef",
]);
export type CloudRefClass = z.infer<typeof CloudRefClassSchema>;

export const CloudRefClassificationSchema = z.object({
  ref: CognitionEventRefSchema,
  ref_class: CloudRefClassSchema,
  cloud_visible: z.boolean(),
  blocked_reason: z.string().min(1).optional(),
}).strict();
export type CloudRefClassification = z.infer<typeof CloudRefClassificationSchema>;

const CloudBoundaryBlockedContextRefSchema = z.object({
  ref: CognitionEventRefSchema,
  reason: z.string().min(1),
}).strict();

export const CloudBoundaryEvaluationSchema = z.object({
  schema_version: z.literal("cognition-cloud-boundary-evaluation/v1"),
  evaluation_id: z.string().min(1),
  caller_path: CloudBoundaryCallerPathSchema.default("chat_user_turn"),
  mode: CloudBoundaryModeSchema,
  cloud_request_id: z.string().min(1).optional(),
  provider_ref: z.string().min(1).optional(),
  provider_policy_ref: CognitionRefSchema.optional(),
  purpose: z.enum(["chat_reply", "tool_reasoning", "research", "summarization", "embedding", "classification"]).optional(),
  payload_fingerprint: z.string().min(1).optional(),
  dispatch_nonce_ref: CognitionRefSchema.optional(),
  target_epoch: z.string().min(1).optional(),
  payload_epoch: z.string().min(1).optional(),
  context_refs: z.array(CognitionEventRefSchema).default([]),
  model_visible_context_refs: z.array(CognitionEventRefSchema).default([]),
  admitted_context_refs: z.array(CognitionEventRefSchema).default([]),
  admitted_ref_versions: z.array(CloudAdmittedRefVersionSchema).default([]),
  blocked_context_refs: z.array(CloudBoundaryBlockedContextRefSchema).default([]),
  redaction_refs: z.array(CognitionRefSchema).default([]),
  external_data_scope_grants: z.array(ExternalDataScopeGrantSchema).default([]),
  invalidation_refs: z.array(CognitionRefSchema).default([]),
  admission_evaluation_ref: CognitionRefSchema.optional(),
  autonomy_evaluation_ref: CognitionRefSchema.optional(),
  external_service_context_allowed: z.boolean(),
  blocked_reason: z.string().min(1).optional(),
  side_effect_profile: z.literal("cloud_compute").optional(),
  privacy_profile: z.literal("external_service").optional(),
  retention_expectation: z.enum(["provider_default", "zero_retention_contract", "unknown"]).optional(),
  user_visible_summary: z.string().min(1).optional(),
  expires_at: z.string().datetime().optional(),
  runtime_authority: z.literal(false).default(false),
  memory_authority: z.literal(false).default(false),
}).strict().superRefine((evaluation, ctx) => {
  if (evaluation.mode === "local_only" && evaluation.external_service_context_allowed) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["external_service_context_allowed"],
      message: "local-only cognition cannot allow external-service model-visible context",
    });
  }
  if (!evaluation.external_service_context_allowed && evaluation.model_visible_context_refs.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["model_visible_context_refs"],
      message: "blocked cloud boundary evaluations cannot expose model-visible context refs",
    });
  }
  if (evaluation.external_service_context_allowed) {
    if (!evaluation.cloud_request_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cloud_request_id"],
        message: "external-service cognition requires a cloud compute request",
      });
    }
    if (!evaluation.provider_ref || !evaluation.provider_policy_ref || !evaluation.payload_fingerprint || !evaluation.dispatch_nonce_ref) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider_ref"],
        message: "external-service cognition requires provider policy, payload fingerprint, and dispatch nonce refs",
      });
    }
    if (!evaluation.admission_evaluation_ref || !evaluation.autonomy_evaluation_ref) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["admission_evaluation_ref"],
        message: "external-service cognition requires admission and autonomy refs",
      });
    }
    if (evaluation.model_visible_context_refs.length > 0 && evaluation.redaction_refs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["redaction_refs"],
        message: "external-service cognition requires redaction refs for model-visible context",
      });
    }
    if (evaluation.blocked_context_refs.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blocked_context_refs"],
        message: "external-service cognition cannot be allowed while context refs are blocked",
      });
    }
  }
  const contextRefKeys = new Set(evaluation.context_refs.map(cognitionEventRefKey));
  for (const [index, modelVisibleRef] of evaluation.model_visible_context_refs.entries()) {
    if (!contextRefKeys.has(cognitionEventRefKey(modelVisibleRef))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["model_visible_context_refs", index],
        message: "model-visible context refs must be drawn from evaluated cognition context refs",
      });
    }
  }
});
export type CloudBoundaryEvaluation = z.infer<typeof CloudBoundaryEvaluationSchema>;

export function evaluateCloudBoundaryForCognition(input: {
  evaluationId: string;
  callerPath?: CloudBoundaryCallerPath;
  mode: CloudBoundaryMode;
  contextRefs?: CognitionEventRef[];
  memorySources?: CognitionMemorySource[];
  cloudComputeRequest?: CloudComputeRequest;
  evaluatedAt?: string;
  currentProviderPolicyRef?: CognitionRef;
  currentTargetEpoch?: string;
  currentPayloadFingerprint?: string;
  usedDispatchNonceRefs?: CognitionRef[];
  currentInvalidationRefs?: CognitionRef[];
}): CloudBoundaryEvaluation {
  const contextRefs = z.array(CognitionEventRefSchema).parse(input.contextRefs ?? []);
  const memorySources = z.array(CognitionMemorySourceSchema).parse(input.memorySources ?? []);
  const cloudComputeRequest = input.cloudComputeRequest
    ? CloudComputeRequestSchema.parse(input.cloudComputeRequest)
    : undefined;
  const staleReasons = cloudComputeRequest ? staleCloudRequestReasons({
    request: cloudComputeRequest,
    evaluatedAt: input.evaluatedAt ?? new Date().toISOString(),
    currentProviderPolicyRef: input.currentProviderPolicyRef,
    currentTargetEpoch: input.currentTargetEpoch,
    currentPayloadFingerprint: input.currentPayloadFingerprint,
    usedDispatchNonceRefs: input.usedDispatchNonceRefs ?? [],
    currentInvalidationRefs: input.currentInvalidationRefs ?? [],
  }) : [];
  const blockedContextRefs = cloudComputeRequest
    ? blockedContextRefsFor({
      contextRefs,
      memorySources,
      request: cloudComputeRequest,
    })
    : [];
  const requestAvailable = input.mode === "gated_external_service"
    && Boolean(cloudComputeRequest)
    && staleReasons.length === 0
    && blockedContextRefs.length === 0;
  const modelVisibleContextRefs = requestAvailable && cloudComputeRequest
    ? approvedModelVisibleContextRefs(contextRefs, cloudComputeRequest)
    : [];
  const allowed = requestAvailable
    && (!cloudComputeRequest || modelVisibleContextRefs.length === cloudComputeRequest.model_visible_context_refs.length);
  const blockedReason = blockedReasonFor({
    mode: input.mode,
    hasRequest: Boolean(cloudComputeRequest),
    staleReasons,
    blockedContextRefs,
    requestedCount: cloudComputeRequest?.model_visible_context_refs.length ?? 0,
    admittedCount: modelVisibleContextRefs.length,
  });

  return CloudBoundaryEvaluationSchema.parse({
    schema_version: "cognition-cloud-boundary-evaluation/v1",
    evaluation_id: input.evaluationId,
    caller_path: input.callerPath ?? "chat_user_turn",
    mode: input.mode,
    ...(cloudComputeRequest ? {
      cloud_request_id: cloudComputeRequest.request_id,
      provider_ref: cloudComputeRequest.provider_ref,
      provider_policy_ref: cloudComputeRequest.provider_policy_ref,
      purpose: cloudComputeRequest.purpose,
      payload_fingerprint: cloudComputeRequest.payload_fingerprint,
      dispatch_nonce_ref: cloudComputeRequest.dispatch_nonce_ref,
      target_epoch: cloudComputeRequest.target_epoch,
      payload_epoch: cloudComputeRequest.payload_epoch,
      admitted_ref_versions: cloudComputeRequest.admitted_ref_versions,
      external_data_scope_grants: cloudComputeRequest.external_data_scope_grants,
      invalidation_refs: cloudComputeRequest.invalidation_refs,
      side_effect_profile: "cloud_compute" as const,
      privacy_profile: cloudComputeRequest.privacy_profile,
      retention_expectation: cloudComputeRequest.retention_expectation,
      user_visible_summary: cloudComputeRequest.user_visible_summary,
      expires_at: cloudComputeRequest.expires_at,
    } : {}),
    context_refs: contextRefs,
    model_visible_context_refs: modelVisibleContextRefs,
    admitted_context_refs: modelVisibleContextRefs,
    blocked_context_refs: blockedContextRefs,
    redaction_refs: cloudComputeRequest?.redaction_refs ?? [],
    ...(cloudComputeRequest ? {
      admission_evaluation_ref: cloudComputeRequest.admission_evaluation_ref,
      autonomy_evaluation_ref: cloudComputeRequest.autonomy_evaluation_ref,
    } : {}),
    external_service_context_allowed: allowed,
    ...(!allowed ? { blocked_reason: blockedReason } : {}),
    runtime_authority: false,
    memory_authority: false,
  });
}

export function classifyCognitionMemorySourceForCloud(source: CognitionMemorySource): CloudRefClassification {
  const parsed = CognitionMemorySourceSchema.parse(source);
  const blockedReason = blockedReasonForMemorySource(parsed);
  if (blockedReason) {
    return CloudRefClassificationSchema.parse({
      ref: parsed.memory_ref,
      ref_class: parsed.sensitivity === "redacted" || parsed.memory_ref.redaction_policy === "redacted"
        ? "LocalOnlyRef"
        : "AuditOnlyRef",
      cloud_visible: false,
      blocked_reason: blockedReason,
    });
  }
  return CloudRefClassificationSchema.parse({
    ref: parsed.memory_ref,
    ref_class: parsed.sensitivity === "public" ? "ModelVisibleContextRef" : "RedactedProjectionRef",
    cloud_visible: true,
  });
}

function approvedModelVisibleContextRefs(
  contextRefs: CognitionEventRef[],
  request: CloudComputeRequest
): CognitionEventRef[] {
  const approvedRefKeys = new Set(request.model_visible_context_refs.map(cognitionEventRefKey));
  const admittedVersionKeys = new Set(request.admitted_ref_versions.map((version) => cognitionEventRefKey(version.ref)));
  return contextRefs.filter((ref) =>
    approvedRefKeys.has(cognitionEventRefKey(ref))
    && admittedVersionKeys.has(cognitionEventRefKey(ref))
    && hasExternalModelGrant(request.external_data_scope_grants, request.purpose, ref)
  );
}

function cognitionEventRefKey(ref: CognitionEventRef): string {
  const parsed = CognitionEventRefSchema.parse(ref);
  return JSON.stringify({
    ref: parsed.ref,
    source_store: parsed.source_store,
    source_event_type: parsed.source_event_type,
    schema_version: parsed.schema_version,
    source_epoch: parsed.source_epoch ?? null,
    high_watermark: parsed.high_watermark ?? null,
    replay_key: parsed.replay_key ?? null,
    redaction_policy: parsed.redaction_policy,
  });
}

function blockedContextRefsFor(input: {
  contextRefs: CognitionEventRef[];
  memorySources: CognitionMemorySource[];
  request: CloudComputeRequest;
}): Array<{ ref: CognitionEventRef; reason: string }> {
  const requestedKeys = new Set(input.request.model_visible_context_refs.map(cognitionEventRefKey));
  const contextKeys = new Set(input.contextRefs.map(cognitionEventRefKey));
  const memoryByKey = new Map(input.memorySources.map((source) => {
    const parsed = CognitionMemorySourceSchema.parse(source);
    return [cognitionEventRefKey(parsed.memory_ref), parsed];
  }));
  const blocked: Array<{ ref: CognitionEventRef; reason: string }> = [];
  for (const requestedRef of input.request.model_visible_context_refs) {
    const key = cognitionEventRefKey(requestedRef);
    if (!contextKeys.has(key)) {
      blocked.push({ ref: requestedRef, reason: "requested_context_ref_not_in_evaluated_context" });
      continue;
    }
    const memorySource = memoryByKey.get(key);
    if (memorySource) {
      const memoryBlockedReason = blockedReasonForMemorySource(memorySource);
      if (memoryBlockedReason) {
        blocked.push({ ref: requestedRef, reason: memoryBlockedReason });
        continue;
      }
    }
    if (!hasAdmittedVersion(input.request.admitted_ref_versions, requestedRef)) {
      blocked.push({ ref: requestedRef, reason: "missing_current_admitted_ref_version" });
      continue;
    }
    if (!hasExternalModelGrant(input.request.external_data_scope_grants, input.request.purpose, requestedRef)) {
      blocked.push({ ref: requestedRef, reason: "missing_external_model_context_grant" });
    }
  }
  return blocked.filter((blockedRef) => requestedKeys.has(cognitionEventRefKey(blockedRef.ref)));
}

function blockedReasonForMemorySource(source: CognitionMemorySource): string | null {
  if (source.sensitivity === "sensitive") return "sensitive_memory_blocked";
  if (source.sensitivity === "redacted" || source.memory_ref.redaction_policy === "redacted") return "redacted_memory_blocked";
  if (source.lifecycle === "deleted") return "deleted_memory_blocked";
  if (source.lifecycle === "retracted") return "tombstoned_memory_blocked";
  if (source.lifecycle === "superseded") return "superseded_memory_blocked";
  if (source.lifecycle !== "active" && source.lifecycle !== "matured") return "inactive_memory_lifecycle_blocked";
  if (source.correction_state !== "current") return "corrected_memory_blocked";
  return null;
}

function staleCloudRequestReasons(input: {
  request: CloudComputeRequest;
  evaluatedAt: string;
  currentProviderPolicyRef?: CognitionRef;
  currentTargetEpoch?: string;
  currentPayloadFingerprint?: string;
  usedDispatchNonceRefs: CognitionRef[];
  currentInvalidationRefs: CognitionRef[];
}): string[] {
  const reasons: string[] = [];
  if (Date.parse(input.evaluatedAt) > Date.parse(input.request.expires_at)) {
    reasons.push("cloud_request_expired");
  }
  if (
    input.currentProviderPolicyRef
    && !sameRef(input.currentProviderPolicyRef, input.request.provider_policy_ref)
  ) {
    reasons.push("provider_policy_changed");
  }
  if (input.currentTargetEpoch && input.currentTargetEpoch !== input.request.target_epoch) {
    reasons.push("target_epoch_changed");
  }
  if (input.currentPayloadFingerprint && input.currentPayloadFingerprint !== input.request.payload_fingerprint) {
    reasons.push("payload_fingerprint_changed");
  }
  if (input.usedDispatchNonceRefs.some((ref) => sameRef(ref, input.request.dispatch_nonce_ref))) {
    reasons.push("dispatch_nonce_reused");
  }
  if (input.currentInvalidationRefs.some((current) => input.request.invalidation_refs.some((ref) => sameRef(ref, current)))) {
    reasons.push("payload_invalidated");
  }
  return reasons;
}

function blockedReasonFor(input: {
  mode: CloudBoundaryMode;
  hasRequest: boolean;
  staleReasons: string[];
  blockedContextRefs: Array<{ ref: CognitionEventRef; reason: string }>;
  requestedCount: number;
  admittedCount: number;
}): string {
  if (input.mode === "local_only") {
    return "external-service context is unavailable in local-only mode";
  }
  if (!input.hasRequest) {
    return "external-service context is unavailable without an explicit cloud gate";
  }
  if (input.staleReasons.length > 0) {
    return input.staleReasons.join(",");
  }
  if (input.blockedContextRefs.length > 0) {
    return input.blockedContextRefs.map((ref) => ref.reason).join(",");
  }
  if (input.admittedCount !== input.requestedCount) {
    return "requested context refs were not admitted";
  }
  return "external-service context is unavailable without an explicit cloud gate";
}

function hasAdmittedVersion(versions: CloudAdmittedRefVersion[], ref: CognitionEventRef): boolean {
  return versions.some((version) => cognitionEventRefKey(version.ref) === cognitionEventRefKey(ref));
}

function hasExternalModelGrant(
  grants: ExternalDataScopeGrant[],
  purpose: CloudComputeRequest["purpose"],
  ref: CognitionEventRef
): boolean {
  return grants.some((grant) =>
    grant.use === "external_model_context"
    && grant.purpose === purpose
    && grant.context_ref
    && cognitionEventRefKey(grant.context_ref) === cognitionEventRefKey(ref)
  );
}

function sameRef(left: CognitionRef, right: CognitionRef): boolean {
  return left.kind === right.kind && left.ref === right.ref;
}
