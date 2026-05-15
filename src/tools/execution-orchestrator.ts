import type { HostToolExecutionDecision, ITool, ToolCallContext, ToolResult } from "./types.js";
import { assessShellCommand } from "./system/ShellTool/command-policy.js";
import { resolveWorkspaceCwd } from "./workspace-scope.js";

export type { HostToolExecutionDecision, HostToolExecutionDecisionStatus } from "./types.js";

export interface HostToolExecutionRequest {
  tool: ITool;
  input: unknown;
  context: ToolCallContext;
}

export function decideHostToolExecution(
  request: HostToolExecutionRequest
): HostToolExecutionDecision {
  const staleStateDecision = decideStateFreshness(request.context);
  if (staleStateDecision) return staleStateDecision;

  const policy = request.context.executionPolicy;
  if (!policy) {
    return { status: "allowed", reason: "No host execution policy is attached to this call." };
  }

  const cwdDecision = decideWorkspaceCwd(request);
  if (cwdDecision) return cwdDecision;

  const shellDecision = decideShellExecution(request);
  if (shellDecision) return shellDecision;

  const needsNetwork = request.tool.metadata.permissionLevel === "write_remote"
    || request.tool.metadata.requiresNetwork === true
    || request.tool.metadata.tags.includes("network");
  if (needsNetwork && !policy.networkAccess) {
    return {
      status: "needs_sandbox",
      reason: "Network access is disabled for this session.",
      executionReason: "sandbox_required",
      requiredSandboxMode: "danger_full_access",
    };
  }

  if (policy.sandboxMode === "read_only" && !request.tool.metadata.isReadOnly) {
    return {
      status: "needs_sandbox",
      reason: "Read-only sandbox blocks mutating tools.",
      executionReason: "sandbox_required",
      requiredSandboxMode: "workspace_write",
    };
  }

  if (
    policy.approvalPolicy === "untrusted"
    && (request.tool.metadata.isDestructive
      || request.tool.metadata.permissionLevel === "execute"
      || request.tool.metadata.permissionLevel === "write_remote")
  ) {
    return {
      status: "needs_escalation",
      reason: `Host policy requires escalation for ${request.tool.metadata.permissionLevel} tools.`,
      executionReason: "escalation_required",
      requiredApprovalPolicy: "on_request",
    };
  }

  if (request.context.hostPolicyApproved === true) {
    return { status: "allowed", reason: "This exact tool request was already approved for execution." };
  }

  if (
    request.tool.metadata.permissionLevel === "write_local"
    || request.tool.metadata.permissionLevel === "execute"
    || request.tool.metadata.permissionLevel === "write_remote"
  ) {
    if (policy.approvalPolicy !== "never") {
      return {
        status: "needs_permission",
        reason: `Host policy requires permission for ${request.tool.metadata.permissionLevel} tools.`,
        executionReason: "approval_denied",
        requiredApprovalPolicy: "on_request",
      };
    }
  }

  return { status: "allowed", reason: "Host policy allows this typed tool request." };
}

function decideStateFreshness(context: ToolCallContext): HostToolExecutionDecision | null {
  const state = context.hostToolState;
  if (!state?.observedEpoch) return null;
  if (state.observedEpoch === state.currentEpoch) return null;
  return {
    status: "fail_closed",
    reason: `Tool request observed state epoch ${state.observedEpoch}, but host state is now ${state.currentEpoch}.`,
    executionReason: "stale_state",
  };
}

function decideWorkspaceCwd(request: HostToolExecutionRequest): HostToolExecutionDecision | null {
  if (typeof request.input !== "object" || request.input === null) return null;
  const cwd = (request.input as { cwd?: unknown }).cwd;
  if (cwd !== undefined && typeof cwd !== "string") {
    return {
      status: "fail_closed",
      reason: "Tool cwd must be a string when provided.",
      executionReason: "policy_blocked",
    };
  }
  const validation = resolveWorkspaceCwd(cwd, request.context);
  if (validation.valid) return null;
  return {
    status: "fail_closed",
    reason: validation.error ?? `Tool cwd escapes workspace root: ${validation.resolved}`,
    executionReason: "policy_blocked",
  };
}

function decideShellExecution(
  request: HostToolExecutionRequest
): HostToolExecutionDecision | null {
  if (
    request.tool.metadata.name !== "shell"
    && request.tool.metadata.name !== "shell_command"
  ) {
    return null;
  }
  if (typeof request.input !== "object" || request.input === null) {
    return null;
  }
  const command = (request.input as { command?: unknown }).command;
  if (typeof command !== "string") return null;
  const cwdValidation = resolveWorkspaceCwd((request.input as { cwd?: unknown }).cwd as string | undefined, request.context);

  const assessment = assessShellCommand(
    command,
    request.context.executionPolicy,
    request.context.trusted === true,
    cwdValidation.resolved
  );
  if (assessment.status === "allowed") {
    return { status: "allowed", reason: "Shell command is allowed by host policy." };
  }
  if (assessment.status === "needs_approval") {
    if (request.context.hostPolicyApproved === true) {
      return { status: "allowed", reason: "This exact shell request was already approved for execution." };
    }
    return {
      status: "needs_permission",
      reason: assessment.reason ?? "Shell command requires permission.",
      executionReason: "approval_denied",
      requiredApprovalPolicy: "on_request",
    };
  }
  if (
    (assessment.capabilities.localWrite && request.context.executionPolicy?.sandboxMode === "read_only")
    || (assessment.capabilities.network && request.context.executionPolicy?.networkAccess === false)
  ) {
    const reason = assessment.capabilities.network
      ? "Network access is disabled for this session."
      : "Read-only sandbox blocks mutating shell commands.";
    return {
      status: "needs_sandbox",
      reason,
      executionReason: "sandbox_required",
      requiredSandboxMode: assessment.capabilities.network ? "danger_full_access" : "workspace_write",
    };
  }
  return {
    status: "denied",
    reason: assessment.reason ?? "Shell command denied by host policy.",
    executionReason: "policy_blocked",
  };
}

export function permissionResultFromHostDecision(decision: HostToolExecutionDecision): {
  status: "allowed";
} | {
  status: "denied";
  reason: string;
  executionReason?: NonNullable<ToolResult["execution"]>["reason"];
  policyDecision: HostToolExecutionDecision;
} | {
  status: "needs_approval";
  reason: string;
  executionReason?: NonNullable<ToolResult["execution"]>["reason"];
  policyDecision: HostToolExecutionDecision;
} {
  if (decision.status === "allowed") return { status: "allowed" };
  if (decision.status === "needs_permission") {
    return {
      status: "needs_approval",
      reason: decision.reason,
      ...(decision.executionReason ? { executionReason: decision.executionReason } : {}),
      policyDecision: decision,
    };
  }
  return {
    status: "denied",
    reason: decision.reason,
    ...(decision.executionReason ? { executionReason: decision.executionReason } : {}),
    policyDecision: decision,
  };
}
