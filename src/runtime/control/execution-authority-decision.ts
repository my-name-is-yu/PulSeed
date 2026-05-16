import { createHash } from "node:crypto";
import { z } from "zod/v3";
import { ToolExecutionReasonSchema, type HostToolExecutionDecision } from "../../tools/types.js";
import {
  PermissionGrantEvaluationSchema,
  type PermissionGrantEvaluation,
} from "../../tools/permission-grant-evaluation.js";
import { AdmissionPolicyEvaluationSchema, type AdmissionPolicyEvaluation } from "./admission-policy.js";
import { AutonomyDecisionSchema, type AutonomyDecision } from "./autonomy-governor.js";
import type { ResidentOperationBoundaryResult } from "../capability-operation-planner.js";
import type {
  PermissionWaitCanonicalPlan,
  PermissionWaitPlanResumeResult,
} from "../store/permission-wait-plan-store.js";
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
  "held",
  "suppressed",
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
  "notify",
  "ask",
  "hold",
  "suppress",
  "callback",
  "feedback",
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
  "peer_initiative",
  "telegram_callback",
  "notification",
  "approval",
  "feedback",
  "runtime_control",
  "memory_correction",
  "tool_executor",
  "schedule",
  "daemon_resident",
  "surface_projection",
]);
export type ExecutionAuthoritySourceKind = z.infer<typeof ExecutionAuthoritySourceKindSchema>;

export const ExecutionAuthoritySurfaceClassSchema = z.enum([
  "normal_user",
  "operator_debug",
  "transport",
  "projection_only",
  "mutation_owner",
  "internal",
]);
export type ExecutionAuthoritySurfaceClass = z.infer<typeof ExecutionAuthoritySurfaceClassSchema>;

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
  delivery_ref: z.string().min(1).optional(),
  transport_message_ref: z.string().min(1).optional(),
  feedback_ref: z.string().min(1).optional(),
  approval_ref: z.string().min(1).optional(),
  quieting_ref: z.string().min(1).optional(),
  normal_surface_projection_ref: z.string().min(1).optional(),
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
  can_notify: z.boolean().default(false),
  can_ask: z.boolean().default(false),
  can_hold: z.boolean().default(false),
  can_suppress: z.boolean().default(false),
  requires_approval: z.boolean().default(false),
  fail_closed: z.boolean().default(false),
  stale_target_rejected: z.boolean().default(false),
  suppressed: z.boolean().default(false),
  memory_withheld: z.boolean().default(false),
  surface: z.string().min(1).optional(),
  surface_class: ExecutionAuthoritySurfaceClassSchema.optional(),
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
  canNotify?: boolean;
  surfaceClass?: ExecutionAuthoritySurfaceClass;
  deliveryRef?: string;
  quietingRef?: string;
  normalSurfaceProjectionRef?: string;
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
    can_notify: targetMatches && input.canNotify === true,
    fail_closed: !targetMatches,
    stale_target_rejected: !targetMatches,
    surface: message.surface,
    surface_class: input.surfaceClass ?? "transport",
    source: {
      kind: "outbound_conversation",
      ref: sourceRef,
      stage: "send",
    },
    bindings: {
      target_binding_ref: message.target_binding_ref,
      channel_policy_ref: message.channel_policy_ref,
      ...(input.deliveryRef ? { delivery_ref: input.deliveryRef } : {}),
      ...(receipt?.transport_message_ref ? { transport_message_ref: receipt.transport_message_ref } : {}),
      ...(input.quietingRef ? { quieting_ref: input.quietingRef } : {}),
      ...(input.normalSurfaceProjectionRef ? { normal_surface_projection_ref: input.normalSurfaceProjectionRef } : {}),
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
      ...(input.deliveryRef ?? receipt?.message_id ? { delivery_ref: input.deliveryRef ?? receipt?.message_id } : {}),
      ...(receipt?.transport_message_ref ? { transport_message_ref: receipt.transport_message_ref } : {}),
      stale_target_rejected: !targetMatches,
    },
  });
}

