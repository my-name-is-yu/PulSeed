import { randomUUID } from "node:crypto";
import type {
  CapabilityAuditRecord,
  CapabilityOperationKind,
  CapabilityRiskClass,
  CapabilitySideEffectProfile,
  CapabilityVerificationRef,
} from "../runtime/store/capability-verification-schemas.js";
import type {
  CapabilityExecutionContext,
  CapabilityExecutionResolutionInput,
  ITool,
  ToolCallContext,
  ToolMetadata,
  ToolResult,
} from "./types.js";

type CapabilityOperationRecord = {
  operationId: string;
  providerRef: string;
  assetRef: string;
  capabilityId: string;
  operationKind: CapabilityOperationKind;
  toolName: string;
  payloadClass: string;
  riskClass: CapabilityRiskClass;
  sideEffectProfile: CapabilitySideEffectProfile;
  userDirected: boolean;
  initiatedBy: string;
  sourceSurface: string;
  readinessSnapshotRefs: string[];
  autonomyDecisionRef?: string;
  approvalRefs: string[];
  executionRefs: string[];
  userVisibleEffect: string;
  sideEffectSummary: string;
};

export async function persistCapabilityExecutionRecords(input: {
  tool: ITool;
  rawInput: unknown;
  result: ToolResult;
  context: ToolCallContext;
}): Promise<void> {
  const store = input.context.capabilityVerificationStore;
  if (!store || input.result.execution?.status === "not_executed") return;

  const now = new Date().toISOString();
  const operation = await buildOperationRecord(input.tool, input.rawInput, input.context, input.result);
  const verification: CapabilityVerificationRef = {
    schema_version: "capability-verification-ref/v1",
    verification_id: `capability-verification:${randomUUID()}`,
    provider_ref: operation.providerRef,
    asset_ref: operation.assetRef,
    capability_id: operation.capabilityId,
    operation_kind: operation.operationKind,
    tool_name: operation.toolName,
    payload_class: operation.payloadClass,
    risk_class: operation.riskClass,
    side_effect_profile: operation.sideEffectProfile,
    verification_class: "production_caller_path",
    result: input.result.success ? "passed" : "failed",
    evidence_stage: input.result.success ? "production_succeeded" : "production_failed",
    evidence_ref: operation.executionRefs[0],
    created_at: now,
    metadata: {
      operation_id: operation.operationId,
      result_summary: input.result.summary,
      ...(input.result.error ? { error: input.result.error } : {}),
      ...(input.result.execution ? { execution: input.result.execution } : {}),
      ...(input.result.artifacts ? { artifacts: input.result.artifacts } : {}),
    },
  };

  const savedVerification = await store.saveVerification(verification);
  const audit: CapabilityAuditRecord = {
    schema_version: "capability-audit-record/v1",
    audit_id: `capability-audit:${randomUUID()}`,
    operation_id: operation.operationId,
    user_directed: operation.userDirected,
    initiated_by: operation.initiatedBy,
    source_surface: operation.sourceSurface,
    capability_refs: [operation.capabilityId],
    provider_refs: [operation.providerRef],
    readiness_snapshot_refs: operation.readinessSnapshotRefs,
    ...(operation.autonomyDecisionRef ? { autonomy_decision_ref: operation.autonomyDecisionRef } : {}),
    approval_refs: operation.approvalRefs,
    execution_refs: operation.executionRefs,
    verification_refs: [savedVerification.verification_id],
    result: input.result.success ? "succeeded" : "failed",
    side_effect_summary: operation.sideEffectSummary,
    user_visible_effect: operation.userVisibleEffect,
    follow_up_policy_effect: input.result.success ? "record_only" : "degrade_readiness_evidence",
    created_at: now,
    metadata: {
      tool_permission_level: input.tool.metadata.permissionLevel,
      tool_is_read_only: input.tool.metadata.isReadOnly,
      tool_is_destructive: input.tool.metadata.isDestructive,
      ...(input.tool.metadata.activityCategory ? { tool_activity_category: input.tool.metadata.activityCategory } : {}),
      ...(input.tool.metadata.requiresNetwork !== undefined ? { tool_requires_network: input.tool.metadata.requiresNetwork } : {}),
      tool_tags: [...input.tool.metadata.tags].sort(),
    },
  };
  await store.saveAudit(audit);
}

