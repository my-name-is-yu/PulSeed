import { z } from "zod/v3";
import { ToolExecutionReasonSchema, type HostToolExecutionDecision } from "../../tools/types.js";
import {
  PermissionGrantEvaluationSchema,
  type PermissionGrantEvaluation,
} from "../../tools/permission-grant-evaluation.js";
import { AdmissionPolicyEvaluationSchema, type AdmissionPolicyEvaluation } from "./admission-policy.js";
import { AutonomyDecisionSchema, type AutonomyDecision } from "./autonomy-governor.js";
import type { ResidentOperationBoundaryResult } from "../capability-operation-planner.js";
import {
  OutboundConversationDeliveryReceiptSchema,
  OutboundConversationMessageSchema,
  OutboundConversationTargetSchema,
  type OutboundConversationDeliveryReceipt,
  type OutboundConversationMessage,
  type OutboundConversationTarget,
} from "../gateway/outbound-conversation.js";

export const ExecutionAuthorityOutcomeSchema = z.enum([
  "allowed",
  "approval_required",
  "denied",
  "sandbox_required",
  "escalation_required",
  "fail_closed",
  "safety_blocked",
  "prepare_only",
  "not_evaluated",
]);
export type ExecutionAuthorityOutcome = z.infer<typeof ExecutionAuthorityOutcomeSchema>;

export const ExecutionAuthorityLifecycleSchema = z.enum([
  "evidence",
  "waiting",
  "approved",
  "denied",
  "expired",
  "superseded",
  "terminal",
]);
export type ExecutionAuthorityLifecycle = z.infer<typeof ExecutionAuthorityLifecycleSchema>;

export const ExecutionAuthorityStageSchema = z.enum([
  "prepare",
  "execute",
  "send",
  "inspect",
  "unknown",
]);
export type ExecutionAuthorityStage = z.infer<typeof ExecutionAuthorityStageSchema>;

export const ExecutionAuthoritySourceKindSchema = z.enum([
  "host_tool_execution",
  "permission_grant",
  "admission_policy",
  "autonomy_decision",
  "resident_operation_boundary",
  "runspec_safety",
  "task_policy_trace",
  "outbound_conversation",
]);
export type ExecutionAuthoritySourceKind = z.infer<typeof ExecutionAuthoritySourceKindSchema>;

export const ExecutionAuthorityHostDecisionSchema = z.object({
  status: z.enum([
    "allowed",
    "denied",
    "needs_permission",
    "needs_sandbox",
    "needs_escalation",
    "fail_closed",
  ]),
  reason: z.string().min(1),
  executionReason: ToolExecutionReasonSchema.optional(),
  requiredSandboxMode: z.enum(["workspace_write", "danger_full_access"]).optional(),
  requiredApprovalPolicy: z.literal("on_request").optional(),
}).strict();

export const ExecutionAuthorityBindingsSchema = z.object({
  operation_id: z.string().min(1).optional(),
  capability_id: z.string().min(1).optional(),
  provider_ref: z.string().min(1).optional(),
  payload_class: z.string().min(1).optional(),
  auth_state_ref: z.string().min(1).optional(),
  surface_ref: z.string().min(1).optional(),
  target_refs: z.array(z.string().min(1)).default([]),
  target_binding_ref: z.string().min(1).optional(),
  channel_policy_ref: z.string().min(1).optional(),
}).strict();
export type ExecutionAuthorityBindings = z.infer<typeof ExecutionAuthorityBindingsSchema>;

export const ExecutionAuthoritySourceSchema = z.object({
  kind: ExecutionAuthoritySourceKindSchema,
  ref: z.string().min(1),
  stage: ExecutionAuthorityStageSchema.default("unknown"),
}).strict();
export type ExecutionAuthoritySource = z.infer<typeof ExecutionAuthoritySourceSchema>;

