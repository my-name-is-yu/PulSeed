import type { Task } from "../../../base/types/task.js";
import type { AgentResult } from "../adapter-layer.js";
import type { ExecutorReport, VerifierDeps } from "./task-verifier-types.js";
import { checkDimensionDirection } from "./task-verifier-rules.js";
import type { runMechanicalVerification } from "./task-verifier-rules.js";
import type { runLLMReview } from "./task-verifier-llm.js";
import type { verifyTaskArtifactContract } from "./task-artifact-contract.js";

type MechanicalVerificationResult = Awaited<ReturnType<typeof runMechanicalVerification>>;
type ArtifactVerificationResult = Awaited<ReturnType<typeof verifyTaskArtifactContract>>;
type LLMReviewResult = Awaited<ReturnType<typeof runLLMReview>>;

export function formatSelfReportEvidence(executorReport: ExecutorReport): string {
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

export function statusAfterIncompleteVerification(task: Task): Task["status"] {
  if (task.status === "timed_out" || task.status === "cancelled" || task.status === "blocked") return task.status;
  return "error";
}

export function getDimensionThresholdType(dim: Record<string, unknown> | undefined): string | undefined {
  return dim && typeof dim.threshold === "object" && dim.threshold !== null
    ? (dim.threshold as Record<string, unknown>).type as string | undefined
    : undefined;
}

export function applyThresholdProgressDelta(
  prevVal: number | null,
  scaledDelta: number,
  thresholdType: string | undefined,
): number {
  const directionalDelta = thresholdType === "max" ? -scaledDelta : scaledDelta;
  return prevVal !== null ? prevVal + directionalDelta : directionalDelta;
}

export function getArtifactMetricValueForDimension(
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

export function isDimensionUpdateDirectionAllowed(input: {
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

export function mergeMechanicalAndArtifactVerification(
  mechanical: MechanicalVerificationResult,
  artifact: ArtifactVerificationResult,
): MechanicalVerificationResult {
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

export function isArtifactFreshnessDisagreement(
  mechanical: MechanicalVerificationResult,
  artifact: ArtifactVerificationResult,
): boolean {
  return artifact.applicable &&
    artifact.passed &&
    mechanical.applicable &&
    !mechanical.passed &&
    /\bstale artifact:/i.test(mechanical.description);
}

export function hasGitHubIssueUrlEvidence(output: string): boolean {
  return output.split(/\s+/).some((token) => isExactGitHubIssueUrl(token));
}

export function isTimedOutAgentLoopResult(executionResult: AgentResult): boolean {
  return executionResult.stopped_reason === "timeout" || executionResult.agentLoop?.stopReason === "timeout";
}

export function isRecoverableAgentLoopFinalizationFailure(executionResult: AgentResult): boolean {
  if (executionResult.success) return false;
  const stopReason = executionResult.agentLoop?.stopReason;
  return stopReason === "max_model_turns" ||
    stopReason === "schema_error" ||
    stopReason === "completion_gate_failed" ||
    executionResult.stopped_reason === "blocked";
}

export function hasCapturedExecutionEvidence(executionResult: AgentResult): boolean {
  return (executionResult.fileDiffs?.length ?? 0) > 0 ||
    (executionResult.filesChanged === true && (executionResult.filesChangedPaths?.length ?? 0) > 0);
}

export function formatTimeoutBudgetEvidence(executionResult: AgentResult): string {
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

export function isCompletionJudgerUnavailable(result: LLMReviewResult): boolean {
  return result.passed === false &&
    result.partial === false &&
    result.confidence === 0 &&
    result.description.startsWith("completion_judger failed after ");
}

export function boundCompletionJudgerForTimedOutTask(deps: VerifierDeps): VerifierDeps {
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

export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function trimUrlToken(value: string): string {
  return value
    .trim()
    .replace(/^[([{"'<]+/, "")
    .replace(/[)\].,;:!?"'>]+$/, "");
}

function isExactGitHubIssueUrl(rawToken: string): boolean {
  const token = trimUrlToken(rawToken);
  if (!token) return false;

  let url: URL;
  try {
    url = new URL(token);
  } catch {
    return false;
  }

  if (url.protocol !== "https:" || url.hostname !== "github.com") return false;

  const [owner, repo, resource, issueNumber, ...extraSegments] =
    url.pathname.split("/").filter((segment) => segment.length > 0);
  return Boolean(
    owner &&
    repo &&
    resource === "issues" &&
    issueNumber &&
    extraSegments.length === 0 &&
    /^[1-9]\d*$/.test(issueNumber),
  );
}
