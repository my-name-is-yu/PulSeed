import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateManager } from "../../../base/state/state-manager.js";
import { RuntimeSessionRegistry } from "../../../runtime/session-registry/index.js";
import { ProcessSessionStateStore } from "../../../runtime/store/process-session-state-store.js";
import {
  ProcessSessionManager,
  ProcessSessionReadTool,
  ProcessSessionStartTool,
  type ProcessSessionReadOutput,
  type ProcessSessionSnapshot,
} from "../../system/ProcessSessionTool/ProcessSessionTool.js";
import type { ToolCallContext } from "../../types.js";
import {
  LongRunningEvidenceSchema,
  RuntimeReportWriteTool,
  RuntimeResultNormalizeTool,
  WorkspaceImportTool,
  type RuntimeReportWriteOutput,
  type RuntimeResultNormalizeOutput,
  type WorkspaceImportOutput,
} from "../LongRunningRuntimeTools.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";

function makeContext(cwd: string): ToolCallContext {
  return {
    cwd,
    goalId: "goal-runtime",
    trustBalance: 0,
    preApproved: true,
    approvalFn: async () => true,
  };
}

async function readUntil(readTool: ProcessSessionReadTool, sessionId: string, expected: string): Promise<string> {
  let output = "";
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const read = await readTool.call({
      session_id: sessionId,
      waitMs: 100,
      maxChars: 4_000,
      consume: true,
    }, makeContext(process.cwd()));
    output += (read.data as ProcessSessionReadOutput).output;
    if (output.includes(expected)) return output;
  }
  return output;
}