export const ExecutionAuthorityResidentBoundarySchema = z.object({
  operation_plan_assembly_id: z.string().min(1),
  operation_plan_status: z.string().min(1),
  operation_plan_reason: z.string().min(1),
  operation_plan_id: z.string().min(1).optional(),
  operation_admission_evaluation_id: z.string().min(1).optional(),
  autonomy_decision_id: z.string().min(1).optional(),
  preparation_allowed: z.boolean(),
  execution_allowed: z.boolean(),
}).strict();
export type ExecutionAuthorityResidentBoundary = z.infer<typeof ExecutionAuthorityResidentBoundarySchema>;

export const ExecutionAuthorityOutboundConversationSchema = z.object({
  message_id: z.string().min(1).optional(),
  surface: z.enum(["telegram", "discord", "whatsapp"]).optional(),
  target_binding_ref: z.string().min(1),
  channel_policy_ref: z.string().min(1),
  delivery_ref: z.string().min(1).optional(),
  transport_message_ref: z.string().min(1).optional(),
  stale_target_rejected: z.boolean().default(false),
}).strict();
export type ExecutionAuthorityOutboundConversation = z.infer<typeof ExecutionAuthorityOutboundConversationSchema>;

export const ExecutionAuthorityDecisionSchema = z.object({
  schema_version: z.literal("execution-authority-decision/v1"),
  decision_id: z.string().min(1),
  decided_at: z.string().min(1),
  lifecycle: ExecutionAuthorityLifecycleSchema,
  outcome: ExecutionAuthorityOutcomeSchema,
  reason: z.string().min(1),
  can_prepare: z.boolean().default(false),
  can_execute: z.boolean().default(false),
  can_send: z.boolean().default(false),
  fail_closed: z.boolean().default(false),
  source: ExecutionAuthoritySourceSchema,
  bindings: ExecutionAuthorityBindingsSchema.default({}),
  evidence_refs: z.array(z.string().min(1)).default([]),
  invalidation_refs: z.array(z.string().min(1)).default([]),
  host_decision: ExecutionAuthorityHostDecisionSchema.optional(),
  permission_grant_evaluation: PermissionGrantEvaluationSchema.optional(),
  admission_evaluation: AdmissionPolicyEvaluationSchema.optional(),
  autonomy_decision: AutonomyDecisionSchema.optional(),
  resident_operation_boundary: ExecutionAuthorityResidentBoundarySchema.optional(),
  outbound_conversation: ExecutionAuthorityOutboundConversationSchema.optional(),
  metadata: z.record(z.unknown()).default({}),
}).strict();
export type ExecutionAuthorityDecision = z.infer<typeof ExecutionAuthorityDecisionSchema>;
export type ExecutionAuthorityDecisionInput = z.input<typeof ExecutionAuthorityDecisionSchema>;

interface ProjectionOptions {
  decisionId?: string;
  decidedAt?: string;
  lifecycle?: ExecutionAuthorityLifecycle;
  sourceRef?: string;
  metadata?: Record<string, unknown>;
}

export function createExecutionAuthorityDecision(input: ExecutionAuthorityDecisionInput): ExecutionAuthorityDecision {
  return ExecutionAuthorityDecisionSchema.parse(input);
}

export function projectHostToolExecutionAuthority(
  hostDecision: HostToolExecutionDecision,
  options: ProjectionOptions = {},
): ExecutionAuthorityDecision {
  const outcome = hostOutcome(hostDecision.status);
  const sourceRef = options.sourceRef ?? `host-tool:${hostDecision.status}`;
  return createExecutionAuthorityDecision({
    schema_version: "execution-authority-decision/v1",
    decision_id: options.decisionId ?? `execution-authority:${sourceRef}`,
    decided_at: options.decidedAt ?? new Date().toISOString(),
    lifecycle: options.lifecycle ?? hostLifecycle(hostDecision.status),
    outcome,
    reason: hostDecision.reason,
    can_execute: hostDecision.status === "allowed",
    fail_closed: hostDecision.status === "denied"
      || hostDecision.status === "needs_sandbox"
      || hostDecision.status === "needs_escalation"
      || hostDecision.status === "fail_closed",
    source: {
      kind: "host_tool_execution",
      ref: sourceRef,
      stage: "execute",
    },
    evidence_refs: [
      hostDecision.requiredSandboxMode ? `sandbox:${hostDecision.requiredSandboxMode}` : null,
      hostDecision.requiredApprovalPolicy ? `approval-policy:${hostDecision.requiredApprovalPolicy}` : null,
    ].filter(isString),
    host_decision: hostDecision,
    metadata: options.metadata ?? {},
  });
}

