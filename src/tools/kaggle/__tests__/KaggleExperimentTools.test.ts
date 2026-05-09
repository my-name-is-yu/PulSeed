import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolCallContext } from "../../types.js";
import { ProcessSessionManager } from "../../system/ProcessSessionTool/ProcessSessionTool.js";
import {
  KaggleCompareExperimentsTool,
  KaggleExperimentListTool,
  KaggleExperimentReadTool,
  KaggleExperimentStartInputSchema,
  KaggleExperimentStartTool,
  KaggleExperimentStopTool,
  KaggleMetricReportTool,
} from "../KaggleExperimentTools.js";
import { teeWrapperArgs } from "../tee-wrapper.js";
import type { KaggleMetricDirection } from "../metrics.js";

function makeContext(cwd = "/tmp"): ToolCallContext {
  return {
    cwd,
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
  };
}

function metricsJson(
  experimentId: string,
  direction: KaggleMetricDirection,
  score: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    experiment_id: experimentId,
    competition: "titanic",
    metric_name: direction === "maximize" ? "accuracy" : "rmse",
    direction,
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
    ...overrides,
  };
}

function validationContract(metricName = "accuracy", direction: KaggleMetricDirection = "maximize") {
  return {
    competition_metric: { name: metricName, direction, source: "competition_rules" as const },
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

async function writeMetrics(
  root: string,
  experimentId: string,
  direction: KaggleMetricDirection,
  score: number,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const dir = path.join(root, "kaggle", "titanic", "experiments", experimentId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "metrics.json"), `${JSON.stringify(metricsJson(experimentId, direction, score, overrides), null, 2)}\n`);
  await fs.writeFile(path.join(dir, "train.log"), "durable log\n");
}

async function waitFor(expectation: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await expectation()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(await expectation()).toBe(true);
}

describe("Kaggle tee wrapper", () => {
  it("keeps wrapper argument order and child-process artifact path stable", () => {
    const wrapperArgs = teeWrapperArgs(
      process.execPath,
      ["train.js", "--fold", "1"],
      "/workspace/kaggle/titanic/experiments/exp-a/train.log",
      "/workspace/kaggle/titanic/experiments/exp-a/metrics.json",
      "/workspace/kaggle/titanic/experiments/exp-a/summary.md",
      "/workspace/kaggle/titanic/experiments/exp-a/next-action.json",
      "exp-a",
      "titanic",
    );

    expect(wrapperArgs[0]).toBe("-e");
    expect(wrapperArgs[2]).toBe(process.execPath);
    expect(JSON.parse(wrapperArgs[3]!)).toEqual(["train.js", "--fold", "1"]);
    expect(wrapperArgs[4]).toBe("/workspace/kaggle/titanic/experiments/exp-a/train.log");
    expect(wrapperArgs[5]).toBe("/workspace/kaggle/titanic/experiments/exp-a/child-process.json");
    expect(wrapperArgs[8]).toBe("/workspace/kaggle/titanic/experiments/exp-a/next-action.json");
    expect(wrapperArgs[9]).toBe("exp-a");
    expect(wrapperArgs[10]).toBe("titanic");
  });
});

describe("Kaggle experiment tools", () => {
  const originalPulseedHome = process.env["PULSEED_HOME"];
  const originalWorkspaceRoot = process.env["PULSEED_WORKSPACE_ROOT"];
  let pulseedHome: string;
  let workspaceBase: string;
  let manager: ProcessSessionManager;

  beforeEach(async () => {
    pulseedHome = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-kaggle-experiment-"));
    workspaceBase = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-workspaces-"));
    process.env["PULSEED_HOME"] = pulseedHome;
    process.env["PULSEED_WORKSPACE_ROOT"] = workspaceBase;
    manager = new ProcessSessionManager();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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
  });

  it("rejects starting long-running experiments without the validation contract foundation", () => {
    const baseInput = {
      workspace: "titanic",
      competition: "titanic",
      experiment_id: "missing-validation",
      command: process.execPath,
      args: [],
      artifact_refs: [],
    };
    const parsed = KaggleExperimentStartInputSchema.safeParse({
      ...baseInput,
      validation_contract: {},
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toEqual(expect.arrayContaining([
      "validation_contract.competition_metric",
      "validation_contract.cv",
      "validation_contract.oof",
      "validation_contract.leak_checks",
      "validation_contract.train_test_drift",
    ]));

    const unsafe = KaggleExperimentStartInputSchema.safeParse({
      ...baseInput,
      experiment_id: "unsafe-validation",
      validation_contract: {
        competition_metric: { name: "accuracy", direction: "maximize", source: "competition_rules" },
        cv: { strategy: "holdout_only" },
        oof: { present: false, leak_checked: false },
        leak_checks: {},
        train_test_drift: { checked: false },
      },
    });
    expect(unsafe.success).toBe(false);
    expect(unsafe.error?.issues.map((issue) => issue.path.join("."))).toEqual(expect.arrayContaining([
      "validation_contract.cv.fold_count",
      "validation_contract.oof.present",
      "validation_contract.oof.leak_checked",
      "validation_contract.leak_checks.target_encoding_oof_only",
      "validation_contract.leak_checks.stacking_oof_only",
      "validation_contract.leak_checks.train_test_boundary_checked",
      "validation_contract.leak_checks.duplicate_or_id_leak_checked",
      "validation_contract.train_test_drift.checked",
    ]));
  });

  it("starts a process session, writes experiment metadata, and reads durable log and metrics", async () => {
    const startTool = new KaggleExperimentStartTool(manager);
    const readTool = new KaggleExperimentReadTool(manager);
    const result = await startTool.call({
      workspace: "titanic",
      competition: "titanic",
      experiment_id: "exp-start",
      command: process.execPath,
      args: ["-e", `
const fs = require("node:fs");
console.log("training started");
fs.writeFileSync("experiments/exp-start/metrics.json", JSON.stringify(${JSON.stringify(metricsJson("exp-start", "maximize", 0.8))}));
console.log("training done");
`],
      artifact_refs: [],
      strategy_id: "strategy-1",
      task_id: "task-1",
      validation_contract: validationContract(),
    }, makeContext(pulseedHome));

    expect(result.success).toBe(true);
    const data = result.data as {
      process: { session_id: string };
      artifacts: { log: { state_relative_path: string } };
      validation_checklist: string[];
      validation_contract: { oof: { leak_checked: boolean } };
    };
    expect(data.artifacts.log.state_relative_path).toBe("workspace:kaggle/titanic/experiments/exp-start/train.log");
    expect(data.validation_checklist).toEqual(expect.arrayContaining(["cv_split_strategy_declared", "oof_predictions_present_and_leak_checked"]));
    expect(data.validation_contract.oof.leak_checked).toBe(true);

    await waitFor(async () => {
      const raw = await fs.readFile(path.join(workspaceBase, "kaggle", "titanic", "experiments", "exp-start", "train.log"), "utf-8");
      return raw.includes("training done");
    });
    await waitFor(async () => {
      try {
        const report = await fs.readFile(
          path.join(workspaceBase, "kaggle", "titanic", "experiments", "exp-start", "summary.md"),
          "utf-8",
        );
        return report.includes("Metric: accuracy=0.8 (maximize)");
      } catch {
        return false;
      }
    });
    const nextAction = JSON.parse(await fs.readFile(
      path.join(workspaceBase, "kaggle", "titanic", "experiments", "exp-start", "next-action.json"),
      "utf-8",
    )) as Record<string, unknown>;
    expect(nextAction).toMatchObject({
      schema_version: "long-running-next-action-v1",
      source: { kind: "kaggle_experiment", experiment_id: "exp-start", competition: "titanic" },
      action: { type: "compare_experiment" },
    });

    const read = await readTool.call({
      workspace: "titanic",
      competition: "titanic",
      experiment_id: "exp-start",
      maxChars: 4_000,
      waitMs: 0,
    }, makeContext(pulseedHome));

    expect(read.success).toBe(true);
    expect(read.data).toMatchObject({
      experiment_id: "exp-start",
      metrics_status: "ok",
      metrics_source_schema: "strict",
      metrics: { cv_score: 0.8 },
    });
    expect((read.data as { log: { text: string } }).log.text).toContain("training done");
    expect(read.data).toMatchObject({
      artifacts: {
        report: { state_relative_path: "workspace:kaggle/titanic/experiments/exp-start/summary.md" },
        next_action: { state_relative_path: "workspace:kaggle/titanic/experiments/exp-start/next-action.json" },
      },
    });
    await expect(fs.readFile(path.join(workspaceBase, "kaggle", "titanic", "experiments", "exp-start", "config.json"), "utf-8"))
      .resolves.toContain(data.process.session_id);
    await expect(fs.readFile(path.join(workspaceBase, "kaggle", "titanic", "experiments", "exp-start", "command.json"), "utf-8"))
      .resolves.toContain("validation_checklist");
  });

  it("recovers experiment reads from files and process metadata without a live process buffer", async () => {
    const startTool = new KaggleExperimentStartTool(manager);
    const result = await startTool.call({
      workspace: "titanic",
      competition: "titanic",
      experiment_id: "exp-restart",
      command: process.execPath,
      args: ["-e", `
const fs = require("node:fs");
console.log("persisted output");
fs.writeFileSync("experiments/exp-restart/metrics.json", JSON.stringify(${JSON.stringify(metricsJson("exp-restart", "minimize", 0.12))}));
      `],
      artifact_refs: [],
      validation_contract: validationContract("rmse", "minimize"),
    }, makeContext(pulseedHome));
    expect(result.success).toBe(true);

    await waitFor(async () => {
      const raw = await fs.readFile(path.join(workspaceBase, "kaggle", "titanic", "experiments", "exp-restart", "train.log"), "utf-8");
      return raw.includes("persisted output");
    });

    const restartedReadTool = new KaggleExperimentReadTool(new ProcessSessionManager());
    const read = await restartedReadTool.call({
      workspace: "titanic",
      competition: "titanic",
      experiment_id: "exp-restart",
      maxChars: 4_000,
      waitMs: 0,
    }, makeContext(pulseedHome));

    expect(read.success).toBe(true);
    expect(read.data).toMatchObject({
      experiment_id: "exp-restart",
      metrics_status: "ok",
      metrics: { cv_score: 0.12, direction: "minimize" },
    });
    expect((read.data as { log: { text: string } }).log.text).toContain("persisted output");
  });

  it("lists filesystem experiments together with live process sessions", async () => {
    await writeMetrics(workspaceBase, "exp-files", "maximize", 0.7);
    const startTool = new KaggleExperimentStartTool(manager);
    const listTool = new KaggleExperimentListTool(manager);
    const result = await startTool.call({
      workspace: "titanic",
      competition: "titanic",
      experiment_id: "exp-live",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      artifact_refs: [],
      validation_contract: validationContract(),
    }, makeContext(pulseedHome));
    expect(result.success).toBe(true);

    const listed = await listTool.call({
      workspace: "titanic",
      competition: "titanic",
      include_exited: true,
    }, makeContext(pulseedHome));

    expect(listed.success).toBe(true);
    const ids = (listed.data as Array<{ experiment_id: string; status: string }>).map((item) => item.experiment_id);
    expect(ids).toEqual(expect.arrayContaining(["exp-files", "exp-live"]));
    expect(listed.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ experiment_id: "exp-live", status: "running" }),
      expect.objectContaining({ experiment_id: "exp-files", status: "completed" }),
    ]));
  });

  it("lists experiments when the model passes the Kaggle runs root instead of the competition workspace", async () => {
    await writeMetrics(workspaceBase, "exp-files", "maximize", 0.7);
    const listTool = new KaggleExperimentListTool(manager);

    const listed = await listTool.call({
      workspace: path.join(workspaceBase, "kaggle"),
      competition: "titanic",
      include_exited: true,
    }, makeContext(pulseedHome));

    expect(listed.success).toBe(true);
    expect((listed.data as Array<{ experiment_id: string }>).map((item) => item.experiment_id)).toContain("exp-files");
  });

  it("stops the process session linked to an experiment", async () => {
    const startTool = new KaggleExperimentStartTool(manager);
    const stopTool = new KaggleExperimentStopTool(manager);
    const result = await startTool.call({
      workspace: "titanic",
      competition: "titanic",
      experiment_id: "exp-stop",
      command: process.execPath,
      args: ["-e", `
const fs = require("node:fs");
setInterval(() => fs.writeFileSync("experiments/exp-stop/heartbeat.txt", String(Date.now())), 50);
      `],
      artifact_refs: [],
      validation_contract: validationContract(),
    }, makeContext(pulseedHome));
    expect(result.success).toBe(true);
    const heartbeatPath = path.join(workspaceBase, "kaggle", "titanic", "experiments", "exp-stop", "heartbeat.txt");
    await waitFor(async () => {
      try {
        await fs.access(heartbeatPath);
        return true;
      } catch {
        return false;
      }
    });

    const stopped = await stopTool.call({
      workspace: "titanic",
      competition: "titanic",
      experiment_id: "exp-stop",
      signal: "SIGTERM",
      waitMs: 1_000,
    }, makeContext(pulseedHome));

    expect(stopped.success).toBe(true);
    expect(stopped.data).toMatchObject({
      experiment_id: "exp-stop",
      process: { running: false },
    });
    const heartbeatAfterStop = await fs.readFile(heartbeatPath, "utf-8");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(fs.readFile(heartbeatPath, "utf-8")).resolves.toBe(heartbeatAfterStop);
  });

  it("does not signal unsafe persisted child process pids", async () => {
    const stopTool = new KaggleExperimentStopTool(manager);
    const experimentDir = path.join(workspaceBase, "kaggle", "titanic", "experiments", "exp-unsafe-child");
    await fs.mkdir(experimentDir, { recursive: true });
    await fs.writeFile(
      path.join(experimentDir, "config.json"),
      JSON.stringify({ process: { session_id: "missing-session" } }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(experimentDir, "child-process.json"),
      JSON.stringify({ pid: Number.MAX_SAFE_INTEGER + 1 }),
      "utf-8",
    );
    const killSpy = vi.spyOn(process, "kill");

    const result = await stopTool.call({
      workspace: "titanic",
      competition: "titanic",
      experiment_id: "exp-unsafe-child",
      signal: "SIGTERM",
      waitMs: 0,
    }, makeContext(pulseedHome));

    expect(result.success).toBe(false);
    expect(result.error).toContain("Process session not found");
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("does not signal persisted child process pids when the owning session is missing", async () => {
    const stopTool = new KaggleExperimentStopTool(manager);
    const experimentDir = path.join(workspaceBase, "kaggle", "titanic", "experiments", "exp-missing-session-child");
    await fs.mkdir(experimentDir, { recursive: true });
    await fs.writeFile(
      path.join(experimentDir, "config.json"),
      JSON.stringify({ process: { session_id: "missing-session" } }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(experimentDir, "child-process.json"),
      JSON.stringify({ pid: process.pid, command: process.execPath, args: [], startedAt: new Date().toISOString() }),
      "utf-8",
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await stopTool.call({
      workspace: "titanic",
      competition: "titanic",
      experiment_id: "exp-missing-session-child",
      signal: "SIGTERM",
      waitMs: 0,
    }, makeContext(pulseedHome));

    expect(result.success).toBe(false);
    expect(result.error).toContain("Process session not found");
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("reports strict metrics and returns failure details for missing or malformed metrics", async () => {
    await writeMetrics(workspaceBase, "exp-ok", "maximize", 0.82);
    const tool = new KaggleMetricReportTool(manager);

    const ok = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      experiment_id: "exp-ok",
      baseline_score: 0.8,
    }, makeContext(pulseedHome));
    expect(ok.success).toBe(true);
    expect(ok.data).toMatchObject({
      status: "ok",
      score: 0.82,
      normalized_score: 0.82,
      baseline_delta: 0.019999999999999907,
      metric_threshold_guidance: { operator: "gte", value_required: true },
    });

    const missing = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      experiment_id: "missing",
    }, makeContext(pulseedHome));
    expect(missing.success).toBe(false);
    expect(missing.data).toMatchObject({
      status: "failure",
      reason: "missing",
      artifact: { state_relative_path: "workspace:kaggle/titanic/experiments/missing/metrics.json" },
    });

    const malformedDir = path.join(workspaceBase, "kaggle", "titanic", "experiments", "malformed");
    await fs.mkdir(malformedDir, { recursive: true });
    await fs.writeFile(path.join(malformedDir, "metrics.json"), "{\"bad\":true}\n");
    const malformed = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      experiment_id: "malformed",
    }, makeContext(pulseedHome));
    expect(malformed.success).toBe(false);
    expect(malformed.data).toMatchObject({
      status: "failure",
      reason: "malformed",
      artifact: { state_relative_path: "workspace:kaggle/titanic/experiments/malformed/metrics.json" },
    });
  });

  it("reports loose real-run metrics with caller fallback context", async () => {
    const dir = path.join(workspaceBase, "kaggle", "titanic", "experiments", "exp-loose");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "metrics.json"), `${JSON.stringify({
      metric_name: "balanced_accuracy",
      metric_value: 0.81,
      metric_direction: "higher_is_better",
      all_metrics: { balanced_accuracy: 0.81 },
    })}\n`);

    const tool = new KaggleMetricReportTool(manager);
    const reported = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      experiment_id: "exp-loose",
    }, makeContext(pulseedHome));

    expect(reported.success).toBe(true);
    expect(reported.data).toMatchObject({
      status: "ok",
      experiment_id: "exp-loose",
      metric_name: "balanced_accuracy",
      direction: "maximize",
      score: 0.81,
      metrics_source_schema: "loose",
      metric_threshold_guidance: { operator: "gte" },
    });
  });

  it("compares maximize and minimize experiments and marks bad metrics inconclusive", async () => {
    await writeMetrics(workspaceBase, "max-a", "maximize", 0.7);
    await writeMetrics(workspaceBase, "max-b", "maximize", 0.8);
    await writeMetrics(workspaceBase, "min-a", "minimize", 0.3);
    await writeMetrics(workspaceBase, "min-b", "minimize", 0.2);
    const badDir = path.join(workspaceBase, "kaggle", "titanic", "experiments", "bad");
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, "metrics.json"), "not json");

    const tool = new KaggleCompareExperimentsTool(manager);
    const max = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      experiment_ids: ["max-a", "max-b", "bad"],
    }, makeContext(pulseedHome));
    expect(max.success).toBe(true);
    expect(max.data).toMatchObject({
      status: "inconclusive",
      best_experiment_id: "max-b",
      direction: "maximize",
    });
    expect((max.data as { rows: Array<{ experiment_id: string; status: string }> }).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ experiment_id: "bad", status: "malformed" }),
    ]));

    const min = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      experiment_ids: ["min-a", "min-b"],
    }, makeContext(pulseedHome));
    expect(min.success).toBe(true);
    expect(min.data).toMatchObject({
      status: "ok",
      best_experiment_id: "min-b",
      direction: "minimize",
    });

    const mixed = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      experiment_ids: ["max-a", "min-a"],
    }, makeContext(pulseedHome));
    expect(mixed.success).toBe(true);
    expect(mixed.data).toMatchObject({
      status: "inconclusive",
      best_experiment_id: null,
      recommendation: "Experiments must share metric_name and direction before comparison.",
    });
  });

  it("does not recommend raw CV top-1 as the safe candidate when validation risk is high", async () => {
    await writeMetrics(workspaceBase, "raw-oof-top", "maximize", 0.835, {
      cv_std: 0.04,
      validation: {
        competition_metric: { name: "accuracy", direction: "maximize", source: "competition_rules" },
        cv: { strategy: "stratified_kfold", fold_count: 5, stratified: true },
        oof: { present: true, path: "experiments/raw-oof-top/oof.csv", coverage: 1, leak_checked: false },
        leak_checks: {
          target_encoding_oof_only: false,
          stacking_oof_only: false,
          train_test_boundary_checked: false,
        },
        train_test_drift: { checked: true, adversarial_validation_auc: 0.74 },
        public_leaderboard: { score: 0.76, submission_id: "raw-oof-top-public", observed_at: "2026-04-25T00:00:00.000Z" },
      },
    });
    await writeMetrics(workspaceBase, "stable-safe", "maximize", 0.821, {
      cv_std: 0.006,
      validation: {
        competition_metric: { name: "accuracy", direction: "maximize", source: "competition_rules" },
        cv: { strategy: "repeated_stratified_kfold", fold_count: 5, repeated_seed_count: 3, stratified: true },
        oof: { present: true, path: "experiments/stable-safe/oof.csv", coverage: 1, leak_checked: true },
        leak_checks: {
          target_encoding_oof_only: true,
          stacking_oof_only: true,
          train_test_boundary_checked: true,
          duplicate_or_id_leak_checked: true,
        },
        stability: { repeated_seed_count: 3, seed_score_std: 0.005 },
        train_test_drift: { checked: true, adversarial_validation_auc: 0.53 },
        public_leaderboard: { score: 0.819, submission_id: "stable-safe-public", observed_at: "2026-04-25T00:10:00.000Z" },
      },
    });

    const tool = new KaggleCompareExperimentsTool(manager);
    const result = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      experiment_ids: ["raw-oof-top", "stable-safe"],
    }, makeContext(pulseedHome));

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      best_experiment_id: "stable-safe",
      raw_best_experiment_id: "raw-oof-top",
      recommendation_mode: "validation_adjusted",
      recommendation: expect.stringContaining("raw CV top-1 raw-oof-top is not the safe recommendation"),
      final_report_sections: expect.arrayContaining(["local_cv_oof", "public_leaderboard_gap", "private_leaderboard_uncertainty"]),
      validation_checklist: expect.arrayContaining([
        "oof_predictions_present_and_leak_checked",
        "target_encoding_and_stacking_are_oof_only",
        "final_report_separates_local_cv_public_lb_private_uncertainty",
      ]),
    });
    expect((result.data as { rows: Array<{ experiment_id: string; raw_rank?: number; robust_rank?: number; validation?: { risk_level: string; leak_risks: string[] } }> }).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        experiment_id: "raw-oof-top",
        raw_rank: 1,
        robust_rank: 2,
        validation: expect.objectContaining({
          risk_level: "high",
          leak_risks: expect.arrayContaining(["target_encoding_not_oof_safe", "stacking_not_oof_safe"]),
        }),
      }),
      expect.objectContaining({
        experiment_id: "stable-safe",
        raw_rank: 2,
        robust_rank: 1,
        validation: expect.objectContaining({ risk_level: "low" }),
      }),
    ]));
  });

});
