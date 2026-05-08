/**
 * completion-judger-timeout.test.ts
 *
 * Tests for the timeout + retry config added to the completion judgment step
 * (runLLMReview inside task-verifier.ts).
 *
 * Approach: use VerifierDeps directly (the functions are exported from task-verifier.ts)
 * and inject a slow/failing mock LLM client to exercise the timeout / retry paths.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../../../base/state/state-manager.js";
import { SessionManager } from "../session-manager.js";
import { TrustManager } from "../../../platform/traits/trust-manager.js";
import { StallDetector } from "../../../platform/drive/stall-detector.js";
import { verifyTask, type VerifierDeps } from "../task/task-verifier.js";
import type { Task } from "../../../base/types/task.js";
import type { AgentResult } from "../adapter-layer.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../../../base/llm/llm-client.js";
import type { z } from "zod";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";

// ─── Helpers ───

function makeTask(): Task {
  return {
    id: "task-timeout-test",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["coverage"],
    primary_dimension: "coverage",
    work_description: "Write tests for module X",
    rationale: "Improve test coverage",
    approach: "Use vitest",
    success_criteria: [
      {
        description: "Coverage >= 80%",
        verification_method: "manual inspection",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["tests/"],
      out_of_scope: ["src/"],
      blast_radius: "test files only",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "running",
    started_at: new Date().toISOString(),
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
  };
}

function makeExecutionResult(): AgentResult {
  return {
    success: true,
    output: "All tests pass",
    error: null,
    exit_code: 0,
    stopped_reason: "completed",
    elapsed_ms: 100,
  };
}

/** Build a slow LLM client that takes `delayMs` ms before resolving. */
function makeSlowLLMClient(delayMs: number, response = '{"verdict":"pass","reasoning":"ok","criteria_met":1,"criteria_total":1}'): ILLMClient {
  return {
    async sendMessage(_messages: LLMMessage[], _options?: LLMRequestOptions): Promise<LLMResponse> {
      await new Promise((res) => setTimeout(res, delayMs));
      return { content: response, usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: "end_turn" };
    },
    parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
      return schema.parse(JSON.parse(content));
    },
  };
}

/** Build a failing LLM client that always rejects after a short delay. */
function makeFailingLLMClient(callDelayMs = 5): ILLMClient & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() { return callCount; },
    async sendMessage(_messages: LLMMessage[], _options?: LLMRequestOptions): Promise<LLMResponse> {
      callCount++;
      await new Promise((res) => setTimeout(res, callDelayMs));
      throw new Error("LLM service unavailable");
    },
    parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
      return schema.parse(JSON.parse(content));
    },
  };
}

/** LLM client that fails the first N calls, then succeeds. */
function makeEventuallySucceedingLLMClient(failFirst: number, callDelayMs = 5): ILLMClient & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() { return callCount; },
    async sendMessage(_messages: LLMMessage[], _options?: LLMRequestOptions): Promise<LLMResponse> {
      callCount++;
      await new Promise((res) => setTimeout(res, callDelayMs));
      if (callCount <= failFirst) {
        throw new Error(`Simulated failure attempt ${callCount}`);
      }
      return {
        content: '{"verdict":"pass","reasoning":"eventually ok","criteria_met":1,"criteria_total":1}',
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
      return schema.parse(JSON.parse(content));
    },
  };
}

// ─── Test Suite ───