export function projectPermissionGrantAuthority(
  evaluation: PermissionGrantEvaluation,
  options: ProjectionOptions = {},
): ExecutionAuthorityDecision {
  const sourceRef = options.sourceRef ?? evaluation.matchedGrantId ?? `permission-grant:${evaluation.status}`;
  const outcome: ExecutionAuthorityOutcome = evaluation.allowed
    ? "allowed"
    : evaluation.status === "hard_boundary"
      ? "fail_closed"
      : "approval_required";
  return createExecutionAuthorityDecision({
    schema_version: "execution-authority-decision/v1",
    decision_id: options.decisionId ?? `execution-authority:${sourceRef}`,
    decided_at: options.decidedAt ?? new Date().toISOString(),
    lifecycle: options.lifecycle ?? (evaluation.allowed ? "approved" : "waiting"),
    outcome,
    reason: evaluation.reason,
    can_execute: evaluation.allowed,
    fail_closed: evaluation.status === "hard_boundary",
    source: {
      kind: "permission_grant",
      ref: sourceRef,
      stage: "execute",
    },
    evidence_refs: [
      ...evaluation.consideredGrantIds.map((grantId) => `permission-grant:${grantId}`),
      ...evaluation.requiredCapabilities.map((capability) => `permission-capability:${capability}`),
      ...evaluation.excludedCapabilities.map((capability) => `permission-excluded:${capability}`),
    ],
    permission_grant_evaluation: evaluation,
    metadata: options.metadata ?? {},
  });
}

export function projectAdmissionAuthority(
  admission: AdmissionPolicyEvaluation,
  options: ProjectionOptions = {},
): ExecutionAuthorityDecision {
  const outcome: ExecutionAuthorityOutcome = admission.result === "allowed"
    ? "allowed"
    : admission.result === "approval_required"
      ? "approval_required"
      : "denied";
  return createExecutionAuthorityDecision({
    schema_version: "execution-authority-decision/v1",
    decision_id: options.decisionId ?? `execution-authority:${admission.evaluation_id}`,
    decided_at: options.decidedAt ?? admission.evaluated_at,
    lifecycle: options.lifecycle ?? (admission.result === "allowed" ? "approved" : "evidence"),
    outcome,
    reason: admission.rationale.join(" "),
    can_prepare: admission.result === "allowed",
    can_execute: admission.result === "allowed",
    fail_closed: admission.result === "suppressed" || admission.result === "prohibited",
    source: {
      kind: "admission_policy",
      ref: options.sourceRef ?? admission.evaluation_id,
      stage: "execute",
    },
    bindings: {
      operation_id: admission.operation_id,
      capability_id: admission.capability_id,
      provider_ref: admission.provider_ref,
      payload_class: admission.payload_class,
      auth_state_ref: admission.auth_state_ref,
      surface_ref: admission.surface_ref,
      target_refs: admission.target_refs,
    },
    evidence_refs: [
      ...admission.permission_grant_refs.map((ref) => `permission-grant:${ref}`),
      ...admission.rejected_permission_grant_refs.map((ref) => `permission-grant-rejected:${ref}`),
      ...admission.runtime_control_refs.map((ref) => `runtime-control:${ref}`),
      ...admission.notification_policy_refs.map((ref) => `notification-policy:${ref}`),
    ],
    invalidation_refs: admission.invalidation_bindings.map((binding) => `${binding.kind}:${binding.ref}`),
    admission_evaluation: admission,
    metadata: options.metadata ?? {},
  });
}

