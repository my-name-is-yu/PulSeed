import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolCallContext } from "../../../../tools/types.js";
import { ProcessSessionManager } from "../../../../tools/system/ProcessSessionTool/ProcessSessionTool.js";
import {
  KaggleCompareExperimentsTool,
  KaggleExperimentReadTool,
  KaggleExperimentStartTool,
  KaggleMetricReportTool,
} from "../../../../tools/kaggle/index.js";
import { handleWaitStrategyExpiry } from "../../../strategy/portfolio-rebalance.js";
import {
  kaggleTrainingBenchmarkRequiredTools,
  runKaggleTrainingBenchmark,
  scoreKaggleTrainingSignals,
} from "../kaggle-training-benchmark.js";

function makeContext(cwd: string): ToolCallContext {
  return {
    cwd,
    goalId: "kaggle-benchmark-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
  };
}

function metricsJson(experimentId: string, score: number): Record<string, unknown> {
  return {
    experiment_id: experimentId,
    competition: "dummy-competition",
    metric_name: "accuracy",
    direction: "maximize",
    cv_score: score,
    cv_std: 0.01,
    holdout_score: null,
    train_rows: 100,
    valid_rows: 20,
    seed: 42,
    created_at: "2026-04-25T00:00:00.000Z",
    status: "completed",
    artifacts: {
      log: `experiments/${experimentId}/train.log`,
    },
  };
}

function validationContract() {
  return {
    competition_metric: { name: "accuracy", direction: "maximize" as const, source: "competition_rules" as const },
    cv: { strategy: "stratified_kfold", fold_count: 5, stratified: true },
    oof: { present: true, path: "oof.csv", coverage: 1, leak_checked: true },
    leak_checks: {
      target_encoding_oof_only: true,
      stacking_oof_only: true,
      train_test_boundary_checked: true,
      duplicate_or_id_leak_checked: true,
      notes: [],
    },
    train_test_drift: { checked: true, adversarial_validation_auc: 0.55 },
  };
}

async function waitFor(expectation: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await expectation()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(await expectation()).toBe(true);
}

async function fileContains(filePath: string, text: string): Promise<boolean> {
  try {
    return (await fs.readFile(filePath, "utf-8")).includes(text);
  } catch {
    return false;
  }
}

