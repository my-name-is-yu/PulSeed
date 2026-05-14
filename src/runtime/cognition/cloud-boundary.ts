import { z } from "zod";
import {
  CloudComputeRequestSchema,
  CognitionEventRefSchema,
  CognitionRefSchema,
  type CloudComputeRequest,
  type CognitionEventRef,
} from "./contracts.js";

export const CloudBoundaryModeSchema = z.enum([
  "local_only",
  "gated_external_service",
]);
export type CloudBoundaryMode = z.infer<typeof CloudBoundaryModeSchema>;

export const CloudBoundaryEvaluationSchema = z.object({
  schema_version: z.literal("cognition-cloud-boundary-evaluation/v1"),
  evaluation_id: z.string().min(1),
  mode: CloudBoundaryModeSchema,
  cloud_request_id: z.string().min(1).optional(),
  context_refs: z.array(CognitionEventRefSchema).default([]),
  model_visible_context_refs: z.array(CognitionEventRefSchema).default([]),
  redaction_refs: z.array(CognitionRefSchema).default([]),
  admission_evaluation_ref: CognitionRefSchema.optional(),
  autonomy_evaluation_ref: CognitionRefSchema.optional(),
  external_service_context_allowed: z.boolean(),
  blocked_reason: z.string().min(1).optional(),
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
  mode: CloudBoundaryMode;
  contextRefs?: CognitionEventRef[];
  cloudComputeRequest?: CloudComputeRequest;
}): CloudBoundaryEvaluation {
  const contextRefs = z.array(CognitionEventRefSchema).parse(input.contextRefs ?? []);
  const cloudComputeRequest = input.cloudComputeRequest
    ? CloudComputeRequestSchema.parse(input.cloudComputeRequest)
    : undefined;
  const allowed = input.mode === "gated_external_service" && Boolean(cloudComputeRequest);
  const modelVisibleContextRefs = allowed && cloudComputeRequest
    ? approvedModelVisibleContextRefs(contextRefs, cloudComputeRequest.model_visible_context_refs)
    : [];

  return CloudBoundaryEvaluationSchema.parse({
    schema_version: "cognition-cloud-boundary-evaluation/v1",
    evaluation_id: input.evaluationId,
    mode: input.mode,
    ...(cloudComputeRequest ? { cloud_request_id: cloudComputeRequest.request_id } : {}),
    context_refs: contextRefs,
    model_visible_context_refs: modelVisibleContextRefs,
    redaction_refs: cloudComputeRequest?.redaction_refs ?? [],
    ...(cloudComputeRequest ? {
      admission_evaluation_ref: cloudComputeRequest.admission_evaluation_ref,
      autonomy_evaluation_ref: cloudComputeRequest.autonomy_evaluation_ref,
    } : {}),
    external_service_context_allowed: allowed,
    ...(!allowed ? { blocked_reason: "external-service context is unavailable without an explicit cloud gate" } : {}),
    runtime_authority: false,
    memory_authority: false,
  });
}

function approvedModelVisibleContextRefs(
  contextRefs: CognitionEventRef[],
  approvedRefs: CognitionEventRef[]
): CognitionEventRef[] {
  const approvedRefKeys = new Set(approvedRefs.map(cognitionEventRefKey));
  return contextRefs.filter((ref) => approvedRefKeys.has(cognitionEventRefKey(ref)));
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
