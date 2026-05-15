import * as path from "node:path";
import type {
  PermissionGrantCapability,
  PermissionGrantExcludedCapability,
  PermissionGrantRecord,
} from "../runtime/store/permission-grant-store.js";
import {
  isPermissionGrantCurrentlyActive,
  isPermissionGrantExpired,
  isPermissionGrantStale,
} from "../runtime/store/permission-grant-store.js";
import type { HostToolExecutionDecision } from "./execution-orchestrator.js";
import type {
  PermissionGrantEvaluation,
  PermissionGrantEvaluationStatus,
} from "./permission-grant-evaluation.js";
import { assessShellCommand } from "./system/ShellTool/command-policy.js";
import type { ITool, ToolCallContext } from "./types.js";
import { resolveWorkspaceCwd } from "./workspace-scope.js";

export type { PermissionGrantEvaluation, PermissionGrantEvaluationStatus };

export interface PermissionGrantEvaluationRequest {
  tool: ITool;
  input: unknown;
  context: ToolCallContext;
  hostDecision: HostToolExecutionDecision;
  now?: number;
}

interface PermissionGrantRequestFacts {
  requiredCapabilities: PermissionGrantCapability[];
  excludedCapabilities: PermissionGrantExcludedCapability[];
}

export async function evaluatePermissionGrantForToolCall(
  request: PermissionGrantEvaluationRequest,
): Promise<PermissionGrantEvaluation> {
  const facts = classifyPermissionGrantRequest(request.tool, request.input, request.context);
  if (request.hostDecision.status !== "needs_permission") {
    return {
      status: "hard_boundary",
      allowed: false,
      reason: `Host policy decision is ${request.hostDecision.status}; grants only apply to needs_permission.`,
      ...facts,
      consideredGrantIds: [],
    };
  }

  if (facts.excludedCapabilities.length > 0) {
    return {
      status: facts.excludedCapabilities.includes("unknown_capability") ? "unknown_capability" : "excluded_capability",
      allowed: false,
      reason: `Permission grants cannot cover excluded capabilities: ${facts.excludedCapabilities.join(", ")}`,
      ...facts,
      consideredGrantIds: [],
    };
  }

  if (facts.requiredCapabilities.length === 0) {
    return {
      status: "fresh_approval_required",
      allowed: false,
      reason: "Tool request did not classify into a grantable capability.",
      ...facts,
      consideredGrantIds: [],
    };
  }

  const store = request.context.permissionGrantStore;
  if (!store) {
    return {
      status: "missing_grant",
      allowed: false,
      reason: "No PermissionGrant store is attached to this tool context.",
      ...facts,
      consideredGrantIds: [],
    };
  }

  const grants = await store.list();
  const consideredGrantIds: string[] = [];
  let lifecycleBlocker: PermissionGrantEvaluation | null = null;

  for (const grant of grants) {
    consideredGrantIds.push(grant.grant_id);
    if (!grantScopeMatchesContext(grant, request.context)) continue;
    if (!grantOriginMatchesContext(grant, request.context)) continue;

    const lifecycleDecision = inactiveGrantDecision(grant, request.now, facts, consideredGrantIds);
    if (lifecycleDecision) {
      lifecycleBlocker ??= lifecycleDecision;
      continue;
    }

    const coversAllCapabilities = facts.requiredCapabilities.every((capability) =>
      grant.capabilities.includes(capability)
    );
    if (!coversAllCapabilities) continue;

    const recorded = await store.recordUse(grant.grant_id, {
      audit_ref: request.context.callId ? `tool-call:${request.context.callId}` : `tool:${request.tool.metadata.name}`,
    });
    if (!recorded) {
      return {
        status: "fresh_approval_required",
        allowed: false,
        reason: `Grant ${grant.grant_id} matched but could not be recorded as used.`,
        ...facts,
        matchedGrantId: grant.grant_id,
        consideredGrantIds,
      };
    }

    return {
      status: "matched",
      allowed: true,
      reason: `PermissionGrant ${grant.grant_id} covers ${facts.requiredCapabilities.join(", ")}.`,
      ...facts,
      matchedGrantId: grant.grant_id,
      consideredGrantIds,
    };
  }

  return lifecycleBlocker ?? {
    status: "missing_grant",
    allowed: false,
    reason: `No active PermissionGrant covers ${facts.requiredCapabilities.join(", ")} in the current scope.`,
    ...facts,
    consideredGrantIds,
  };
}

