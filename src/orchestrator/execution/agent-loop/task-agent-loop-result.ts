import { z } from "zod/v3";
import * as path from "node:path";
import type { AgentCompletionArtifact, AgentResult } from "../adapter-layer.js";
import type { AgentLoopResult, AgentLoopWorkspaceInfo } from "./agent-loop-result.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeStatus(value: unknown): unknown {
  return value === "completed" ? "done" : value;
}

function normalizeStringArray(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (item === null || item === undefined) return "";
    if (isRecord(item)) {
      const parts = [
        typeof item.type === "string" ? item.type : "",
        typeof item.command === "string" ? item.command : "",
        typeof item.status === "string" ? item.status : "",
        typeof item.summary === "string" ? item.summary : "",
        typeof item.output === "string" ? item.output : "",
      ].filter((part) => part.trim().length > 0);
      if (parts.length > 0) return parts.join("; ");
    }
    try {
      return JSON.stringify(item);
    } catch {
      return String(item);
    }
  }).filter((item) => item.trim().length > 0);
}

function normalizeTaskAgentLoopOutput(value: unknown): unknown {
  if (!isRecord(value)) return value;

  const normalized: Record<string, unknown> = { ...value };
  normalized.status = normalizeStatus(normalized.status);
  normalized.finalAnswer ??= normalized.final_answer ?? normalized.summary;
  normalized.filesChanged ??= normalized.files_changed ?? normalized.changed_files;
  normalized.testsRun ??= normalized.tests_run;
  normalized.completionEvidence ??= normalized.completion_evidence;
  normalized.verificationHints ??= normalized.verification_hints;
  normalized.completionEvidence = normalizeStringArray(normalized.completionEvidence);
  normalized.verificationHints = normalizeStringArray(normalized.verificationHints);
  normalized.blockers = normalizeStringArray(normalized.blockers);
  normalized.filesChanged = normalizeStringArray(normalized.filesChanged);
  return normalized;
}

const StringArraySchema = z.preprocess(normalizeStringArray, z.array(z.string())).default([]);

export const TaskAgentLoopOutputSchema = z.preprocess(normalizeTaskAgentLoopOutput, z.object({
  status: z.enum(["done", "blocked", "partial", "failed"]),
  finalAnswer: z.string(),
  summary: z.string().default(""),
  filesChanged: StringArraySchema,
  testsRun: z.array(z.object({
    command: z.string(),
    passed: z.boolean(),
    outputSummary: z.string(),
  })).default([]),
  completionEvidence: StringArraySchema,
  verificationHints: StringArraySchema,
  blockers: StringArraySchema,
}));

export type TaskAgentLoopOutput = z.infer<typeof TaskAgentLoopOutputSchema>;

function isSafeRelativeArtifact(filePath: string): boolean {
  const trimmed = filePath.trim();
  if (!trimmed || trimmed.includes("\0") || path.isAbsolute(trimmed)) return false;
  const segments = trimmed.replace(/\\/g, "/").split("/");
  return !segments.includes("..");
}

function collectAgentLoopChangedPaths(
  result: AgentLoopResult<TaskAgentLoopOutput>,
): string[] {
  const applyPatchArtifactPaths = (result.toolResults ?? []).flatMap((entry) => {
    if (!entry.success || entry.toolName !== "apply_patch" || entry.checkOnly === true) return [];
    return (entry.artifacts ?? []).map((artifact) => artifact.trim()).filter(isSafeRelativeArtifact);
  });
  return [
    ...new Set([
      ...(result.output?.filesChanged ?? []),
      ...result.changedFiles,
      ...applyPatchArtifactPaths,
    ]),
  ];
}