describe("LongRunningRuntimeTools", () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env["PULSEED_HOME"];
    tmpHome = makeTempDir();
    process.env["PULSEED_HOME"] = tmpHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env["PULSEED_HOME"];
    } else {
      process.env["PULSEED_HOME"] = originalHome;
    }
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("normalizes loose command output and links durable report artifacts to a process session", async () => {
    const manager = new ProcessSessionManager();
    const startTool = new ProcessSessionStartTool(manager);
    const readTool = new ProcessSessionReadTool(manager);
    const normalizeTool = new RuntimeResultNormalizeTool();
    const reportTool = new RuntimeReportWriteTool(manager);
    const runDir = path.join(tmpHome, "dummy-run");
    const looseMetricsPath = path.join(runDir, "loose-metrics.json");
    const trainLogPath = path.join(runDir, "train.log");

    try {
      const start = await startTool.call({
        command: process.execPath,
        args: ["-e", [
          "const fs = require('fs');",
          "const path = require('path');",
          "const dir = process.argv[1];",
          "fs.mkdirSync(dir, { recursive: true });",
          "fs.writeFileSync(path.join(dir, 'train.log'), 'epoch=1 score=0.81\\n');",
          "fs.writeFileSync(path.join(dir, 'loose-metrics.json'), JSON.stringify({",
          "  status: 'completed',",
          "  balanced_accuracy: 0.8123,",
          "  cv_std: 0.01,",
          "  artifacts: { log: path.join(dir, 'train.log') }",
          "}, null, 2));",
          "console.log('dummy workflow done');",
        ].join(" "), runDir],
        label: "dummy-long-running-workflow",
        artifact_refs: [trainLogPath],
      }, makeContext(tmpHome));
      expect(start.success).toBe(true);
      const session = start.data as ProcessSessionSnapshot;

      await expect(readUntil(readTool, session.session_id, "dummy workflow done")).resolves.toContain("dummy workflow done");

      const normalized = await normalizeTool.call({
        objective: "Run a dummy long-running metric workflow",
        source_json_path: looseMetricsPath,
        profile: "kaggle_metrics",
        metric_name: "balanced_accuracy",
        metric_direction: "maximize",
        run_id: "dummy-runtime-run",
        process_session_id: session.session_id,
      }, makeContext(tmpHome));
      expect(normalized.success).toBe(true);
      const normalizedData = normalized.data as RuntimeResultNormalizeOutput;
      expect(normalizedData.result).toMatchObject({
        schema_version: "long-running-result-v1",
        status: "succeeded",
        evidence: [
          expect.objectContaining({
            kind: "metric",
            label: "balanced_accuracy",
            value: 0.8123,
            direction: "maximize",
          }),
          expect.objectContaining({
            kind: "metric",
            label: "balanced_accuracy_std",
            value: 0.01,
          }),
        ],
        next_action: expect.objectContaining({
          type: "continue",
        }),
      });

      const report = await reportTool.call({
        result_json_path: normalizedData.files.result,
        run_id: "dummy-runtime-run",
        process_session_id: session.session_id,
      }, makeContext(tmpHome));
      expect(report.success).toBe(true);
      const reportData = report.data as RuntimeReportWriteOutput;
      await expect(fs.readFile(reportData.files.summary, "utf8")).resolves.toContain("## Next Action");
      await expect(fs.readFile(reportData.files.next_action, "utf8")).resolves.toContain("long-running-next-action-v1");
      const postLinkRead = await readTool.call({
        session_id: session.session_id,
        waitMs: 0,
        maxChars: 128,
        consume: false,
      }, makeContext(tmpHome));
      expect(postLinkRead.success).toBe(true);

      const processSnapshot = await new ProcessSessionStateStore(tmpHome).loadSnapshot(session.session_id);
      expect(processSnapshot?.artifactRefs).toEqual(expect.arrayContaining([
        trainLogPath,
        reportData.files.summary,
        reportData.files.result,
        reportData.files.next_action,
      ]));

      const stateManager = new StateManager(tmpHome, undefined, { walEnabled: false });
      const registrySnapshot = await new RuntimeSessionRegistry({ stateManager }).snapshot();
      const run = registrySnapshot.background_runs.find((candidate) => candidate.id === `run:process:${session.session_id}`);
      expect(run).toMatchObject({
        kind: "process_run",
        status: "succeeded",
        artifacts: expect.arrayContaining([
          expect.objectContaining({ label: "summary.md", kind: "report" }),
          expect.objectContaining({ label: "result.json", kind: "metrics" }),
          expect.objectContaining({ label: "next-action.json", kind: "other" }),
        ]),
      });
    } finally {
      await manager.stopAll();
    }
  });

  it("links durable report artifacts to a persisted process session after manager restart", async () => {
    const sessionId = "persisted-process-session";
    const store = new ProcessSessionStateStore(tmpHome);
    await store.saveSnapshot({
      session_id: sessionId,
      label: "persisted workflow",
      command: process.execPath,
      args: ["-e", "console.log('done')"],
      cwd: tmpHome,
      goal_id: "goal-runtime",
      task_id: "task-runtime",
      strategy_id: "strategy-runtime",
      running: false,
      exitCode: 0,
      signal: null,
      startedAt: "2026-05-10T00:00:00.000Z",
      exitedAt: "2026-05-10T00:01:00.000Z",
      bufferedChars: 128,
      artifactRefs: ["existing.log"],
    });
    const reportTool = new RuntimeReportWriteTool(new ProcessSessionManager());

    const report = await reportTool.call({
      objective: "Summarize a restarted workflow",
      status: "succeeded",
      next_action: {
        type: "continue",
        summary: "Review the persisted workflow report.",
      },
      run_id: "persisted-runtime-run",
      process_session_id: sessionId,
    }, makeContext(tmpHome));

    expect(report.success).toBe(true);
    const reportData = report.data as RuntimeReportWriteOutput;
    expect(reportData.warnings).toEqual([]);
    const processSnapshot = await store.loadSnapshot(sessionId);
    expect(processSnapshot?.artifactRefs).toEqual(expect.arrayContaining([
      "existing.log",
      reportData.files.summary,
      reportData.files.result,
      reportData.files.next_action,
    ]));
  });

  it("imports a workspace into PulSeed state and rejects symlink escapes", async () => {
    const source = path.join(tmpHome, "external-workspace");
    await fs.mkdir(path.join(source, "data"), { recursive: true });
    await fs.writeFile(path.join(source, "data", "raw.csv"), "id,value\n1,ok\n", "utf8");
    const tool = new WorkspaceImportTool();

    const imported = await tool.call({
      overwrite: false,
      source_path: source,
      workspace_id: "demo-workspace",
    }, makeContext(tmpHome));
    expect(imported.success).toBe(true);
    const importedData = imported.data as WorkspaceImportOutput;
    expect(importedData.workspace.state_relative_path).toBe("runtime/workspaces/imports/demo-workspace");
    await expect(fs.readFile(path.join(importedData.workspace.path, "data", "raw.csv"), "utf8")).resolves.toContain("ok");

    await fs.symlink(path.join(tmpHome, "outside"), path.join(source, "escape-link"));
    const rejected = await tool.call({
      overwrite: false,
      source_path: source,
      workspace_id: "demo-workspace-with-link",
    }, makeContext(tmpHome));
    expect(rejected.success).toBe(false);
    expect(rejected.error).toContain("symlink");
  });

  it("preserves canonical succeeded status during normalization", async () => {
    const tool = new RuntimeResultNormalizeTool();

    const normalized = await tool.call({
      objective: "Accept already-canonical runtime status",
      profile: "generic",
      value: {
        status: "succeeded",
        metrics: {
          balanced_accuracy: 0.91,
        },
      },
      run_id: "canonical-succeeded-run",
    }, makeContext(tmpHome));

    expect(normalized.success).toBe(true);
    const data = normalized.data as RuntimeResultNormalizeOutput;
    expect(data.result).toMatchObject({
      status: "succeeded",
      next_action: expect.objectContaining({
        type: "continue",
      }),
      evidence: [
        expect.objectContaining({
          kind: "metric",
          label: "balanced_accuracy",
          value: 0.91,
        }),
      ],
    });
  });

  it("rejects non-finite evidence values instead of persisting JSON null metrics", async () => {
    expect(LongRunningEvidenceSchema.safeParse({
      kind: "metric",
      label: "score",
      value: Number.POSITIVE_INFINITY,
    }).success).toBe(false);

    const tool = new RuntimeResultNormalizeTool();
    const normalized = await tool.call({
      objective: "Reject non-finite metric",
      profile: "generic",
      value: {
        metrics: {
          score: Number.POSITIVE_INFINITY,
        },
      },
      run_id: "non-finite-metric",
    }, makeContext(tmpHome));

    expect(normalized.success).toBe(false);
    expect(normalized.error).toContain("Failed to normalize long-running result");
    await expect(fs.access(path.join(tmpHome, "runtime", "artifacts", "non-finite-metric", "result.json"))).rejects.toThrow();
  });
});