function inactiveGrantDecision(
  grant: PermissionGrantRecord,
  now: number | undefined,
  facts: PermissionGrantRequestFacts,
  consideredGrantIds: string[],
): PermissionGrantEvaluation | null {
  if (grant.state === "revoked") {
    return {
      status: "revoked_grant",
      allowed: false,
      reason: `Grant ${grant.grant_id} is revoked.`,
      ...facts,
      matchedGrantId: grant.grant_id,
      consideredGrantIds: [...consideredGrantIds],
    };
  }
  if (grant.state === "superseded") {
    return {
      status: "superseded_grant",
      allowed: false,
      reason: `Grant ${grant.grant_id} is superseded.`,
      ...facts,
      matchedGrantId: grant.grant_id,
      consideredGrantIds: [...consideredGrantIds],
    };
  }
  if (isPermissionGrantExpired(grant, now)) {
    return {
      status: "expired_grant",
      allowed: false,
      reason: `Grant ${grant.grant_id} is expired.`,
      ...facts,
      matchedGrantId: grant.grant_id,
      consideredGrantIds: [...consideredGrantIds],
    };
  }
  if (isPermissionGrantStale(grant) || !isPermissionGrantCurrentlyActive(grant, now)) {
    return {
      status: "stale_grant",
      allowed: false,
      reason: `Grant ${grant.grant_id} is stale or no longer active.`,
      ...facts,
      matchedGrantId: grant.grant_id,
      consideredGrantIds: [...consideredGrantIds],
    };
  }
  return null;
}

function classifyPermissionGrantRequest(
  tool: ITool,
  input: unknown,
  context: ToolCallContext,
): PermissionGrantRequestFacts {
  if (tool.metadata.name === "shell" || tool.metadata.name === "shell_command") {
    return classifyShellPermissionGrantRequest(input, context);
  }

  const requiredCapabilities = new Set<PermissionGrantCapability>();
  const excludedCapabilities = new Set<PermissionGrantExcludedCapability>();

  if (tool.metadata.isDestructive) excludedCapabilities.add("destructive_action");
  if (tool.metadata.permissionLevel === "write_remote") excludedCapabilities.add("write_remote");
  if (tool.metadata.requiresNetwork || tool.metadata.tags.includes("network")) {
    excludedCapabilities.add("network_send");
    excludedCapabilities.add("external_send");
  }

  if (tool.metadata.tags.includes("memory")) requiredCapabilities.add("update_memory");
  if (tool.metadata.tags.includes("surface")) requiredCapabilities.add("update_surface");
  if (tool.metadata.activityCategory === "test") requiredCapabilities.add("run_tests");
  if (tool.metadata.activityCategory === "file_create" || tool.metadata.activityCategory === "file_modify") {
    requiredCapabilities.add("write_workspace");
  }

  if (requiredCapabilities.size === 0) {
    switch (tool.metadata.permissionLevel) {
      case "read_only":
        requiredCapabilities.add("read_workspace");
        break;
      case "read_metrics":
        requiredCapabilities.add("inspect_runtime");
        break;
      case "write_local":
        requiredCapabilities.add("write_workspace");
        break;
      case "execute":
        excludedCapabilities.add("unknown_capability");
        break;
      case "write_remote":
        break;
    }
  }

  return {
    requiredCapabilities: [...requiredCapabilities],
    excludedCapabilities: [...excludedCapabilities],
  };
}