async function buildOperationRecord(
  tool: ITool,
  rawInput: unknown,
  context: ToolCallContext,
  result: ToolResult,
): Promise<CapabilityOperationRecord> {
  const fallbackOperationKind = inferOperationKind(tool.metadata);
  const fallbackSideEffectProfile = inferSideEffectProfile(tool.metadata, fallbackOperationKind);
  const fallbackRiskClass = inferRiskClass(tool.metadata);
  const fallbackPayloadClass = `tool-input:${tool.metadata.name}`;
  const execution = context.capabilityExecution ?? await resolveCapabilityExecution(context, {
    toolName: tool.metadata.name,
    toolMetadata: tool.metadata,
    rawInput,
    operationKind: fallbackOperationKind,
    payloadClass: fallbackPayloadClass,
    riskClass: fallbackRiskClass,
    sideEffectProfile: fallbackSideEffectProfile,
  });
  const toolName = execution?.toolName ?? tool.metadata.name;
  const operationKind = execution?.operationKind ?? fallbackOperationKind;
  const sideEffectProfile = execution?.sideEffectProfile ?? fallbackSideEffectProfile;
  const riskClass = execution?.riskClass ?? fallbackRiskClass;
  const operationId = execution?.operationId ?? `capability-operation:${toolName}:${context.callId ?? randomUUID()}`;
  const executionRefs = execution?.executionRefs && execution.executionRefs.length > 0
    ? execution.executionRefs
    : [`tool-call:${toolName}:${context.callId ?? operationId}`];
  const providerRef = execution?.providerRef ?? `runtime-tool:${toolName}`;
  const assetRef = execution?.assetRef ?? providerRef;
  const capabilityId = execution?.capabilityId ?? `capability:runtime-tool:${toolName}:${operationKind}`;
  return {
    operationId,
    providerRef,
    assetRef,
    capabilityId,
    operationKind,
    toolName,
    payloadClass: execution?.payloadClass ?? fallbackPayloadClass,
    riskClass,
    sideEffectProfile,
    userDirected: execution?.userDirected ?? true,
    initiatedBy: execution?.initiatedBy ?? "user",
    sourceSurface: execution?.sourceSurface ?? (context.conversationSessionId ? "chat" : "tool_executor"),
    readinessSnapshotRefs: execution?.readinessSnapshotRefs ?? [],
    ...(execution?.autonomyDecisionRef ? { autonomyDecisionRef: execution.autonomyDecisionRef } : {}),
    approvalRefs: execution?.approvalRefs ?? [],
    executionRefs,
    userVisibleEffect: execution?.userVisibleEffect ?? (
      result.success
        ? "Tool result was returned to the calling surface."
        : "Tool failure was returned to the calling surface."
    ),
    sideEffectSummary: execution?.sideEffectSummary ?? `${operationKind} operation via ${toolName} completed with ${sideEffectProfile} side-effect profile.`,
  };
}

async function resolveCapabilityExecution(
  context: ToolCallContext,
  input: CapabilityExecutionResolutionInput,
): Promise<CapabilityExecutionContext | null> {
  if (!context.capabilityExecutionResolver) return null;
  return context.capabilityExecutionResolver(input);
}

function inferOperationKind(metadata: ToolMetadata): CapabilityOperationKind {
  if (metadata.activityCategory === "search") return "search";
  if (metadata.activityCategory === "read") return "read";
  if (metadata.activityCategory === "planning" || metadata.activityCategory === "approval") return "prepare";
  if (metadata.activityCategory === "file_create" || metadata.activityCategory === "file_modify") return "write";
  if (metadata.activityCategory === "command" || metadata.activityCategory === "test") return "run";
  switch (metadata.permissionLevel) {
    case "read_only":
    case "read_metrics":
      return "read";
    case "write_local":
      return "write";
    case "execute":
      return "run";
    case "write_remote":
      return "mutate";
  }
}

function inferRiskClass(metadata: ToolMetadata): CapabilityRiskClass {
  if (metadata.isDestructive || metadata.permissionLevel === "execute" || metadata.permissionLevel === "write_remote") {
    return "high";
  }
  if (metadata.permissionLevel === "write_local" || metadata.permissionLevel === "read_metrics") {
    return "medium";
  }
  return "low";
}

function inferSideEffectProfile(
  metadata: ToolMetadata,
  operationKind: CapabilityOperationKind,
): CapabilitySideEffectProfile {
  if (operationKind === "hint" || operationKind === "prepare") return "none";
  if (operationKind === "read" || operationKind === "search") return "read";
  if (operationKind === "send") return "send";
  if (operationKind === "write") return "write";
  if (operationKind === "publish") return "publish";
  if (operationKind === "delete") return "delete";
  if (metadata.permissionLevel === "write_local") return "write";
  return "mutate";
}
