import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod/v3";
import { StateManager } from "../../../base/state/state-manager.js";
import { SessionManager } from "../session-manager.js";
import { TrustManager } from "../../../platform/traits/trust-manager.js";
import { StrategyManager } from "../../strategy/strategy-manager.js";
import { StallDetector } from "../../../platform/drive/stall-detector.js";
import { AdapterRegistry, TaskLifecycle } from "../task/task-lifecycle.js";
import type { Task } from "../../../base/types/task.js";
import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
} from "../../../base/llm/llm-client.js";
import type { ToolExecutor } from "../../../tools/executor.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { makeDimension, makeGoal } from "../../../../tests/helpers/fixtures.js";

// ─── Spy LLM Client ───

function createSpyLLMClient(responses: string[]): ILLMClient & { calls: Array<{ messages: LLMMessage[]; options?: LLMRequestOptions }> } {
  let callIndex = 0;
  const calls: Array<{ messages: LLMMessage[]; options?: LLMRequestOptions }> = [];
  return {
    calls,
    async sendMessage(
      messages: LLMMessage[],
      options?: LLMRequestOptions
    ): Promise<LLMResponse> {
      calls.push({ messages, options });
      return {
        content: responses[callIndex++] ?? "",
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
      const match = content.match(/```json\n?([\s\S]*?)\n?```/) || [
        null,
        content,
      ];
      return schema.parse(JSON.parse(match[1] ?? content));
    },
  };
}

// ─── Fixtures ───

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["dim"],
    primary_dimension: "dim",
    work_description: "test task",
    rationale: "test rationale",
    approach: "test approach",
    success_criteria: [
      {
        description: "Tests pass",
        verification_method: "npx vitest run",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["module A"],
      out_of_scope: ["module B"],
      blast_radius: "low",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: { value: 2, unit: "hours" },
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

function makeExecutionResult(
  overrides: Partial<import("../task/task-lifecycle.js").AgentResult> = {}
): import("../task/task-lifecycle.js").AgentResult {
  return {
    success: true,
    output: "Task completed: all tests pass",
    error: null,
    exit_code: 0,
    elapsed_ms: 100,
    stopped_reason: "completed",
    ...overrides,
  };
}

function makePassingAdapterRegistry(adapterType = "openai_codex_cli"): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register({
    adapterType,
    async execute() {
      return {
        success: true,
        output: "mechanical verification passed",
        error: null,
        exit_code: 0,
        elapsed_ms: 1,
        stopped_reason: "completed",
      };
    },
  });
  return registry;
}

// LLM responses for verification
const LLM_REVIEW_PASS = '{"verdict": "pass", "reasoning": "All criteria satisfied", "criteria_met": 1, "criteria_total": 1}';
const LLM_REVIEW_FAIL = '{"verdict": "fail", "reasoning": "Criteria not met", "criteria_met": 0, "criteria_total": 1}';
const LLM_REVIEW_PARTIAL = '{"verdict": "partial", "reasoning": "Some criteria met", "criteria_met": 1, "criteria_total": 2}';

// ─── Test Suite ───

describe("TaskLifecycle", async () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let sessionManager: SessionManager;
  let trustManager: TrustManager;
  let strategyManager: StrategyManager;
  let stallDetector: StallDetector;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    sessionManager = new SessionManager(stateManager);
    trustManager = new TrustManager(stateManager);
    stallDetector = new StallDetector(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
  });

  function createLifecycle(
    llmClient: ILLMClient,
    options?: {
      approvalFn?: (task: Task) => Promise<boolean>;
      logger?: import("../../../runtime/logger.js").Logger;
      adapterRegistry?: import("../task/task-lifecycle.js").AdapterRegistry | null;
      execFileSyncFn?: (cmd: string, args: string[], opts: { cwd: string; encoding: "utf-8" }) => string;
      toolExecutor?: ToolExecutor;
      revertCwd?: string;
    }
  ): TaskLifecycle {
    strategyManager = new StrategyManager(stateManager, llmClient);
    const hasAdapterRegistryOption = options
      ? Object.prototype.hasOwnProperty.call(options, "adapterRegistry")
      : false;
    const adapterRegistry = hasAdapterRegistryOption
      ? options?.adapterRegistry ?? undefined
      : makePassingAdapterRegistry();
    return new TaskLifecycle(
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      { ...options, adapterRegistry }
    );
  }

  // ─────────────────────────────────────────────
  // verifyTask
  // ─────────────────────────────────────────────

  describe("verifyTask", async () => {
    it("L1 pass + L2 pass results in verdict pass", async () => {
      // L1 mechanical verification (no LLM, uses prefix check) + L2 LLM review
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask(); // has "npx vitest run" → L1 applicable, MVP pass
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("pass");
    });

    it("trusts verified completion artifacts instead of model self-report for ARC scorecards", async () => {
      const runDir = path.join(tmpDir, "arc-agi-3", "runs", "run-arc");
      fs.mkdirSync(runDir, { recursive: true });
      const now = new Date().toISOString();
      const runPath = path.join(runDir, "run.json");
      fs.writeFileSync(runPath, JSON.stringify({
        schema_version: "pulseed.arc_agi_3.run/v1",
        claim_mode: "community_online_scorecard",
        run_id: "run-arc",
        mode: "online_api",
        game_id: "ft09-0d8bbf25",
        model_provider: "openai",
        model_id: "gpt-5.5",
        pulseed_commit: "commit-1",
        tool_policy_version: "arc-agi-3-tool-policy-v1",
        created_at: now,
        updated_at: now,
        card_id: "card-arc",
        guid: "guid-arc",
        replay_url: "https://arcprize.org/scorecards/card-arc",
        action_count: 2,
        reset_count: 1,
        submitted_action_log: [{
          at: now,
          action: "RESET",
          state_after: "NOT_FINISHED",
          levels_completed_after: 0,
          available_actions_after: [1],
          reasoning_provided: false,
        }],
        latest_snapshot: {
          game_id: "ft09-0d8bbf25",
          guid: "guid-arc",
          frame: [[[0]]],
          state: "NOT_FINISHED",
          levels_completed: 0,
          win_levels: 254,
          action_input: {},
          available_actions: [1],
        },
        official_scorecard_id: "card-arc",
        official_score: 0,
        scorecard: { card_id: "card-arc", score: 0, total_actions: 2 },
        model_turns: null,
        tool_calls: null,
        token_usage: null,
        cost: null,
        failure_reason: null,
      }), "utf8");

      const llm = createSpyLLMClient([LLM_REVIEW_FAIL]);
      const lifecycle = createLifecycle(llm, { adapterRegistry: null });
      const task = makeTask({
        constraints: ["run_spec_profile:arc_agi_3"],
        target_dimensions: ["official_score"],
        primary_dimension: "official_score",
        work_description: "Run ARC-AGI-3 and finish the scorecard.",
        artifact_contract: { required: false, required_artifacts: [] },
      });
      const verification = await lifecycle.verifyTask(task, makeExecutionResult({
        success: false,
        output: "Agent loop stopped before final JSON.",
        error: "model stream failed",
        stopped_reason: "error",
        completionArtifacts: [{ path: runPath, sourceTool: "arc_agi3_finish" }],
        agentLoop: {
          traceId: "trace-1",
          sessionId: "session-1",
          turnId: "turn-1",
          stopReason: "fatal_error",
          modelTurns: 1,
          toolCalls: 3,
          compactions: 0,
          completionArtifacts: [{ path: runPath, sourceTool: "arc_agi3_finish" }],
        },
      }));

      expect(verification.verdict).toBe("pass");
      expect(verification.completion_artifact_status).toMatchObject({
        applicable: true,
        passed: true,
      });
      expect(verification.evidence[0]?.description).toContain("ARC-AGI-3 completion artifact verified");
      expect(llm.calls).toHaveLength(0);
    });

    it("treats incomplete completion artifacts as hard mechanical failures", async () => {
      const runDir = path.join(tmpDir, "arc-agi-3", "runs", "run-incomplete");
      fs.mkdirSync(runDir, { recursive: true });
      const now = new Date().toISOString();
      const runPath = path.join(runDir, "run.json");
      fs.writeFileSync(runPath, JSON.stringify({
        schema_version: "pulseed.arc_agi_3.run/v1",
        claim_mode: "community_online_scorecard",
        run_id: "run-incomplete",
        mode: "online_api",
        game_id: "ft09-0d8bbf25",
        model_provider: "openai",
        model_id: "gpt-5.5",
        pulseed_commit: "commit-1",
        tool_policy_version: "arc-agi-3-tool-policy-v1",
        created_at: now,
        updated_at: now,
        card_id: "card-incomplete",
        guid: "guid-incomplete",
        replay_url: "https://arcprize.org/scorecards/card-incomplete",
        action_count: 2,
        reset_count: 1,
        submitted_action_log: [{
          at: now,
          action: "RESET",
          state_after: "NOT_FINISHED",
          levels_completed_after: 0,
          available_actions_after: [1],
          reasoning_provided: false,
        }],
        latest_snapshot: {
          game_id: "ft09-0d8bbf25",
          guid: "guid-incomplete",
          frame: [[[0]]],
          state: "NOT_FINISHED",
          levels_completed: 0,
          win_levels: 254,
          action_input: {},
          available_actions: [1],
        },
        official_scorecard_id: "card-incomplete",
        official_score: null,
        scorecard: null,
        model_turns: null,
        tool_calls: null,
        token_usage: null,
        cost: null,
        failure_reason: "scorecard close failed",
      }), "utf8");

      const llm = createSpyLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm, { adapterRegistry: null });
      const task = makeTask({
        constraints: ["run_spec_profile:arc_agi_3"],
        target_dimensions: ["official_score"],
        primary_dimension: "official_score",
        work_description: "Run ARC-AGI-3 and finish the scorecard.",
        artifact_contract: { required: false, required_artifacts: [] },
      });
      const verification = await lifecycle.verifyTask(task, makeExecutionResult({
        success: true,
        output: "I finished the run.",
        completionArtifacts: [{ path: runPath, sourceTool: "arc_agi3_start" }],
      }));

      expect(verification.verdict).toBe("fail");
      expect(verification.completion_artifact_status).toMatchObject({
        applicable: true,
        passed: false,
      });
      expect(verification.evidence[0]?.description).toContain("scorecard close failed");
      expect(llm.calls).toHaveLength(0);
    });

    it("fails artifact-contracted Kaggle progress when only source markers exist", async () => {
      const workspace = path.join(tmpDir, "kaggle-workspace");
      fs.mkdirSync(path.join(workspace, "src", "experiments"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, "src", "experiments", "train_hgb_engineered_auc.py"),
        "print('training script only')\n"
      );
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm, { adapterRegistry: null });
      const task = makeTask({
        work_description: "Run Kaggle HGB experiment and produce fresh metrics/submission artifacts",
        approach: "Create the training script, run it, and retain metrics plus submission artifacts.",
        constraints: [`workspace_path:${workspace}`],
        success_criteria: [
          {
            description: "Training script exists",
            verification_method: "test -f src/experiments/train_hgb_engineered_auc.py",
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
            {
              kind: "submission_csv",
              path: "submissions/hgb_seed_blend.csv",
              required_fields: [],
              fresh_after_task_start: true,
            },
          ],
        },
      });

      const verification = await lifecycle.verifyTask(task, makeExecutionResult({
        output: "Created src/experiments/train_hgb_engineered_auc.py",
        filesChangedPaths: ["src/experiments/train_hgb_engineered_auc.py"],
      }));

      expect(verification.verdict).toBe("fail");
      expect(verification.evidence[0]?.description).toContain("Artifact contract verification failed");
      expect(verification.evidence[0]?.description).toContain("reports/hgb_seed_blend.json is missing");
      expect(verification.evidence[0]?.description).toContain("submissions/hgb_seed_blend.csv is missing");
    });

    it("does not let GitHub issue URL evidence bypass a missing artifact contract", async () => {
      const workspace = path.join(tmpDir, "kaggle-workspace-issue-url");
      fs.mkdirSync(path.join(workspace, "src", "experiments"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, "src", "experiments", "train_hgb_engineered_auc.py"),
        "print('training script only')\n"
      );
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm, { adapterRegistry: null });
      const task = makeTask({
        work_description: "Run Kaggle HGB experiment and produce fresh metrics/submission artifacts",
        approach: "Create the training script, run it, and retain metrics plus submission artifacts.",
        constraints: [`workspace_path:${workspace}`],
        success_criteria: [
          {
            description: "Training script exists",
            verification_method: "test -f src/experiments/train_hgb_engineered_auc.py",
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
      });

      const verification = await lifecycle.verifyTask(task, makeExecutionResult({
        output: "Created follow-up https://github.com/my-name-is-yu/PulSeed/issues/999 and script marker.",
        filesChangedPaths: ["src/experiments/train_hgb_engineered_auc.py"],
      }));

      expect(verification.verdict).toBe("fail");
      expect(verification.evidence[0]?.description).toContain("Artifact contract verification failed");
      expect(verification.evidence[0]?.description).toContain("reports/hgb_seed_blend.json is missing");
    });

    it("allows non-Kaggle required artifact contracts to declare only the concrete metrics artifact", async () => {
      const workspace = path.join(tmpDir, "contract-workspace-metrics-only");
      const metricsPath = path.join(workspace, "reports", "contract.json");
      fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
      fs.writeFileSync(metricsPath, JSON.stringify({ score: 1, scenario: "fresh-contract-canary" }), "utf8");
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm, { adapterRegistry: null });
      const task = makeTask({
        work_description: "Create a fresh generic metrics contract artifact",
        approach: "Write and verify reports/contract.json.",
        created_at: "2020-01-01T00:00:00.000Z",
        started_at: "2020-01-01T00:00:00.000Z",
        constraints: [`workspace_path:${workspace}`],
        success_criteria: [
          {
            description: "Metrics artifact exists",
            verification_method: "test -f reports/contract.json",
            is_blocking: true,
          },
        ],
        artifact_contract: {
          required: true,
          required_artifacts: [
            {
              kind: "metrics_json",
              path: "reports/contract.json",
              required_fields: ["score", "scenario"],
              field_types: { score: "number", scenario: "string" },
              fresh_after_task_start: true,
            },
          ],
        },
      });

      const verification = await lifecycle.verifyTask(task, makeExecutionResult({
        output: "Produced reports/contract.json",
        filesChangedPaths: ["reports/contract.json"],
      }));

      expect(verification.verdict).toBe("pass");
      expect(verification.artifact_contract_status).toMatchObject({
        applicable: true,
        passed: true,
      });
      const artifactContractStatus = verification.artifact_contract_status!;
      expect(artifactContractStatus.description).not.toContain("submission_csv");
    });

    it("uses passed metrics_json artifact values for dimension updates instead of synthetic progress deltas", async () => {
      const workspace = path.join(tmpDir, "contract-workspace-accuracy-update");
      const metricsPath = path.join(workspace, "experiments", "fresh", "metrics.json");
      fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
      fs.writeFileSync(metricsPath, JSON.stringify({ accuracy: 0.93 }), "utf8");
      await stateManager.saveGoal(makeGoal({
        id: "goal-artifact-accuracy",
        constraints: [`workspace_path:${workspace}`],
        dimensions: [
          makeDimension({
            name: "accuracy",
            label: "accuracy",
            current_value: 0,
            threshold: { type: "min", value: 0.9 },
          }),
        ],
      }));
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm, { adapterRegistry: null });
      const task = makeTask({
        id: "task-artifact-accuracy",
        goal_id: "goal-artifact-accuracy",
        target_dimensions: ["accuracy"],
        primary_dimension: "accuracy",
        work_description: "Create fresh accuracy metrics artifact",
        approach: "Write and verify experiments/fresh/metrics.json.",
        created_at: "2020-01-01T00:00:00.000Z",
        started_at: "2020-01-01T00:00:00.000Z",
        constraints: [`workspace_path:${workspace}`],
        success_criteria: [
          {
            description: "Fresh metrics artifact exists",
            verification_method: "test -f experiments/fresh/metrics.json",
            is_blocking: true,
          },
        ],
        artifact_contract: {
          required: true,
          required_artifacts: [
            {
              kind: "metrics_json",
              path: "experiments/fresh/metrics.json",
              required_fields: ["accuracy"],
              field_types: { accuracy: "number" },
              fresh_after_task_start: true,
            },
          ],
        },
      });

      const verification = await lifecycle.verifyTask(task, makeExecutionResult({
        output: "Produced experiments/fresh/metrics.json",
        filesChangedPaths: ["experiments/fresh/metrics.json"],
      }));
      await lifecycle.handleVerdict(task, verification);

      expect(verification.verdict).toBe("pass");
      expect(verification.dimension_updates).toEqual([
        {
          dimension_name: "accuracy",
          previous_value: 0,
          new_value: 0.93,
          confidence: 0.9,
          source: "artifact_contract",
        },
      ]);
      const updated = await stateManager.loadGoal("goal-artifact-accuracy");
      expect(updated?.dimensions[0]?.current_value).toBe(0.93);
    });

    it("fails stale required artifacts even when the generated artifact opts out of freshness", async () => {
      const workspace = path.join(tmpDir, "kaggle-workspace-stale-artifact");
      const metricsPath = path.join(workspace, "reports", "hgb_seed_blend.json");
      const submissionPath = path.join(workspace, "submissions", "hgb_seed_blend.csv");
      fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
      fs.mkdirSync(path.dirname(submissionPath), { recursive: true });
      fs.writeFileSync(metricsPath, JSON.stringify({ balanced_accuracy: 0.9473134912423415 }), "utf8");
      fs.writeFileSync(submissionPath, "id,target\n1,0\n", "utf8");
      const staleMtime = new Date(Date.now() - 60_000);
      fs.utimesSync(metricsPath, staleMtime, staleMtime);

      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm, { adapterRegistry: null });
      const task = makeTask({
        work_description: "Run Kaggle HGB experiment and produce fresh metrics artifacts",
        approach: "Run the local experiment and retain metrics artifacts.",
        constraints: [`workspace_path:${workspace}`],
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
              fresh_after_task_start: false,
            },
            {
              kind: "submission_csv",
              path: "submissions/hgb_seed_blend.csv",
              required_fields: [],
              fresh_after_task_start: true,
            },
          ],
        },
      });

      const verification = await lifecycle.verifyTask(task, makeExecutionResult({
        output: "Reused reports/hgb_seed_blend.json",
        filesChangedPaths: ["reports/hgb_seed_blend.json"],
      }));

      expect(verification.verdict).toBe("fail");
      expect(verification.evidence[0]?.description).toContain("Artifact contract verification failed");
      expect(verification.evidence[0]?.description).toContain("reports/hgb_seed_blend.json is stale relative to task start");
    });

    it("fails required Kaggle artifacts when only fresh metrics are declared", async () => {
      const workspace = path.join(tmpDir, "kaggle-workspace-metrics-only");
      const metricsPath = path.join(workspace, "reports", "hgb_seed_blend.json");
      fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
      fs.writeFileSync(metricsPath, JSON.stringify({ balanced_accuracy: 0.9473134912423415 }), "utf8");
      await stateManager.saveGoal(makeGoal({
        id: "goal-1",
        constraints: [`workspace_path:${workspace}`, "run_spec_profile:kaggle"],
      }));
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm, { adapterRegistry: null });
      const task = makeTask({
        work_description: "Run Kaggle HGB experiment and produce fresh metrics/submission artifacts",
        approach: "Run the local experiment and retain metrics plus submission artifacts.",
        constraints: [`workspace_path:${workspace}`],
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
      });

      const verification = await lifecycle.verifyTask(task, makeExecutionResult({
        output: "Produced reports/hgb_seed_blend.json",
        filesChangedPaths: ["reports/hgb_seed_blend.json"],
      }));

      expect(verification.verdict).toBe("fail");
      expect(verification.evidence[0]?.description).toContain("Artifact contract verification failed");
      expect(verification.evidence[0]?.description).toContain("missing required artifact kind(s): submission_csv");
    });

    it("fails when artifact evidence is required but no artifacts are declared", async () => {
      const workspace = path.join(tmpDir, "kaggle-workspace-required-contract");
      fs.mkdirSync(path.join(workspace, "src", "experiments"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, "src", "experiments", "train_hgb_engineered_auc.py"),
        "print('training script only')\n"
      );
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm, { adapterRegistry: null });
      const task = makeTask({
        work_description: "Run Kaggle HGB experiment and produce fresh metrics/submission artifacts",
        approach: "Create the training script, run it, and retain metrics plus submission artifacts.",
        constraints: [`workspace_path:${workspace}`, "artifact_contract:required"],
        success_criteria: [
          {
            description: "Training script exists",
            verification_method: "test -f src/experiments/train_hgb_engineered_auc.py",
            is_blocking: true,
          },
        ],
      });

      const verification = await lifecycle.verifyTask(task, makeExecutionResult({
        output: "Created src/experiments/train_hgb_engineered_auc.py",
        filesChangedPaths: ["src/experiments/train_hgb_engineered_auc.py"],
      }));

      expect(verification.verdict).toBe("fail");
      expect(verification.evidence[0]?.description).toContain("Artifact contract verification failed");
      expect(verification.evidence[0]?.description).toContain("no required_artifacts were declared");
    });

    it("fails a Kaggle RunSpec-profile task even when the generated contract says artifacts are not required", async () => {
      const workspace = path.join(tmpDir, "kaggle-workspace-profile-contract");
      fs.mkdirSync(path.join(workspace, "src", "experiments"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, "src", "experiments", "train_hgb_engineered_auc.py"),
        "print('training script only')\n"
      );
      await stateManager.saveGoal(makeGoal({
        id: "goal-1",
        constraints: [`workspace_path:${workspace}`, "run_spec_profile:kaggle"],
      }));
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm, { adapterRegistry: null });
      const task = makeTask({
        work_description: "Run Kaggle HGB experiment and produce fresh metrics/submission artifacts",
        approach: "Create the training script, run it, and retain metrics plus submission artifacts.",
        constraints: [`workspace_path:${workspace}`],
        success_criteria: [
          {
            description: "Training script exists",
            verification_method: "test -f src/experiments/train_hgb_engineered_auc.py",
            is_blocking: true,
          },
        ],
        artifact_contract: { required: false, required_artifacts: [] },
      });

      const verification = await lifecycle.verifyTask(task, makeExecutionResult({
        output: "Created src/experiments/train_hgb_engineered_auc.py",
        filesChangedPaths: ["src/experiments/train_hgb_engineered_auc.py"],
      }));

      expect(verification.verdict).toBe("fail");
      expect(verification.evidence[0]?.description).toContain("Artifact contract verification failed");
      expect(verification.evidence[0]?.description).toContain("no required_artifacts were declared");
    });

    it("L1 pass + L2 fail triggers re-review", async () => {
      // L1 pass (MVP auto-pass), L2 fail, L2 re-review pass → pass
      const llm = createMockLLMClient([LLM_REVIEW_FAIL, LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("pass");
    });

    it("L1 pass + L2 fail + re-review fail results in verdict fail", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_FAIL, LLM_REVIEW_FAIL]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("fail");
    });

    it("L1 not applicable when no mechanical prefix in verification_method", async () => {
      // With non-mechanical verification methods, L1 should be skipped
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        success_criteria: [
          {
            description: "Code quality",
            verification_method: "Review the code manually",
            is_blocking: true,
          },
        ],
      });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      // L1 skip → L2 pass → pass with lower confidence
      expect(verification.verdict).toBe("pass");
      expect(verification.confidence).toBeLessThanOrEqual(0.7);
    });

    it("L1 applicable when verification_method starts with mechanical prefix", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        success_criteria: [
          {
            description: "Tests pass",
            verification_method: "npm test",
            is_blocking: true,
          },
        ],
      });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      // L1 applicable (MVP auto-pass) + L2 pass → pass with high confidence
      expect(verification.verdict).toBe("pass");
      expect(verification.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it("L1 applicable for direct file-check command prefixes", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        success_criteria: [
          {
            description: "File contains recovery code",
            verification_method: "rg -n \"recovery\" src/runtime/daemon/runner.ts",
            is_blocking: true,
          },
        ],
      });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("pass");
      expect(verification.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it("runs safe workspace-relative Python verification commands locally", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const workspace = path.join(tmpDir, "python-verification-workspace");
      const pythonPath = path.join(workspace, ".venv", "bin", "python");
      const scriptPath = path.join(workspace, "src", "experiments", "check_contract.py");
      fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
      fs.writeFileSync(
        pythonPath,
        [
          "#!/bin/sh",
          "printf '%s\\n' \"$@\" > python.args",
          "exit 0",
          "",
        ].join("\n"),
        "utf-8"
      );
      fs.chmodSync(pythonPath, 0o755);
      fs.writeFileSync(scriptPath, "print('contract ok')\n", "utf-8");
      const lifecycle = createLifecycle(llm, { adapterRegistry: null });
      const task = makeTask({
        constraints: [`workspace_path:${workspace}`],
        success_criteria: [
          {
            description: "Generated experiment contract validates",
            verification_method: ".venv/bin/python src/experiments/check_contract.py --check-contract",
            is_blocking: true,
          },
        ],
      });

      const verification = await lifecycle.verifyTask(task, makeExecutionResult());

      expect(verification.verdict).toBe("pass");
      expect(verification.evidence[0]?.description).toContain("Mechanical verification passed");
      expect(fs.readFileSync(path.join(workspace, "python.args"), "utf-8")).toContain("--check-contract");
    });

    it("uses execution-provided diffs as the source of truth", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const execute = vi.fn();
      const lifecycle = createLifecycle(llm, {
        toolExecutor: { execute } as unknown as ToolExecutor,
      });
      const task = makeTask();
      const result = makeExecutionResult({
        filesChangedPaths: ["src/example.ts"],
        fileDiffs: [{
          path: "src/example.ts",
          patch: [
            "diff --git a/src/example.ts b/src/example.ts",
            "@@ -1 +1 @@",
            "-before",
            "+after",
          ].join("\n"),
        }],
      });

      const verification = await lifecycle.verifyTask(task, result);

      expect(execute).not.toHaveBeenCalled();
      expect(verification.file_diffs).toEqual([
        expect.objectContaining({
          path: "src/example.ts",
          patch: expect.stringContaining("+after"),
        }),
      ]);
    });

    it("falls back to synthetic diff output for newly created files", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const execute = vi.fn()
        .mockResolvedValueOnce({
          success: true,
          data: "",
          summary: "No changes found",
          durationMs: 1,
        })
        .mockResolvedValueOnce({
          success: false,
          data: {
            stdout: [
              "diff --git a/src/new-file.ts b/src/new-file.ts",
              "new file mode 100644",
              "--- /dev/null",
              "+++ b/src/new-file.ts",
              "@@ -0,0 +1 @@",
              "+export const created = true;",
            ].join("\n"),
            stderr: "",
            exitCode: 1,
          },
          summary: "Command failed (exit 1)",
          error: "",
          durationMs: 1,
        });
      const lifecycle = createLifecycle(llm, {
        toolExecutor: { execute } as unknown as ToolExecutor,
      });
      const task = makeTask();
      const result = makeExecutionResult({
        filesChangedPaths: ["src/new-file.ts"],
      });

      const verification = await lifecycle.verifyTask(task, result);

      expect(execute).toHaveBeenNthCalledWith(
        2,
        "shell_command",
        expect.objectContaining({
          command: expect.stringContaining("git diff --no-index -- /dev/null"),
        }),
        expect.objectContaining({ goalId: task.goal_id })
      );
      expect(verification.file_diffs).toEqual([
        expect.objectContaining({
          path: "src/new-file.ts",
          patch: expect.stringContaining("new file mode 100644"),
        }),
      ]);
    });

    it("uses the preferred execution adapter for mechanical verification", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const registry = new AdapterRegistry();
      let fallbackAdapterCalls = 0;
      let codexCalls = 0;
      registry.register({
        adapterType: "fallback_external_cli",
        async execute() {
          fallbackAdapterCalls += 1;
          return {
            success: false,
            output: "",
            error: "fallback adapter should not run",
            exit_code: 1,
            elapsed_ms: 1,
            stopped_reason: "error",
          };
        },
      });
      registry.register({
        adapterType: "openai_codex_cli",
        async execute() {
          codexCalls += 1;
          return {
            success: true,
            output: "ok",
            error: null,
            exit_code: 0,
            elapsed_ms: 1,
            stopped_reason: "completed",
          };
        },
      });
      const lifecycle = createLifecycle(llm, { adapterRegistry: registry });
      const task = makeTask({
        success_criteria: [
          {
            description: "File contains recovery code",
            verification_method: "rg -n \"recovery\" src/runtime/daemon/runner.ts",
            is_blocking: true,
          },
        ],
      });

      const verification = await lifecycle.verifyTask(
        task,
        makeExecutionResult(),
        "openai_codex_cli"
      );

      expect(fallbackAdapterCalls).toBe(0);
      expect(codexCalls).toBe(1);
      expect(verification.verdict).toBe("pass");
    });

    it("runs cheap mechanical verification in the resolved non-git workspace", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const workspace = path.join(tmpDir, "non-git-workspace");
      const fakeBin = path.join(tmpDir, "bin");
      fs.mkdirSync(workspace, { recursive: true });
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(workspace, "marker.txt"), "expected marker\n", "utf-8");
      const fakeRg = path.join(fakeBin, "rg");
      fs.writeFileSync(
        fakeRg,
        [
          "#!/bin/sh",
          "pwd > rg.cwd",
          "if [ \"$1\" = \"-n\" ]; then shift; fi",
          "grep -n \"$1\" \"$2\" >/dev/null",
          "",
        ].join("\n"),
        "utf-8"
      );
      fs.chmodSync(fakeRg, 0o755);
      const previousPath = process.env.PATH;
      process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;

      const registry = new AdapterRegistry();
      let adapterCalls = 0;
      registry.register({
        adapterType: "openai_codex_cli",
        async execute() {
          adapterCalls += 1;
          return {
            success: false,
            output: "",
            error: "cheap command should run locally",
            exit_code: 1,
            elapsed_ms: 1,
            stopped_reason: "error",
          };
        },
      });
      const lifecycle = createLifecycle(llm, { adapterRegistry: registry });
      const task = makeTask({
        success_criteria: [
          {
            description: "Workspace marker exists and contains expected text",
            verification_method: "test -f marker.txt && rg -n expected marker.txt",
            is_blocking: true,
          },
        ],
      });

      try {
        await stateManager.saveGoal(makeGoal({
          id: task.goal_id,
          constraints: [`workspace_path:${workspace}`],
        }));

        const verification = await lifecycle.verifyTask(
          task,
          makeExecutionResult(),
          "openai_codex_cli"
        );

        expect(adapterCalls).toBe(0);
        expect(verification.verdict).toBe("pass");
        expect(fs.realpathSync(fs.readFileSync(path.join(workspace, "rg.cwd"), "utf-8").trim())).toBe(
          fs.realpathSync(workspace)
        );
      } finally {
        process.env.PATH = previousPath;
      }
    });

    it("runs cheap mechanical verification for a legacy relative workspace_path under revertCwd", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const workspaceBase = path.join(tmpDir, "workspace-base");
      const workspace = path.join(workspaceBase, "relative-workspace");
      const fakeBin = path.join(tmpDir, "bin-relative");
      fs.mkdirSync(workspace, { recursive: true });
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(workspace, "marker.txt"), "expected marker\n", "utf-8");
      const fakeRg = path.join(fakeBin, "rg");
      fs.writeFileSync(
        fakeRg,
        [
          "#!/bin/sh",
          "pwd > rg.cwd",
          "if [ \"$1\" = \"-n\" ]; then shift; fi",
          "grep -n \"$1\" \"$2\" >/dev/null",
          "",
        ].join("\n"),
        "utf-8"
      );
      fs.chmodSync(fakeRg, 0o755);
      const previousPath = process.env.PATH;
      process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;

      const lifecycle = createLifecycle(llm, { adapterRegistry: null, revertCwd: workspaceBase });
      const task = makeTask({
        success_criteria: [
          {
            description: "Workspace marker exists and contains expected text",
            verification_method: "test -f marker.txt && rg -n expected marker.txt",
            is_blocking: true,
          },
        ],
      });

      try {
        await stateManager.saveGoal(makeGoal({
          id: task.goal_id,
          constraints: ["workspace_path:relative-workspace"],
        }));

        const verification = await lifecycle.verifyTask(task, makeExecutionResult(), "openai_codex_cli");

        expect(verification.verdict).toBe("pass");
        expect(fs.realpathSync(fs.readFileSync(path.join(workspace, "rg.cwd"), "utf-8").trim())).toBe(
          fs.realpathSync(workspace)
        );
      } finally {
        process.env.PATH = previousPath;
      }
    });

    it("keeps shell control operators on the adapter path while preserving workspace cwd", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const workspace = path.join(tmpDir, "non-git-workspace-control");
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(path.join(workspace, "marker.txt"), "expected marker\n", "utf-8");

      const registry = new AdapterRegistry();
      let adapterCwd: string | undefined;
      registry.register({
        adapterType: "openai_codex_cli",
        async execute(agentTask) {
          adapterCwd = agentTask.cwd;
          return {
            success: true,
            output: "adapter handled control operator command",
            error: null,
            exit_code: 0,
            elapsed_ms: 1,
            stopped_reason: "completed",
          };
        },
      });
      const lifecycle = createLifecycle(llm, { adapterRegistry: registry });
      const task = makeTask({
        success_criteria: [
          {
            description: "Workspace marker exists",
            verification_method: "test -f marker.txt & touch should-not-run",
            is_blocking: true,
          },
        ],
      });

      await stateManager.saveGoal(makeGoal({
        id: task.goal_id,
        constraints: [`workspace_path:${workspace}`],
      }));

      const verification = await lifecycle.verifyTask(
        task,
        makeExecutionResult(),
        "openai_codex_cli"
      );

      expect(verification.verdict).toBe("pass");
      expect(adapterCwd).toBe(workspace);
      expect(fs.existsSync(path.join(workspace, "should-not-run"))).toBe(false);
    });

    it("keeps rg execution options on the adapter path while preserving workspace cwd", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const workspace = path.join(tmpDir, "non-git-workspace-rg-pre");
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(path.join(workspace, "marker.txt"), "expected marker\n", "utf-8");
      const preprocessor = path.join(workspace, "side-effect-preprocessor.sh");
      fs.writeFileSync(
        preprocessor,
        [
          "#!/bin/sh",
          "touch rg-pre-side-effect",
          "cat \"$1\"",
          "",
        ].join("\n"),
        "utf-8"
      );
      fs.chmodSync(preprocessor, 0o755);

      const registry = new AdapterRegistry();
      let adapterCwd: string | undefined;
      registry.register({
        adapterType: "openai_codex_cli",
        async execute(agentTask) {
          adapterCwd = agentTask.cwd;
          return {
            success: true,
            output: "adapter handled rg option command",
            error: null,
            exit_code: 0,
            elapsed_ms: 1,
            stopped_reason: "completed",
          };
        },
      });
      const lifecycle = createLifecycle(llm, { adapterRegistry: registry });
      const task = makeTask({
        success_criteria: [
          {
            description: "Workspace marker contains expected text",
            verification_method: "rg --pre ./side-effect-preprocessor.sh expected marker.txt",
            is_blocking: true,
          },
        ],
      });

      await stateManager.saveGoal(makeGoal({
        id: task.goal_id,
        constraints: [`workspace_path:${workspace}`],
      }));

      const verification = await lifecycle.verifyTask(
        task,
        makeExecutionResult(),
        "openai_codex_cli"
      );

      expect(verification.verdict).toBe("pass");
      expect(adapterCwd).toBe(workspace);
      expect(fs.existsSync(path.join(workspace, "rg-pre-side-effect"))).toBe(false);
    });

    it("keeps escaped path operands on the adapter path while preserving workspace cwd", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const workspace = path.join(tmpDir, "non-git-workspace-path-scope");
      const outside = path.join(tmpDir, "outside-workspace");
      fs.mkdirSync(workspace, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, "marker.txt"), "expected marker\n", "utf-8");

      const registry = new AdapterRegistry();
      let adapterCwd: string | undefined;
      registry.register({
        adapterType: "openai_codex_cli",
        async execute(agentTask) {
          adapterCwd = agentTask.cwd;
          return {
            success: true,
            output: "adapter handled escaped path command",
            error: null,
            exit_code: 0,
            elapsed_ms: 1,
            stopped_reason: "completed",
          };
        },
      });
      const lifecycle = createLifecycle(llm, { adapterRegistry: registry });
      const task = makeTask({
        success_criteria: [
          {
            description: "Workspace marker contains expected text",
            verification_method: "rg -n expected ../outside-workspace/marker.txt",
            is_blocking: true,
          },
        ],
      });

      await stateManager.saveGoal(makeGoal({
        id: task.goal_id,
        constraints: [`workspace_path:${workspace}`],
      }));

      const verification = await lifecycle.verifyTask(
        task,
        makeExecutionResult(),
        "openai_codex_cli"
      );

      expect(verification.verdict).toBe("pass");
      expect(adapterCwd).toBe(workspace);
    });

    it("still runs cheap local failures before fail-closed adapter-unavailable evidence", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const workspace = path.join(tmpDir, "non-git-workspace-no-adapter");
      fs.mkdirSync(workspace, { recursive: true });
      const lifecycle = createLifecycle(llm, { adapterRegistry: null });
      const task = makeTask({
        success_criteria: [
          {
            description: "Full test suite passes",
            verification_method: "npm test",
            is_blocking: true,
          },
          {
            description: "Workspace marker exists",
            verification_method: "test -f missing-marker.txt",
            is_blocking: true,
          },
        ],
      });

      await stateManager.saveGoal(makeGoal({
        id: task.goal_id,
        constraints: [`workspace_path:${workspace}`],
      }));

      const verification = await lifecycle.verifyTask(task, makeExecutionResult());

      expect(verification.verdict).toBe("fail");
      expect(verification.evidence[0]?.description).toContain("missing-marker.txt");
    });

    it("fails closed when blocking mechanical commands need an adapter but no registry is configured", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm, { adapterRegistry: null });
      const task = makeTask({
        success_criteria: [
          {
            description: "Full test suite passes",
            verification_method: "npm test",
            is_blocking: true,
          },
        ],
      });

      const verification = await lifecycle.verifyTask(task, makeExecutionResult());
      const mechanicalEvidence = verification.evidence.find((entry) => entry.layer === "mechanical");

      expect(verification.verdict).toBe("fail");
      expect(mechanicalEvidence?.description).toContain("could not execute");
      expect(mechanicalEvidence?.description).toContain("no adapter registry is configured");
      expect(mechanicalEvidence?.description).toContain("command(s) did not run: npm test");
      expect(mechanicalEvidence?.description).toContain("unknown/Uncertain");
    });

    it("fails closed when the adapter registry is empty for a blocking mechanical command", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm, { adapterRegistry: new AdapterRegistry() });
      const task = makeTask({
        success_criteria: [
          {
            description: "Full test suite passes",
            verification_method: "npm test",
            is_blocking: true,
          },
        ],
      });

      const verification = await lifecycle.verifyTask(task, makeExecutionResult());
      const mechanicalEvidence = verification.evidence.find((entry) => entry.layer === "mechanical");

      expect(verification.verdict).toBe("fail");
      expect(mechanicalEvidence?.description).toContain("no adapters are registered");
      expect(mechanicalEvidence?.description).toContain("command(s) did not run: npm test");
      expect(mechanicalEvidence?.description).toContain("fails closed");
    });

    it("fails closed when adapter lookup fails for a blocking mechanical command", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const registry = new AdapterRegistry();
      const execute = vi.fn(async () => ({
        success: true,
        output: "should not execute",
        error: null,
        exit_code: 0,
        elapsed_ms: 1,
        stopped_reason: "completed" as const,
      }));
      registry.register({
        adapterType: "openai_codex_cli",
        execute,
      });
      vi.spyOn(registry, "getAdapter").mockImplementation(() => {
        throw new Error("lookup unavailable");
      });
      const lifecycle = createLifecycle(llm, { adapterRegistry: registry });
      const task = makeTask({
        success_criteria: [
          {
            description: "Full test suite passes",
            verification_method: "npm test",
            is_blocking: true,
          },
        ],
      });

      const verification = await lifecycle.verifyTask(
        task,
        makeExecutionResult(),
        "openai_codex_cli"
      );
      const mechanicalEvidence = verification.evidence.find((entry) => entry.layer === "mechanical");

      expect(execute).not.toHaveBeenCalled();
      expect(verification.verdict).toBe("fail");
      expect(mechanicalEvidence?.description).toContain("adapter lookup failed for openai_codex_cli");
      expect(mechanicalEvidence?.description).toContain("command(s) did not run: npm test");
    });

    it("fails closed with unknown evidence when adapter execution throws for a blocking mechanical command", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const registry = new AdapterRegistry();
      const execute = vi.fn(async () => {
        throw new Error("adapter process unavailable");
      });
      registry.register({
        adapterType: "openai_codex_cli",
        execute,
      });
      const lifecycle = createLifecycle(llm, { adapterRegistry: registry });
      const task = makeTask({
        success_criteria: [
          {
            description: "Full test suite passes",
            verification_method: "npm test",
            is_blocking: true,
          },
        ],
      });

      const verification = await lifecycle.verifyTask(
        task,
        makeExecutionResult(),
        "openai_codex_cli"
      );
      const mechanicalEvidence = verification.evidence.find((entry) => entry.layer === "mechanical");

      expect(execute).toHaveBeenCalledOnce();
      expect(verification.verdict).toBe("fail");
      expect(mechanicalEvidence?.description).toContain("adapter execution failed for openai_codex_cli");
      expect(mechanicalEvidence?.description).toContain("command(s) did not run to completion: npm test");
      expect(mechanicalEvidence?.description).toContain("unknown/Uncertain");
    });

    it("keeps glob path operands on the adapter path while preserving workspace cwd", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const workspace = path.join(tmpDir, "non-git-workspace-glob");
      fs.mkdirSync(path.join(workspace, "reports"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "reports", "result.md"), "done\n", "utf-8");

      const registry = new AdapterRegistry();
      let adapterCwd: string | undefined;
      registry.register({
        adapterType: "openai_codex_cli",
        async execute(agentTask) {
          adapterCwd = agentTask.cwd;
          return {
            success: true,
            output: "adapter handled glob command",
            error: null,
            exit_code: 0,
            elapsed_ms: 1,
            stopped_reason: "completed",
          };
        },
      });
      const lifecycle = createLifecycle(llm, { adapterRegistry: registry });
      const task = makeTask({
        success_criteria: [
          {
            description: "Report exists",
            verification_method: "ls reports/*.md",
            is_blocking: true,
          },
        ],
      });

      await stateManager.saveGoal(makeGoal({
        id: task.goal_id,
        constraints: [`workspace_path:${workspace}`],
      }));

      const verification = await lifecycle.verifyTask(
        task,
        makeExecutionResult(),
        "openai_codex_cli"
      );

      expect(verification.verdict).toBe("pass");
      expect(adapterCwd).toBe(workspace);
    });

    it("runs all mechanical blocking criteria instead of passing on the first match", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const registry = new AdapterRegistry();
      const calls: string[] = [];
      registry.register({
        adapterType: "openai_codex_cli",
        async execute(agentTask) {
          calls.push(agentTask.prompt);
          return {
            success: calls.length === 1,
            output: calls.length === 1 ? "ok" : "",
            error: calls.length === 1 ? null : "second criterion failed",
            exit_code: calls.length === 1 ? 0 : 1,
            elapsed_ms: 1,
            stopped_reason: calls.length === 1 ? "completed" : "error",
          };
        },
      });
      const lifecycle = createLifecycle(llm, { adapterRegistry: registry });
      const task = makeTask({
        success_criteria: [
          {
            description: "Runtime file contains recovery code",
            verification_method: "rg -n \"recovery\" src/runtime/watchdog.ts",
            is_blocking: true,
          },
          {
            description: "Runtime test contains recovery coverage",
            verification_method: "rg -n \"recovery\" src/runtime/__tests__/watchdog.test.ts",
            is_blocking: true,
          },
        ],
      });

      const verification = await lifecycle.verifyTask(
        task,
        makeExecutionResult(),
        "openai_codex_cli"
      );

      expect(calls).toEqual([
        "rg -n \"recovery\" src/runtime/watchdog.ts",
        "rg -n \"recovery\" src/runtime/__tests__/watchdog.test.ts",
      ]);
      expect(verification.verdict).toBe("fail");
      expect(verification.evidence[0]?.description).toContain("1/2 command(s)");
    });

    it("does not let non-blocking mechanical criteria override passing blocking review", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const registry = new AdapterRegistry();
      let calls = 0;
      registry.register({
        adapterType: "openai_codex_cli",
        async execute() {
          calls += 1;
          return {
            success: false,
            output: "",
            error: "supporting check failed",
            exit_code: 1,
            elapsed_ms: 1,
            stopped_reason: "error",
          };
        },
      });
      const lifecycle = createLifecycle(llm, { adapterRegistry: registry });
      const task = makeTask({
        success_criteria: [
          {
            description: "Behavior is correct",
            verification_method: "Independent review confirms behavior",
            is_blocking: true,
          },
          {
            description: "Supporting grep evidence",
            verification_method: "rg -n \"optional\" src/runtime/watchdog.ts",
            is_blocking: false,
          },
        ],
      });

      const verification = await lifecycle.verifyTask(
        task,
        makeExecutionResult(),
        "openai_codex_cli"
      );

      expect(calls).toBe(0);
      expect(verification.verdict).toBe("pass");
      expect(verification.confidence).toBeLessThanOrEqual(0.7);
    });

    it("L1 skip + L2 pass results in verdict pass with lower confidence", async () => {
      // Task with no mechanical criteria → L1 skip
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        success_criteria: [
          {
            description: "Code is clean",
            verification_method: "Manual review",
            is_blocking: true,
          },
        ],
      });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("pass");
      expect(verification.confidence).toBeLessThanOrEqual(0.7);
    });

    it("L1 skip + L2 fail results in verdict fail", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_FAIL]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        success_criteria: [
          {
            description: "Code is clean",
            verification_method: "Manual review",
            is_blocking: true,
          },
        ],
      });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("fail");
    });

    it("L1 skip + L2 partial results in verdict partial", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PARTIAL]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        success_criteria: [
          {
            description: "Code is clean",
            verification_method: "Manual review",
            is_blocking: true,
          },
        ],
      });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("partial");
    });

    it("builds correct review context (no self-report)", async () => {
      const spy = createSpyLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(spy);
      const task = makeTask();
      const result = makeExecutionResult();

      await lifecycle.verifyTask(task, result);

      // L2 review call should use review context (excludes self-report)
      // L1 no longer uses LLM, so first call is L2
      expect(spy.calls.length).toBeGreaterThanOrEqual(1);
      const l2Call = spy.calls[0]!;
      expect(l2Call.options?.system).toContain("Review task results objectively");
      expect(l2Call.options?.system).toContain("Ignore executor self-assessment");
    });

    it("LLM reviewer receives correct prompt with success criteria", async () => {
      const spy = createSpyLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(spy);
      const task = makeTask();
      const result = makeExecutionResult();

      await lifecycle.verifyTask(task, result);

      const l2Prompt = spy.calls[0]!.messages[0]!.content;
      expect(l2Prompt).toContain("Tests pass");
      expect(l2Prompt).toContain("npx vitest run");
    });

    it("evidence is collected from all layers", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);

      const layers = verification.evidence.map((e) => e.layer);
      expect(layers).toContain("mechanical");
      expect(layers).toContain("independent_review");
      expect(layers).toContain("self_report");
    });

    it("self_report evidence has lowest confidence", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);

      const selfReport = verification.evidence.find((e) => e.layer === "self_report");
      expect(selfReport).toBeDefined();
      expect(selfReport!.confidence).toBeLessThanOrEqual(0.3);
    });

    it("confidence is higher when both L1 and L2 agree on pass", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it("confidence is higher when L1 skip and L2 fail", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_FAIL]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        success_criteria: [
          {
            description: "Code is clean",
            verification_method: "Manual review",
            is_blocking: true,
          },
        ],
      });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("fail");
      expect(verification.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("persists verification result to state", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);

      const persisted = await stateManager.readRaw(
        `verification/${task.id}/verification-result.json`
      ) as Record<string, unknown>;
      expect(persisted).not.toBeNull();
      expect(persisted.task_id).toBe(task.id);
      expect(persisted.verdict).toBe(verification.verdict);
    });

    it("sets valid timestamp on verification result", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const result = makeExecutionResult();

      const before = new Date().toISOString();
      const verification = await lifecycle.verifyTask(task, result);
      const after = new Date().toISOString();

      expect(verification.timestamp >= before).toBe(true);
      expect(verification.timestamp <= after).toBe(true);
    });

    it("sets task_id on verification result", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ id: "my-task-42" });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.task_id).toBe("my-task-42");
    });

    it("handles unparseable LLM response gracefully", async () => {
      // L1 no longer uses LLM, so only L2 gets garbage → should still produce a result
      // L1 passes (MVP assumed pass) + L2 fails → triggers L2 retry (2nd call)
      const llm = createMockLLMClient(["not json", "not json"]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      // Should still return a valid VerificationResult
      expect(verification.verdict).toBeDefined();
      expect(verification.task_id).toBe(task.id);
    });

    it("includes execution output in L2 review prompt", async () => {
      const spy = createSpyLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(spy);
      const task = makeTask();
      const result = makeExecutionResult({ output: "UNIQUE_OUTPUT_MARKER_12345" });

      await lifecycle.verifyTask(task, result);

      const l2Prompt = spy.calls[0]!.messages[0]!.content;
      expect(l2Prompt).toContain("UNIQUE_OUTPUT_MARKER_12345");
    });

    it("includes agentloop verification metadata in L2 review prompt and persisted result", async () => {
      const spy = createSpyLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(spy);
      const task = makeTask({
        success_criteria: [
          {
            description: "Behavior is correct",
            verification_method: "Manual review",
            is_blocking: true,
          },
        ],
      });
      const result = makeExecutionResult({
        output: "Patched implementation",
        agentLoop: {
          traceId: "trace-1",
          sessionId: "session-1",
          turnId: "turn-1",
          stopReason: "completed",
          modelTurns: 3,
          toolCalls: 2,
          compactions: 1,
          completionEvidence: ["updated handler", "added regression test"],
          verificationHints: ["run targeted vitest"],
          filesChangedPaths: ["src/example.ts"],
        },
      });

      const verification = await lifecycle.verifyTask(task, result);

      const l2Prompt = spy.calls[0]!.messages[0]!.content;
      expect(l2Prompt).toContain("Supplemental execution metadata");
      expect(l2Prompt).toContain("updated handler");
      expect(l2Prompt).toContain("run targeted vitest");

      const selfReport = verification.evidence.find((e) => e.layer === "self_report");
      expect(selfReport?.description).toContain("completion evidence: updated handler; added regression test");
      expect(selfReport?.description).toContain("verification hints: run targeted vitest");

      const persisted = await stateManager.readRaw(
        `verification/${task.id}/verification-result.json`
      ) as Record<string, unknown>;
      expect(persisted.agent_loop).toMatchObject({
        traceId: "trace-1",
        stopReason: "completed",
      });
      expect(persisted.executor_report).toMatchObject({
        completion_evidence: ["updated handler", "added regression test"],
        verification_hints: ["run targeted vitest"],
      });
    });

    it("collects git diff entries into the verification result when toolExecutor is available", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const toolExecutor = {
        execute: async (toolName: string, input: unknown) => {
          if (toolName !== "git_diff") throw new Error("unexpected tool");
          const path = (input as { path?: string }).path;
          return {
            success: true,
            data: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`,
            summary: "diff ok",
            durationMs: 1,
          };
        },
      } as unknown as ToolExecutor;
      const lifecycle = createLifecycle(llm, { toolExecutor });
      const task = makeTask();
      const result = makeExecutionResult({
        filesChangedPaths: ["src/example.ts"],
      });

      const verification = await lifecycle.verifyTask(task, result);
      const fileDiffs = verification.file_diffs ?? [];

      expect(fileDiffs).toEqual([
        expect.objectContaining({
          path: "src/example.ts",
        }),
      ]);
      expect(fileDiffs[0]?.patch).toContain("+new");
    });

    it("does not widen back to workspace git diff when execution captured no task-produced paths", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const execute = vi.fn().mockResolvedValue({
        success: true,
        data: [
          "diff --git a/preexisting.txt b/preexisting.txt",
          "--- a/preexisting.txt",
          "+++ b/preexisting.txt",
          "@@ -1 +1 @@",
          "-clean",
          "+dirty before task",
        ].join("\n"),
        summary: "workspace diff",
        durationMs: 1,
      });
      const lifecycle = createLifecycle(llm, {
        toolExecutor: { execute } as unknown as ToolExecutor,
      });
      const task = makeTask();
      const result = makeExecutionResult({
        filesChanged: false,
        filesChangedPaths: [],
        fileDiffs: [],
      });

      const verification = await lifecycle.verifyTask(task, result);

      expect(execute).not.toHaveBeenCalled();
      expect(verification.file_diffs).toEqual([]);
    });

    it("truncates very long output in L2 review prompt", async () => {
      const spy = createSpyLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(spy);
      const task = makeTask();
      const longOutput = "x".repeat(5000);
      const result = makeExecutionResult({ output: longOutput });

      await lifecycle.verifyTask(task, result);

      const l2Prompt = spy.calls[0]!.messages[0]!.content;
      // Should be truncated to 2000 chars
      expect(l2Prompt.length).toBeLessThan(longOutput.length + 500);
    });

    // ─── dimension_updates tests ───

    it("dimension_updates is empty on fail verdict", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_FAIL, LLM_REVIEW_FAIL]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask();
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("fail");
      expect(verification.dimension_updates).toHaveLength(0);
    });

    it("dimension_updates has one entry per target_dimension on pass verdict", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ target_dimensions: ["coverage", "reliability"] });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("pass");
      expect(verification.dimension_updates).toHaveLength(2);
      const names = verification.dimension_updates.map((u) => u.dimension_name);
      expect(names).toContain("coverage");
      expect(names).toContain("reliability");
    });

    it("dimension_updates new_value is significant (>=0.3) on pass verdict", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ target_dimensions: ["performance"] });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("pass");
      const update = verification.dimension_updates[0]!;
      expect(typeof update.new_value).toBe("number");
      expect(update.new_value as number).toBeGreaterThanOrEqual(0.1);
    });

    it("dimension_updates new_value is moderate (0.1-0.25) on partial verdict", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PARTIAL]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        target_dimensions: ["quality"],
        success_criteria: [
          {
            description: "Code is clean",
            verification_method: "Manual review",
            is_blocking: true,
          },
        ],
      });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("partial");
      expect(verification.dimension_updates).toHaveLength(1);
      const update = verification.dimension_updates[0]!;
      expect(update.dimension_name).toBe("quality");
      expect(typeof update.new_value).toBe("number");
      expect(update.new_value as number).toBeGreaterThanOrEqual(0.1);
      expect(update.new_value as number).toBeLessThanOrEqual(0.25);
    });

    it("dimension_updates entries carry confidence matching the verdict confidence", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ target_dimensions: ["dim"] });
      const result = makeExecutionResult();

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("pass");
      const update = verification.dimension_updates[0]!;
      expect(update.confidence).toBe(verification.confidence);
    });

    it("dimension_updates previous_value is null when goal has no matching dimension in state", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ target_dimensions: ["dim"] });
      const result = makeExecutionResult();

      // No goal written to state → previous_value falls back to null
      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.dimension_updates[0]!.previous_value).toBeNull();
    });

    it("dimension_updates reads previous_value from goal state when available", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ target_dimensions: ["dim"] });
      const result = makeExecutionResult();

      await stateManager.writeRaw("goals/goal-1/goal.json", {
        id: "goal-1",
        title: "Test Goal",
        status: "active",
        dimensions: [
          { name: "dim", label: "Dim", current_value: 0.3, last_updated: null },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("pass");
      expect(verification.dimension_updates[0]!.previous_value).toBe(0.3);
    });

    it("dimension_updates new_value is previous_value + delta (clamped) on pass", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ target_dimensions: ["dim"] });
      const result = makeExecutionResult();

      await stateManager.writeRaw("goals/goal-1/goal.json", {
        id: "goal-1",
        title: "Test Goal",
        status: "active",
        dimensions: [
          { name: "dim", label: "Dim", current_value: 0.3, last_updated: null },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("pass");
      const update = verification.dimension_updates[0]!;
      // pass delta = 0.2; new_value = clamp(0.3 + 0.2, 0, 1) = 0.5
      expect(update.new_value).toBeCloseTo(0.5, 5);
    });

    it("dimension_updates new_value is clamped to 1 when previous_value + delta exceeds 1", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PASS]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({ target_dimensions: ["dim"] });
      const result = makeExecutionResult();

      await stateManager.writeRaw("goals/goal-1/goal.json", {
        id: "goal-1",
        title: "Test Goal",
        status: "active",
        dimensions: [
          { name: "dim", label: "Dim", current_value: 0.9, last_updated: null },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("pass");
      // No threshold on dimension → scaledDelta = progressDelta = 0.2 (no scaling)
      // new_value = 0.9 + 0.2 = 1.1 (no [0,1] clamp at verifier level; raw scale)
      expect(verification.dimension_updates[0]!.new_value).toBeCloseTo(1.1, 5);
    });

    it("dimension_updates new_value is previous_value + partial_delta on partial verdict", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PARTIAL]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        target_dimensions: ["quality"],
        success_criteria: [
          {
            description: "Code is clean",
            verification_method: "Manual review",
            is_blocking: true,
          },
        ],
      });
      const result = makeExecutionResult();

      await stateManager.writeRaw("goals/goal-1/goal.json", {
        id: "goal-1",
        title: "Test Goal",
        status: "active",
        dimensions: [
          { name: "quality", label: "Quality", current_value: 0.2, last_updated: null },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("partial");
      const update = verification.dimension_updates[0]!;
      // partial delta = 0.15; new_value = clamp(0.2 + 0.15, 0, 1) = 0.35
      expect(update.previous_value).toBe(0.2);
      expect(update.new_value).toBeCloseTo(0.35, 5);
    });

    it("dimension_updates lowers max-threshold values on partial verdict", async () => {
      const llm = createMockLLMClient([LLM_REVIEW_PARTIAL]);
      const lifecycle = createLifecycle(llm);
      const task = makeTask({
        target_dimensions: ["bug_count"],
        success_criteria: [
          {
            description: "Bug count is reduced",
            verification_method: "Manual review",
            is_blocking: true,
          },
        ],
      });
      const result = makeExecutionResult();

      await stateManager.writeRaw("goals/goal-1/goal.json", {
        id: "goal-1",
        title: "Reduce Bugs",
        status: "active",
        dimensions: [
          {
            name: "bug_count",
            label: "Bug Count",
            current_value: 10,
            threshold: { type: "max", value: 5 },
            last_updated: null,
          },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const verification = await lifecycle.verifyTask(task, result);
      expect(verification.verdict).toBe("partial");
      const update = verification.dimension_updates[0]!;
      expect(update.previous_value).toBe(10);
      expect(update.new_value).toBeCloseTo(9.25, 5);
    });
  });
});
