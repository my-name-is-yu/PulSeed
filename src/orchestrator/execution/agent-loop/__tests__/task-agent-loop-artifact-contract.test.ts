import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { Task } from "../../../../base/types/task.js";
import {
  buildTaskAgentLoopTurnContext,
  createAgentLoopSession,
  defaultAgentLoopCapabilities,
  type AgentLoopModelInfo,
} from "../index.js";

function makeModelInfo(options: { toolCalling?: boolean } = {}): AgentLoopModelInfo {
  return {
    ref: { providerId: "test", modelId: "model" },
    displayName: "test/model",
    capabilities: {
      ...defaultAgentLoopCapabilities,
      ...(typeof options.toolCalling === "boolean" ? { toolCalling: options.toolCalling } : {}),
    },
  };
}

function makeKaggleArtifactTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["score"],
    primary_dimension: "score",
    work_description: "Run Kaggle training and produce metrics plus submission artifacts",
    rationale: "Fresh artifacts are required to prove score progress.",
    approach: "Run the local experiment and write reports/metrics plus submissions.",
    success_criteria: [
      {
        description: "Training script exists",
        verification_method: "test -f src/experiments/train_hgb_engineered_auc.py",
        is_blocking: true,
      },
    ],
    scope_boundary: { in_scope: ["."], out_of_scope: [], blast_radius: "low" },
    constraints: [],
    artifact_contract: {
      required: true,
      required_artifacts: [
        {
          kind: "metrics_json",
          path: "reports/hgb_seed_blend.json",
          required_fields: ["balanced_accuracy"],
          fresh_after_task_start: true,
        },
        {
          kind: "submission_csv",
          path: "submissions/hgb_seed_blend.csv",
          required_fields: [],
          fresh_after_task_start: true,
        },
      ],
    },
    plateau_until: null,
    estimated_duration: { value: 1, unit: "hours" },
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("task agent loop artifact contract completion gate", () => {
  it("passes the exact artifact contract into the production task prompt", () => {
    const modelInfo = makeModelInfo();
    const turn = buildTaskAgentLoopTurnContext({
      task: makeKaggleArtifactTask({
        artifact_contract: {
          required: true,
          required_artifacts: [
            {
              kind: "metrics_json",
              path: "reports/hgb_lap_context_auc.json",
              required_fields: ["roc_auc", "engineered_features", "output_paths"],
              field_types: {
                roc_auc: "number",
                engineered_features: "array",
                output_paths: "object",
              },
              fresh_after_task_start: true,
            },
            {
              kind: "submission_csv",
              path: "submissions/hgb_lap_context_auc.csv",
              required_fields: ["id", "PitNextLap"],
              fresh_after_task_start: true,
            },
          ],
        },
      }),
      model: modelInfo.ref,
      modelInfo,
      session: createAgentLoopSession(),
      cwd: process.cwd(),
    });

    const taskPrompt = turn.messages.find((message) => message.role === "user")?.content ?? "";
    expect(taskPrompt).toContain("Artifact contract:");
    expect(taskPrompt).toContain('"required_fields"');
    expect(taskPrompt).toContain('"engineered_features"');
    expect(taskPrompt).toContain("metrics writer must emit those exact keys");
  });

  it("rejects done when required metrics and submission artifacts are missing", async () => {
    const modelInfo = makeModelInfo();
    const turn = buildTaskAgentLoopTurnContext({
      task: makeKaggleArtifactTask(),
      model: modelInfo.ref,
      modelInfo,
      session: createAgentLoopSession(),
      cwd: process.cwd(),
    });

    const result = await turn.completionValidator!({
      output: {
        status: "done",
        finalAnswer: "Implemented the training script.",
        summary: "script only",
        filesChanged: ["src/experiments/train_hgb_engineered_auc.py"],
        testsRun: [{ command: "test -f src/experiments/train_hgb_engineered_auc.py", passed: true, outputSummary: "exists" }],
        completionEvidence: ["script exists"],
        verificationHints: [],
        blockers: [],
      },
      changedFiles: ["src/experiments/train_hgb_engineered_auc.py"],
      commandResults: [{
        toolName: "shell_command",
        command: "test -f src/experiments/train_hgb_engineered_auc.py",
        cwd: process.cwd(),
        success: true,
        category: "verification",
        evidenceEligible: true,
        outputSummary: "exists",
        durationMs: 1,
      }],
      toolResults: [],
      calledTools: ["shell_command"],
      modelTurns: 2,
      toolCalls: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.reasons.join("\n")).toContain("Artifact contract verification failed");
    expect(result.reasons.join("\n")).toContain("reports/hgb_seed_blend.json is missing");
    expect(result.reasons.join("\n")).toContain("submissions/hgb_seed_blend.csv is missing");
  });

  it("rejects done when artifact evidence is required but no artifacts are declared", async () => {
    const modelInfo = makeModelInfo();
    const turn = buildTaskAgentLoopTurnContext({
      task: makeKaggleArtifactTask({
        artifact_contract: { required: true, required_artifacts: [] },
      }),
      model: modelInfo.ref,
      modelInfo,
      session: createAgentLoopSession(),
      cwd: process.cwd(),
    });

    const result = await turn.completionValidator!({
      output: {
        status: "done",
        finalAnswer: "Implemented the training script.",
        summary: "script only",
        filesChanged: [],
        testsRun: [{ command: "test -f src/experiments/train_hgb_engineered_auc.py", passed: true, outputSummary: "exists" }],
        completionEvidence: ["script exists"],
        verificationHints: [],
        blockers: [],
      },
      changedFiles: [],
      commandResults: [{
        toolName: "shell_command",
        command: "test -f src/experiments/train_hgb_engineered_auc.py",
        cwd: process.cwd(),
        success: true,
        category: "verification",
        evidenceEligible: true,
        outputSummary: "exists",
        durationMs: 1,
      }],
      toolResults: [],
      calledTools: ["shell_command"],
      modelTurns: 2,
      toolCalls: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.reasons.join("\n")).toContain("no required_artifacts were declared");
  });

  it("rejects done when goal constraints require artifacts but the task contract opted out", async () => {
    const modelInfo = makeModelInfo();
    const turn = buildTaskAgentLoopTurnContext({
      task: makeKaggleArtifactTask({
        artifact_contract: { required: false, required_artifacts: [] },
      }),
      artifactGoal: { constraints: ["run_spec_profile:kaggle"] },
      model: modelInfo.ref,
      modelInfo,
      session: createAgentLoopSession(),
      cwd: process.cwd(),
    });

    const result = await turn.completionValidator!({
      output: {
        status: "done",
        finalAnswer: "Implemented the training script.",
        summary: "script only",
        filesChanged: [],
        testsRun: [{ command: "test -f src/experiments/train_hgb_engineered_auc.py", passed: true, outputSummary: "exists" }],
        completionEvidence: ["script exists"],
        verificationHints: [],
        blockers: [],
      },
      changedFiles: [],
      commandResults: [{
        toolName: "shell_command",
        command: "test -f src/experiments/train_hgb_engineered_auc.py",
        cwd: process.cwd(),
        success: true,
        category: "verification",
        evidenceEligible: true,
        outputSummary: "exists",
        durationMs: 1,
      }],
      toolResults: [],
      calledTools: ["shell_command"],
      modelTurns: 2,
      toolCalls: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.reasons.join("\n")).toContain("no required_artifacts were declared");
  });

  it("rejects done when a required contract declares metrics but no submission artifact", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-agentloop-artifacts-"));
    try {
      const metricsPath = path.join(workspace, "reports", "hgb_seed_blend.json");
      fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
      fs.writeFileSync(metricsPath, JSON.stringify({ balanced_accuracy: 0.95 }), "utf8");
      const modelInfo = makeModelInfo();
      const turn = buildTaskAgentLoopTurnContext({
        task: makeKaggleArtifactTask({
          success_criteria: [
            {
              description: "Metrics artifact exists",
              verification_method: "test -f reports/hgb_seed_blend.json",
              is_blocking: true,
            },
          ],
          artifact_contract: {
            required: true,
            required_artifacts: [
              {
                kind: "metrics_json",
                path: "reports/hgb_seed_blend.json",
                required_fields: ["balanced_accuracy"],
                fresh_after_task_start: true,
              },
            ],
          },
        }),
        artifactGoal: { constraints: ["run_spec_profile:kaggle"] },
        model: modelInfo.ref,
        modelInfo,
        session: createAgentLoopSession(),
        cwd: workspace,
      });

      const result = await turn.completionValidator!({
        output: {
          status: "done",
          finalAnswer: "Produced a fresh metrics JSON.",
          summary: "metrics only",
          filesChanged: ["reports/hgb_seed_blend.json"],
          testsRun: [{ command: "test -f reports/hgb_seed_blend.json", passed: true, outputSummary: "exists" }],
          completionEvidence: ["fresh metrics json exists"],
          verificationHints: [],
          blockers: [],
        },
        changedFiles: ["reports/hgb_seed_blend.json"],
        commandResults: [{
          toolName: "shell_command",
          command: "test -f reports/hgb_seed_blend.json",
          cwd: workspace,
          success: true,
          category: "verification",
          evidenceEligible: true,
          outputSummary: "exists",
          durationMs: 1,
        }],
        toolResults: [],
        calledTools: ["shell_command"],
        modelTurns: 2,
        toolCalls: 1,
      });

      expect(result.ok).toBe(false);
      expect(result.reasons.join("\n")).toContain("missing required artifact kind(s): submission_csv");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("allows a typed blocked result without artifact evidence", async () => {
    const modelInfo = makeModelInfo();
    const turn = buildTaskAgentLoopTurnContext({
      task: makeKaggleArtifactTask(),
      model: modelInfo.ref,
      modelInfo,
      session: createAgentLoopSession(),
      cwd: process.cwd(),
    });

    const result = await turn.completionValidator!({
      output: {
        status: "blocked",
        finalAnswer: "Experiment execution could not run.",
        summary: "blocked",
        filesChanged: [],
        testsRun: [],
        completionEvidence: [],
        verificationHints: [],
        blockers: ["local Kaggle data is unavailable"],
      },
      changedFiles: [],
      commandResults: [],
      toolResults: [],
      calledTools: [],
      modelTurns: 1,
      toolCalls: 0,
    });

    expect(result).toEqual({ ok: true, reasons: [] });
  });

  it("allows fresh artifact contract evidence to verify changed files for non-native tool clients", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-agentloop-artifact-non-native-"));
    try {
      const startedAt = new Date(Date.now() - 2_000).toISOString();
      const metricsPath = path.join(workspace, "reports", "hgb_seed_blend.json");
      const submissionPath = path.join(workspace, "submissions", "hgb_seed_blend.csv");
      fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
      fs.mkdirSync(path.dirname(submissionPath), { recursive: true });
      fs.writeFileSync(metricsPath, JSON.stringify({ balanced_accuracy: 0.95 }), "utf8");
      fs.writeFileSync(submissionPath, "id,PitNextLap\n1,0.1\n", "utf8");

      const modelInfo = makeModelInfo({ toolCalling: false });
      const turn = buildTaskAgentLoopTurnContext({
        task: makeKaggleArtifactTask({
          created_at: startedAt,
          started_at: startedAt,
        }),
        model: modelInfo.ref,
        modelInfo,
        session: createAgentLoopSession(),
        cwd: workspace,
      });

      const result = await turn.completionValidator!({
        output: {
          status: "done",
          finalAnswer: "Produced fresh metrics and submission artifacts.",
          summary: "fresh artifacts",
          filesChanged: ["reports/hgb_seed_blend.json", "submissions/hgb_seed_blend.csv"],
          testsRun: [],
          completionEvidence: ["fresh artifact contract satisfied"],
          verificationHints: [],
          blockers: [],
        },
        changedFiles: ["reports/hgb_seed_blend.json", "submissions/hgb_seed_blend.csv"],
        commandResults: [],
        toolResults: [],
        calledTools: [],
        modelTurns: 2,
        toolCalls: 0,
      });

      expect(result).toEqual({ ok: true, reasons: [] });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("allows external agent completion evidence to defer changed-file proof to task verification", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-agentloop-external-evidence-"));
    try {
      const reportPath = path.join(workspace, "reports", "final-schema.json");
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(
        reportPath,
        JSON.stringify({ scenario: "agentloop-final-output-schema", ok: true }),
        "utf8",
      );
      const modelInfo = makeModelInfo({ toolCalling: false });
      const turn = buildTaskAgentLoopTurnContext({
        task: makeKaggleArtifactTask({
          work_description: "Create reports/final-schema.json and verify it with Node.",
          success_criteria: [
            {
              description: "Final schema report exists",
              verification_method:
                "node -e \"const fs=require('fs'); const x=JSON.parse(fs.readFileSync('reports/final-schema.json','utf8')); if(x.scenario!=='agentloop-final-output-schema'||x.ok!==true) process.exit(1)\"",
              is_blocking: true,
            },
          ],
          artifact_contract: { required: false, required_artifacts: [] },
        }),
        model: modelInfo.ref,
        modelInfo,
        session: createAgentLoopSession(),
        cwd: workspace,
      });

      const result = await turn.completionValidator!({
        output: {
          status: "done",
          finalAnswer: "Created and verified reports/final-schema.json.",
          summary: "final schema artifact created",
          filesChanged: [],
          testsRun: [],
          completionEvidence: [
            "node -e \"const fs=require('fs'); const x=JSON.parse(fs.readFileSync('reports/final-schema.json','utf8')); if(x.scenario!=='agentloop-final-output-schema'||x.ok!==true) process.exit(1)\" exited successfully",
          ],
          verificationHints: [],
          blockers: [],
        },
        changedFiles: ["reports/final-schema.json"],
        commandResults: [],
        toolResults: [],
        calledTools: [],
        modelTurns: 4,
        toolCalls: 0,
      });

      expect(result).toEqual({ ok: true, reasons: [] });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("allows an explicit non-numeric JSON artifact contract when required fields and types match", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-agentloop-typed-json-contract-"));
    try {
      const reportPath = path.join(workspace, "reports", "final-schema.json");
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(
        reportPath,
        JSON.stringify({ scenario: "agentloop-final-output-schema", ok: true }),
        "utf8",
      );

      const modelInfo = makeModelInfo({ toolCalling: false });
      const turn = buildTaskAgentLoopTurnContext({
        task: makeKaggleArtifactTask({
          created_at: "2020-01-01T00:00:00.000Z",
          started_at: "2020-01-01T00:00:00.000Z",
          work_description: "Create reports/final-schema.json with typed non-numeric fields.",
          success_criteria: [
            {
              description: "Final schema report exists",
              verification_method:
                "node -e \"const fs=require('fs'); const x=JSON.parse(fs.readFileSync('reports/final-schema.json','utf8')); if(x.scenario!=='agentloop-final-output-schema'||x.ok!==true) process.exit(1)\"",
              is_blocking: true,
            },
          ],
          artifact_contract: {
            required: true,
            required_artifacts: [
              {
                kind: "metrics_json",
                path: "reports/final-schema.json",
                required_fields: ["scenario", "ok"],
                field_types: { ok: "boolean" },
                fresh_after_task_start: true,
              },
            ],
          },
        }),
        model: modelInfo.ref,
        modelInfo,
        session: createAgentLoopSession(),
        cwd: workspace,
      });

      const result = await turn.completionValidator!({
        output: {
          status: "done",
          finalAnswer: "Created and verified reports/final-schema.json.",
          summary: "typed json artifact created",
          filesChanged: ["reports/final-schema.json"],
          testsRun: [],
          completionEvidence: ["typed final-schema artifact contract satisfied"],
          verificationHints: [],
          blockers: [],
        },
        changedFiles: ["reports/final-schema.json"],
        commandResults: [],
        toolResults: [],
        calledTools: [],
        modelTurns: 4,
        toolCalls: 0,
      });

      expect(result).toEqual({ ok: true, reasons: [] });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("still rejects stale artifact contract evidence for non-native tool clients", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-agentloop-artifact-stale-"));
    try {
      const startedAt = new Date(Date.now() - 2_000).toISOString();
      const stale = new Date(Date.now() - 60_000);
      const metricsPath = path.join(workspace, "reports", "hgb_seed_blend.json");
      const submissionPath = path.join(workspace, "submissions", "hgb_seed_blend.csv");
      fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
      fs.mkdirSync(path.dirname(submissionPath), { recursive: true });
      fs.writeFileSync(metricsPath, JSON.stringify({ balanced_accuracy: 0.95 }), "utf8");
      fs.writeFileSync(submissionPath, "id,PitNextLap\n1,0.1\n", "utf8");
      fs.utimesSync(metricsPath, stale, stale);

      const modelInfo = makeModelInfo({ toolCalling: false });
      const turn = buildTaskAgentLoopTurnContext({
        task: makeKaggleArtifactTask({
          created_at: startedAt,
          started_at: startedAt,
        }),
        model: modelInfo.ref,
        modelInfo,
        session: createAgentLoopSession(),
        cwd: workspace,
      });

      const result = await turn.completionValidator!({
        output: {
          status: "done",
          finalAnswer: "Produced metrics and submission artifacts.",
          summary: "stale metrics",
          filesChanged: ["reports/hgb_seed_blend.json", "submissions/hgb_seed_blend.csv"],
          testsRun: [],
          completionEvidence: ["artifact contract claimed"],
          verificationHints: [],
          blockers: [],
        },
        changedFiles: ["reports/hgb_seed_blend.json", "submissions/hgb_seed_blend.csv"],
        commandResults: [],
        toolResults: [],
        calledTools: [],
        modelTurns: 2,
        toolCalls: 0,
      });

      expect(result.ok).toBe(false);
      expect(result.reasons.join("\n")).toContain("reports/hgb_seed_blend.json is stale relative to task start");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("allows required metrics fields that are arrays or objects while enforcing declared field types", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-agentloop-artifact-types-"));
    try {
      const metricsPath = path.join(workspace, "reports", "group_target_encoding_auc.json");
      const submissionPath = path.join(workspace, "submissions", "group_target_encoding_auc.csv");
      fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
      fs.mkdirSync(path.dirname(submissionPath), { recursive: true });
      fs.writeFileSync(metricsPath, JSON.stringify({
        roc_auc: 0.531,
        fold_roc_auc: [0.5, 0.56, 0.51],
        target_encoding_features: ["te_Driver"],
        model_params: { max_iter: 5 },
        output_paths: { metrics_json: "reports/group_target_encoding_auc.json" },
      }), "utf8");
      fs.writeFileSync(submissionPath, "id,PitNextLap\n1,0.1\n", "utf8");

      const modelInfo = makeModelInfo();
      const turn = buildTaskAgentLoopTurnContext({
        task: makeKaggleArtifactTask({
          created_at: "2020-01-01T00:00:00.000Z",
          started_at: "2020-01-01T00:00:00.000Z",
          success_criteria: [
            {
              description: "Metrics artifact exists",
              verification_method: "test -f reports/group_target_encoding_auc.json",
              is_blocking: true,
            },
          ],
          artifact_contract: {
            required: true,
            required_artifacts: [
              {
                kind: "metrics_json",
                path: "reports/group_target_encoding_auc.json",
                required_fields: ["roc_auc", "fold_roc_auc", "target_encoding_features", "model_params", "output_paths"],
                field_types: {
                  roc_auc: "number",
                  fold_roc_auc: "array",
                  target_encoding_features: "array",
                  model_params: "object",
                  output_paths: "object",
                },
                fresh_after_task_start: true,
              },
              {
                kind: "submission_csv",
                path: "submissions/group_target_encoding_auc.csv",
                required_fields: [],
                fresh_after_task_start: true,
              },
            ],
          },
        }),
        model: modelInfo.ref,
        modelInfo,
        session: createAgentLoopSession(),
        cwd: workspace,
      });

      const result = await turn.completionValidator!({
        output: {
          status: "done",
          finalAnswer: "Produced fresh metrics and submission artifacts.",
          summary: "fresh artifacts",
          filesChanged: ["reports/group_target_encoding_auc.json"],
          testsRun: [],
          completionEvidence: ["contract check passed"],
          verificationHints: [],
          blockers: [],
        },
        changedFiles: ["reports/group_target_encoding_auc.json"],
        commandResults: [{
          toolName: "shell_command",
          command: "test -f reports/group_target_encoding_auc.json",
          cwd: workspace,
          success: true,
          category: "verification",
          evidenceEligible: true,
          outputSummary: "exists",
          durationMs: 1,
        }],
        toolResults: [],
        calledTools: ["shell_command"],
        modelTurns: 2,
        toolCalls: 1,
      });

      expect(result).toEqual({ ok: true, reasons: [] });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