export function projectPeerInitiativeDeliveryAuthority(input: {
  candidateId: string;
  deliveryId: string;
  surface: string;
  reason: string;
  decidedAt?: string;
  decisionId?: string;
  outcome?: Extract<ExecutionAuthorityOutcome, "allowed" | "held" | "suppressed" | "fail_closed" | "approval_required">;
  canSend?: boolean;
  canNotify?: boolean;
  canHold?: boolean;
  canSuppress?: boolean;
  requiresApproval?: boolean;
  failClosed?: boolean;
  suppressed?: boolean;
  targetBindingRef?: string;
  channelPolicyRef?: string;
  deliveryRef?: string;
  transportMessageRef?: string;
  expressionDecisionRef?: string;
  visibilityPolicyRef?: string;
  quietingRef?: string;
  normalSurfaceProjectionRef?: string;
}): ExecutionAuthorityDecision {
  const outcome = input.outcome
    ?? (input.failClosed
      ? "fail_closed"
      : input.suppressed || input.canSuppress
        ? "suppressed"
        : input.canSend
          ? "allowed"
          : "held");
  const sourceRef = `peer-initiative:${input.candidateId}:${input.deliveryId}`;
  return createExecutionAuthorityDecision({
    schema_version: "execution-authority-decision/v1",
    decision_id: input.decisionId ?? `execution-authority:${sourceRef}`,
    decided_at: input.decidedAt ?? new Date().toISOString(),
    lifecycle: outcome === "allowed" ? "approved" : outcome === "approval_required" ? "waiting" : "terminal",
    outcome,
    reason: input.reason,
    can_prepare: true,
    can_send: input.canSend === true,
    can_notify: input.canNotify === true,
    can_hold: input.canHold === true || outcome === "held",
    can_suppress: input.canSuppress === true || outcome === "suppressed",
    requires_approval: input.requiresApproval === true || outcome === "approval_required",
    fail_closed: input.failClosed === true || outcome === "fail_closed",
    suppressed: input.suppressed === true || outcome === "suppressed",
    surface: input.surface,
    surface_class: "mutation_owner",
    source: {
      kind: "peer_initiative",
      ref: sourceRef,
      stage: outcome === "suppressed" ? "suppress" : outcome === "held" ? "hold" : "send",
    },
    bindings: {
      target_refs: [
        input.candidateId,
        input.targetBindingRef,
        input.channelPolicyRef,
      ].filter(isString),
      ...(input.targetBindingRef ? { target_binding_ref: input.targetBindingRef } : {}),
      ...(input.channelPolicyRef ? { channel_policy_ref: input.channelPolicyRef } : {}),
      delivery_ref: input.deliveryRef ?? input.deliveryId,
      ...(input.transportMessageRef ? { transport_message_ref: input.transportMessageRef } : {}),
      ...(input.quietingRef ? { quieting_ref: input.quietingRef } : {}),
      ...(input.normalSurfaceProjectionRef ? { normal_surface_projection_ref: input.normalSurfaceProjectionRef } : {}),
    },
    evidence_refs: [
      `candidate:${input.candidateId}`,
      input.expressionDecisionRef ? `expression:${input.expressionDecisionRef}` : null,
      input.visibilityPolicyRef ? `visibility:${input.visibilityPolicyRef}` : null,
      input.quietingRef ? `quieting:${input.quietingRef}` : null,
    ].filter(isString),
  });
}

export function projectTelegramCallbackAuthority(input: {
  callbackId: string;
  candidateId?: string;
  action?: string;
  deliveryId?: string;
  targetBindingRef?: string;
  channelPolicyRef?: string;
  transportMessageRef?: string;
  callbackTargetBindingRef?: string;
  callbackTransportMessageRef?: string;
  deliveryMatches: boolean;
  actionMatches: boolean;
  feedbackRef?: string;
  approvalRef?: string;
  reason?: string;
  decidedAt?: string;
  decisionId?: string;
}): ExecutionAuthorityDecision {
  const allowed = input.deliveryMatches && input.actionMatches;
  const sourceRef = `telegram-callback:${input.callbackId}`;
  return createExecutionAuthorityDecision({
    schema_version: "execution-authority-decision/v1",
    decision_id: input.decisionId ?? `execution-authority:${sourceRef}`,
    decided_at: input.decidedAt ?? new Date().toISOString(),
    lifecycle: allowed ? "approved" : "terminal",
    outcome: allowed ? "allowed" : "fail_closed",
    reason: input.reason ?? (allowed
      ? "Telegram callback matched the current peer delivery and action binding."
      : "Telegram callback rejected stale, wrong-target, or unknown peer delivery/action binding."),
    can_execute: allowed,
    fail_closed: !allowed,
    stale_target_rejected: !allowed,
    surface: "telegram",
    surface_class: "transport",
    source: {
      kind: "telegram_callback",
      ref: sourceRef,
      stage: "callback",
    },
    bindings: {
      target_refs: [
        input.candidateId,
        input.deliveryId,
        input.targetBindingRef,
        input.channelPolicyRef,
        input.callbackTargetBindingRef,
      ].filter(isString),
      ...(input.targetBindingRef ? { target_binding_ref: input.targetBindingRef } : {}),
      ...(input.channelPolicyRef ? { channel_policy_ref: input.channelPolicyRef } : {}),
      ...(input.deliveryId ? { delivery_ref: input.deliveryId } : {}),
      ...(input.transportMessageRef ? { transport_message_ref: input.transportMessageRef } : {}),
      ...(input.feedbackRef ? { feedback_ref: input.feedbackRef } : {}),
      ...(input.approvalRef ? { approval_ref: input.approvalRef } : {}),
    },
    evidence_refs: [
      input.candidateId ? `candidate:${input.candidateId}` : null,
      input.deliveryId ? `peer-delivery:${input.deliveryId}` : null,
      input.action ? `telegram-callback-action:${input.action}` : null,
      input.callbackTargetBindingRef ? `callback-target:${input.callbackTargetBindingRef}` : null,
      input.callbackTransportMessageRef ? `callback-transport-message:${input.callbackTransportMessageRef}` : null,
    ].filter(isString),
  });
}

