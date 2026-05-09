import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../../../base/types/task.js";
import type { AgentResult } from "../../adapter-layer.js";
import {
  applyThresholdProgressDelta,
  boundCompletionJudgerForTimedOutTask,
  formatSelfReportEvidence,
  formatTimeoutBudgetEvidence,
  getArtifactMetricValueForDimension,
  hasCapturedExecutionEvidence,
  hasGitHubIssueUrlEvidence,
  isArtifactFreshnessDisagreement,
  isCompletionJudgerUnavailable,
  isDimensionUpdateDirectionAllowed,
  isRecoverableAgentLoopFinalizationFailure,
  isTimedOutAgentLoopResult,
  mergeMechanicalAndArtifactVerification,
  quoteShellArg,
  statusAfterIncompleteVerification,
} from "../task-verifier-evidence.js";
import type { ExecutorReport, VerifierDeps } from "../task-verifier-types.js";

describe("task verifier evidence helpers", () => {
  it("accepts exact GitHub issue URLs and rejects adjacent GitHub resources", () => {
    expect(hasGitHubIssueUrlEvidence("created (https://github.com/my-name-is-yu/PulSeed/issues/123).")).toBe(true);
    expect(hasGitHubIssueUrlEvidence("see https://github.com/my-name-is-yu/PulSeed/pull/123")).toBe(false);
    expect(hasGitHubIssueUrlEvidence("see http://github.com/my-name-is-yu/PulSeed/issues/123")).toBe(false);
    expect(hasGitHubIssueUrlEvidence("see https://github.com/my-name-is-yu/PulSeed/issues/123/edit")).toBe(false);
  });

  it("formats executor self-report evidence without empty sections", () => {
    const report: ExecutorReport = {
      summary: "implemented",
      completed: true,
      stop_reason: "done",
      partial_results: [],
      completion_evidence: ["test passed"],
      verification_hints: [],
      blockers: ["none"],
    };

    expect(formatSelfReportEvidence(report)).toBe([
      "implemented",
      "stop reason: done",
      "completion evidence: test passed",
      "blockers: none",
    ].join("\n"));
  });

  it("keeps artifact metrics aligned with best_ dimension aliases", () => {
    const metrics = new Map([
      ["accuracy", 0.91],
      ["loss", 0.12],
    ]);

    expect(getArtifactMetricValueForDimension(metrics, "accuracy")).toBe(0.91);
    expect(getArtifactMetricValueForDimension(metrics, "best_accuracy")).toBe(0.91);
    expect(getArtifactMetricValueForDimension(metrics, "best_auc")).toBeNull();
  });

  it("applies threshold progress direction and blocks updates away from thresholds", () => {
    expect(applyThresholdProgressDelta(0.6, 0.2, "min")).toBe(0.8);
    expect(applyThresholdProgressDelta(0.6, 0.2, "max")).toBe(0.39999999999999997);

    const warn = vi.fn();
    expect(isDimensionUpdateDirectionAllowed({
      intendedDirection: "increase",
      dim: { name: "accuracy", threshold: { type: "min", value: 0.9 } },
      previousValue: 0.8,
      newValue: 0.7,
      logger: { warn } as unknown as VerifierDeps["logger"],
    })).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("moves away from min threshold"));
  });

  it("merges mechanical and artifact verification with stale-artifact disagreement precedence", () => {
    const mechanical = {
      applicable: true,
      passed: false,
      description: "stale artifact: metrics.json is older than task start",
    };
    const artifact = {
      applicable: true,
      passed: true,
      description: "Artifact contract verification passed",
    };

    expect(isArtifactFreshnessDisagreement(mechanical, artifact)).toBe(true);
    expect(mergeMechanicalAndArtifactVerification(mechanical, artifact)).toMatchObject({
      applicable: true,
      passed: true,
    });
  });

  it("classifies AgentLoop terminal states and bounded completion judging", () => {
    const timedOut = {
      success: false,
      output: "",
      error: null,
      exit_code: null,
      elapsed_ms: 10,
      stopped_reason: "completed",
      agentLoop: { stopReason: "timeout", generatedEstimateMs: 20_000, activeBudgetMs: 10_000 },
    } as AgentResult;
    const blocked = {
      ...timedOut,
      stopped_reason: "blocked",
      agentLoop: { stopReason: "max_model_turns" },
    } as AgentResult;

    expect(isTimedOutAgentLoopResult(timedOut)).toBe(true);
    expect(formatTimeoutBudgetEvidence(timedOut)).toContain("active budget: 10000ms");
    expect(isRecoverableAgentLoopFinalizationFailure(blocked)).toBe(true);
    expect(hasCapturedExecutionEvidence({ ...timedOut, fileDiffs: [{ path: "a.ts", patch: "diff" }] })).toBe(true);
    expect(boundCompletionJudgerForTimedOutTask({
      completionJudgerConfig: { timeoutMs: 30_000, maxRetries: 2, retryBackoffMs: 1_000 },
    } as VerifierDeps).completionJudgerConfig).toEqual({
      timeoutMs: 5_000,
      maxRetries: 0,
      retryBackoffMs: 0,
    });
  });

  it("keeps incomplete task status and shell quoting stable", () => {
    expect(statusAfterIncompleteVerification({ status: "blocked" } as Task)).toBe("blocked");
    expect(statusAfterIncompleteVerification({ status: "running" } as Task)).toBe("error");
    expect(quoteShellArg("path with ' quote")).toBe("'path with '\\'' quote'");
    expect(isCompletionJudgerUnavailable({
      passed: false,
      partial: false,
      description: "completion_judger failed after retries",
      confidence: 0,
      tokensUsed: 0,
    })).toBe(true);
  });
});
