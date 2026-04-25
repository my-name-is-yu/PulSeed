import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolCallContext } from "../../types.js";
import { ProcessSessionManager } from "../../system/ProcessSessionTool/ProcessSessionTool.js";
import {
  KaggleCompareExperimentsTool,
  KaggleExperimentListTool,
  KaggleExperimentReadTool,
  KaggleExperimentStartTool,
  KaggleExperimentStopTool,
  KaggleMetricReportTool,
} from "../KaggleExperimentTools.js";
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
  };
}

async function writeMetrics(root: string, experimentId: string, direction: KaggleMetricDirection, score: number): Promise<void> {
  const dir = path.join(root, "kaggle-runs", "titanic", "experiments", experimentId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "metrics.json"), `${JSON.stringify(metricsJson(experimentId, direction, score), null, 2)}\n`);
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

describe("Kaggle experiment tools", () => {
  const originalPulseedHome = process.env["PULSEED_HOME"];
  let pulseedHome: string;
  let manager: ProcessSessionManager;

  beforeEach(async () => {
    pulseedHome = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-kaggle-experiment-"));
    process.env["PULSEED_HOME"] = pulseedHome;
    manager = new ProcessSessionManager();
  });

  afterEach(async () => {
    await manager.stopAll();
    if (originalPulseedHome === undefined) {
      delete process.env["PULSEED_HOME"];
    } else {
      process.env["PULSEED_HOME"] = originalPulseedHome;
    }
    await fs.rm(pulseedHome, { recursive: true, force: true });
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
    }, makeContext(pulseedHome));

    expect(result.success).toBe(true);
    const data = result.data as { process: { session_id: string }; artifacts: { log: { state_relative_path: string } } };
    expect(data.artifacts.log.state_relative_path).toBe("kaggle-runs/titanic/experiments/exp-start/train.log");

    await waitFor(async () => {
      const raw = await fs.readFile(path.join(pulseedHome, "kaggle-runs", "titanic", "experiments", "exp-start", "train.log"), "utf-8");
      return raw.includes("training done");
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
      metrics: { cv_score: 0.8 },
    });
    expect((read.data as { log: { text: string } }).log.text).toContain("training done");
    await expect(fs.readFile(path.join(pulseedHome, "kaggle-runs", "titanic", "experiments", "exp-start", "config.json"), "utf-8"))
      .resolves.toContain(data.process.session_id);
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
    }, makeContext(pulseedHome));
    expect(result.success).toBe(true);

    await waitFor(async () => {
      const raw = await fs.readFile(path.join(pulseedHome, "kaggle-runs", "titanic", "experiments", "exp-restart", "train.log"), "utf-8");
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
    await writeMetrics(pulseedHome, "exp-files", "maximize", 0.7);
    const startTool = new KaggleExperimentStartTool(manager);
    const listTool = new KaggleExperimentListTool(manager);
    const result = await startTool.call({
      workspace: "titanic",
      competition: "titanic",
      experiment_id: "exp-live",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      artifact_refs: [],
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
    }, makeContext(pulseedHome));
    expect(result.success).toBe(true);
    const heartbeatPath = path.join(pulseedHome, "kaggle-runs", "titanic", "experiments", "exp-stop", "heartbeat.txt");
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

  it("reports strict metrics and returns failure details for missing or malformed metrics", async () => {
    await writeMetrics(pulseedHome, "exp-ok", "maximize", 0.82);
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
      artifact: { state_relative_path: "kaggle-runs/titanic/experiments/missing/metrics.json" },
    });

    const malformedDir = path.join(pulseedHome, "kaggle-runs", "titanic", "experiments", "malformed");
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
      artifact: { state_relative_path: "kaggle-runs/titanic/experiments/malformed/metrics.json" },
    });
  });

  it("compares maximize and minimize experiments and marks bad metrics inconclusive", async () => {
    await writeMetrics(pulseedHome, "max-a", "maximize", 0.7);
    await writeMetrics(pulseedHome, "max-b", "maximize", 0.8);
    await writeMetrics(pulseedHome, "min-a", "minimize", 0.3);
    await writeMetrics(pulseedHome, "min-b", "minimize", 0.2);
    const badDir = path.join(pulseedHome, "kaggle-runs", "titanic", "experiments", "bad");
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

});
