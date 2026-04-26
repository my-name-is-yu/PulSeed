import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolCallContext } from "../../types.js";
import { KaggleWorkspacePrepareTool } from "../KaggleWorkspacePrepareTool.js";

function makeContext(): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
  };
}

describe("KaggleWorkspacePrepareTool", () => {
  const originalPulseedHome = process.env["PULSEED_HOME"];
  let pulseedHome: string;
  let tmpDirs: string[];

  beforeEach(async () => {
    pulseedHome = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-kaggle-workspace-"));
    tmpDirs = [pulseedHome];
    process.env["PULSEED_HOME"] = pulseedHome;
  });

  afterEach(async () => {
    if (originalPulseedHome === undefined) {
      delete process.env["PULSEED_HOME"];
    } else {
      process.env["PULSEED_HOME"] = originalPulseedHome;
    }
    await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("creates the standard workspace directories and metadata under PulSeed state", async () => {
    const tool = new KaggleWorkspacePrepareTool();
    const result = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      metric_name: "accuracy",
      metric_direction: "maximize",
      target_column: "Survived",
      submission_format_hint: "PassengerId,Survived",
      notes: "baseline",
    }, makeContext());

    expect(result.success).toBe(true);
    const data = result.data as {
      workspace: { path: string; state_relative_path: string };
      metadata: { path: string; state_relative_path: string };
      directories: Array<{ name: string; path: string }>;
      artifacts: { metrics_template: { state_relative_path: string }; train_log: { state_relative_path: string } };
      wait_condition_hints: {
        file_exists: { path: string; absolute_path: string };
      };
      metric_threshold_guidance: { metric: string; operator: string; metrics_artifact_state_relative_path: string };
    };
    expect(data.workspace.path).toBe(path.join(pulseedHome, "kaggle-runs", "titanic"));
    expect(data.workspace.state_relative_path).toBe("kaggle-runs/titanic");
    expect(data.metadata.state_relative_path).toBe("kaggle-runs/titanic/workspace.json");
    expect(data.directories.map((dir) => dir.name).sort()).toEqual([
      "data",
      "experiments",
      "notebooks",
      "src",
      "submissions",
    ]);
    for (const dirname of ["data", "notebooks", "src", "experiments", "submissions"]) {
      const stat = await fs.stat(path.join(pulseedHome, "kaggle-runs", "titanic", dirname));
      expect(stat.isDirectory()).toBe(true);
    }

    const metadata = JSON.parse(await fs.readFile(data.metadata.path, "utf-8")) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      schema_version: "kaggle-workspace-v1",
      competition: "titanic",
      target_column: "Survived",
      submission_format_hint: "PassengerId,Survived",
      metrics_schema_version: "kaggle-metrics-v1",
    });
    expect(data.artifacts.metrics_template.state_relative_path).toBe("kaggle-runs/titanic/experiments/metrics.json");
    expect(data.artifacts.train_log.state_relative_path).toBe("kaggle-runs/titanic/experiments/train.log");
    expect(data.wait_condition_hints.file_exists.path).toBe("kaggle-runs/titanic/experiments/metrics.json");
    expect(data.wait_condition_hints.file_exists.absolute_path).toBe(
      path.join(pulseedHome, "kaggle-runs", "titanic", "experiments", "metrics.json"),
    );
    expect(data.metric_threshold_guidance).toMatchObject({
      metric: "accuracy",
      operator: "gte",
      metrics_artifact_state_relative_path: "kaggle-runs/titanic/experiments/metrics.json",
    });
  });

  it("rejects workspace traversal", async () => {
    const tool = new KaggleWorkspacePrepareTool();
    const result = await tool.call({
      workspace: "../titanic",
      competition: "titanic",
      metric_name: "rmse",
      metric_direction: "minimize",
    }, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("workspace must resolve");
    await expect(fs.stat(path.join(pulseedHome, "titanic"))).rejects.toThrow();
  });

  it("accepts a state-relative kaggle-runs workspace path for the same competition", async () => {
    const tool = new KaggleWorkspacePrepareTool();
    const result = await tool.call({
      workspace: "kaggle-runs/titanic",
      competition: "titanic",
      metric_name: "rmse",
      metric_direction: "minimize",
    }, makeContext());

    expect(result.success).toBe(true);
    const data = result.data as { workspace: { state_relative_path: string } };
    expect(data.workspace.state_relative_path).toBe("kaggle-runs/titanic");
  });

  it("accepts the Kaggle runs root when competition identifies the workspace", async () => {
    const tool = new KaggleWorkspacePrepareTool();
    const stateRelative = await tool.call({
      workspace: "kaggle-runs",
      competition: "titanic",
      metric_name: "rmse",
      metric_direction: "minimize",
    }, makeContext());
    const absolute = await tool.call({
      workspace: path.join(pulseedHome, "kaggle-runs"),
      competition: "titanic",
      metric_name: "rmse",
      metric_direction: "minimize",
    }, makeContext());

    expect(stateRelative.success).toBe(true);
    expect(absolute.success).toBe(true);
    expect((stateRelative.data as { workspace: { state_relative_path: string } }).workspace.state_relative_path).toBe("kaggle-runs/titanic");
    expect((absolute.data as { workspace: { state_relative_path: string } }).workspace.state_relative_path).toBe("kaggle-runs/titanic");
  });

  it("rejects absolute workspace paths outside the fixed competition root", async () => {
    const tool = new KaggleWorkspacePrepareTool();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-kaggle-outside-"));
    tmpDirs.push(outside);
    const result = await tool.call({
      workspace: outside,
      competition: "titanic",
      metric_name: "rmse",
      metric_direction: "minimize",
    }, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("workspace must resolve");
  });

  it("rejects symlink escape under kaggle-runs", async () => {
    const tool = new KaggleWorkspacePrepareTool();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-kaggle-symlink-target-"));
    tmpDirs.push(outside);
    await fs.mkdir(path.join(pulseedHome, "kaggle-runs"), { recursive: true });
    await fs.symlink(outside, path.join(pulseedHome, "kaggle-runs", "titanic"), "dir");

    const result = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      metric_name: "rmse",
      metric_direction: "minimize",
    }, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("must not be a symlink");
    await expect(fs.stat(path.join(outside, "workspace.json"))).rejects.toThrow();
  });

  it("rejects symlinks that point to another location inside the PulSeed state root", async () => {
    const tool = new KaggleWorkspacePrepareTool();
    await fs.mkdir(path.join(pulseedHome, "other-state-subtree"), { recursive: true });
    await fs.mkdir(path.join(pulseedHome, "kaggle-runs"), { recursive: true });
    await fs.symlink(
      path.join(pulseedHome, "other-state-subtree"),
      path.join(pulseedHome, "kaggle-runs", "titanic"),
      "dir",
    );

    const result = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      metric_name: "rmse",
      metric_direction: "minimize",
    }, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("must not be a symlink");
    await expect(fs.stat(path.join(pulseedHome, "other-state-subtree", "workspace.json"))).rejects.toThrow();
  });

});