export function projectAutonomyAuthority(
  autonomy: AutonomyDecision,
  options: ProjectionOptions = {},
): ExecutionAuthorityDecision {
  const outcome = autonomyOutcome(autonomy.level);
  const canPrepare = autonomy.allowed_steps.some((step) => step === "prepare" || step === "advise");
  const canExecute = autonomy.allowed_steps.some((step) => step.includes("execute"));
  return createExecutionAuthorityDecision({
    schema_version: "execution-authority-decision/v1",
    decision_id: options.decisionId ?? `execution-authority:${autonomy.decision_id}`,
    decided_at: options.decidedAt ?? autonomy.evaluated_at,
    lifecycle: options.lifecycle ?? (canExecute ? "approved" : "evidence"),
    outcome,
    reason: autonomy.rationale.join(" "),
    can_prepare: canPrepare,
    can_execute: canExecute,
    fail_closed: autonomy.level === "prohibited",
    source: {
      kind: "autonomy_decision",
      ref: options.sourceRef ?? autonomy.decision_id,
      stage: canExecute ? "execute" : "prepare",
    },
    bindings: {
      operation_id: autonomy.operation_id,
      capability_id: autonomy.capability_id,
    },
    evidence_refs: [
      `admission:${autonomy.metadata.admission_evaluation_ref}`,
      ...autonomy.audit_refs,
      ...autonomy.metadata.readiness_refs.map((ref) => `readiness:${ref}`),
      ...autonomy.metadata.context_authority_evidence_refs.map((ref) => `context-authority:${ref}`),
    ],
    invalidation_refs: autonomy.invalidation_bindings.map((binding) => `${binding.kind}:${binding.ref}`),
    autonomy_decision: autonomy,
    metadata: options.metadata ?? {},
  });
}

export function projectResidentOperationBoundaryAuthority(
  boundary: ResidentOperationBoundaryResult,
  options: ProjectionOptions = {},
): ExecutionAuthorityDecision {
  const candidate = boundary.assembly.candidate_plans[0];
  const admission = boundary.admission_evaluation;
  const autonomy = boundary.autonomy_decision;
  const outcome: ExecutionAuthorityOutcome = boundary.execution_allowed
    ? "allowed"
    : autonomy?.required_user_approval || admission?.result === "approval_required"
      ? "approval_required"
    : boundary.preparation_allowed
      ? "prepare_only"
      : "fail_closed";
  const sourceRef = options.sourceRef ?? boundary.assembly.assembly_id;
  return createExecutionAuthorityDecision({
    schema_version: "execution-authority-decision/v1",
    decision_id: options.decisionId ?? `execution-authority:${sourceRef}`,
    decided_at: options.decidedAt ?? boundary.assembly.assembled_at,
    lifecycle: options.lifecycle ?? (boundary.execution_allowed ? "approved" : "evidence"),
    outcome,
    reason: boundary.assembly.reason,
    can_prepare: boundary.preparation_allowed,
    can_execute: boundary.execution_allowed,
    fail_closed: outcome === "fail_closed",
    source: {
      kind: "resident_operation_boundary",
      ref: sourceRef,
      stage: boundary.execution_allowed ? "execute" : "prepare",
    },
    bindings: {
      operation_id: candidate?.operation_plan.operation_id,
      capability_id: candidate?.operation_plan.capability_id,
      provider_ref: candidate?.operation_plan.provider_ref,
      payload_class: candidate?.operation_plan.payload_class,
      surface_ref: admission?.surface_ref,
      target_refs: candidate?.operation_plan.target_refs ?? [],
    },
    evidence_refs: [
      candidate?.plan_id ? `operation-plan:${candidate.plan_id}` : null,
      admission ? `admission:${admission.evaluation_id}` : null,
      autonomy ? `autonomy:${autonomy.decision_id}` : null,
    ].filter(isString),
    resident_operation_boundary: {
      operation_plan_assembly_id: boundary.assembly.assembly_id,
      operation_plan_status: boundary.assembly.status,
      operation_plan_reason: boundary.assembly.reason,
      ...(candidate ? { operation_plan_id: candidate.plan_id } : {}),
      ...(admission ? { operation_admission_evaluation_id: admission.evaluation_id } : {}),
      ...(autonomy ? { autonomy_decision_id: autonomy.decision_id } : {}),
      preparation_allowed: boundary.preparation_allowed,
      execution_allowed: boundary.execution_allowed,
    },
    ...(admission ? { admission_evaluation: admission } : {}),
    ...(autonomy ? { autonomy_decision: autonomy } : {}),
    metadata: options.metadata ?? {},
  });
}