describe("kaggle training benchmark", () => {
  it("scores a completed training loop", () => {
    const score = scoreKaggleTrainingSignals({
      experimentStarted: true,
      logArtifactWritten: true,
      metricsParsed: true,
      reportArtifactWritten: true,
      nextActionWritten: true,
      bestSelectedByDirection: true,
      waitResumedAfterProcessExit: true,
      restartReadsArtifacts: true,
      noSubmitCalled: true,
    });

    expect(score).toEqual({ passed: true, reasons: [] });
  });

  it("reports missing runtime capabilities", () => {
    const score = scoreKaggleTrainingSignals({
      experimentStarted: true,
      logArtifactWritten: false,
      metricsParsed: true,
      reportArtifactWritten: false,
      nextActionWritten: false,
      bestSelectedByDirection: false,
      waitResumedAfterProcessExit: true,
      restartReadsArtifacts: false,
      noSubmitCalled: true,
    });

    expect(score.passed).toBe(false);
    expect(score.reasons).toEqual([
      "train.log was not written as a durable artifact",
      "summary.md was not written as a durable artifact",
      "next-action.json was not written as a durable artifact",
      "best experiment was not selected using metric direction",
      "restart-time read did not recover from artifacts",
    ]);
  });

  it("summarizes benchmark cases", async () => {
    const summary = await runKaggleTrainingBenchmark([
      {
        name: "dummy-training-loop",
        run: async () => ({
          experimentStarted: true,
          logArtifactWritten: true,
          metricsParsed: true,
          reportArtifactWritten: true,
          nextActionWritten: true,
          bestSelectedByDirection: true,
          waitResumedAfterProcessExit: true,
          restartReadsArtifacts: true,
          noSubmitCalled: true,
        }),
      },
    ]);

    expect(summary.ready).toBe(true);
    expect(summary.passRate).toBe(1);
    expect(summary.passedCases).toBe(1);
  });

  it("requires training-first tools and no submit tool", () => {
    expect(kaggleTrainingBenchmarkRequiredTools).toEqual([
      "kaggle_workspace_prepare",
      "kaggle_experiment_start",
      "kaggle_experiment_read",
      "kaggle_experiment_list",
      "kaggle_metric_report",
      "kaggle_compare_experiments",
    ]);
    expect(kaggleTrainingBenchmarkRequiredTools).not.toContain("kaggle_submit");
  });

  it("scores a dummy training loop through the Kaggle tools without submit", async () => {
    const originalPulseedHome = process.env["PULSEED_HOME"];
    const originalWorkspaceRoot = process.env["PULSEED_WORKSPACE_ROOT"];
    const pulseedHome = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-kaggle-benchmark-"));
    const workspaceBase = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-kaggle-benchmark-workspaces-"));
    const competitionWorkspace = path.join(workspaceBase, "kaggle", "dummy-competition");
    const manager = new ProcessSessionManager();
    process.env["PULSEED_HOME"] = pulseedHome;
    process.env["PULSEED_WORKSPACE_ROOT"] = workspaceBase;
    try {
      const startTool = new KaggleExperimentStartTool(manager);
      const reportTool = new KaggleMetricReportTool(manager);
      const compareTool = new KaggleCompareExperimentsTool(manager);
      const context = makeContext(pulseedHome);

      const started = await startTool.call({
        workspace: "dummy-competition",
        competition: "dummy-competition",
        experiment_id: "exp-benchmark-a",
        command: process.execPath,
        args: ["-e", `
const fs = require("node:fs");
console.log("benchmark training started");
fs.writeFileSync("experiments/exp-benchmark-a/metrics.json", JSON.stringify(${JSON.stringify(metricsJson("exp-benchmark-a", 0.82))}));
console.log("benchmark training completed");
        `],
        artifact_refs: [],
        validation_contract: validationContract(),
      }, context);
      expect(started.success).toBe(true);

      await waitFor(async () => {
        const log = await fs.readFile(
          path.join(competitionWorkspace, "experiments", "exp-benchmark-a", "train.log"),
          "utf-8",
        );
        return log.includes("benchmark training completed");
      });
      await waitFor(async () => {
        try {
          const report = await fs.readFile(
            path.join(competitionWorkspace, "experiments", "exp-benchmark-a", "summary.md"),
            "utf-8",
          );
          const nextAction = await fs.readFile(
            path.join(competitionWorkspace, "experiments", "exp-benchmark-a", "next-action.json"),
            "utf-8",
          );
          return report.includes("Metric: accuracy=0.82 (maximize)") && nextAction.includes("compare_experiment");
        } catch {
          return false;
        }
      });

      const restartedRead = await new KaggleExperimentReadTool(new ProcessSessionManager()).call({
        workspace: "dummy-competition",
        competition: "dummy-competition",
        experiment_id: "exp-benchmark-a",
        maxChars: 12_000,
        waitMs: 0,
      }, context);
      let writtenWaitMetadata: Record<string, unknown> | null = null;
      const startedProcess = (started.data as {
        process?: { session_id?: string; metadataRef?: string };
      }).process;
      const waitOutcome = await handleWaitStrategyExpiry(
        "goal-1",
        "wait-benchmark",
        ({
          id: "wait-benchmark",
          goal_id: "goal-1",
          target_dimensions: ["quality"],
          primary_dimension: "quality",
          hypothesis: "wait for Kaggle training",
          expected_effect: [],
          resource_estimate: { sessions: 0, duration: { value: 1, unit: "minutes" }, llm_calls: null },
          state: "active",
          allocation: 0,
          created_at: "2026-04-25T00:00:00.000Z",
          started_at: null,
          completed_at: null,
          gap_snapshot_at_start: 0.8,
          tasks_generated: [],
          effectiveness_score: null,
          consecutive_stall_count: 0,
          source_template_id: null,
          cross_goal_context: null,
          rollback_target_id: null,
          max_pivot_count: 2,
          pivot_count: 0,
          toolset_locked: false,
          allowed_tools: [],
          required_tools: [],
          wait_reason: "training",
          wait_until: "2026-04-24T00:00:00.000Z",
          measurement_plan: "observe process exit",
          fallback_strategy_id: null,
        } as never),
        () => true,
        async () => 0.5,
        async () => undefined,
        async () => undefined,
        async () => [],
        async () => ({
          schema_version: 1,
          wait_until: "2026-04-24T00:00:00.000Z",
          conditions: [{ type: "process_session_exited", session_id: startedProcess?.session_id }],
          resume_plan: { action: "complete_wait" },
          process_refs: [{
            session_id: startedProcess?.session_id,
            metadata_ref: startedProcess?.metadataRef,
          }],
        }),
        async () => ({ capabilities: [], last_checked: "2026-04-25T00:00:00.000Z" }),
        async () => null,
        async (_goalId: string, _strategyId: string, metadata: unknown) => {
          writtenWaitMetadata = metadata as unknown as Record<string, unknown>;
        },
        () => pulseedHome,
      );
      const report = await reportTool.call({
        workspace: "dummy-competition",
        competition: "dummy-competition",
        experiment_id: "exp-benchmark-a",
      }, context);

      const secondDir = path.join(competitionWorkspace, "experiments", "exp-benchmark-b");
      await fs.mkdir(secondDir, { recursive: true });
      await fs.writeFile(path.join(secondDir, "metrics.json"), `${JSON.stringify(metricsJson("exp-benchmark-b", 0.8))}\n`);
      await fs.writeFile(path.join(secondDir, "train.log"), "benchmark fallback log\n");
      const compared = await compareTool.call({
        workspace: "dummy-competition",
        competition: "dummy-competition",
        experiment_ids: ["exp-benchmark-a", "exp-benchmark-b"],
      }, context);

      const summary = await runKaggleTrainingBenchmark([
        {
          name: "dummy-tool-training-loop",
          run: async () => ({
            experimentStarted: Boolean((started.data as { process?: { metadataRef?: string } }).process?.metadataRef),
            logArtifactWritten: ((restartedRead.data as { log?: { text?: string } }).log?.text ?? "").includes("benchmark training completed"),
            metricsParsed: report.success,
            reportArtifactWritten: await fileContains(
              path.join(competitionWorkspace, "experiments", "exp-benchmark-a", "summary.md"),
              "Metric: accuracy=0.82 (maximize)",
            ),
            nextActionWritten: await fileContains(
              path.join(competitionWorkspace, "experiments", "exp-benchmark-a", "next-action.json"),
              "compare_experiment",
            ),
            bestSelectedByDirection: (compared.data as { best_experiment_id?: string }).best_experiment_id === "exp-benchmark-a",
            waitResumedAfterProcessExit: waitOutcome.status === "improved"
              && (writtenWaitMetadata?.latest_observation as { status?: string } | undefined)?.status === "satisfied",
            restartReadsArtifacts: restartedRead.success,
            noSubmitCalled: true,
          }),
        },
      ]);

      expect(summary.ready).toBe(true);
    } finally {
      await manager.stopAll();
      if (originalPulseedHome === undefined) {
        delete process.env["PULSEED_HOME"];
      } else {
        process.env["PULSEED_HOME"] = originalPulseedHome;
      }
      if (originalWorkspaceRoot === undefined) {
        delete process.env["PULSEED_WORKSPACE_ROOT"];
      } else {
        process.env["PULSEED_WORKSPACE_ROOT"] = originalWorkspaceRoot;
      }
      await fs.rm(pulseedHome, { recursive: true, force: true });
      await fs.rm(workspaceBase, { recursive: true, force: true });
    }
  }, 10_000);
});
