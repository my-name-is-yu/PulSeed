import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConcurrencyController } from "../../concurrency.js";
import { ToolExecutor } from "../../executor.js";
import { ToolPermissionManager } from "../../permission.js";
import { ToolRegistry } from "../../registry.js";
import type { ToolCallContext } from "../../types.js";
import {
  KaggleLeaderboardSnapshotTool,
  KaggleListSubmissionsTool,
  KaggleSubmissionPrepareTool,
  KaggleSubmitTool,
  type KaggleCommandResult,
  type KaggleCommandRunner,
} from "../KaggleSubmissionTools.js";

function makeContext(cwd = "/tmp"): ToolCallContext {
  return {
    cwd,
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
  };
}

class RecordingRunner implements KaggleCommandRunner {
  calls: Array<{ command: string; args: string[]; cwd: string }> = [];

  constructor(private readonly result: KaggleCommandResult = {
    exitCode: 0,
    stdout: "ok\n",
    stderr: "",
  }) {}

  async run(command: string, args: string[], options: { cwd: string }): Promise<KaggleCommandResult> {
    this.calls.push({ command, args, cwd: options.cwd });
    return this.result;
  }
}

function metricsJson(experimentId: string) {
  return {
    experiment_id: experimentId,
    competition: "titanic",
    metric_name: "accuracy",
    direction: "maximize",
    cv_score: 0.82,
    cv_std: 0.01,
    holdout_score: 0.8,
    train_rows: 800,
    valid_rows: 200,
    seed: 42,
    created_at: "2026-04-25T00:00:00.000Z",
    status: "completed",
    artifacts: {
      model: "experiments/exp-a/model.pkl",
      submission: "experiments/exp-a/submission.csv",
      log: "experiments/exp-a/train.log",
    },
  };
}