function collectCompletionArtifacts(
  result: AgentLoopResult<TaskAgentLoopOutput>,
): AgentCompletionArtifact[] {
  const artifacts = (result.toolResults ?? []).flatMap((entry) => {
    if (!entry.success || entry.checkOnly === true) return [];
    if (entry.toolName === "apply_patch") return [];
    return (entry.artifacts ?? [])
      .map((artifact) => artifact.trim())
      .filter((artifact) => artifact.length > 0)
      .map((artifact) => ({
        path: artifact,
        sourceTool: entry.toolName,
      }));
  });

  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = `${artifact.sourceTool ?? ""}:${artifact.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isBlockingNotExecutedReason(reason: string | undefined): boolean {
  return reason !== "dry_run";
}

function formatNotExecutedDetail(input: {
  kind: "Command" | "Tool";
  name: string;
  reason?: string;
  message?: string;
  command?: string;
  cwd?: string;
}): string {
  const reason = input.reason ? ` (${input.reason})` : "";
  const command = input.command ? `: ${input.command}` : "";
  const cwd = input.cwd ? ` in ${input.cwd}` : "";
  const message = input.message?.trim() ? `. ${input.message.trim()}` : "";
  return `${input.kind} ${input.name} was not executed${reason}${cwd}${command}${message}`;
}

export function requiresIsolatedWorkspaceHandoff(
  workspace: Pick<AgentLoopWorkspaceInfo, "isolated" | "disposition"> | undefined,
): boolean {
  return workspace?.isolated === true && workspace.disposition === "handoff_required";
}

function formatIsolatedWorkspaceHandoffBlocker(workspace: AgentLoopWorkspaceInfo): string {
  return `Isolated agent loop worktree has unintegrated changes; completion requires operator handoff: ${workspace.executionCwd}`;
}

function entrySequence(entry: { sequence?: number }, fallbackIndex: number): number {
  return entry.sequence ?? fallbackIndex;
}

export function collectTaskAgentLoopNotExecutedBlockers(
  result: AgentLoopResult<TaskAgentLoopOutput>,
): string[] {
  const toolResults = result.toolResults ?? [];
  const lastSuccessfulSequence = Math.max(
    -1,
    ...result.commandResults
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.success)
      .map(({ entry, index }) => entrySequence(entry, index)),
    ...toolResults
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.success)
      .map(({ entry, index }) => entrySequence(entry, index)),
  );
  const commandBlockers = result.commandResults
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry, index }) =>
      entrySequence(entry, index) > lastSuccessfulSequence
      && entry.execution?.status === "not_executed"
      && isBlockingNotExecutedReason(entry.execution.reason)
    )
    .map(({ entry }) => formatNotExecutedDetail({
      kind: "Command",
      name: entry.toolName,
      reason: entry.execution?.reason,
      message: entry.execution?.message || entry.outputSummary,
      command: entry.command,
      cwd: entry.cwd,
    }));
  const commandToolNames = new Set(
    result.commandResults
      .filter((entry) => entry.execution?.status === "not_executed")
      .map((entry) => entry.toolName),
  );
  const toolBlockers = toolResults
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry, index }) =>
      entrySequence(entry, index) > lastSuccessfulSequence
      && entry.execution?.status === "not_executed"
      && isBlockingNotExecutedReason(entry.execution.reason)
      && !commandToolNames.has(entry.toolName)
    )
    .map(({ entry }) => formatNotExecutedDetail({
      kind: "Tool",
      name: entry.toolName,
      reason: entry.execution?.reason,
      message: entry.execution?.message || entry.outputSummary,
    }));
  return [...new Set([...commandBlockers, ...toolBlockers])];
}

function collectTaskAgentLoopPolicyBlockedBlockers(
  result: AgentLoopResult<TaskAgentLoopOutput>,
): string[] {
  return collectTaskAgentLoopNotExecutedBlockers(result)
    .filter((blocker) => blocker.includes("(policy_blocked)"));
}

export function taskAgentLoopResultToAgentResult(
  result: AgentLoopResult<TaskAgentLoopOutput>,
): AgentResult {
  const notExecutedBlockers = collectTaskAgentLoopNotExecutedBlockers(result);
  const policyBlockedBlockers = collectTaskAgentLoopPolicyBlockedBlockers(result);
  const workspaceHandoffBlockers = requiresIsolatedWorkspaceHandoff(result.workspace)
    ? [formatIsolatedWorkspaceHandoffBlocker(result.workspace!)]
    : [];
  const blockers = [
    ...(result.output?.blockers ?? []),
    ...notExecutedBlockers,
    ...workspaceHandoffBlockers,
  ];
  const done = result.success && result.output?.status === "done" && blockers.length === 0;
  const blocked = result.success && result.output?.status === "blocked";
  const runtimeVerificationCommands = result.commandResults.filter((command) =>
    command.evidenceEligible && command.relevantToTask !== false
  );
  const filesChangedPaths = collectAgentLoopChangedPaths(result);
  const completionArtifacts = collectCompletionArtifacts(result);
  const blockerOutput = blockers.join("; ");
  const policyBlocked = policyBlockedBlockers.length > 0;
  const fallbackOutput = done
    ? result.output?.finalAnswer ?? result.finalText ?? result.stopReason
    : blockerOutput || result.output?.finalAnswer || result.finalText || result.stopReason;
  return {
    success: done,
    output: fallbackOutput,
    error: done ? null : blockerOutput || result.finalText || result.stopReason,
    structuredOutput: result.output ?? undefined,
    exit_code: null,
    elapsed_ms: result.elapsedMs,
    stopped_reason:
      result.stopReason === "timeout" ? "timeout" :
      result.stopReason === "cancelled" ? "cancelled" :
      policyBlocked ? "policy_blocked" :
      blocked ? "blocked" :
      done ? "completed" : "error",
    filesChanged: filesChangedPaths.length > 0 || Boolean(result.filesChanged),
    filesChangedPaths,
    ...(completionArtifacts.length > 0 ? { completionArtifacts } : {}),
    agentLoop: {
      traceId: result.traceId,
      sessionId: result.sessionId,
      turnId: result.turnId,
      stopReason: result.stopReason,
      ...(result.failureReason ? { failureReason: result.failureReason } : {}),
      ...(result.failureDetail ? { failureDetail: result.failureDetail } : {}),
      modelTurns: result.modelTurns,
      toolCalls: result.toolCalls,
      usage: result.usage,
      compactions: result.compactions,
      ...(result.profileName ? { profileName: result.profileName } : {}),
      ...(result.reasoningEffort ? { reasoningEffort: result.reasoningEffort } : {}),
      completionEvidence: [
        ...(result.output?.completionEvidence ?? []),
        ...runtimeVerificationCommands.filter((command) => command.success).map((command) => `verified command: ${command.command}`),
        ...completionArtifacts.map((artifact) =>
          `completion artifact${artifact.sourceTool ? ` from ${artifact.sourceTool}` : ""}: ${artifact.path}`
        ),
      ],
      verificationHints: [
        ...(result.output?.verificationHints ?? []),
        ...runtimeVerificationCommands.filter((command) => !command.success).map((command) => `failed command: ${command.command}`),
        ...notExecutedBlockers,
        ...workspaceHandoffBlockers,
      ],
      ...(completionArtifacts.length > 0 ? { completionArtifacts } : {}),
      filesChangedPaths,
      ...(result.workspace
        ? {
            requestedCwd: result.workspace.requestedCwd,
            executionCwd: result.workspace.executionCwd,
            isolatedWorkspace: result.workspace.isolated,
            workspaceCleanupStatus: result.workspace.cleanupStatus,
            workspaceCleanupReason: result.workspace.cleanupReason,
            workspaceDirty: result.workspace.dirty,
            workspaceDisposition: result.workspace.disposition,
          }
        : {}),
      ...(result.executionPolicy
        ? {
            sandboxMode: result.executionPolicy.sandboxMode,
            approvalPolicy: result.executionPolicy.approvalPolicy,
            networkAccess: result.executionPolicy.networkAccess,
          }
        : {}),
      ...(typeof result.activeBudgetMs === "number" ? { activeBudgetMs: result.activeBudgetMs } : {}),
      ...(typeof result.generatedEstimateMs === "number" ? { generatedEstimateMs: result.generatedEstimateMs } : {}),
      ...(result.requiresPostVerificationBeforeSuccessLedger !== undefined
        ? { requiresPostVerificationBeforeSuccessLedger: result.requiresPostVerificationBeforeSuccessLedger }
        : {}),
    },
  };
}