function classifyShellPermissionGrantRequest(
  input: unknown,
  context: ToolCallContext,
): PermissionGrantRequestFacts {
  const requiredCapabilities = new Set<PermissionGrantCapability>();
  const excludedCapabilities = new Set<PermissionGrantExcludedCapability>();
  if (typeof input !== "object" || input === null) {
    excludedCapabilities.add("unknown_capability");
    return {
      requiredCapabilities: [],
      excludedCapabilities: [...excludedCapabilities],
    };
  }

  const command = (input as { command?: unknown }).command;
  if (typeof command !== "string") {
    excludedCapabilities.add("unknown_capability");
    return {
      requiredCapabilities: [],
      excludedCapabilities: [...excludedCapabilities],
    };
  }

  const cwdValidation = resolveWorkspaceCwd((input as { cwd?: unknown }).cwd as string | undefined, context);
  const assessment = assessShellCommand(
    command,
    context.executionPolicy,
    context.trusted === true,
    cwdValidation.valid ? cwdValidation.resolved : context.cwd,
  );

  if (assessment.capabilities.destructive) excludedCapabilities.add("destructive_action");
  if (assessment.capabilities.protectedTarget) excludedCapabilities.add("protected_path_mutation");
  if (assessment.capabilities.network) {
    excludedCapabilities.add("network_send");
    excludedCapabilities.add("external_send");
  }
  if (
    !assessment.capabilities.readOnly
    && !assessment.capabilities.localWrite
    && !assessment.capabilities.network
    && !assessment.capabilities.destructive
  ) {
    excludedCapabilities.add("unknown_capability");
  }
  if (assessment.capabilities.localWrite) requiredCapabilities.add("run_safe_local_commands");
  if (assessment.capabilities.readOnly && requiredCapabilities.size === 0) requiredCapabilities.add("inspect_runtime");

  return {
    requiredCapabilities: [...requiredCapabilities],
    excludedCapabilities: [...excludedCapabilities],
  };
}

function grantScopeMatchesContext(grant: PermissionGrantRecord, context: ToolCallContext): boolean {
  switch (grant.scope.kind) {
    case "turn":
      return Boolean(context.turnId && context.turnId === grant.scope.turn_id);
    case "run":
      return Boolean(context.runId && context.runId === grant.scope.run_id);
    case "goal":
      return context.goalId === grant.scope.goal_id;
    case "session":
      return contextSessionIds(context).includes(grant.scope.session_id ?? "");
    case "workspace": {
      const grantWorkspaceRoot = normalizePath(grant.scope.workspace_root);
      return Boolean(grantWorkspaceRoot && contextWorkspaceRoots(context).includes(grantWorkspaceRoot));
    }
    case "project":
      return Boolean(context.projectId && context.projectId === grant.scope.project_id);
    case "global":
      return true;
  }
}

function grantOriginMatchesContext(grant: PermissionGrantRecord, context: ToolCallContext): boolean {
  const sessionIds = contextSessionIds(context);
  const standingGrant = grant.duration.kind === "standing";
  if (grant.origin.session_id && !standingGrant && !sessionIds.includes(grant.origin.session_id)) return false;
  if (grant.origin.conversation_id) {
    const conversationIds = contextConversationIds(context);
    if (!conversationIds.includes(grant.origin.conversation_id)) return false;
  }
  if (grant.origin.user_id) {
    const userIds = contextUserIds(context);
    if (userIds.length > 0 && !userIds.includes(grant.origin.user_id)) return false;
  }
  return true;
}

function contextSessionIds(context: ToolCallContext): string[] {
  return [context.sessionId, context.conversationSessionId].filter((value): value is string => Boolean(value));
}

function contextConversationIds(context: ToolCallContext): string[] {
  return [
    context.conversationSessionId,
    stringField(context.runtimeReplyTarget, "conversation_id"),
    stringField(context.runtimeControlActor, "conversation_id"),
  ].filter((value): value is string => Boolean(value));
}

function contextUserIds(context: ToolCallContext): string[] {
  return [
    stringField(context.runtimeReplyTarget, "user_id"),
    stringField(context.runtimeControlActor, "user_id"),
  ].filter((value): value is string => Boolean(value));
}

function contextWorkspaceRoots(context: ToolCallContext): string[] {
  return [
    normalizePath(context.executionPolicy?.workspaceRoot),
    normalizePath(context.cwd),
  ].filter((value): value is string => Boolean(value));
}

function stringField(value: Record<string, unknown> | null | undefined, field: string): string | undefined {
  const fieldValue = value?.[field];
  return typeof fieldValue === "string" && fieldValue.trim() ? fieldValue : undefined;
}

function normalizePath(value: string | undefined): string | undefined {
  return value ? path.resolve(value) : undefined;
}