describe("Kaggle submission tools", () => {
  const originalPulseedHome = process.env["PULSEED_HOME"];
  let pulseedHome: string;
  let workspaceRoot: string;
  let tmpDirs: string[];

  beforeEach(async () => {
    pulseedHome = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-kaggle-submission-"));
    tmpDirs = [pulseedHome];
    process.env["PULSEED_HOME"] = pulseedHome;
    workspaceRoot = path.join(pulseedHome, "kaggle-runs", "titanic");
    await fs.mkdir(path.join(workspaceRoot, "experiments", "exp-a"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "experiments", "exp-a", "submission.csv"), "PassengerId,Survived\n1,0\n");
    await fs.writeFile(
      path.join(workspaceRoot, "experiments", "exp-a", "metrics.json"),
      `${JSON.stringify(metricsJson("exp-a"), null, 2)}\n`,
    );
  });

  afterEach(async () => {
    if (originalPulseedHome === undefined) {
      delete process.env["PULSEED_HOME"];
    } else {
      process.env["PULSEED_HOME"] = originalPulseedHome;
    }
    await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("prepares a submission artifact inside the competition workspace", async () => {
    const tool = new KaggleSubmissionPrepareTool();
    const result = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      source_file: "experiments/exp-a/submission.csv",
      selected_experiment_id: "exp-a",
      submission_id: "exp-a-public",
      output_filename: "exp-a-public.csv",
      message: "exp-a public submit",
    }, makeContext(pulseedHome));

    expect(result.success).toBe(true);
    const data = result.data as {
      submission_id: string;
      file: { state_relative_path: string; workspace_relative_path: string };
      metadata: { path: string; state_relative_path: string };
      submit_hint: { file: string; message: string };
    };
    expect(data.submission_id).toBe("exp-a-public");
    expect(data.file).toMatchObject({
      workspace_relative_path: "submissions/exp-a-public.csv",
      state_relative_path: "kaggle-runs/titanic/submissions/exp-a-public.csv",
    });
    expect(data.submit_hint).toEqual({
      tool: "kaggle_submit",
      file: "submissions/exp-a-public.csv",
      message: "exp-a public submit",
    });
    await expect(fs.readFile(path.join(workspaceRoot, "submissions", "exp-a-public.csv"), "utf-8"))
      .resolves.toContain("PassengerId,Survived");
    const metadata = JSON.parse(await fs.readFile(data.metadata.path, "utf-8")) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      schema_version: "kaggle-submission-v1",
      competition: "titanic",
      submission_id: "exp-a-public",
      message: "exp-a public submit",
      provenance: {
        selected_experiment_id: "exp-a",
        local_metrics: {
          schema_version: "kaggle-metrics-v1",
          evidence_type: "local_cv",
          metrics: { experiment_id: "exp-a", cv_score: 0.82, metric_name: "accuracy" },
          artifact: { workspace_relative_path: "experiments/exp-a/metrics.json" },
        },
      },
    });
  });

  it("rejects source file traversal and symlink escapes", async () => {
    const tool = new KaggleSubmissionPrepareTool();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-kaggle-outside-"));
    tmpDirs.push(outside);
    await fs.writeFile(path.join(outside, "submission.csv"), "escaped\n");

    const traversal = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      source_file: "../../outside.csv",
      selected_experiment_id: "exp-a",
      submission_id: "bad",
    }, makeContext(pulseedHome));
    expect(traversal.success).toBe(false);
    expect(traversal.error).toContain("must stay within");

    await fs.symlink(path.join(outside, "submission.csv"), path.join(workspaceRoot, "experiments", "exp-a", "escape.csv"));
    const symlink = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      source_file: "experiments/exp-a/escape.csv",
      selected_experiment_id: "exp-a",
      submission_id: "bad-link",
    }, makeContext(pulseedHome));
    expect(symlink.success).toBe(false);
    expect(symlink.error).toContain("must stay within the Kaggle workspace");
  });

  it("rejects existing symlink leaves before writing prepared artifacts", async () => {
    const tool = new KaggleSubmissionPrepareTool();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-kaggle-prepared-leaf-"));
    tmpDirs.push(outside);
    await fs.mkdir(path.join(workspaceRoot, "submissions"), { recursive: true });
    await fs.writeFile(path.join(outside, "prepared.csv"), "outside\n");
    await fs.symlink(path.join(outside, "prepared.csv"), path.join(workspaceRoot, "submissions", "prepared.csv"));

    const result = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      source_file: "experiments/exp-a/submission.csv",
      selected_experiment_id: "exp-a",
      submission_id: "prepared",
      output_filename: "prepared.csv",
    }, makeContext(pulseedHome));

    expect(result.success).toBe(false);
    expect(result.error).toContain("must not be a symlink");
    await expect(fs.readFile(path.join(outside, "prepared.csv"), "utf-8")).resolves.toBe("outside\n");
  });

  it("rejects a symlinked competition workspace before running Kaggle commands", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-kaggle-workspace-escape-"));
    tmpDirs.push(outside);
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.mkdir(path.dirname(workspaceRoot), { recursive: true });
    await fs.symlink(outside, workspaceRoot, "dir");
    await fs.mkdir(path.join(outside, "submissions"), { recursive: true });
    await fs.writeFile(path.join(outside, "submissions", "submission.csv"), "escaped\n");

    const runner = new RecordingRunner();
    const tool = new KaggleSubmitTool(runner);
    const result = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      file: "submissions/submission.csv",
      message: "should not run",
      sandbox: false,
      quiet: false,
      timeoutMs: 10_000,
    }, makeContext(pulseedHome));

    expect(result.success).toBe(false);
    expect(result.error).toContain("must not be a symlink");
    expect(runner.calls).toEqual([]);
  });

  it("rejects direct experiment CSV submission before running Kaggle commands", async () => {
    const runner = new RecordingRunner({ exitCode: 0, stdout: "submitted\n", stderr: "" });
    const tool = new KaggleSubmitTool(runner);

    const result = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      file: "experiments/exp-a/submission.csv",
      message: "baseline",
      sandbox: false,
      quiet: false,
      timeoutMs: 10_000,
    }, makeContext(pulseedHome));

    expect(result.success).toBe(false);
    expect(result.error).toContain("prepared submission");
    expect(runner.calls).toEqual([]);
  });

  it("rejects symlinked submissions directories before running Kaggle commands", async () => {
    await fs.symlink(
      path.join(workspaceRoot, "experiments", "exp-a"),
      path.join(workspaceRoot, "submissions"),
    );

    const runner = new RecordingRunner({ exitCode: 0, stdout: "submitted\n", stderr: "" });
    const tool = new KaggleSubmitTool(runner);
    const result = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      file: "submissions/submission.csv",
      message: "baseline",
      sandbox: false,
      quiet: false,
      timeoutMs: 10_000,
    }, makeContext(pulseedHome));

    expect(result.success).toBe(false);
    expect(result.error).toContain("must not be a symlink");
    expect(runner.calls).toEqual([]);
  });

  it("submits prepared CSVs using the documented Kaggle CLI args and requires approval", async () => {
    const prepare = new KaggleSubmissionPrepareTool();
    const prepared = await prepare.call({
      workspace: "titanic",
      competition: "titanic",
      source_file: "experiments/exp-a/submission.csv",
      selected_experiment_id: "exp-a",
      submission_id: "exp-a-public",
      output_filename: "exp-a-public.csv",
      message: "baseline",
    }, makeContext(pulseedHome));
    expect(prepared.success).toBe(true);

    const runner = new RecordingRunner({ exitCode: 0, stdout: "submitted\n", stderr: "" });
    const tool = new KaggleSubmitTool(runner);
    const permission = await tool.checkPermissions({
      workspace: "titanic",
      competition: "titanic",
      file: "submissions/exp-a-public.csv",
      message: "baseline",
      kernel: "owner/kernel",
      version: "3",
      sandbox: true,
      quiet: true,
      timeoutMs: 10_000,
    });
    expect(permission).toMatchObject({ status: "needs_approval" });
    expect(tool.metadata).toMatchObject({
      permissionLevel: "write_remote",
      isDestructive: true,
      requiresNetwork: true,
    });

    const result = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      file: "submissions/exp-a-public.csv",
      message: "baseline",
      kernel: "owner/kernel",
      version: "3",
      sandbox: true,
      quiet: true,
      timeoutMs: 10_000,
    }, makeContext(pulseedHome));

    expect(result.success).toBe(true);
    expect(runner.calls).toEqual([{
      command: "kaggle",
      cwd: workspaceRoot,
      args: [
        "competitions",
        "submit",
        "titanic",
        "-f",
        path.join(workspaceRoot, "submissions", "exp-a-public.csv"),
        "-m",
        "baseline",
        "-k",
        "owner/kernel",
        "-v",
        "3",
        "--sandbox",
        "-q",
      ],
    }]);
    expect(result.data).toMatchObject({
      prepared_metadata: { workspace_relative_path: "submissions/exp-a-public.json" },
      provenance: {
        selected_experiment_id: "exp-a",
        local_metrics: { metrics: { cv_score: 0.82 } },
      },
    });
  });

  it("does not run submit through ToolExecutor when operator approval is denied", async () => {
    const runner = new RecordingRunner({ exitCode: 0, stdout: "submitted\n", stderr: "" });
    const registry = new ToolRegistry();
    registry.register(new KaggleSubmitTool(runner));
    const executor = new ToolExecutor({
      registry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });

    const result = await executor.execute("kaggle_submit", {
      workspace: "titanic",
      competition: "titanic",
      file: "experiments/exp-a/submission.csv",
      message: "baseline",
    }, makeContext(pulseedHome));

    expect(result.success).toBe(false);
    expect(result.error).toContain("User denied approval");
    expect(runner.calls).toEqual([]);
  });

  it("lists submissions with the documented submissions args", async () => {
    const runner = new RecordingRunner({ exitCode: 0, stdout: "date,description,status\n", stderr: "" });
    const tool = new KaggleListSubmissionsTool(runner);
    const result = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      timeoutMs: 10_000,
    }, makeContext(pulseedHome));

    expect(result.success).toBe(true);
    expect(tool.metadata).toMatchObject({ permissionLevel: "read_metrics", isDestructive: false });
    expect(runner.calls).toEqual([{
      command: "kaggle",
      cwd: workspaceRoot,
      args: ["competitions", "submissions", "titanic", "-v", "-q"],
    }]);
  });

  it("lists submissions when the model passes the Kaggle runs root instead of the competition workspace", async () => {
    const runner = new RecordingRunner({ exitCode: 0, stdout: "date,description,status\n", stderr: "" });
    const tool = new KaggleListSubmissionsTool(runner);
    const result = await tool.call({
      workspace: path.join(pulseedHome, "kaggle-runs"),
      competition: "titanic",
      timeoutMs: 10_000,
    }, makeContext(pulseedHome));

    expect(result.success).toBe(true);
    expect(runner.calls).toEqual([{
      command: "kaggle",
      cwd: workspaceRoot,
      args: ["competitions", "submissions", "titanic", "-v", "-q"],
    }]);
  });

  it("stores leaderboard snapshots under the Kaggle workspace", async () => {
    const runner = new RecordingRunner({ exitCode: 0, stdout: "team,score\nA,0.9\n", stderr: "" });
    const tool = new KaggleLeaderboardSnapshotTool(runner);
    const result = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      snapshot_id: "public-1",
      timeoutMs: 10_000,
    }, makeContext(pulseedHome));

    expect(result.success).toBe(true);
    const data = result.data as {
      snapshot: { path: string; state_relative_path: string; workspace_relative_path: string };
    };
    expect(data.snapshot).toMatchObject({
      workspace_relative_path: "submissions/leaderboard/public-1.json",
      state_relative_path: "kaggle-runs/titanic/submissions/leaderboard/public-1.json",
    });
    expect(runner.calls).toEqual([{
      command: "kaggle",
      cwd: workspaceRoot,
      args: ["competitions", "leaderboard", "titanic", "-s", "-v", "-q"],
    }]);
    const snapshot = JSON.parse(await fs.readFile(data.snapshot.path, "utf-8")) as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      schema_version: "kaggle-leaderboard-snapshot-v1",
      competition: "titanic",
      snapshot_id: "public-1",
      stdout: "team,score\nA,0.9\n",
    });
  });

  it("rejects existing symlink leaves before writing leaderboard snapshots", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-kaggle-leaderboard-leaf-"));
    tmpDirs.push(outside);
    await fs.mkdir(path.join(workspaceRoot, "submissions", "leaderboard"), { recursive: true });
    await fs.writeFile(path.join(outside, "snapshot.json"), "outside\n");
    await fs.symlink(
      path.join(outside, "snapshot.json"),
      path.join(workspaceRoot, "submissions", "leaderboard", "public-escape.json"),
    );

    const runner = new RecordingRunner({ exitCode: 0, stdout: "team,score\nA,0.9\n", stderr: "" });
    const tool = new KaggleLeaderboardSnapshotTool(runner);
    const result = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      snapshot_id: "public-escape",
      timeoutMs: 10_000,
    }, makeContext(pulseedHome));

    expect(result.success).toBe(false);
    expect(result.error).toContain("must not be a symlink");
    expect(runner.calls).toEqual([]);
    await expect(fs.readFile(path.join(outside, "snapshot.json"), "utf-8")).resolves.toBe("outside\n");
  });
});