export function projectOutboundConversationAuthority(input: {
  message: OutboundConversationMessage;
  currentTarget: OutboundConversationTarget | null;
  receipt?: OutboundConversationDeliveryReceipt;
  reason?: string;
  decidedAt?: string;
  decisionId?: string;
}): ExecutionAuthorityDecision {
  const message = OutboundConversationMessageSchema.parse(input.message);
  const currentTarget = input.currentTarget ? OutboundConversationTargetSchema.parse(input.currentTarget) : null;
  const receipt = input.receipt ? OutboundConversationDeliveryReceiptSchema.parse(input.receipt) : undefined;
  const targetMatches = currentTarget !== null
    && message.target_binding_ref === currentTarget.target_binding_ref
    && message.channel_policy_ref === currentTarget.channel_policy_ref;
  const sourceRef = `outbound-conversation:${message.message_id}`;
  return createExecutionAuthorityDecision({
    schema_version: "execution-authority-decision/v1",
    decision_id: input.decisionId ?? `execution-authority:${sourceRef}`,
    decided_at: input.decidedAt ?? receipt?.delivered_at ?? new Date().toISOString(),
    lifecycle: targetMatches ? "approved" : "terminal",
    outcome: targetMatches ? "allowed" : "fail_closed",
    reason: input.reason ?? (targetMatches
      ? "Outbound conversation target and channel policy refs match the current target."
      : "Outbound conversation rejected stale target or channel policy ref."),
    can_send: targetMatches,
    fail_closed: !targetMatches,
    source: {
      kind: "outbound_conversation",
      ref: sourceRef,
      stage: "send",
    },
    bindings: {
      target_binding_ref: message.target_binding_ref,
      channel_policy_ref: message.channel_policy_ref,
      target_refs: [message.target_binding_ref, message.channel_policy_ref],
    },
    evidence_refs: [
      `candidate:${message.candidate_id}`,
      `expression:${message.expression_decision_ref}`,
      `visibility:${message.visibility_policy_ref}`,
      receipt?.transport_message_ref ? `transport-message:${receipt.transport_message_ref}` : null,
    ].filter(isString),
    outbound_conversation: {
      message_id: message.message_id,
      surface: message.surface,
      target_binding_ref: message.target_binding_ref,
      channel_policy_ref: message.channel_policy_ref,
      ...(receipt ? { delivery_ref: receipt.message_id } : {}),
      ...(receipt?.transport_message_ref ? { transport_message_ref: receipt.transport_message_ref } : {}),
      stale_target_rejected: !targetMatches,
    },
  });
}

function hostOutcome(status: HostToolExecutionDecision["status"]): ExecutionAuthorityOutcome {
  switch (status) {
    case "allowed":
      return "allowed";
    case "denied":
      return "denied";
    case "needs_permission":
      return "approval_required";
    case "needs_sandbox":
      return "sandbox_required";
    case "needs_escalation":
      return "escalation_required";
    case "fail_closed":
      return "fail_closed";
  }
}

function hostLifecycle(status: HostToolExecutionDecision["status"]): ExecutionAuthorityLifecycle {
  switch (status) {
    case "allowed":
      return "approved";
    case "needs_permission":
      return "waiting";
    case "denied":
      return "denied";
    case "needs_sandbox":
    case "needs_escalation":
    case "fail_closed":
      return "terminal";
  }
}

function autonomyOutcome(level: AutonomyDecision["level"]): ExecutionAuthorityOutcome {
  switch (level) {
    case "advisory":
    case "prepare_only":
      return "prepare_only";
    case "user_directed_execute":
    case "autonomous_low_risk":
      return "allowed";
    case "approval_required":
      return "approval_required";
    case "prohibited":
      return "denied";
  }
}

function isString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
