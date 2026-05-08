/**
 * task-verifier.ts
 *
 * Verification logic extracted from TaskLifecycle:
 *   - verifyTask
 *   - handleVerdict
 *   - handleFailure
 *
 * All functions are standalone and receive explicit dependencies instead of
 * relying on `this`. TaskLifecycle keeps thin wrapper methods for backward
 * compatibility.
 *
 * Implementation is split across:
 *   - task-verifier-types.ts  — interfaces, Zod schemas
 *   - task-verifier-rules.ts  — mechanical verification, dimension guards, history
 *   - task-verifier-llm.ts    — LLM review, timeout, retry
 */

import { StateManager } from "../../../base/state/state-manager.js";
import { VerificationResultSchema } from "../../../base/types/task.js";
import type { Task, VerificationResult, VerificationFileDiff } from "../../../base/types/task.js";
import type { AgentResult } from "../adapter-layer.js";
import { wrapXmlTag, formatKnowledge } from "../../../prompt/formatters.js";
import { analyzeImpact } from "../impact-analyzer.js";
import type { ImpactAnalysis } from "../../../base/types/pipeline.js";

// Re-export types so external consumers keep working
export type {
  ExecutorReport,
  VerdictResult,
  FailureResult,
  VerdictHandlingContext,
  CompletionJudgerConfig,
  VerifierDeps,
} from "./task-verifier-types.js";
export { CompletionJudgerResponseSchema } from "./task-verifier-types.js";

// Re-export rule helpers (used by task-lifecycle.ts and tests)
export {
  clampDimensionUpdate,
  checkDimensionDirection,
} from "./task-verifier-rules.js";

import type { VerifierDeps, VerdictResult, FailureResult, VerdictHandlingContext } from "./task-verifier-types.js";
import {
  runMechanicalVerification,
  clampDimensionUpdate,
  checkDimensionDirection,
  parseExecutorReport,
  isDirectionCorrect,
  attemptRevert,
  setDimensionIntegrity,
  appendTaskHistory,
} from "./task-verifier-rules.js";
import { runLLMReview } from "./task-verifier-llm.js";
import { appendTaskOutcomeEvent } from "./task-outcome-ledger.js";
import { resolveTaskWorkspacePath } from "./task-workspace.js";
import { readTaskArtifactMetricValues, verifyTaskArtifactContract } from "./task-artifact-contract.js";

function formatSelfReportEvidence(executorReport: import("./task-verifier-types.js").ExecutorReport): string {
  const segments = [
    executorReport.summary.trim(),
    executorReport.stop_reason ? `stop reason: ${executorReport.stop_reason}` : "",
    executorReport.completion_evidence.length > 0
      ? `completion evidence: ${executorReport.completion_evidence.join("; ")}`
      : "",
    executorReport.verification_hints.length > 0
      ? `verification hints: ${executorReport.verification_hints.join("; ")}`
      : "",
    executorReport.blockers.length > 0
      ? `blockers: ${executorReport.blockers.join("; ")}`
      : "",
  ].filter((segment) => segment.length > 0);

  return segments.join("\n");
}

function statusAfterIncompleteVerification(task: Task): Task["status"] {
  if (task.status === "timed_out" || task.status === "cancelled" || task.status === "blocked") return task.status;
  return "error";
}

function getDimensionThresholdType(dim: Record<string, unknown> | undefined): string | undefined {
  return dim && typeof dim.threshold === "object" && dim.threshold !== null
    ? (dim.threshold as Record<string, unknown>).type as string | undefined
    : undefined;
}

function applyThresholdProgressDelta(prevVal: number | null, scaledDelta: number, thresholdType: string | undefined): number {
  const directionalDelta = thresholdType === "max" ? -scaledDelta : scaledDelta;
  return prevVal !== null ? prevVal + directionalDelta : directionalDelta;
}

function getArtifactMetricValueForDimension(
  artifactMetricValues: ReadonlyMap<string, number>,
  dimensionName: string,
): number | null {
  const exact = artifactMetricValues.get(dimensionName);
  if (exact !== undefined) return exact;

  const withoutBest = dimensionName.startsWith("best_") ? dimensionName.slice("best_".length) : null;
  if (withoutBest) {
    const stripped = artifactMetricValues.get(withoutBest);
    if (stripped !== undefined) return stripped;
  }

  return null;
}

function isDimensionUpdateDirectionAllowed(input: {
  intendedDirection: Task["intended_direction"];
  dim: Record<string, unknown>;
  previousValue: number;
  newValue: number;
  logger?: VerifierDeps["logger"];
}): boolean {
  const thresholdType = getDimensionThresholdType(input.dim);
  if (thresholdType === "min" && input.newValue < input.previousValue) {
    input.logger?.warn?.(
      `[handleVerdict] Skipping dimension update for ${String(input.dim.name)}: update moves away from min threshold`
    );
    return false;
  }
  if (thresholdType === "max" && input.newValue > input.previousValue) {
    input.logger?.warn?.(
      `[handleVerdict] Skipping dimension update for ${String(input.dim.name)}: update moves away from max threshold`
    );
    return false;
  }
  return checkDimensionDirection(
    input.intendedDirection,
    input.previousValue,
    input.newValue,
    input.logger,
    String(input.dim.name),
  );
}

