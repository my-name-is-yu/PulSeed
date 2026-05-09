import type { VerificationResult } from "../../../base/types/task.js";
import type { AgentResult } from "../adapter-layer.js";
import type { VerdictHandlingContext } from "./task-verifier-types.js";

export function isolatedWorkspaceHandoff(
  context: VerdictHandlingContext,
): NonNullable<VerdictHandlingContext["agentLoopWorkspace"]> | null {
  const workspace = context.agentLoopWorkspace;
  if (
    workspace?.isolatedWorkspace === true &&
    workspace.workspaceDisposition === "handoff_required"
  ) {
    return workspace;
  }
  return null;
}

export function discardedDirtyIsolatedWorkspace(
  context: VerdictHandlingContext,
): NonNullable<VerdictHandlingContext["agentLoopWorkspace"]> | null {
  const workspace = context.agentLoopWorkspace;
  if (
    workspace?.isolatedWorkspace === true &&
    workspace.workspaceDirty === true &&
    workspace.workspaceDisposition === "discarded"
  ) {
    return workspace;
  }
  return null;
}

export function shouldCollectDiffsFromRequestedWorkspace(executionResult: AgentResult): boolean {
  if (executionResult.agentLoop?.isolatedWorkspace !== true) return true;
  if (executionResult.agentLoop.workspaceDirty !== true) return true;
  return executionResult.agentLoop.workspaceDisposition !== "handoff_required" &&
    executionResult.agentLoop.workspaceDisposition !== "discarded";
}

export function formatIsolatedWorkspaceHandoffReason(
  workspace: NonNullable<VerdictHandlingContext["agentLoopWorkspace"]>,
): string {
  const executionCwd = workspace.executionCwd ?? "unknown isolated worktree";
  const requestedCwd = workspace.requestedCwd ?? "unknown requested workspace";
  return [
    `dirty isolated worktree retained at ${executionCwd}`,
    `requested workspace ${requestedCwd} was not reverted or discarded`,
    "operator review is required before completion",
  ].join("; ");
}

export function formatDiscardedDirtyIsolatedWorkspaceReason(
  workspace: NonNullable<VerdictHandlingContext["agentLoopWorkspace"]>,
): string {
  const executionCwd = workspace.executionCwd ?? "unknown isolated worktree";
  const requestedCwd = workspace.requestedCwd ?? "unknown requested workspace";
  return [
    `dirty isolated worktree changes were discarded from ${executionCwd}`,
    `requested workspace ${requestedCwd} was not reverted or discarded`,
    "task must be retried from the requested workspace",
  ].join("; ");
}

export function applyVerdictHandlingContextGuards(
  verificationResult: VerificationResult,
  context: VerdictHandlingContext,
): VerificationResult {
  const workspace = isolatedWorkspaceHandoff(context) ?? discardedDirtyIsolatedWorkspace(context);
  if (!workspace) return verificationResult;
  const reason = workspace.workspaceDisposition === "discarded"
    ? formatDiscardedDirtyIsolatedWorkspaceReason(workspace)
    : formatIsolatedWorkspaceHandoffReason(workspace);
  return {
    ...verificationResult,
    verdict: "fail",
    confidence: Math.max(verificationResult.confidence ?? 0, 0.95),
    evidence: [
      {
        layer: "mechanical" as const,
        description: reason,
        confidence: 0.95,
      },
      ...(verificationResult.evidence ?? []),
    ],
  };
}