export function projectApprovalResumeAuthority(input: {
  waitPlanId: string;
  resumeResult: PermissionWaitPlanResumeResult;
  expectedCanonicalPlan?: PermissionWaitCanonicalPlan;
  actualCanonicalPlan: PermissionWaitCanonicalPlan;
  resumePhase?: "before_mutation" | "outcome";
  reason?: string;
  decidedAt?: string;
  decisionId?: string;
}): ExecutionAuthorityDecision {
  const beforeMutation = input.resumePhase === "before_mutation";
  const resumed = input.resumeResult.status === "resumed";
  const record = input.resumeResult.status === "not_found" ? null : input.resumeResult.record;
  const mismatchReasons = input.resumeResult.status === "mismatch_rejected"
    ? input.resumeResult.mismatch_reasons
    : [];
  const expectedPlan = input.expectedCanonicalPlan ?? record?.canonical_plan ?? input.actualCanonicalPlan;
  const actualPlan = input.actualCanonicalPlan;
  const targetBindingRef = approvalTargetBindingRef(actualPlan);
  const sourceRef = `approval:${input.waitPlanId}:resume`;
  return createExecutionAuthorityDecision({
    schema_version: "execution-authority-decision/v1",
    decision_id: input.decisionId ?? `execution-authority:${sourceRef}`,
    decided_at: input.decidedAt ?? new Date().toISOString(),
    lifecycle: beforeMutation ? "evidence" : resumed ? "approved" : "terminal",
    outcome: beforeMutation ? "prepare_only" : resumed ? "allowed" : "fail_closed",
    reason: input.reason ?? approvalResumeReason(input.resumeResult.status, mismatchReasons),
    can_prepare: beforeMutation,
    can_execute: !beforeMutation && resumed,
    requires_approval: true,
    fail_closed: !beforeMutation && !resumed,
    stale_target_rejected: !beforeMutation && !resumed,
    source: {
      kind: "approval",
      ref: sourceRef,
      stage: beforeMutation ? "prepare" : "execute",
    },
    bindings: {
      approval_ref: record?.approval_id ?? input.waitPlanId,
      target_binding_ref: targetBindingRef,
      target_refs: uniqueStrings([
        targetBindingRef,
        ...approvalPlanTargetRefs(expectedPlan, "expected"),
        ...approvalPlanTargetRefs(actualPlan, "actual"),
      ]),
    },
    evidence_refs: [
      `approval:${record?.approval_id ?? input.waitPlanId}`,
      `permission-wait-plan:${input.waitPlanId}`,
      record?.state ? `permission-wait-state:${record.state}` : null,
      ...mismatchReasons.map((reason) => `approval-mismatch:${reason}`),
    ].filter(isString),
    invalidation_refs: mismatchReasons.map((reason) => `approval-mismatch:${reason}`),
    metadata: {
      resume_phase: beforeMutation ? "before_mutation" : "outcome",
      resume_status: input.resumeResult.status,
      mismatch_reasons: mismatchReasons,
      expected_target_binding_ref: approvalTargetBindingRef(expectedPlan),
      actual_target_binding_ref: targetBindingRef,
      expected_input_ref: approvalInputRef(expectedPlan),
      actual_input_ref: approvalInputRef(actualPlan),
    },
  });
}