function isolatedWorkspaceHandoff(
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

function discardedDirtyIsolatedWorkspace(
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

function shouldCollectDiffsFromRequestedWorkspace(executionResult: AgentResult): boolean {
  if (executionResult.agentLoop?.isolatedWorkspace !== true) return true;
  if (executionResult.agentLoop.workspaceDirty !== true) return true;
  return executionResult.agentLoop.workspaceDisposition !== "handoff_required" &&
    executionResult.agentLoop.workspaceDisposition !== "discarded";
}

function formatIsolatedWorkspaceHandoffReason(
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

function formatDiscardedDirtyIsolatedWorkspaceReason(
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

function mergeMechanicalAndArtifactVerification(
  mechanical: Awaited<ReturnType<typeof runMechanicalVerification>>,
  artifact: Awaited<ReturnType<typeof verifyTaskArtifactContract>>,
): Awaited<ReturnType<typeof runMechanicalVerification>> {
  if (!artifact.applicable) return mechanical;
  if (isArtifactFreshnessDisagreement(mechanical, artifact)) {
    return {
      applicable: true,
      passed: true,
      description: `${artifact.description}; mechanical --check-contract reported a stale-artifact freshness failure, but PulSeed artifact_contract passed using task-start freshness: ${mechanical.description}`,
    };
  }
  if (!mechanical.applicable) {
    return {
      applicable: true,
      passed: artifact.passed,
      description: artifact.description,
    };
  }
  return {
    applicable: true,
    passed: mechanical.passed && artifact.passed,
    description: `${mechanical.description}; ${artifact.description}`,
  };
}

function isArtifactFreshnessDisagreement(
  mechanical: Awaited<ReturnType<typeof runMechanicalVerification>>,
  artifact: Awaited<ReturnType<typeof verifyTaskArtifactContract>>,
): boolean {
  return artifact.applicable &&
    artifact.passed &&
    mechanical.applicable &&
    !mechanical.passed &&
    /\bstale artifact:/i.test(mechanical.description);
}

function isTimedOutAgentLoopResult(executionResult: AgentResult): boolean {
  return executionResult.stopped_reason === "timeout" || executionResult.agentLoop?.stopReason === "timeout";
}

function isRecoverableAgentLoopFinalizationFailure(executionResult: AgentResult): boolean {
  if (executionResult.success) return false;
  const stopReason = executionResult.agentLoop?.stopReason;
  return stopReason === "max_model_turns" ||
    stopReason === "schema_error" ||
    stopReason === "completion_gate_failed" ||
    executionResult.stopped_reason === "blocked";
}

function hasCapturedExecutionEvidence(executionResult: AgentResult): boolean {
  return (executionResult.fileDiffs?.length ?? 0) > 0 ||
    (executionResult.filesChanged === true && (executionResult.filesChangedPaths?.length ?? 0) > 0);
}

function formatTimeoutBudgetEvidence(executionResult: AgentResult): string {
  const details = [
    "AgentLoop stopped because the wall-clock budget timed out",
    typeof executionResult.agentLoop?.generatedEstimateMs === "number"
      ? `generated estimate: ${executionResult.agentLoop.generatedEstimateMs}ms`
      : "",
    typeof executionResult.agentLoop?.activeBudgetMs === "number"
      ? `active budget: ${executionResult.agentLoop.activeBudgetMs}ms`
      : "",
  ].filter(Boolean);
  return details.join("; ");
}

function isCompletionJudgerUnavailable(result: Awaited<ReturnType<typeof runLLMReview>>): boolean {
  return result.passed === false &&
    result.partial === false &&
    result.confidence === 0 &&
    result.description.startsWith("completion_judger failed after ");
}

function boundCompletionJudgerForTimedOutTask(deps: VerifierDeps): VerifierDeps {
  const existing = deps.completionJudgerConfig;
  return {
    ...deps,
    completionJudgerConfig: {
      timeoutMs: Math.min(existing?.timeoutMs ?? 30_000, 5_000),
      maxRetries: 0,
      retryBackoffMs: 0,
    },
  };
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function collectVerificationDiffs(
  deps: VerifierDeps,
  task: Task,
  executionResult: AgentResult,
): Promise<VerificationFileDiff[]> {
  if (executionResult.fileDiffs && executionResult.fileDiffs.length > 0) {
    return executionResult.fileDiffs;
  }

  if (!shouldCollectDiffsFromRequestedWorkspace(executionResult)) return [];

  if (!deps.toolExecutor) return [];

  const cwd =
    executionResult.agentLoop?.requestedCwd ??
    executionResult.agentLoop?.executionCwd ??
    await resolveTaskWorkspacePath({ stateManager: deps.stateManager, task, fallbackCwd: deps.revertCwd }) ??
    process.cwd();

  const changedPaths = [
    ...(executionResult.filesChangedPaths ?? []),
    ...(executionResult.agentLoop?.filesChangedPaths ?? []),
  ].filter((path, index, all) => path.length > 0 && all.indexOf(path) === index);
  const hasExplicitExecutionDiffPaths =
    executionResult.filesChangedPaths !== undefined ||
    executionResult.agentLoop?.filesChangedPaths !== undefined;

  const toolContext = {
    cwd,
    goalId: task.goal_id,
    trustBalance: 0,
    preApproved: true,
    approvalFn: async () => true,
  };

  const collectForPath = async (path: string): Promise<VerificationFileDiff | null> => {
    try {
      const result = await deps.toolExecutor!.execute(
        "git_diff",
        { target: "unstaged", path, maxLines: 160 },
        toolContext
      );
      if (result.success && typeof result.data === "string" && result.data.trim()) {
        return { path, patch: result.data };
      }
    } catch {
      // Fall through to untracked-file fallback.
    }

    try {
      const quotedPath = quoteShellArg(path);
      const fallback = await deps.toolExecutor!.execute(
        "shell_command",
        {
          command: `test -f ${quotedPath} && git diff --no-index -- /dev/null ${quotedPath} || true`,
          cwd,
          timeoutMs: 30_000,
          description: `Render diff for new file ${path}`,
        },
        toolContext
      );
      const shellOutput =
        fallback.data &&
        typeof fallback.data === "object" &&
        "stdout" in fallback.data &&
        typeof fallback.data.stdout === "string"
          ? fallback.data.stdout
          : "";
      if (shellOutput.trim()) {
        return { path, patch: shellOutput };
      }
    } catch {
      return null;
    }

    return null;
  };

  if (changedPaths.length > 0) {
    const diffs = await Promise.all(changedPaths.slice(0, 5).map((path) => collectForPath(path)));
    return diffs.filter((diff): diff is VerificationFileDiff => diff !== null);
  }

  if (hasExplicitExecutionDiffPaths) {
    return [];
  }

  try {
    const result = await deps.toolExecutor.execute(
      "git_diff",
      { target: "unstaged", maxLines: 240 },
      toolContext
    );
    if (!result.success || typeof result.data !== "string" || !result.data.trim()) return [];

    return result.data
      .split(/^diff --git /m)
      .filter(Boolean)
      .slice(0, 5)
      .map((section) => {
        const patch = `diff --git ${section}`;
        const match = patch.match(/^diff --git a\/(.+?) b\/(.+)$/m);
        return {
          path: match?.[2] ?? match?.[1] ?? "unknown",
          patch,
        };
      });
  } catch {
    return [];
  }
}

// ─── verifyTask ───

/**
 * Verify task execution results using 3-layer verification.
 *
 * Layer 1: Mechanical verification (via adapter in review session)
 * Layer 2: LLM task reviewer (independent, no self-report)
 * Layer 3: Executor self-report (reference only)
 *
 * Contradiction resolution:
 * - L1 PASS + L2 PASS → pass
 * - L1 PASS + L2 FAIL → re-review; if still FAIL → fail
 * - L1 FAIL + L2 PASS → fail (mechanical priority)
 * - L1 FAIL + L2 FAIL → fail
 * - L1 SKIP → use L2 only (lower confidence)
 */
export async function verifyTask(
  deps: VerifierDeps,
  task: Task,
  executionResult: AgentResult
): Promise<VerificationResult> {
  let goalForArtifactContract: Awaited<ReturnType<StateManager["loadGoal"]>> = null;
  try {
    goalForArtifactContract = await deps.stateManager.loadGoal(task.goal_id);
  } catch {
    goalForArtifactContract = null;
  }

  const taskWorkspacePath = executionResult.agentLoop?.executionCwd
    ?? executionResult.agentLoop?.requestedCwd
    ?? await resolveTaskWorkspacePath({ stateManager: deps.stateManager, task, fallbackCwd: deps.revertCwd });
  const artifactResult = await verifyTaskArtifactContract(
    task,
    taskWorkspacePath,
    { goal: goalForArtifactContract }
  );
  const artifactMetricValues = artifactResult.passed
    ? await readTaskArtifactMetricValues(task, taskWorkspacePath)
    : new Map<string, number>();

  // ─── Short-circuit: GitHub issue URL evidence ───
  // When execution succeeded and output contains a GitHub issue URL,
  // treat as mechanical pass without running full L1/L2 verification.
  // Dimension updates are left to ObservationEngine (next loop iteration).
  const githubIssueUrlPattern = /github\.com\/.+\/issues\/\d+/;
  if (
    executionResult.success === true &&
    executionResult.output &&
    githubIssueUrlPattern.test(executionResult.output) &&
    (!artifactResult.applicable || artifactResult.passed)
  ) {
    const scResult = VerificationResultSchema.parse({
      task_id: task.id,
      verdict: "pass",
      confidence: 0.95,
      evidence: [
        {
          layer: "mechanical" as const,
          description:
            "GitHub issue URL found in execution output — mechanical evidence of successful issue creation",
          confidence: 0.95,
        },
        ...(artifactResult.applicable
          ? [{
              layer: "mechanical" as const,
              description: artifactResult.description,
              confidence: 0.9,
            }]
          : []),
      ],
      dimension_updates: [],
      artifact_contract_status: artifactResult,
      timestamp: new Date().toISOString(),
    });
    return scResult;
  }

  // ─── Layer 1: Mechanical verification ───
  const l1Result = await runMechanicalVerification(deps, task);
  const artifactFreshnessDisagreement = isArtifactFreshnessDisagreement(l1Result, artifactResult);
  const effectiveL1Result = mergeMechanicalAndArtifactVerification(l1Result, artifactResult);

  if (
    isRecoverableAgentLoopFinalizationFailure(executionResult) &&
    effectiveL1Result.applicable &&
    effectiveL1Result.passed &&
    (
      artifactResult.passed ||
      (executionResult.agentLoop?.completionEvidence?.length ?? 0) > 0 ||
      hasCapturedExecutionEvidence(executionResult)
    )
  ) {
    deps.logger?.info?.("[completion_judger] Skipping completion judging for AgentLoop finalization failure with mechanical salvage evidence", {
      taskId: task.id,
      stoppedReason: executionResult.stopped_reason,
      agentLoopStopReason: executionResult.agentLoop?.stopReason,
    });
    return VerificationResultSchema.parse({
      task_id: task.id,
      verdict: "pass",
      confidence: 0.85,
      evidence: [
        {
          layer: "mechanical" as const,
          description: effectiveL1Result.description,
          confidence: 0.9,
        },
        {
          layer: "independent_review" as const,
          description: `completion judging skipped because AgentLoop stopped with ${executionResult.agentLoop?.stopReason ?? executionResult.stopped_reason} after mechanical/artifact evidence passed`,
          confidence: 0.85,
        },
        {
          layer: "self_report" as const,
          description: formatSelfReportEvidence(parseExecutorReport(executionResult)),
          confidence: 0.3,
        },
      ],
      dimension_updates: [],
      file_diffs: await collectVerificationDiffs(deps, task, executionResult),
      artifact_contract_status: artifactResult,
      timestamp: new Date().toISOString(),
    });
  }

  const timedOutAgentLoop = isTimedOutAgentLoopResult(executionResult);
  if (timedOutAgentLoop && !effectiveL1Result.passed) {
    deps.logger?.info?.("[completion_judger] Skipping completion judging for timed-out AgentLoop task without mechanical salvage evidence", {
      taskId: task.id,
      stoppedReason: executionResult.stopped_reason,
      generatedEstimateMs: executionResult.agentLoop?.generatedEstimateMs,
      activeBudgetMs: executionResult.agentLoop?.activeBudgetMs,
    });
    const evidence = [
      ...(effectiveL1Result.applicable
        ? [{
            layer: "mechanical" as const,
            description: effectiveL1Result.description,
            confidence: 0.9,
          }]
        : []),
      {
        layer: "independent_review" as const,
        description: `${formatTimeoutBudgetEvidence(executionResult)}; completion judging skipped because timeout is the primary terminal reason and no mechanical salvage evidence passed`,
        confidence: 0,
      },
      {
        layer: "self_report" as const,
        description: formatSelfReportEvidence(parseExecutorReport(executionResult)),
        confidence: 0.3,
      },
    ];
    return VerificationResultSchema.parse({
      task_id: task.id,
      verdict: "fail",
      confidence: 0.9,
      evidence,
      dimension_updates: [],
      file_diffs: await collectVerificationDiffs(deps, task, executionResult),
      artifact_contract_status: artifactResult,
      timestamp: new Date().toISOString(),
    });
  }

  // ─── Build optional enrichment blocks for LLM review ───
  let knowledgeBlock = "";
  if (deps.knowledgeManager?.getRelevantKnowledge) {
    try {
      const entries = await deps.knowledgeManager.getRelevantKnowledge(task.goal_id);
      if (entries.length > 0) {
        knowledgeBlock = wrapXmlTag(
          "relevant_knowledge",
          formatKnowledge(
            entries.map((e) => ({ question: e.question, answer: e.answer, confidence: e.confidence }))
          )
        );
      }
    } catch { /* knowledge enrichment is optional */ }
  }

  let stateBlock = "";
  try {
    const goalDataForState = await deps.stateManager.readRaw(`goals/${task.goal_id}/goal.json`);
    if (goalDataForState && typeof goalDataForState === "object") {
      const dims = (goalDataForState as Record<string, unknown>).dimensions as Array<Record<string, unknown>> | undefined;
      const primaryDim = dims?.find((d) => d.name === task.primary_dimension);
      if (primaryDim) {
        const currentValue = typeof primaryDim.current_value === "number" ? primaryDim.current_value : undefined;
        const threshold = primaryDim.threshold;
        if (currentValue !== undefined) {
          stateBlock = wrapXmlTag(
            "current_state",
            `Dimension: ${task.primary_dimension}, current value: ${currentValue}${threshold !== undefined ? `, target: ${JSON.stringify(threshold)}` : ""}`
          );
        }
      }
    }
  } catch { /* state enrichment is optional */ }

  // ─── Layer 2: LLM task reviewer (independent) ───
  const reviewDeps = timedOutAgentLoop ? boundCompletionJudgerForTimedOutTask(deps) : deps;
  if (timedOutAgentLoop) {
    deps.logger?.info?.("[completion_judger] Running sharply bounded completion judging for timed-out AgentLoop task with mechanical salvage evidence", {
      taskId: task.id,
      stoppedReason: executionResult.stopped_reason,
      generatedEstimateMs: executionResult.agentLoop?.generatedEstimateMs,
      activeBudgetMs: executionResult.agentLoop?.activeBudgetMs,
      timeoutMs: reviewDeps.completionJudgerConfig?.timeoutMs,
      maxRetries: reviewDeps.completionJudgerConfig?.maxRetries,
    });
  }
  const l2Result = artifactFreshnessDisagreement && executionResult.success === true
    ? {
        passed: true,
        partial: false,
        description: "completion judging skipped because PulSeed artifact_contract is authoritative for fresh_after_task_start and the contract passed",
        confidence: 0.85,
        tokensUsed: 0,
      }
    : await runLLMReview(reviewDeps, task, executionResult, knowledgeBlock, stateBlock);

  // ─── Layer 3: Executor self-report (reference only) ───
  const executorReport = parseExecutorReport(executionResult);

  // ─── Contradiction resolution ───
  let verdict: "pass" | "partial" | "fail";
  let confidence: number;
  let l2Retry: Awaited<ReturnType<typeof runLLMReview>> | undefined;
  const l2Unavailable = isCompletionJudgerUnavailable(l2Result);
  const l2UnavailableButMechanicallyPassed =
    l2Unavailable &&
    executionResult.success === true &&
    effectiveL1Result.applicable &&
    effectiveL1Result.passed;

  if (effectiveL1Result.applicable) {
    if (l2UnavailableButMechanicallyPassed) {
      verdict = "pass";
      confidence = 0.85;
    } else if (effectiveL1Result.passed && l2Result.passed) {
      verdict = "pass";
      confidence = 0.9;
    } else if (effectiveL1Result.passed && l2Result.partial) {
      // L1 pass + L2 partial → partial
      verdict = "partial";
      confidence = 0.7;
    } else if (effectiveL1Result.passed && !l2Result.passed && !l2Result.partial) {
      // L1 pass + L2 fail → re-review
      l2Retry = timedOutAgentLoop ? l2Result : await runLLMReview(deps, task, executionResult, knowledgeBlock, stateBlock, 'main');
      if (l2Retry.passed) {
        verdict = "pass";
        confidence = 0.75;
      } else if (l2Retry.partial) {
        verdict = "partial";
        confidence = 0.65;
      } else {
        verdict = "fail";
        confidence = 0.8;
      }
    } else if (!effectiveL1Result.passed && l2Result.passed) {
      // Mechanical verification takes priority
      verdict = "fail";
      confidence = 0.85;
    } else {
      // Both fail (or L1 fail + L2 partial → fail, mechanical priority)
      verdict = "fail";
      confidence = 0.9;
    }
  } else {
    // L1 skipped — use L2 only with lower confidence
    if (l2Result.passed) {
      verdict = "pass";
      confidence = 0.6;
    } else if (l2Result.partial) {
      verdict = "partial";
      confidence = 0.5;
    } else {
      verdict = "fail";
      confidence = 0.6;
    }
  }

  // Handle partial from L2 when L1 is applicable but didn't fail
  if (effectiveL1Result.applicable && l2Result.partial && verdict !== "fail") {
    verdict = "partial";
  }

  // Use retry result for evidence when a retry occurred, to keep audit trail accurate
  const effectiveL2 = l2Retry ?? l2Result;
  const independentReviewDescription = l2UnavailableButMechanicallyPassed
    ? `${effectiveL2.description}; using passing mechanical/artifact evidence because completion judging was unavailable`
    : effectiveL2.description;

  const now = new Date().toISOString();
  const evidence = [
    ...(effectiveL1Result.applicable
      ? [
          {
            layer: "mechanical" as const,
            description: effectiveL1Result.description,
            confidence: 0.9,
          },
        ]
      : []),
    {
      layer: "independent_review" as const,
      description: independentReviewDescription,
      confidence: effectiveL2.confidence,
    },
    {
      layer: "self_report" as const,
      description: formatSelfReportEvidence(executorReport),
      confidence: 0.3, // self-report has lowest confidence
    },
  ];

  // Build dimension_updates from task's target dimensions based on verdict.
  // pass: significant progress (+0.2), partial: moderate progress (+0.15), fail: no update.
  const progressByVerdict: Record<string, number> = {
    pass: 0.2,
    partial: 0.15,
    fail: 0,
  };
  const progressDelta = progressByVerdict[verdict] ?? 0;

  // Read goal state to get actual current dimension values for previous_value / new_value.
  const goalDataForUpdate = await deps.stateManager.readRaw(`goals/${task.goal_id}/goal.json`);
  const goalDimsForUpdate =
    goalDataForUpdate && typeof goalDataForUpdate === "object"
      ? ((goalDataForUpdate as Record<string, unknown>).dimensions as
          | Array<Record<string, unknown>>
          | undefined)
      : undefined;

  const dimension_updates =
    verdict === "fail"
      ? []
      : task.target_dimensions.map((dimName) => {
          const artifactMetricValue = getArtifactMetricValueForDimension(artifactMetricValues, dimName);
          const dim = goalDimsForUpdate?.find((d) => d.name === dimName);
          const prevVal =
            dim !== undefined && typeof dim.current_value === "number"
              ? (dim.current_value as number)
              : null;
          if (artifactMetricValue !== null) {
            return {
              dimension_name: dimName,
              previous_value: prevVal,
              new_value: artifactMetricValue,
              confidence,
              source: "artifact_contract" as const,
            };
          }
          // Scale the normalized delta to raw threshold-scale space.
          const threshold =
            dim !== undefined &&
            typeof dim.threshold === "object" &&
            dim.threshold !== null
              ? (dim.threshold as Record<string, unknown>)
              : null;
          let scaledDelta = progressDelta;
          if (threshold) {
            const thresholdType = threshold.type as string | undefined;
            if (
              (thresholdType === "min" || thresholdType === "max") &&
              typeof threshold.value === "number" &&
              threshold.value !== 0
            ) {
              scaledDelta = progressDelta * threshold.value;
            } else if (
              thresholdType === "range" &&
              typeof threshold.low === "number" &&
              typeof threshold.high === "number"
            ) {
              scaledDelta = progressDelta * (threshold.high - threshold.low);
            }
          }
          const thresholdType = threshold?.type as string | undefined;
          const newVal = applyThresholdProgressDelta(prevVal, scaledDelta, thresholdType);
          return {
            dimension_name: dimName,
            previous_value: prevVal,
            new_value: newVal,
            confidence,
            source: "verdict_delta" as const,
          };
        });

  const verificationResult = VerificationResultSchema.parse({
    task_id: task.id,
    verdict,
    confidence,
    evidence,
    dimension_updates,
    file_diffs: await collectVerificationDiffs(deps, task, executionResult),
    artifact_contract_status: artifactResult,
    timestamp: now,
  });

  // Post-verification: analyze impact for unintended side effects (opt-in)
  let impactAnalysis: ImpactAnalysis | undefined;
  if (deps.enableImpactAnalysis) try {
    impactAnalysis = await analyzeImpact(
      { llmClient: deps.llmClient, logger: deps.logger! },
      {
        taskDescription: task.work_description,
        taskOutput: executionResult.output,
        verificationVerdict: verdict,
        targetScope: task.scope_boundary.in_scope,
      }
    );
    if (impactAnalysis.side_effects.length > 0) {
      deps.logger?.warn("[task-verifier] Impact analysis detected side effects", {
        verdict: impactAnalysis.verdict,
        side_effects: impactAnalysis.side_effects,
        confidence: impactAnalysis.confidence,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger?.warn("[task-verifier] Impact analysis failed (non-fatal)", { error: msg });
  }

  // Persist verification result — include criteria fields from LLM review for failure context
  await deps.stateManager.writeRaw(
    `verification/${task.id}/verification-result.json`,
    {
      ...verificationResult,
      criteria_met: effectiveL2.criteria_met,
      criteria_total: effectiveL2.criteria_total,
      executor_report: executorReport,
      agent_loop: executionResult.agentLoop ?? null,
      impact_analysis: impactAnalysis,
    }
  );

  return verificationResult;
}

// ─── handleVerdict ───

/**
 * Handle a verification verdict (pass/partial/fail).
 */
export async function handleVerdict(
  deps: VerifierDeps,
  task: Task,
  verificationResult: VerificationResult,
  context: VerdictHandlingContext = {}
): Promise<VerdictResult> {
  // P0: Progress-verdict contradiction check (§4.1)
  if (verificationResult.verdict === "pass" && verificationResult.dimension_updates?.length > 0) {
    const goalRawForGuard = await deps.stateManager.readRaw(`goals/${task.goal_id}/goal.json`);
    const goalDimsForGuard = (
      goalRawForGuard &&
      typeof goalRawForGuard === "object" &&
      Array.isArray((goalRawForGuard as Record<string, unknown>).dimensions)
        ? (goalRawForGuard as Record<string, unknown>).dimensions as Array<Record<string, unknown>>
        : []
    );

    const anyWorsened = verificationResult.dimension_updates.some((u) => {
      const prev = typeof u.previous_value === "number" ? u.previous_value : null;
      const next = typeof u.new_value === "number" ? u.new_value : null;
      if (prev === null || next === null) return false;

      const dimMeta = goalDimsForGuard.find((d) => d.name === u.dimension_name);
      const thresholdType =
        dimMeta && typeof dimMeta.threshold === "object" && dimMeta.threshold !== null
          ? (dimMeta.threshold as Record<string, unknown>).type as string | undefined
          : undefined;

      if (thresholdType === "min") {
        return next < prev - 0.05;
      } else if (thresholdType === "max") {
        return next > prev + 0.05;
      }
      return false;
    });
    if (anyWorsened) {
      deps.logger?.warn(
        "progress-verdict contradiction: dimension value moved away from target but verdict was pass. Overriding to partial."
      );
      verificationResult = { ...verificationResult, verdict: "partial" };
    }
  }

  if (context.verificationGuardsApplied !== true) {
    verificationResult = applyVerdictHandlingContextGuards(verificationResult, context);
  }

  // Save failure context for fail/partial verdicts (§4.7)
  if (verificationResult.verdict === "fail" || verificationResult.verdict === "partial") {
    const firstEvidence = verificationResult.evidence?.[0];
    const reasoning = typeof firstEvidence?.description === "string" ? firstEvidence.description : "";
    let criteria_met: number | undefined;
    let criteria_total: number | undefined;
    try {
      const raw = await deps.stateManager.readRaw(`verification/${task.id}/verification-result.json`) as Record<string, unknown> | null;
      if (raw && typeof raw.criteria_met === "number") criteria_met = raw.criteria_met;
      if (raw && typeof raw.criteria_total === "number") criteria_total = raw.criteria_total;
    } catch {
      // Non-fatal: criteria fields are best-effort
    }
    const failureContext = {
      prev_task_description: task.work_description,
      verdict: verificationResult.verdict,
      reasoning,
      criteria_met,
      criteria_total,
      timestamp: new Date().toISOString(),
    };
    try {
      await deps.stateManager.writeRaw(
        `tasks/${task.goal_id}/last-failure-context.json`,
        failureContext
      );
    } catch {
      // Non-fatal: failure context saving is best-effort
    }
  }

  switch (verificationResult.verdict) {
    case "pass": {
      // Clear stale failure context
      try {
        await deps.stateManager.writeRaw(
          `tasks/${task.goal_id}/last-failure-context.json`,
          null
        );
      } catch {
        // Non-fatal
      }

      deps.trustManager.recordSuccess(task.task_category);

      const now = new Date().toISOString();

      const completedTask = {
        ...task,
        consecutive_failure_count: 0,
        status: "completed" as const,
        completed_at: now,
        verification_verdict: verificationResult.verdict,
        verification_evidence: verificationResult.evidence?.map((e) => e.description ?? String(e)) ?? [],
      };
      await deps.stateManager.writeRaw(
        `tasks/${task.goal_id}/${task.id}.json`,
        completedTask
      );

      // Apply dimension_updates
      const goalData = await deps.stateManager.readRaw(`goals/${task.goal_id}/goal.json`);
      if (goalData && typeof goalData === "object") {
        const goal = goalData as Record<string, unknown>;
        const dimensions = goal.dimensions as Array<Record<string, unknown>> | undefined;
        if (dimensions) {
          for (const dim of dimensions) {
            const update = verificationResult.dimension_updates.find(
              (u) => u.dimension_name === dim.name
            );
            if (update !== undefined && typeof update.new_value === "number") {
              const prev = typeof dim.current_value === "number" ? dim.current_value : 0;
              if (!isDimensionUpdateDirectionAllowed({
                intendedDirection: task.intended_direction,
                dim,
                previousValue: prev,
                newValue: update.new_value,
                logger: deps.logger,
              })) {
                continue;
              }
              dim.current_value = update.source === "artifact_contract"
                ? update.new_value
                : clampDimensionUpdate(prev, update.new_value, deps.logger, String(dim.name));
              dim.confidence = verificationResult.confidence ?? 0.70;
              dim.last_observed_layer = "mechanical";
            }
            if (dim.name === task.primary_dimension) {
              dim.last_updated = now;
            }
          }
          await deps.stateManager.writeRaw(`goals/${task.goal_id}/goal.json`, goal);
        }
      }

      await appendTaskHistory(deps, task.goal_id, completedTask);
      await appendTaskOutcomeEvent(deps.stateManager, {
        task: completedTask,
        type: "succeeded",
        attempt: task.consecutive_failure_count + 1,
        action: "completed",
        verificationResult,
      });

      if (deps.onTaskComplete && completedTask.strategy_id) {
        deps.onTaskComplete(completedTask.strategy_id);
      }

      return { action: "completed", task: completedTask };
    }
    case "partial": {
      const directionCorrect = isDirectionCorrect(verificationResult);
      if (directionCorrect) {
        const goalDataPartial = await deps.stateManager.readRaw(`goals/${task.goal_id}/goal.json`);
        if (goalDataPartial && typeof goalDataPartial === "object") {
          const goal = goalDataPartial as Record<string, unknown>;
          const dimensions = goal.dimensions as Array<Record<string, unknown>> | undefined;
          if (dimensions) {
            for (const dim of dimensions) {
              const update = verificationResult.dimension_updates.find(
                (u) => u.dimension_name === dim.name
              );
              if (update !== undefined && typeof update.new_value === "number") {
                const prev = typeof dim.current_value === "number" ? dim.current_value : 0;
                if (!isDimensionUpdateDirectionAllowed({
                  intendedDirection: task.intended_direction,
                  dim,
                  previousValue: prev,
                  newValue: update.new_value,
                  logger: deps.logger,
                })) {
                  continue;
                }
                dim.current_value = update.source === "artifact_contract"
                  ? update.new_value
                  : clampDimensionUpdate(prev, update.new_value, deps.logger, String(dim.name));
                dim.confidence = verificationResult.confidence ?? 0.70;
                dim.last_observed_layer = "mechanical";
              }
            }
            await deps.stateManager.writeRaw(`goals/${task.goal_id}/goal.json`, goal);
          }
        }
        const partialTask = {
          ...task,
          status: statusAfterIncompleteVerification(task),
          verification_verdict: verificationResult.verdict,
          verification_evidence: verificationResult.evidence?.map((e) => e.description ?? String(e)) ?? [],
        };
        await deps.stateManager.writeRaw(
          `tasks/${task.goal_id}/${task.id}.json`,
          partialTask
        );
        await appendTaskHistory(deps, task.goal_id, partialTask);
        await appendTaskOutcomeEvent(deps.stateManager, {
          task: partialTask,
          type: "retried",
          attempt: task.consecutive_failure_count + 1,
          action: "keep",
          verificationResult,
          reason: "partial progress kept for follow-up work",
          stoppedReason: context.stoppedReason ?? undefined,
        });
        return { action: "keep", task: partialTask };
      }
      return handleFailure(deps, task, verificationResult, context);
    }
    case "fail": {
      return handleFailure(deps, task, verificationResult, context);
    }
  }
}

// ─── handleFailure ───

/**
 * Handle a task failure: increment failure count, record failure,
 * decide keep/discard/escalate.
 */
export async function handleFailure(
  deps: VerifierDeps,
  task: Task,
  verificationResult: VerificationResult,
  context: VerdictHandlingContext = {}
): Promise<FailureResult> {
  const updatedTask = {
    ...task,
    status: statusAfterIncompleteVerification(task),
    consecutive_failure_count: task.consecutive_failure_count + 1,
    verification_verdict: verificationResult.verdict,
    verification_evidence: verificationResult.evidence?.map((e) => e.description ?? String(e)) ?? [],
  };

  deps.trustManager.recordFailure(task.task_category);

  await deps.stateManager.writeRaw(
    `tasks/${task.goal_id}/${task.id}.json`,
    updatedTask
  );
  await appendTaskOutcomeEvent(deps.stateManager, {
    task: updatedTask,
    type: "failed",
    attempt: updatedTask.consecutive_failure_count,
    verificationResult,
    stoppedReason: context.stoppedReason ?? undefined,
  });

  if (updatedTask.consecutive_failure_count >= 3) {
    deps.stallDetector.checkConsecutiveFailures(
      task.goal_id,
      task.primary_dimension,
      updatedTask.consecutive_failure_count
    );
    await appendTaskHistory(deps, task.goal_id, updatedTask);
    await appendTaskOutcomeEvent(deps.stateManager, {
      task: updatedTask,
      type: "abandoned",
      attempt: updatedTask.consecutive_failure_count,
      action: "escalate",
      verificationResult,
      reason: "consecutive failure threshold reached",
      stoppedReason: context.stoppedReason ?? undefined,
    });
    return { action: "escalate", task: updatedTask };
  }

  const handoffWorkspace = isolatedWorkspaceHandoff(context);
  if (handoffWorkspace) {
    const reason = formatIsolatedWorkspaceHandoffReason(handoffWorkspace);
    await appendTaskHistory(deps, task.goal_id, updatedTask);
    await appendTaskOutcomeEvent(deps.stateManager, {
      task: updatedTask,
      type: "abandoned",
      attempt: updatedTask.consecutive_failure_count,
      action: "escalate",
      verificationResult,
      reason,
      stoppedReason: context.stoppedReason ?? undefined,
    });
    return { action: "escalate", task: updatedTask };
  }

  const discardedWorkspace = discardedDirtyIsolatedWorkspace(context);
  if (discardedWorkspace) {
    const reason = formatDiscardedDirtyIsolatedWorkspaceReason(discardedWorkspace);
    await appendTaskHistory(deps, task.goal_id, updatedTask);
    await appendTaskOutcomeEvent(deps.stateManager, {
      task: updatedTask,
      type: "abandoned",
      attempt: updatedTask.consecutive_failure_count,
      action: "discard",
      verificationResult,
      reason,
      stoppedReason: context.stoppedReason ?? undefined,
    });
    return { action: "discard", task: updatedTask };
  }

  const directionCorrect = isDirectionCorrect(verificationResult);

  if (directionCorrect) {
    await appendTaskHistory(deps, task.goal_id, updatedTask);
    await appendTaskOutcomeEvent(deps.stateManager, {
      task: updatedTask,
      type: "retried",
      attempt: updatedTask.consecutive_failure_count,
      action: "keep",
      verificationResult,
      reason: "failure kept for retry because direction remained correct",
      stoppedReason: context.stoppedReason ?? undefined,
    });
    return { action: "keep", task: updatedTask };
  }

  if (updatedTask.reversibility === "reversible") {
    const fileDiffs = verificationResult.file_diffs ?? [];
    const concreteRevertPaths = [
      ...new Set(
        fileDiffs
          .filter((diff) => diff.safe_to_revert !== false)
          .map((diff) => diff.path)
          .filter((filePath) => filePath.trim().length > 0)
      ),
    ];
    const unsafeRevertPaths = [
      ...new Set(
        fileDiffs
          .filter((diff) => diff.safe_to_revert === false)
          .map((diff) => diff.path)
          .filter((filePath) => filePath.trim().length > 0)
      ),
    ];
    const revertSuccess = await attemptRevert(deps, updatedTask, {
      concretePaths: concreteRevertPaths,
      unsafePaths: unsafeRevertPaths,
    });
    deps.logger?.warn(`[task] revert attempted`, {
      taskId: task.id,
      success: revertSuccess.success,
      reason: revertSuccess.reason,
      concretePaths: revertSuccess.concretePaths,
      unsafePaths: revertSuccess.unsafePaths,
    });
    if (revertSuccess.success) {
      await appendTaskHistory(deps, task.goal_id, updatedTask);
      await appendTaskOutcomeEvent(deps.stateManager, {
        task: updatedTask,
        type: "abandoned",
        attempt: updatedTask.consecutive_failure_count,
        action: "discard",
        verificationResult,
        reason: `task discarded after successful ${revertSuccess.method ?? "revert"} for ${revertSuccess.concretePaths.length} concrete paths`,
        stoppedReason: context.stoppedReason ?? undefined,
      });
      return { action: "discard", task: updatedTask };
    }
    deps.logger?.error(`[task] revert FAILED`, { taskId: task.id });
    await setDimensionIntegrity(deps, task.goal_id, task.primary_dimension, "uncertain");
    await appendTaskHistory(deps, task.goal_id, updatedTask);
    await appendTaskOutcomeEvent(deps.stateManager, {
      task: updatedTask,
      type: "abandoned",
      attempt: updatedTask.consecutive_failure_count,
      action: "escalate",
      verificationResult,
      reason: revertSuccess.method === "git_unavailable"
        ? `${revertSuccess.reason}; git restore is unavailable for this non-git workspace, so changed filesystem paths and artifacts require operator handoff`
        : (revertSuccess.unsafePaths?.length ?? 0) > 0
        ? `revert could not safely discard all task changes because some share pre-existing dirty paths: ${revertSuccess.unsafePaths?.join(", ")}`
        : revertSuccess.concretePaths.length === 0
        ? "revert skipped because no concrete changed paths were captured; task output requires operator review"
        : `revert failed after wrong-direction result: ${revertSuccess.reason}`,
      stoppedReason: context.stoppedReason ?? undefined,
    });
    return { action: "escalate", task: updatedTask };
  }

  await appendTaskHistory(deps, task.goal_id, updatedTask);
  await appendTaskOutcomeEvent(deps.stateManager, {
    task: updatedTask,
    type: "abandoned",
    attempt: updatedTask.consecutive_failure_count,
    action: "escalate",
    verificationResult,
    reason: "task cannot be safely retried or reverted",
    stoppedReason: context.stoppedReason ?? undefined,
  });
  return { action: "escalate", task: updatedTask };
}