describe("completion_judger timeout + retry", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let sessionManager: SessionManager;
  let trustManager: TrustManager;
  let stallDetector: StallDetector;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-cjt-");
    stateManager = new StateManager(tmpDir);
    sessionManager = new SessionManager(stateManager);
    trustManager = new TrustManager(stateManager);
    stallDetector = new StallDetector(stateManager);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  function makeDeps(llmClient: ILLMClient, overrides: Partial<VerifierDeps> = {}): VerifierDeps {
    return {
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      stallDetector,
      durationToMs: (d) => d.value * (d.unit === "hours" ? 3_600_000 : 60_000),
      ...overrides,
    };
  }

  // ─────────────────────────────────────
  // Timeout
  // ─────────────────────────────────────

  it("returns a clear error state when LLM call times out (no hang)", async () => {
    // LLM takes 200ms but timeout is 50ms → should time out
    const slowLLM = makeSlowLLMClient(200);

    const deps = makeDeps(slowLLM, {
      completionJudgerConfig: { timeoutMs: 50, maxRetries: 0, retryBackoffMs: 0 },
    });

    const task = makeTask();
    const result = await verifyTask(deps, task, makeExecutionResult());

    // Should return a failed verdict, not hang
    expect(result.verdict).toBe("fail");
    // The description should mention timeout or failure
    const desc = result.evidence.find((e) => e.layer === "independent_review")?.description ?? "";
    expect(desc).toMatch(/timeout|failed/i);
  }, 2_000 /* 2 second wall-clock limit to confirm no hang */);

  it("skips completion judging for timed-out AgentLoop tasks without mechanical salvage evidence", async () => {
    const failingLLM = makeFailingLLMClient(1);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const deps = makeDeps(failingLLM, {
      logger: logger as never,
      completionJudgerConfig: { timeoutMs: 30_000, maxRetries: 2, retryBackoffMs: 1_000 },
    });
    const task = {
      ...makeTask(),
      artifact_contract: {
        required: true,
        required_artifacts: [{
          kind: "metrics_json" as const,
          path: "experiments/hgb_cv_auc_fast/metrics.json",
          required_fields: ["roc_auc"],
          fresh_after_task_start: true,
        }],
      },
    };
    const result = await verifyTask(deps, task, {
      ...makeExecutionResult(),
      success: false,
      output: "timeout",
      error: "wall clock timeout",
      stopped_reason: "timeout",
      agentLoop: {
        traceId: "trace-1",
        sessionId: "session-1",
        turnId: "turn-1",
        stopReason: "timeout",
        modelTurns: 2,
        toolCalls: 3,
        compactions: 0,
        generatedEstimateMs: 45 * 60_000,
        activeBudgetMs: 50 * 60_000,
      },
    });

    expect(failingLLM.callCount).toBe(0);
    expect(result.verdict).toBe("fail");
    const reviewEvidence = result.evidence.find((e) => e.layer === "independent_review");
    expect(reviewEvidence?.description).toContain("completion judging skipped");
    expect(reviewEvidence?.description).toContain("generated estimate: 2700000ms");
    expect(reviewEvidence?.description).toContain("active budget: 3000000ms");
    expect(result.artifact_contract_status).toMatchObject({
      applicable: true,
      passed: false,
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Skipping completion judging"),
      expect.objectContaining({ taskId: task.id })
    );
  }, 2_000);

  it("skips completion judging for AgentLoop finalization errors when artifact evidence passes", async () => {
    const workspace = `${tmpDir}/kaggle-workspace`;
    fs.mkdirSync(`${workspace}/reports`, { recursive: true });
    fs.mkdirSync(`${workspace}/submissions`, { recursive: true });
    fs.writeFileSync(`${workspace}/reports/group_target_encoding_auc.json`, JSON.stringify({
      roc_auc: 0.531,
      fold_roc_auc: [0.5, 0.56, 0.51],
      target_encoding_features: ["te_Driver"],
      model_params: { max_iter: 5 },
      output_paths: { metrics_json: "reports/group_target_encoding_auc.json" },
    }), "utf8");
    fs.writeFileSync(`${workspace}/submissions/group_target_encoding_auc.csv`, "id,PitNextLap\n1,0.1\n", "utf8");

    const failingLLM = makeFailingLLMClient(1);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const deps = makeDeps(failingLLM, {
      logger: logger as never,
      completionJudgerConfig: { timeoutMs: 30_000, maxRetries: 2, retryBackoffMs: 1_000 },
    });
    const task = {
      ...makeTask(),
      created_at: "2020-01-01T00:00:00.000Z",
      started_at: "2020-01-01T00:00:00.000Z",
      constraints: [`workspace_path:${workspace}`],
      success_criteria: [
        {
          description: "Manual artifact review",
          verification_method: "Manual review",
          is_blocking: true,
        },
      ],
      artifact_contract: {
        required: true,
        required_artifacts: [
          {
            kind: "metrics_json" as const,
            path: "reports/group_target_encoding_auc.json",
            required_fields: ["roc_auc", "fold_roc_auc", "target_encoding_features", "model_params", "output_paths"],
            field_types: {
              roc_auc: "number" as const,
              fold_roc_auc: "array" as const,
              target_encoding_features: "array" as const,
              model_params: "object" as const,
              output_paths: "object" as const,
            },
            fresh_after_task_start: true,
          },
          {
            kind: "submission_csv" as const,
            path: "submissions/group_target_encoding_auc.csv",
            required_fields: [],
            fresh_after_task_start: true,
          },
        ],
      },
    };

    const result = await verifyTask(deps, task, {
      ...makeExecutionResult(),
      success: false,
      output: "{\"status\":\"done\",\"finalAnswer\":\"done\"}",
      error: "{\"status\":\"done\",\"finalAnswer\":\"done\"}",
      stopped_reason: "error",
      agentLoop: {
        traceId: "trace-1",
        sessionId: "session-1",
        turnId: "turn-1",
        stopReason: "max_model_turns",
        failureReason: "max_model_turns",
        modelTurns: 12,
        toolCalls: 12,
        compactions: 0,
        completionEvidence: ["verified command: .venv/bin/python src/experiments/train_group_target_encoding_auc.py --contract-check"],
        executionCwd: workspace,
      },
    });

    expect(failingLLM.callCount).toBe(0);
    expect(result.verdict).toBe("pass");
    expect(result.artifact_contract_status).toMatchObject({
      applicable: true,
      passed: true,
    });
    expect(result.evidence.find((e) => e.layer === "independent_review")?.description).toContain("completion judging skipped");
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Skipping completion judging"),
      expect.objectContaining({ taskId: task.id, agentLoopStopReason: "max_model_turns" })
    );
  }, 2_000);

  it("salvages a blocked AgentLoop final answer when artifact evidence passes", async () => {
    const workspace = `${tmpDir}/blocked-artifact-workspace`;
    fs.mkdirSync(`${workspace}/reports`, { recursive: true });
    fs.mkdirSync(`${workspace}/scripts`, { recursive: true });
    fs.writeFileSync(`${workspace}/reports/judger.json`, JSON.stringify({
      scenario: "completion-judger-fallback",
      passed: true,
    }), "utf8");
    fs.writeFileSync(`${workspace}/scripts/judger-canary.mjs`, [
      "import fs from 'node:fs';",
      "const report = JSON.parse(fs.readFileSync('reports/judger.json', 'utf8'));",
      "if (report.scenario !== 'completion-judger-fallback' || report.passed !== true) process.exit(1);",
      "",
    ].join("\n"), "utf8");

    const failingLLM = makeFailingLLMClient(1);
    const deps = makeDeps(failingLLM, {
      completionJudgerConfig: { timeoutMs: 30_000, maxRetries: 0, retryBackoffMs: 0 },
    });
    const task = {
      ...makeTask(),
      created_at: "2020-01-01T00:00:00.000Z",
      started_at: "2020-01-01T00:00:00.000Z",
      constraints: [`workspace_path:${workspace}`],
      success_criteria: [
        {
          description: "Run the canary contract check",
          verification_method: "node scripts/judger-canary.mjs --check-contract",
          is_blocking: true,
        },
      ],
      artifact_contract: {
        required: true,
        required_artifacts: [{
          kind: "metrics_json" as const,
          path: "reports/judger.json",
          required_fields: ["scenario", "passed"],
          field_types: {
            scenario: "string" as const,
            passed: "boolean" as const,
          },
          fresh_after_task_start: true,
        }],
      },
    };

    const result = await verifyTask(deps, task, {
      ...makeExecutionResult(),
      success: false,
      output: "{\"status\":\"blocked\",\"finalAnswer\":\"workspace was read-only\"}",
      error: "{\"status\":\"blocked\",\"finalAnswer\":\"workspace was read-only\"}",
      stopped_reason: "blocked",
      filesChanged: true,
      filesChangedPaths: ["reports/judger.json"],
      agentLoop: {
        traceId: "trace-1",
        sessionId: "session-1",
        turnId: "turn-1",
        stopReason: "completed",
        modelTurns: 2,
        toolCalls: 0,
        compactions: 0,
        executionCwd: workspace,
        filesChangedPaths: ["reports/judger.json"],
      },
    });

    expect(failingLLM.callCount).toBe(0);
    expect(result.verdict).toBe("pass");
    expect(result.artifact_contract_status).toMatchObject({
      applicable: true,
      passed: true,
    });
    expect(result.evidence.find((e) => e.layer === "independent_review")?.description).toContain("completion judging skipped");
  }, 2_000);

  it("salvages a completion-gate failure when changed files pass blocking mechanical verification", async () => {
    const workspace = `${tmpDir}/completion-gate-mechanical-workspace`;
    fs.mkdirSync(`${workspace}/reports`, { recursive: true });
    fs.mkdirSync(`${workspace}/scripts`, { recursive: true });
    fs.writeFileSync(`${workspace}/reports/judger.json`, JSON.stringify({
      scenario: "completion-judger-fallback",
      passed: true,
    }), "utf8");
    fs.writeFileSync(`${workspace}/scripts/judger-canary.mjs`, [
      "import fs from 'node:fs';",
      "const report = JSON.parse(fs.readFileSync('reports/judger.json', 'utf8'));",
      "if (report.scenario !== 'completion-judger-fallback' || report.passed !== true) process.exit(1);",
      "",
    ].join("\n"), "utf8");

    const failingLLM = makeFailingLLMClient(1);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const deps = makeDeps(failingLLM, {
      logger: logger as never,
      completionJudgerConfig: { timeoutMs: 30_000, maxRetries: 0, retryBackoffMs: 0 },
    });
    const task = {
      ...makeTask(),
      constraints: [`workspace_path:${workspace}`],
      success_criteria: [
        {
          description: "Run the canary contract check",
          verification_method: "node scripts/judger-canary.mjs --check-contract",
          is_blocking: true,
        },
      ],
    };

    const result = await verifyTask(deps, task, {
      ...makeExecutionResult(),
      success: false,
      output: "{\"status\":\"done\",\"finalAnswer\":\"claimed verification without observed tool call\"}",
      error: "{\"status\":\"done\",\"finalAnswer\":\"claimed verification without observed tool call\"}",
      stopped_reason: "error",
      filesChanged: true,
      filesChangedPaths: ["reports/judger.json", "scripts/judger-canary.mjs"],
      agentLoop: {
        traceId: "trace-1",
        sessionId: "session-1",
        turnId: "turn-1",
        stopReason: "completion_gate_failed",
        failureReason: "completion_gate_failed",
        modelTurns: 5,
        toolCalls: 0,
        compactions: 0,
        executionCwd: workspace,
        filesChangedPaths: ["reports/judger.json", "scripts/judger-canary.mjs"],
      },
    });

    expect(failingLLM.callCount).toBe(0);
    expect(result.verdict).toBe("pass");
    expect(result.evidence.find((e) => e.layer === "mechanical")?.description)
      .toContain("node scripts/judger-canary.mjs --check-contract");
    expect(result.evidence.find((e) => e.layer === "independent_review")?.description)
      .toContain("completion judging skipped");
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Skipping completion judging"),
      expect.objectContaining({ taskId: task.id, agentLoopStopReason: "completion_gate_failed" })
    );
  }, 2_000);

  it("uses passing artifact evidence when completion judging is unavailable after successful execution", async () => {
    const workspace = `${tmpDir}/artifact-workspace`;
    fs.mkdirSync(`${workspace}/reports`, { recursive: true });
    fs.mkdirSync(`${workspace}/submissions`, { recursive: true });
    fs.writeFileSync(`${workspace}/reports/order_rank_blend_auc.json`, JSON.stringify({
      created_at: "2026-05-07T12:43:36.000Z",
      run_name: "order_rank_blend_auc",
      roc_auc: 0.924,
      mean_roc_auc: 0.924,
      output_paths: { metrics_json: "reports/order_rank_blend_auc.json" },
    }), "utf8");
    fs.writeFileSync(`${workspace}/submissions/order_rank_blend_auc.csv`, "id,PitNextLap\n1,0.1\n", "utf8");

    const failingLLM = makeFailingLLMClient(1);
    const deps = makeDeps(failingLLM, {
      completionJudgerConfig: { timeoutMs: 5_000, maxRetries: 0, retryBackoffMs: 0 },
    });
    const task = {
      ...makeTask(),
      created_at: "2020-01-01T00:00:00.000Z",
      started_at: "2020-01-01T00:00:00.000Z",
      success_criteria: [
        {
          description: "Artifact contract validates",
          verification_method: "manual artifact review",
          is_blocking: true,
        },
      ],
      artifact_contract: {
        required: true,
        required_artifacts: [
          {
            kind: "metrics_json" as const,
            path: "reports/order_rank_blend_auc.json",
            required_fields: ["created_at", "run_name", "roc_auc", "mean_roc_auc", "output_paths"],
            field_types: {
              created_at: "string" as const,
              run_name: "string" as const,
              roc_auc: "number" as const,
              mean_roc_auc: "number" as const,
              output_paths: "object" as const,
            },
            fresh_after_task_start: true,
          },
          {
            kind: "submission_csv" as const,
            path: "submissions/order_rank_blend_auc.csv",
            required_fields: ["id", "PitNextLap"],
            fresh_after_task_start: true,
          },
        ],
      },
    };

    const result = await verifyTask(deps, task, {
      ...makeExecutionResult(),
      agentLoop: {
        traceId: "trace-1",
        sessionId: "session-1",
        turnId: "turn-1",
        stopReason: "completed",
        modelTurns: 6,
        toolCalls: 10,
        compactions: 0,
        executionCwd: workspace,
      },
    });

    expect(failingLLM.callCount).toBe(1);
    expect(result.verdict).toBe("pass");
    expect(result.confidence).toBe(0.85);
    expect(result.artifact_contract_status).toMatchObject({
      applicable: true,
      passed: true,
    });
    const reviewEvidence = result.evidence.find((e) => e.layer === "independent_review");
    expect(reviewEvidence?.description).toContain("completion_judger failed after 1 attempt");
    expect(reviewEvidence?.description).toContain("using passing mechanical/artifact evidence");
  }, 5_000);

  it("treats PulSeed artifact_contract freshness as authoritative when script check-contract reports stale artifacts", async () => {
    const workspace = path.join(tmpDir, "freshness-workspace");
    fs.mkdirSync(path.join(workspace, ".venv", "bin"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "src", "experiments"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "reports"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "submissions"), { recursive: true });

    const pythonShim = path.join(workspace, ".venv", "bin", "python");
    fs.writeFileSync(pythonShim, [
      "#!/bin/sh",
      "echo 'contract validation failed:' >&2",
      "echo 'stale artifact: reports/fresh_auc.json' >&2",
      "echo 'stale artifact: submissions/fresh_auc.csv' >&2",
      "exit 1",
      "",
    ].join("\n"), "utf8");
    fs.chmodSync(pythonShim, 0o755);
    fs.writeFileSync(path.join(workspace, "src", "experiments", "check_contract.py"), "", "utf8");
    fs.writeFileSync(path.join(workspace, "reports", "fresh_auc.json"), JSON.stringify({
      created_at: "2026-05-07T13:07:20.000Z",
      run_name: "fresh_auc",
      roc_auc: 0.815,
      mean_roc_auc: 0.815,
      std_roc_auc: 0.01,
      output_paths: { metrics_json: "reports/fresh_auc.json", submission_csv: "submissions/fresh_auc.csv" },
    }), "utf8");
    fs.writeFileSync(path.join(workspace, "submissions", "fresh_auc.csv"), "id,PitNextLap\n1,0.2\n", "utf8");

    const failingLLM = makeFailingLLMClient(1);
    const deps = makeDeps(failingLLM, {
      completionJudgerConfig: { timeoutMs: 5_000, maxRetries: 0, retryBackoffMs: 0 },
    });
    const task = {
      ...makeTask(),
      created_at: "2020-01-01T00:00:00.000Z",
      started_at: "2020-01-01T00:00:00.000Z",
      constraints: [`workspace_path:${workspace}`],
      success_criteria: [
        {
          description: "Script contract validates artifacts",
          verification_method: ".venv/bin/python src/experiments/check_contract.py --check-contract",
          is_blocking: true,
        },
      ],
      artifact_contract: {
        required: true,
        required_artifacts: [
          {
            kind: "metrics_json" as const,
            path: "reports/fresh_auc.json",
            required_fields: ["created_at", "run_name", "roc_auc", "mean_roc_auc", "std_roc_auc", "output_paths"],
            field_types: {
              created_at: "string" as const,
              run_name: "string" as const,
              roc_auc: "number" as const,
              mean_roc_auc: "number" as const,
              std_roc_auc: "number" as const,
              output_paths: "object" as const,
            },
            fresh_after_task_start: true,
          },
          {
            kind: "submission_csv" as const,
            path: "submissions/fresh_auc.csv",
            required_fields: [],
            fresh_after_task_start: true,
          },
        ],
      },
    };

    const result = await verifyTask(deps, task, {
      ...makeExecutionResult(),
      agentLoop: {
        traceId: "trace-1",
        sessionId: "session-1",
        turnId: "turn-1",
        stopReason: "completed",
        modelTurns: 6,
        toolCalls: 10,
        compactions: 0,
        executionCwd: workspace,
      },
    });

    expect(failingLLM.callCount).toBe(0);
    expect(result.verdict).toBe("pass");
    expect(result.confidence).toBe(0.9);
    expect(result.artifact_contract_status).toMatchObject({
      applicable: true,
      passed: true,
    });
    expect(result.evidence.find((e) => e.layer === "mechanical")?.description).toContain(
      "mechanical --check-contract reported a stale-artifact freshness failure"
    );
    expect(result.evidence.find((e) => e.layer === "independent_review")?.description).toContain(
      "PulSeed artifact_contract is authoritative"
    );
  }, 5_000);

  // ─────────────────────────────────────
  // Retry count
  // ─────────────────────────────────────

  it("retries the specified number of times before giving up", async () => {
    const failingLLM = makeFailingLLMClient(5);

    const deps = makeDeps(failingLLM, {
      completionJudgerConfig: { timeoutMs: 5_000, maxRetries: 2, retryBackoffMs: 0 },
    });

    const task = makeTask();
    await verifyTask(deps, task, makeExecutionResult());

    // 1 initial attempt + 2 retries = 3 total calls
    // (Note: verifyTask calls runLLMReview once; a retry case re-calls it for L1 pass + L2 fail,
    //  but here we're interested in the retry within a single runLLMReview call)
    // The failing LLM records how many times sendMessage was called
    expect(failingLLM.callCount).toBe(3);
  }, 5_000);

  it("succeeds if a retry eventually returns a valid response", async () => {
    // First 1 call fails, 2nd call succeeds
    const eventualLLM = makeEventuallySucceedingLLMClient(1, 5);

    const deps = makeDeps(eventualLLM, {
      completionJudgerConfig: { timeoutMs: 5_000, maxRetries: 2, retryBackoffMs: 0 },
    });

    const task = makeTask();
    const result = await verifyTask(deps, task, makeExecutionResult());

    // Should succeed — no mechanical criterion so L2 decides alone
    // With L1 skipped + L2 pass → "pass" verdict
    expect(result.verdict).toBe("pass");
    // Exactly 2 calls: 1 fail + 1 success
    expect(eventualLLM.callCount).toBe(2);
  }, 5_000);

  // ─────────────────────────────────────
  // Exponential backoff timing
  // ─────────────────────────────────────

  it("applies exponential backoff between retries", async () => {
    const failingLLM = makeFailingLLMClient(1);
    const timestamps: number[] = [];

    // Wrap the sendMessage to record call timestamps
    const origSend = failingLLM.sendMessage.bind(failingLLM);
    failingLLM.sendMessage = async (messages, options) => {
      timestamps.push(Date.now());
      return origSend(messages, options);
    };

    const retryBackoffMs = 50;
    const deps = makeDeps(failingLLM, {
      completionJudgerConfig: { timeoutMs: 5_000, maxRetries: 2, retryBackoffMs },
    });

    // Actually run the test with the patched deps
    const task = makeTask();
    timestamps.length = 0;

    const patchedLLM = makeFailingLLMClient(1);
    const ts: number[] = [];
    patchedLLM.sendMessage = async (messages, options) => {
      ts.push(Date.now());
      // Always throw to measure all retry gaps
      await new Promise((res) => setTimeout(res, 1));
      throw new Error("always fail");
    };

    const patchedDeps = makeDeps(patchedLLM, {
      completionJudgerConfig: { timeoutMs: 5_000, maxRetries: 2, retryBackoffMs },
    });

    await verifyTask(patchedDeps, task, makeExecutionResult());

    expect(ts.length).toBe(3); // 1 initial + 2 retries

    // Gap between attempt 0→1 should be ~retryBackoffMs (backoff * 2^0 = 50ms)
    // Gap between attempt 1→2 should be ~retryBackoffMs * 2 (backoff * 2^1 = 100ms)
    if (ts.length >= 3) {
      const gap01 = ts[1]! - ts[0]!;
      const gap12 = ts[2]! - ts[1]!;
      // Allow generous tolerance for CI timing variance
      expect(gap01).toBeGreaterThanOrEqual(retryBackoffMs * 0.5);
      expect(gap12).toBeGreaterThanOrEqual(gap01 * 0.8); // second gap >= first gap (exponential)
    }
  }, 10_000);

  // ─────────────────────────────────────
  // Clear error on final failure
  // ─────────────────────────────────────

  it("returns verdict=fail with descriptive message on final failure (no silent hang)", async () => {
    const failingLLM = makeFailingLLMClient(1);

    const deps = makeDeps(failingLLM, {
      completionJudgerConfig: { timeoutMs: 5_000, maxRetries: 1, retryBackoffMs: 0 },
    });

    const task = makeTask();
    const result = await verifyTask(deps, task, makeExecutionResult());

    expect(result.verdict).toBe("fail");
    const reviewEvidence = result.evidence.find((e) => e.layer === "independent_review");
    expect(reviewEvidence).toBeDefined();
    // description should mention "failed" and attempt count
    expect(reviewEvidence!.description).toMatch(/failed.*attempt/i);
    // confidence should be very low (0.0) on final failure
    expect(reviewEvidence!.confidence).toBe(0.0);
  }, 5_000);

  // ─────────────────────────────────────
  // Default config (no hang by default)
  // ─────────────────────────────────────

  it("uses sane defaults when no completionJudgerConfig is provided", () => {
    // Verifies that VerifierDeps without completionJudgerConfig does not throw during construction
    const llm = makeSlowLLMClient(1, '{"verdict":"pass","reasoning":"ok","criteria_met":1,"criteria_total":1}');
    const deps = makeDeps(llm); // no completionJudgerConfig
    // Just verify the deps object is valid (no config error)
    expect(deps.completionJudgerConfig).toBeUndefined();
  });
});