export function projectNotificationAuthority(input: {
  reportId: string;
  reportType: string;
  reason: string;
  decidedAt?: string;
  decisionId?: string;
  channelRefs?: readonly string[];
  canNotify?: boolean;
  suppressed?: boolean;
  quietingRef?: string;
}): ExecutionAuthorityDecision {
  const suppressed = input.suppressed === true;
  const sourceRef = `notification:${input.reportId}:${input.reportType}`;
  return createExecutionAuthorityDecision({
    schema_version: "execution-authority-decision/v1",
    decision_id: input.decisionId ?? `execution-authority:${sourceRef}`,
    decided_at: input.decidedAt ?? new Date().toISOString(),
    lifecycle: suppressed ? "terminal" : "approved",
    outcome: suppressed ? "suppressed" : "allowed",
    reason: input.reason,
    can_notify: input.canNotify === true && !suppressed,
    can_suppress: suppressed,
    suppressed,
    surface: "notification",
    surface_class: "mutation_owner",
    source: {
      kind: "notification",
      ref: sourceRef,
      stage: suppressed ? "suppress" : "notify",
    },
    bindings: {
      target_refs: [...(input.channelRefs ?? [])],
      ...(input.quietingRef ? { quieting_ref: input.quietingRef } : {}),
    },
    evidence_refs: [
      `report:${input.reportId}`,
      `report-type:${input.reportType}`,
      input.quietingRef ? `quieting:${input.quietingRef}` : null,
      ...(input.channelRefs ?? []).map((ref) => `channel:${ref}`),
    ].filter(isString),
  });
}

export function projectMemoryCorrectionAuthority(input: {
  correctionId: string;
  targetRef: string;
  reason: string;
  decidedAt?: string;
  decisionId?: string;
  memoryWithheld?: boolean;
  normalSurfaceProjectionRef?: string;
}): ExecutionAuthorityDecision {
  const sourceRef = `memory-correction:${input.correctionId}`;
  return createExecutionAuthorityDecision({
    schema_version: "execution-authority-decision/v1",
    decision_id: input.decisionId ?? `execution-authority:${sourceRef}`,
    decided_at: input.decidedAt ?? new Date().toISOString(),
    lifecycle: "approved",
    outcome: "allowed",
    reason: input.reason,
    can_execute: true,
    memory_withheld: input.memoryWithheld === true,
    surface: "memory_correction",
    surface_class: "mutation_owner",
    source: {
      kind: "memory_correction",
      ref: sourceRef,
      stage: "execute",
    },
    bindings: {
      target_refs: [input.targetRef],
      ...(input.normalSurfaceProjectionRef ? { normal_surface_projection_ref: input.normalSurfaceProjectionRef } : {}),
    },
    evidence_refs: [
      `memory-correction:${input.correctionId}`,
      `memory-target:${input.targetRef}`,
    ],
  });
}

function approvalResumeReason(
  status: PermissionWaitPlanResumeResult["status"],
  mismatchReasons: readonly string[],
): string {
  if (status === "resumed") {
    return "Approval resume matched the stored canonical plan before tool execution.";
  }
  if (status === "mismatch_rejected") {
    return `Approval resume rejected stale or mismatched canonical plan: ${mismatchReasons.join(", ")}`;
  }
  if (status === "expired") {
    return "Approval resume rejected an expired approval before tool execution.";
  }
  if (status === "not_approved") {
    return "Approval resume rejected a wait plan that is not approved.";
  }
  return "Approval resume rejected a missing wait plan.";
}

function approvalPlanTargetRefs(plan: PermissionWaitCanonicalPlan, prefix: "expected" | "actual"): string[] {
  return [
    `approval-${prefix}-tool:${plan.tool_name}`,
    plan.target.goal_id ? `approval-${prefix}-goal:${plan.target.goal_id}` : null,
    plan.target.run_id ? `approval-${prefix}-run:${plan.target.run_id}` : null,
    plan.target.session_id ? `approval-${prefix}-session:${plan.target.session_id}` : null,
    plan.target.turn_id ? `approval-${prefix}-turn:${plan.target.turn_id}` : null,
    plan.target.tool_call_id ? `approval-${prefix}-tool-call:${plan.target.tool_call_id}` : null,
    plan.state_epoch ? `approval-${prefix}-state-epoch:${plan.state_epoch}` : null,
    approvalInputRef(plan),
  ].filter(isString);
}

function approvalTargetBindingRef(plan: PermissionWaitCanonicalPlan): string {
  return `permission-wait-target:${stableAuthorityHash({
    tool_name: plan.tool_name,
    cwd: plan.cwd,
    target: plan.target,
    permission: plan.permission,
    state_epoch: plan.state_epoch ?? null,
  })}`;
}

function approvalInputRef(plan: PermissionWaitCanonicalPlan): string {
  return `approval-input:${stableAuthorityHash(plan.input)}`;
}

function stableAuthorityHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJson((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
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
