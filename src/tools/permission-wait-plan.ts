import { randomUUID } from "crypto";
import type { PermissionWaitCanonicalPlan } from "../runtime/store/permission-wait-plan-store.js";
import {
  decideHostToolExecution,
  type HostToolExecutionDecision,
} from "./execution-orchestrator.js";
import type {
  ApprovalRequest,
  ITool,
  ToolCallContext,
} from "./types.js";
import { resolveWorkspaceCwd } from "./workspace-scope.js";

export interface PermissionWaitPlanInput {
  tool: ITool;
  input: unknown;
  context: ToolCallContext;
  reason: string;
  reversibility: "reversible" | "irreversible" | "unknown";
  policyDecision?: HostToolExecutionDecision;
  permissionGrantDecision?: unknown;
}

export interface PermissionApprovalWaitPlan {
  approvalId: string;
  auditRef: string;
  canonicalPlan: PermissionWaitCanonicalPlan;
  approvalRequest: ApprovalRequest & { callId?: string };
}

export function buildPermissionApprovalWaitPlan(input: PermissionWaitPlanInput): PermissionApprovalWaitPlan {
  const approvalId = `permission-wait:${randomUUID()}`;
  const canonicalPlan = buildPermissionWaitCanonicalPlan(input);
  const auditRef = `tool:${input.tool.metadata.name}:${input.context.callId ?? approvalId}`;
  const approvalRequest = {
    toolName: input.tool.metadata.name,
    input: input.input,
    reason: input.reason,
    permissionLevel: input.tool.metadata.permissionLevel,
    isDestructive: input.tool.metadata.isDestructive,
    reversibility: input.reversibility,
    approvalId,
    permissionWaitPlanId: approvalId,
    canonicalPermissionPlan: canonicalPlan,
    ...(input.context.callId ? { callId: input.context.callId } : {}),
    ...(input.context.sessionId ? { sessionId: input.context.sessionId } : {}),
    ...(input.context.runId ? { runId: input.context.runId } : {}),
    ...(input.context.turnId ? { turnId: input.context.turnId } : {}),
    ...(input.permissionGrantDecision ? { permissionGrantDecision: input.permissionGrantDecision } : {}),
  };
  return {
    approvalId,
    auditRef,
    canonicalPlan,
    approvalRequest,
  };
}

export function buildPermissionWaitCanonicalPlan(input: PermissionWaitPlanInput): PermissionWaitCanonicalPlan {
  const inputRecord = input.input && typeof input.input === "object"
    ? input.input as Record<string, unknown>
    : {};
  const cwdInput = typeof inputRecord["cwd"] === "string" ? inputRecord["cwd"] as string : undefined;
  const cwdResolution = resolveWorkspaceCwd(cwdInput, input.context);
  const hostDecision = input.policyDecision ?? decideHostToolExecution({
    tool: input.tool,
    input: input.input,
    context: input.context,
  });
  const permissionGrantSummary = summarizePermissionGrantDecision(input.permissionGrantDecision);
  return {
    schema_version: "permission-wait-canonical-plan-v1",
    tool_name: input.tool.metadata.name,
    input: input.input,
    cwd: cwdResolution.valid ? cwdResolution.resolved : input.context.cwd,
    ...(typeof inputRecord["command"] === "string" && inputRecord["command"].trim()
      ? { command: inputRecord["command"] as string }
      : {}),
    target: {
      goal_id: input.context.goalId,
      ...(input.context.runId ? { run_id: input.context.runId } : {}),
      ...(input.context.sessionId ? { session_id: input.context.sessionId } : {}),
      ...(input.context.turnId ? { turn_id: input.context.turnId } : {}),
      ...(input.context.callId ? { tool_call_id: input.context.callId } : {}),
    },
    permission: {
      permission_level: input.tool.metadata.permissionLevel,
      is_destructive: input.tool.metadata.isDestructive,
      reversibility: input.reversibility,
    },
    ...(input.context.hostToolState?.currentEpoch ?? input.context.hostToolState?.observedEpoch
      ? { state_epoch: input.context.hostToolState?.currentEpoch ?? input.context.hostToolState?.observedEpoch }
      : {}),
    capability_facts: {
      tool_permission_level: input.tool.metadata.permissionLevel,
      tool_is_read_only: input.tool.metadata.isReadOnly,
      tool_is_destructive: input.tool.metadata.isDestructive,
      ...(input.tool.metadata.requiresNetwork !== undefined ? { tool_requires_network: input.tool.metadata.requiresNetwork } : {}),
      ...(input.tool.metadata.activityCategory ? { tool_activity_category: input.tool.metadata.activityCategory } : {}),
      tool_tags: [...input.tool.metadata.tags].sort(),
      host_decision_status: hostDecision.status,
      host_decision_reason: hostDecision.reason,
      ...(permissionGrantSummary.status ? { permission_grant_status: permissionGrantSummary.status } : {}),
      ...(permissionGrantSummary.reason ? { permission_grant_reason: permissionGrantSummary.reason } : {}),
    },
  };
}

export function buildApprovedToolCallContext(context: ToolCallContext): ToolCallContext {
  return {
    ...context,
    preApproved: true,
    hostPolicyApproved: true,
  };
}

function summarizePermissionGrantDecision(value: unknown): { status?: string; reason?: string } {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const status = typeof record["status"] === "string" ? record["status"] : undefined;
  const reason = typeof record["reason"] === "string"
    ? record["reason"]
    : typeof record["evidence"] === "string"
      ? record["evidence"]
      : undefined;
  return {
    ...(status ? { status } : {}),
    ...(reason ? { reason } : {}),
  };
}
