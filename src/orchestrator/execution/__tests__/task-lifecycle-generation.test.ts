import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { StateManager } from "../../../base/state/state-manager.js";
import { SessionManager } from "../session-manager.js";
import { TrustManager } from "../../../platform/traits/trust-manager.js";
import { StrategyManager } from "../../strategy/strategy-manager.js";
import { StallDetector } from "../../../platform/drive/stall-detector.js";
import { TaskLifecycle } from "../task/task-lifecycle.js";
import type { Task } from "../../../base/types/task.js";
import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
} from "../../../base/llm/llm-client.js";
import { saveDreamConfig } from "../../../platform/dream/dream-config.js";
import { upsertDreamPlaybook } from "../../../platform/dream/playbook-memory.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { makeGoal } from "../../../../tests/helpers/fixtures.js";
import { RuntimeOperatorHandoffStore } from "../../../runtime/store/operator-handoff-store.js";

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

const VALID_TASK_RESPONSE = `\`\`\`json
{
  "work_description": "Write unit tests for the authentication module",
  "rationale": "Improve test coverage to catch regressions early",
  "approach": "Use vitest to write tests for login, logout, and token refresh flows",
  "success_criteria": [
    {
      "description": "All auth flows have at least one test",
      "verification_method": "Run vitest and check test count",
      "is_blocking": true
    }
  ],
  "scope_boundary": {
    "in_scope": ["auth module tests"],
    "out_of_scope": ["auth module implementation changes"],
    "blast_radius": "tests/ directory only"
  },
  "constraints": ["Must not modify production code"],
  "artifact_contract": {
    "required": false,
    "required_artifacts": []
  },
  "reversibility": "reversible",
  "estimated_duration": { "value": 2, "unit": "hours" }
}
\`\`\``;

const UNKNOWN_REVERSIBILITY_RESPONSE = `\`\`\`json
{
  "work_description": "Refactor config loading",
  "rationale": "Simplify configuration management",
  "approach": "Consolidate config files",
  "success_criteria": [
    {
      "description": "Config loads correctly",
      "verification_method": "Integration test",
      "is_blocking": true
    }
  ],
  "scope_boundary": {
    "in_scope": ["config loading"],
    "out_of_scope": ["feature flags"],
    "blast_radius": "startup flow"
  },
  "constraints": [],
  "artifact_contract": {
    "required": false,
    "required_artifacts": []
  },
  "reversibility": "unknown",
  "estimated_duration": null
}
\`\`\``;

const HEREDOC_VERIFICATION_RESPONSE = `\`\`\`json
{
  "work_description": "Create a Kaggle metrics contract check",
  "rationale": "Fresh metrics must be verified",
  "approach": "Write a report and validate it",
  "success_criteria": [
    {
      "description": "Report contains roc_auc",
      "verification_method": "python - <<'PY'\\nimport json\\nprint(json.load(open('reports/run.json'))['roc_auc'])\\nPY",
      "is_blocking": true
    }
  ],
  "scope_boundary": {
    "in_scope": ["reports/run.json"],
    "out_of_scope": [],
    "blast_radius": "low"
  },
  "constraints": [],
  "artifact_contract": {
    "required": true,
    "required_artifacts": [
      {
        "kind": "metrics_json",
        "path": "reports/run.json",
        "required_fields": ["roc_auc"],
        "field_types": { "roc_auc": "number" },
        "fresh_after_task_start": true
      },
      {
        "kind": "submission_csv",
        "path": "submissions/run.csv",
        "required_fields": [],
        "field_types": {},
        "fresh_after_task_start": true
      }
    ]
  },
  "reversibility": "reversible",
  "estimated_duration": { "value": 1, "unit": "hours" }
}
\`\`\``;

const WORKSPACE_ARTIFACT_WITH_BROAD_REPO_TEST_RESPONSE = `\`\`\`json
{
  "work_description": "Create fresh and stale accuracy metrics artifacts in experiments/",
  "rationale": "The goal observes fresh workspace artifact evidence",
  "approach": "Write the fresh metrics artifact and keep the stale comparison artifact in the disposable workspace",
  "success_criteria": [
    {
      "description": "Fresh and stale metrics files exist",
      "verification_method": "test -f experiments/fresh/metrics.json && test -f experiments/stale/metrics.json",
      "is_blocking": true
    },
    {
      "description": "Repository tests pass",
      "verification_method": "npx vitest run",
      "is_blocking": true
    },
    {
      "description": "Workspace contract check passes",
      "verification_method": "python src/experiments/run.py --check-contract",
      "is_blocking": true
    },
    {
      "description": "Non-local PulSeed module check passes",
      "verification_method": "python -m pulseed observe --check-contract",
      "is_blocking": true
    }
  ],
  "scope_boundary": {
    "in_scope": ["experiments/fresh/metrics.json", "experiments/stale/metrics.json"],
    "out_of_scope": ["PulSeed source changes"],
    "blast_radius": "disposable workspace artifacts only"
  },
  "constraints": [],
  "artifact_contract": {
    "required": true,
    "required_artifacts": [
      {
        "kind": "metrics_json",
        "path": "experiments/fresh/metrics.json",
        "required_fields": ["accuracy"],
        "field_types": { "accuracy": "number" },
        "fresh_after_task_start": true
      }
    ]
  },
  "reversibility": "reversible",
  "intended_direction": "increase",
  "estimated_duration": null
}
\`\`\``;

const WORKSPACE_ARTIFACT_WITH_CREATED_CHECK_CONTRACT_RESPONSE = `\`\`\`json
{
  "work_description": "Create a local canary script and report artifact",
  "rationale": "The task should verify the artifact with the script it creates",
  "approach": "Write scripts/judger-canary.mjs and run its --check-contract mode",
  "success_criteria": [
    {
      "description": "Workspace contract check passes",
      "verification_method": "node scripts/judger-canary.mjs --check-contract",
      "is_blocking": true
    }
  ],
  "scope_boundary": {
    "in_scope": ["scripts/judger-canary.mjs", "reports/judger.json"],
    "out_of_scope": ["PulSeed source changes"],
    "blast_radius": "disposable workspace artifacts only"
  },
  "constraints": [],
  "artifact_contract": {
    "required": true,
    "required_artifacts": [
      {
        "kind": "metrics_json",
        "path": "reports/judger.json",
        "required_fields": ["scenario", "passed"],
        "field_types": { "scenario": "string", "passed": "boolean" },
        "fresh_after_task_start": true
      }
    ]
  },
  "reversibility": "reversible",
  "estimated_duration": null
}
\`\`\``;

// ─── Test Suite ───

function expectTask(task: Task | null): Task {
  if (!task) {
    throw new Error("Expected generateTask() to return a task");
  }
  return task;
}

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
      adapterRegistry?: import("../task/task-lifecycle.js").AdapterRegistry;
      execFileSyncFn?: (cmd: string, args: string[], opts: { cwd: string; encoding: "utf-8" }) => string;
      operatorHandoffStore?: RuntimeOperatorHandoffStore;
      revertCwd?: string;
    }
  ): TaskLifecycle {
    strategyManager = new StrategyManager(stateManager, llmClient);
    return new TaskLifecycle(
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      options
    );
  }

  // ─────────────────────────────────────────────
  // generateTask
  // ─────────────────────────────────────────────

  describe("generateTask", async () => {
    it("calls LLM with a prompt containing goalId and targetDimension", async () => {
      const spy = createSpyLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(spy);

      await lifecycle.generateTask("goal-42", "test_coverage");

      expect(spy.calls.length).toBe(1);
      const userMessage = spy.calls[0]!.messages[0]!.content;
      expect(userMessage).toContain("test_coverage");
      expect(userMessage).toContain("goal-42");
    });

    it("tells generated check-contract validators to use PulSeed task-start freshness", async () => {
      const spy = createSpyLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(spy);

      await lifecycle.generateTask("goal-42", "roc_auc");

      const userMessage = spy.calls[0]!.messages[0]!.content;
      expect(userMessage).toContain("PulSeed enforces fresh_after_task_start relative to the task start time");
      expect(userMessage).toContain("script validators should regenerate missing or schema-invalid artifacts");
    });

    it("builds repository prompt context from goal workspace_path instead of daemon cwd", async () => {
      const spy = createSpyLLMClient([VALID_TASK_RESPONSE]);
      const daemonDir = path.join(tmpDir, "daemon-repo");
      const workspaceDir = path.join(tmpDir, "workspace-repo");
      fs.mkdirSync(daemonDir, { recursive: true });
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.writeFileSync(
        path.join(daemonDir, "package.json"),
        JSON.stringify({
          name: "daemon-package",
          description: "context from daemon cwd",
        }),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(workspaceDir, "package.json"),
        JSON.stringify({
          name: "workspace-package",
          description: "context from goal workspace",
        }),
        "utf-8",
      );
      await stateManager.saveGoal(makeGoal({
        id: "goal-workspace-context",
        title: "Improve workspace context",
        constraints: [`workspace_path:${workspaceDir}`],
      }));
      const lifecycle = createLifecycle(spy, { revertCwd: daemonDir });

      await lifecycle.generateTask("goal-workspace-context", "test_coverage", undefined, undefined, "openai_codex_cli");

      expect(spy.calls.length).toBe(1);
      const userMessage = spy.calls[0]!.messages[0]!.content;
      expect(userMessage).toContain("Project name: workspace-package");
      expect(userMessage).toContain("Project description: context from goal workspace");
      expect(userMessage).not.toContain("daemon-package");
      expect(userMessage).not.toContain("context from daemon cwd");
    });

    it("does not carry unsupported verification commands into workspace-bound artifact tasks", async () => {
      const llm = createMockLLMClient([WORKSPACE_ARTIFACT_WITH_BROAD_REPO_TEST_RESPONSE]);
      const daemonDir = path.join(tmpDir, "daemon-repo");
      const workspaceDir = path.join(tmpDir, "disposable-workspace");
      fs.mkdirSync(daemonDir, { recursive: true });
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.writeFileSync(
        path.join(daemonDir, "package.json"),
        JSON.stringify({ name: "pulseed-daemon-repo" }),
        "utf-8",
      );
      await stateManager.saveGoal(makeGoal({
        id: "goal-workspace-artifact",
        title: "Observe fresh accuracy artifact",
        constraints: [`workspace_path:${workspaceDir}`, "artifact_contract:required"],
      }));
      const lifecycle = createLifecycle(llm, { revertCwd: daemonDir });

      const task = expectTask(await lifecycle.generateTask(
        "goal-workspace-artifact",
        "accuracy",
        undefined,
        undefined,
        "openai_codex_cli"
      ));

      expect(task.constraints).toContain(`workspace_path:${workspaceDir}`);
      expect(task.success_criteria.map((criterion) => criterion.verification_method)).toEqual([
        "test -f experiments/fresh/metrics.json && test -f experiments/stale/metrics.json",
      ]);
      expect(task.artifact_contract).toMatchObject({
        required: true,
        required_artifacts: [
          {
            path: "experiments/fresh/metrics.json",
            required_fields: ["accuracy"],
          },
        ],
      });
    });

    it("keeps a workspace-local check-contract verifier when the task scope creates that script", async () => {
      const llm = createMockLLMClient([WORKSPACE_ARTIFACT_WITH_CREATED_CHECK_CONTRACT_RESPONSE]);
      const daemonDir = path.join(tmpDir, "daemon-repo");
      const workspaceDir = path.join(tmpDir, "disposable-workspace");
      fs.mkdirSync(daemonDir, { recursive: true });
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.writeFileSync(
        path.join(daemonDir, "package.json"),
        JSON.stringify({ name: "pulseed-daemon-repo" }),
        "utf-8",
      );
      await stateManager.saveGoal(makeGoal({
        id: "goal-workspace-created-check",
        title: "Create a checked canary report",
        constraints: [`workspace_path:${workspaceDir}`, "artifact_contract:required"],
      }));
      const lifecycle = createLifecycle(llm, { revertCwd: daemonDir });

      const task = expectTask(await lifecycle.generateTask(
        "goal-workspace-created-check",
        "judger_report_exists",
        undefined,
        undefined,
        "openai_codex_cli"
      ));

      expect(task.constraints).toContain(`workspace_path:${workspaceDir}`);
      expect(task.success_criteria.map((criterion) => criterion.verification_method)).toEqual([
        "node scripts/judger-canary.mjs --check-contract",
      ]);
      expect(task.scope_boundary.in_scope).toContain("scripts/judger-canary.mjs");
    });

    it("does not inject learned pattern hints when verified-only planner mode is enabled", async () => {
      const spy = createSpyLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(spy);

      await stateManager.saveGoal({
        id: "goal-42",
        title: "Improve onboarding completion",
        description: "Reduce user drop-off during signup",
        status: "active",
        dimensions: [],
        parent_id: null,
        child_goal_ids: [],
        success_criteria: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as any);
      await stateManager.writeRaw("learning/goal-42_patterns.json", [
        {
          pattern_id: "pat-1",
          type: "task_generation",
          description: "Use step-by-step signup hints before proposing new UI changes",
          confidence: 0.82,
          evidence_count: 4,
          source_goal_ids: ["goal-42"],
          applicable_domains: ["signup", "onboarding"],
          embedding_id: null,
          created_at: new Date().toISOString(),
          last_applied_at: null,
        },
      ]);
      await saveDreamConfig({
        activation: {
          verifiedPlannerHintsOnly: true,
          semanticWorkingMemory: false,
          crossGoalLessons: false,
          semanticContext: false,
          autoAcquireKnowledge: false,
          learnedPatternHints: true,
          playbookHints: false,
          workflowHints: false,
          strategyTemplates: false,
          decisionHeuristics: false,
          graphTraversal: false,
        },
      }, stateManager.getBaseDir());

      await lifecycle.generateTask("goal-42", "completion_rate");

      const userMessage = spy.calls[0]!.messages[0]!.content;
      expect(userMessage).not.toContain("Learned pattern hints");
      expect(userMessage).not.toContain("step-by-step signup hints");
    });

    it("does not inject workflow recovery hints when verified-only planner mode is enabled", async () => {
      const spy = createSpyLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(spy);

      await stateManager.saveGoal({
        id: "goal-42",
        title: "Improve daemon recovery",
        description: "Avoid repeated confidence stalls during verification",
        status: "active",
        dimensions: [],
        parent_id: null,
        child_goal_ids: [],
        success_criteria: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as any);
      await stateManager.writeRaw("dream/workflows.json", {
        version: "dream-workflows-v1",
        generated_at: new Date().toISOString(),
        workflows: [
          {
            workflow_id: "dream-workflow:test-stall",
            type: "stall_recovery",
            title: "Stall recovery: confidence stall",
            description: "Change strategy when verification confidence stalls.",
            applicability: {
              goal_ids: ["goal-42"],
              task_ids: [],
              event_types: ["StallDetected"],
              signals: ["confidence_stall", "verification"],
            },
            preconditions: ["A stall was detected."],
            steps: ["Pause repeated attempts.", "Inspect the verification signal.", "Change strategy."],
            failure_modes: ["confidence_stall"],
            recovery_steps: ["Re-plan before retrying."],
            evidence_refs: ["dream/events/goal-42.jsonl#L1"],
            evidence_count: 2,
            success_count: 0,
            failure_count: 2,
            confidence: 0.73,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      });
      await saveDreamConfig({
        activation: {
          verifiedPlannerHintsOnly: true,
          semanticWorkingMemory: false,
          crossGoalLessons: false,
          semanticContext: false,
          autoAcquireKnowledge: false,
          learnedPatternHints: false,
          playbookHints: false,
          workflowHints: true,
          strategyTemplates: false,
          decisionHeuristics: false,
          graphTraversal: false,
        },
      }, stateManager.getBaseDir());

      await lifecycle.generateTask("goal-42", "verification");

      const userMessage = spy.calls[0]!.messages[0]!.content;
      expect(userMessage).not.toContain("Workflow recovery hints");
      expect(userMessage).not.toContain("Stall recovery: confidence stall");
    });

    it("allows learned pattern hints when verified-only planner mode is explicitly disabled", async () => {
      const spy = createSpyLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(spy);

      await stateManager.saveGoal({
        id: "goal-42",
        title: "Improve onboarding completion",
        description: "Reduce user drop-off during signup",
        status: "active",
        dimensions: [],
        parent_id: null,
        child_goal_ids: [],
        success_criteria: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as any);
      await stateManager.writeRaw("learning/goal-42_patterns.json", [
        {
          pattern_id: "pat-1",
          type: "task_generation",
          description: "Use step-by-step signup hints before proposing new UI changes",
          confidence: 0.82,
          evidence_count: 4,
          source_goal_ids: ["goal-42"],
          applicable_domains: ["signup", "onboarding"],
          embedding_id: null,
          created_at: new Date().toISOString(),
          last_applied_at: null,
        },
      ]);
      await saveDreamConfig({
        activation: {
          verifiedPlannerHintsOnly: false,
          semanticWorkingMemory: false,
          crossGoalLessons: false,
          semanticContext: false,
          autoAcquireKnowledge: false,
          learnedPatternHints: true,
          playbookHints: false,
          workflowHints: false,
          strategyTemplates: false,
          decisionHeuristics: false,
          graphTraversal: false,
        },
      }, stateManager.getBaseDir());

      await lifecycle.generateTask("goal-42", "completion_rate");

      const userMessage = spy.calls[0]!.messages[0]!.content;
      expect(userMessage).toContain("Learned pattern hints");
      expect(userMessage).toContain("step-by-step signup hints");
    });

    it("allows workflow recovery hints when verified-only planner mode is explicitly disabled", async () => {
      const spy = createSpyLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(spy);

      await stateManager.saveGoal({
        id: "goal-42",
        title: "Improve daemon recovery",
        description: "Avoid repeated confidence stalls during verification",
        status: "active",
        dimensions: [],
        parent_id: null,
        child_goal_ids: [],
        success_criteria: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as any);
      await stateManager.writeRaw("dream/workflows.json", {
        version: "dream-workflows-v1",
        generated_at: new Date().toISOString(),
        workflows: [
          {
            workflow_id: "dream-workflow:test-stall",
            type: "stall_recovery",
            title: "Stall recovery: confidence stall",
            description: "Change strategy when verification confidence stalls.",
            applicability: {
              goal_ids: ["goal-42"],
              task_ids: [],
              event_types: ["StallDetected"],
              signals: ["confidence_stall", "verification"],
            },
            preconditions: ["A stall was detected."],
            steps: ["Pause repeated attempts.", "Inspect the verification signal.", "Change strategy."],
            failure_modes: ["confidence_stall"],
            recovery_steps: ["Re-plan before retrying."],
            evidence_refs: ["dream/events/goal-42.jsonl#L1"],
            evidence_count: 2,
            success_count: 0,
            failure_count: 2,
            confidence: 0.73,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      });
      await saveDreamConfig({
        activation: {
          verifiedPlannerHintsOnly: false,
          semanticWorkingMemory: false,
          crossGoalLessons: false,
          semanticContext: false,
          autoAcquireKnowledge: false,
          learnedPatternHints: false,
          playbookHints: false,
          workflowHints: true,
          strategyTemplates: false,
          decisionHeuristics: false,
          graphTraversal: false,
        },
      }, stateManager.getBaseDir());

      await lifecycle.generateTask("goal-42", "verification");

      const userMessage = spy.calls[0]!.messages[0]!.content;
      expect(userMessage).toContain("Workflow recovery hints");
      expect(userMessage).toContain("Stall recovery: confidence stall");
    });

    it("injects promoted playbook hints into task generation when playbook hints are enabled", async () => {
      const spy = createSpyLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(spy);

      await stateManager.saveGoal({
        id: "goal-42",
        title: "Stabilize provider config verification",
        description: "Keep the provider config boundary strict while fixing type errors",
        status: "active",
        dimensions: [],
        parent_id: null,
        child_goal_ids: [],
        success_criteria: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as any);
      await upsertDreamPlaybook(stateManager.getBaseDir(), {
        playbook_id: "dream-playbook-provider-config",
        status: "promoted",
        kind: "verified_execution",
        title: "Repair the provider config type boundary",
        summary: "Verified workflow for type_safety: repair the provider config boundary and rerun focused verification.",
        source_signature: "provider-config-boundary",
        applicability: {
          goal_ids: ["goal-42"],
          primary_dimensions: ["type_safety"],
          task_categories: ["verification"],
          terms: ["provider", "config", "boundary", "typecheck"],
        },
        preconditions: ["Constraint: Keep runtime validation strict"],
        recommended_steps: [
          "Repair the provider config type boundary",
          "Rerun focused typecheck before broadening scope",
        ],
        verification_checks: [
          {
            description: "Focused typecheck passes",
            verification_method: "npm run typecheck",
            blocking: true,
          },
        ],
        failure_warnings: ["Out of scope: broad runtime widening"],
        evidence_refs: ["Focused typecheck passed"],
        source_task_ids: ["task-provider-config"],
        verification: {
          verdict: "pass",
          confidence: 0.89,
          last_verified_at: new Date().toISOString(),
        },
        usage: {
          retrieved_count: 0,
          verified_success_count: 2,
          successful_reuse_count: 0,
          failed_reuse_count: 0,
        },
        governance: {
          created_by: "dream",
          review_state: "verified",
          auto_generated: true,
          user_editable: true,
          auto_mutation: "forbidden",
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await saveDreamConfig({
        activation: {
          verifiedPlannerHintsOnly: true,
          semanticWorkingMemory: false,
          crossGoalLessons: false,
          semanticContext: false,
          autoAcquireKnowledge: false,
          learnedPatternHints: false,
          playbookHints: true,
          workflowHints: false,
          strategyTemplates: false,
          decisionHeuristics: false,
          graphTraversal: false,
        },
      }, stateManager.getBaseDir());

      await lifecycle.generateTask("goal-42", "type_safety");

      const userMessage = spy.calls[0]!.messages[0]!.content;
      expect(userMessage).toContain("Verified playbook hints");
      expect(userMessage).toContain("Repair the provider config type boundary");
      expect(userMessage).toContain("Focused typecheck passes");
    });

    it("does not inject candidate or disabled playbooks into task generation", async () => {
      const spy = createSpyLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(spy);

      await stateManager.saveGoal({
        id: "goal-42",
        title: "Reduce drift in verification planning",
        description: "Prefer verified workflows over speculative recall",
        status: "active",
        dimensions: [],
        parent_id: null,
        child_goal_ids: [],
        success_criteria: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as any);
      const now = new Date().toISOString();
      await upsertDreamPlaybook(stateManager.getBaseDir(), {
        playbook_id: "dream-playbook-candidate",
        status: "candidate",
        kind: "verified_execution",
        title: "Candidate playbook should stay hidden",
        summary: "Candidate only",
        source_signature: "candidate-playbook",
        applicability: {
          goal_ids: ["goal-42"],
          primary_dimensions: ["verification"],
          task_categories: ["verification"],
          terms: ["candidate", "hidden"],
        },
        preconditions: [],
        recommended_steps: ["Candidate step"],
        verification_checks: [],
        failure_warnings: [],
        evidence_refs: [],
        source_task_ids: ["task-candidate"],
        verification: { verdict: "pass", confidence: 0.6, last_verified_at: now },
        usage: { retrieved_count: 0, verified_success_count: 1, successful_reuse_count: 0, failed_reuse_count: 0 },
        governance: {
          created_by: "dream",
          review_state: "pending",
          auto_generated: true,
          user_editable: true,
          auto_mutation: "forbidden",
        },
        created_at: now,
        updated_at: now,
      });
      await upsertDreamPlaybook(stateManager.getBaseDir(), {
        playbook_id: "dream-playbook-disabled",
        status: "disabled",
        kind: "verified_execution",
        title: "Disabled playbook should stay hidden",
        summary: "Disabled only",
        source_signature: "disabled-playbook",
        applicability: {
          goal_ids: ["goal-42"],
          primary_dimensions: ["verification"],
          task_categories: ["verification"],
          terms: ["disabled", "hidden"],
        },
        preconditions: [],
        recommended_steps: ["Disabled step"],
        verification_checks: [],
        failure_warnings: [],
        evidence_refs: [],
        source_task_ids: ["task-disabled"],
        verification: { verdict: "pass", confidence: 0.9, last_verified_at: now },
        usage: { retrieved_count: 0, verified_success_count: 3, successful_reuse_count: 0, failed_reuse_count: 0 },
        governance: {
          created_by: "dream",
          review_state: "disabled",
          auto_generated: true,
          user_editable: true,
          auto_mutation: "forbidden",
        },
        created_at: now,
        updated_at: now,
      });
      await saveDreamConfig({
        activation: {
          verifiedPlannerHintsOnly: true,
          semanticWorkingMemory: false,
          crossGoalLessons: false,
          semanticContext: false,
          autoAcquireKnowledge: false,
          learnedPatternHints: false,
          playbookHints: true,
          workflowHints: false,
          strategyTemplates: false,
          decisionHeuristics: false,
          graphTraversal: false,
        },
      }, stateManager.getBaseDir());

      await lifecycle.generateTask("goal-42", "verification");

      const userMessage = spy.calls[0]!.messages[0]!.content;
      expect(userMessage).not.toContain("Verified playbook hints");
      expect(userMessage).not.toContain("Candidate playbook should stay hidden");
      expect(userMessage).not.toContain("Disabled playbook should stay hidden");
    });

    it("sends a system prompt for task generation", async () => {
      const spy = createSpyLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(spy);

      await lifecycle.generateTask("goal-1", "dim");

      expect(spy.calls[0]!.options?.system).toBeDefined();
      expect(spy.calls[0]!.options!.system).toContain("task generation");
    });

    it("parses valid LLM response into a Task object", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task = expectTask(await lifecycle.generateTask("goal-1", "test_coverage"));

      expect(task.work_description).toBe(
        "Write unit tests for the authentication module"
      );
      expect(task.rationale).toContain("test coverage");
      expect(task.approach).toContain("vitest");
      expect(task.success_criteria.length).toBe(1);
      expect(task.scope_boundary.in_scope).toContain("auth module tests");
      expect(task.constraints).toContain("Must not modify production code");
      expect(task.reversibility).toBe("reversible");
      expect(task.estimated_duration).toEqual({ value: 2, unit: "hours" });
    });

    it("rejects generated multiline heredoc verification methods before task persistence", async () => {
      const llm = createMockLLMClient([HEREDOC_VERIFICATION_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      await expect(lifecycle.generateTask("goal-1", "roc_auc")).rejects.toThrow(/verification_method/);

      const taskDir = path.join(tmpDir, "tasks", "goal-1");
      expect(fs.existsSync(taskDir)).toBe(false);
    });

    it("forces artifact contract required for typed Kaggle RunSpec goals", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);
      await stateManager.saveGoal(makeGoal({
        id: "goal-kaggle",
        constraints: ["run_spec_profile:kaggle"],
      }));

      const task = expectTask(await lifecycle.generateTask("goal-kaggle", "test_coverage"));

      expect(task.artifact_contract).toMatchObject({ required: true, required_artifacts: [] });
    });

    it("sets strategy_id from active strategy", async () => {
      const strategyResponse = `\`\`\`json
[{
  "hypothesis": "Test strategy",
  "expected_effect": [{ "dimension": "test_coverage", "direction": "increase", "magnitude": "medium" }],
  "resource_estimate": { "sessions": 5, "duration": { "value": 7, "unit": "days" }, "llm_calls": null },
  "allocation": 1.0
}]
\`\`\``;
      const llm = createMockLLMClient([strategyResponse, VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      // Generate and activate a strategy first
      await strategyManager.generateCandidates("goal-1", "test_coverage", ["test_coverage"], {
        currentGap: 0.5,
        pastStrategies: [],
      });
      const activeStrategy = await strategyManager.activateBestCandidate("goal-1");

      const task = expectTask(await lifecycle.generateTask("goal-1", "test_coverage"));
      expect(task.strategy_id).toBe(activeStrategy.id);
    });

    it("sets strategy_id from parameter when no active strategy", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task = expectTask(await lifecycle.generateTask("goal-1", "dim", "manual-strategy-id"));
      expect(task.strategy_id).toBe("manual-strategy-id");
    });

    it("sets strategy_id to null when no strategy available", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task = expectTask(await lifecycle.generateTask("goal-1", "dim"));
      expect(task.strategy_id).toBeNull();
    });

    it("persists task to state file", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task = expectTask(await lifecycle.generateTask("goal-1", "dim"));

      const persisted = await stateManager.readRaw(`tasks/goal-1/${task.id}.json`);
      expect(persisted).not.toBeNull();
      expect((persisted as Record<string, unknown>).id).toBe(task.id);
    });

    it("sets status to pending", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task = expectTask(await lifecycle.generateTask("goal-1", "dim"));
      expect(task.status).toBe("pending");
    });

    it("sets a valid created_at ISO timestamp", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const before = new Date().toISOString();
      const task = expectTask(await lifecycle.generateTask("goal-1", "dim"));
      const after = new Date().toISOString();

      expect(task.created_at).toBeDefined();
      expect(task.created_at >= before).toBe(true);
      expect(task.created_at <= after).toBe(true);
    });

    it("generates a unique UUID for task id", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE, VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task1 = expectTask(await lifecycle.generateTask("goal-1", "dim"));
      const task2 = expectTask(await lifecycle.generateTask("goal-1", "dim"));

      expect(task1.id).not.toBe(task2.id);
      // UUID format check
      expect(task1.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it("sets goal_id correctly", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task = expectTask(await lifecycle.generateTask("my-goal", "dim"));
      expect(task.goal_id).toBe("my-goal");
    });

    it("sets target_dimensions and primary_dimension", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task = expectTask(await lifecycle.generateTask("goal-1", "coverage"));
      expect(task.target_dimensions).toEqual(["coverage"]);
      expect(task.primary_dimension).toBe("coverage");
    });

    it("sets consecutive_failure_count to 0", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task = expectTask(await lifecycle.generateTask("goal-1", "dim"));
      expect(task.consecutive_failure_count).toBe(0);
    });

    it("throws on invalid LLM response (missing fields)", async () => {
      const invalidResponse = `\`\`\`json
{ "work_description": "test" }
\`\`\``;
      const llm = createMockLLMClient([invalidResponse]);
      const lifecycle = createLifecycle(llm);

      await expect(
        lifecycle.generateTask("goal-1", "dim")
      ).rejects.toThrow();
    });

    it("throws on non-JSON LLM response", async () => {
      const llm = createMockLLMClient(["This is not JSON at all"]);
      const lifecycle = createLifecycle(llm);

      await expect(
        lifecycle.generateTask("goal-1", "dim")
      ).rejects.toThrow();
    });

    it("logs error via logger when parseJSON fails", async () => {
      const rawResponse = "This is not JSON at all";
      const llm = createMockLLMClient([rawResponse]);
      const mockLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
      const lifecycle = createLifecycle(llm, { logger: mockLogger as unknown as import("../../../runtime/logger.js").Logger });

      await lifecycle.generateTask("goal-1", "dim").catch(() => {});

      expect(mockLogger.error).toHaveBeenCalledTimes(1);
      expect(mockLogger.error.mock.calls[0]![0]).toContain("Task generation failed");
    });

    it("handles null estimated_duration from LLM", async () => {
      const llm = createMockLLMClient([UNKNOWN_REVERSIBILITY_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task = expectTask(await lifecycle.generateTask("goal-1", "dim"));
      expect(task.estimated_duration).toBeNull();
    });

    it("handles empty constraints array", async () => {
      const llm = createMockLLMClient([UNKNOWN_REVERSIBILITY_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task = expectTask(await lifecycle.generateTask("goal-1", "dim"));
      expect(task.constraints).toEqual([]);
    });

    it("persists the full Task structure that can be read back", async () => {
      const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
      const lifecycle = createLifecycle(llm);

      const task = expectTask(await lifecycle.generateTask("goal-1", "dim"));
      const raw = await stateManager.readRaw(`tasks/goal-1/${task.id}.json`) as Record<string, unknown>;

      expect(raw.work_description).toBe(task.work_description);
      expect(raw.status).toBe("pending");
      expect(raw.goal_id).toBe("goal-1");
      expect(raw.strategy_id).toBeNull();
    });
  });

  // ─────────────────────────────────────────────
  // checkIrreversibleApproval
  // ─────────────────────────────────────────────

  describe("checkIrreversibleApproval", async () => {
    function makeTask(overrides: Partial<Task> = {}): Task {
      return {
        id: "task-1",
        goal_id: "goal-1",
        strategy_id: null,
        target_dimensions: ["dim"],
        primary_dimension: "dim",
        work_description: "test task",
        rationale: "test",
        approach: "test",
        success_criteria: [
          {
            description: "test",
            verification_method: "test",
            is_blocking: true,
          },
        ],
        scope_boundary: {
          in_scope: ["a"],
          out_of_scope: ["b"],
          blast_radius: "low",
        },
        constraints: [],
        risk_profile: {
          external_action: {
            required: false,
            approval_required: false,
            action_kind: "none",
            rationale: "Test fixture task is local-only unless overridden.",
          },
        },
        plateau_until: null,
        estimated_duration: null,
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

    it("skips approval for reversible task with high trust and high confidence", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);

      // Set trust high enough for autonomous quadrant
      await trustManager.setOverride("normal", 30, "test");

      const task = makeTask({ reversibility: "reversible" });
      const result = await lifecycle.checkIrreversibleApproval(task, 0.8);
      expect(result).toBe(true);
    });

    it("calls approvalFn for irreversible task", async () => {
      let approvalCalled = false;
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => {
          approvalCalled = true;
          return true;
        },
      });

      const task = makeTask({ reversibility: "irreversible" });
      await lifecycle.checkIrreversibleApproval(task);
      expect(approvalCalled).toBe(true);
    });

    it("calls approvalFn for unknown reversibility", async () => {
      let approvalCalled = false;
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => {
          approvalCalled = true;
          return true;
        },
      });

      const task = makeTask({ reversibility: "unknown" });
      await lifecycle.checkIrreversibleApproval(task);
      expect(approvalCalled).toBe(true);
    });

    it("returns true when approvalFn returns true", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
      });

      const task = makeTask({ reversibility: "irreversible" });
      const result = await lifecycle.checkIrreversibleApproval(task);
      expect(result).toBe(true);
    });

    it("returns false when approvalFn returns false", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => false,
      });

      const task = makeTask({ reversibility: "irreversible" });
      const result = await lifecycle.checkIrreversibleApproval(task);
      expect(result).toBe(false);
    });

    it("default approvalFn returns false (safe default)", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm); // no custom approvalFn

      const task = makeTask({ reversibility: "irreversible" });
      const result = await lifecycle.checkIrreversibleApproval(task);
      expect(result).toBe(false);
    });

    it("requires approval when trust is low even for reversible task", async () => {
      let approvalCalled = false;
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => {
          approvalCalled = true;
          return true;
        },
      });

      // Trust is at 0 (default), confidence is low → quadrant is not autonomous
      const task = makeTask({ reversibility: "reversible" });
      await lifecycle.checkIrreversibleApproval(task, 0.3);
      expect(approvalCalled).toBe(true);
    });

    it("requires approval when permanent gate exists", async () => {
      let approvalCalled = false;
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => {
          approvalCalled = true;
          return true;
        },
      });

      await trustManager.addPermanentGate("normal", "normal");
      await trustManager.setOverride("normal", 50, "test"); // high trust

      const task = makeTask({ reversibility: "reversible" });
      await lifecycle.checkIrreversibleApproval(task, 0.9);
      expect(approvalCalled).toBe(true);
    });

    it("passes task to approvalFn", async () => {
      let receivedTask: Task | null = null;
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async (task) => {
          receivedTask = task;
          return true;
        },
      });

      const task = makeTask({
        reversibility: "irreversible",
        work_description: "special task",
      });
      await lifecycle.checkIrreversibleApproval(task);
      expect(receivedTask).not.toBeNull();
      expect(receivedTask!.work_description).toBe("special task");
    });

    it("uses task_category as domain for trust check", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
      });

      // Set high trust for "verification" domain
      await trustManager.setOverride("verification", 50, "test");

      const task = makeTask({
        reversibility: "reversible",
        task_category: "verification",
      });
      const result = await lifecycle.checkIrreversibleApproval(task, 0.8);
      // With high trust + high confidence + reversible → should skip approval
      expect(result).toBe(true);
    });

    it("requires approval and records a handoff for external submission tasks even when otherwise reversible", async () => {
      let approvalCalled = false;
      const handoffStore = new RuntimeOperatorHandoffStore(`${tmpDir}/runtime`);
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => {
          approvalCalled = true;
          return false;
        },
        operatorHandoffStore: handoffStore,
      });
      await trustManager.setOverride("normal", 50, "test");

      const task = makeTask({
        work_description: "Hand the final artifact to the competition scoring system",
        approach: "Use the typed task risk profile to require operator approval before the handoff",
        reversibility: "reversible",
        risk_profile: {
          external_action: {
            required: true,
            approval_required: true,
            action_kind: "submission",
            rationale: "The task sends an artifact to an external competition system.",
          },
        },
      });
      const result = await lifecycle.checkIrreversibleApproval(task, 0.9);

      expect(result).toBe(false);
      expect(approvalCalled).toBe(true);
      expect(await handoffStore.listOpen()).toEqual([]);
      expect(await handoffStore.load("handoff:goal-1:task:task-1:approval-required")).toMatchObject({
        goal_id: "goal-1",
        status: "dismissed",
        triggers: ["external_action"],
        required_approvals: [task.work_description],
        gate: expect.objectContaining({
          external_action_requires_approval: true,
        }),
      });
    });

    it("resolves external submission handoffs as approved when the operator approves", async () => {
      const handoffStore = new RuntimeOperatorHandoffStore(`${tmpDir}/runtime`);
      const llm = createMockLLMClient([]);
      let receivedApprovalRequestId: string | undefined;
      const lifecycle = createLifecycle(llm, {
        approvalFn: async (task) => {
          receivedApprovalRequestId = (task as unknown as { approval_request_id?: string }).approval_request_id;
          return true;
        },
        operatorHandoffStore: handoffStore,
      });
      await trustManager.setOverride("normal", 50, "test");

      const task = makeTask({
        work_description: "Make the final report visible outside the local workspace",
        reversibility: "reversible",
        risk_profile: {
          external_action: {
            required: true,
            approval_required: true,
            action_kind: "publication",
            rationale: "The task exposes a report outside the local workspace.",
          },
        },
      });
      const result = await lifecycle.checkIrreversibleApproval(task, 0.9);

      expect(result).toBe(true);
      expect(receivedApprovalRequestId).toBe("handoff:goal-1:task:task-1:approval-required");
      expect(await handoffStore.listOpen()).toEqual([]);
      expect(await handoffStore.load("handoff:goal-1:task:task-1:approval-required")).toMatchObject({
        status: "approved",
        triggers: ["external_action"],
      });
    });

    it("does not infer external approval from freeform task keywords without a typed risk profile", async () => {
      let approvalCalled = false;
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => {
          approvalCalled = true;
          return true;
        },
      });
      await trustManager.setOverride("normal", 50, "test");

      const task = makeTask({
        work_description: "Publish a local-only fixture named production-notify-sample.json",
        approach: "Create a local test fixture; no external system is contacted.",
        reversibility: "reversible",
      });
      const result = await lifecycle.checkIrreversibleApproval(task, 0.9);

      expect(result).toBe(true);
      expect(approvalCalled).toBe(false);
    });

    it("requires approval when the typed external action profile is missing or unknown", async () => {
      let approvalCalls = 0;
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => {
          approvalCalls += 1;
          return false;
        },
      });
      await trustManager.setOverride("normal", 50, "test");

      const missingProfileTask = makeTask({ reversibility: "reversible" });
      delete missingProfileTask.risk_profile;
      await expect(lifecycle.checkIrreversibleApproval(missingProfileTask, 0.9)).resolves.toBe(false);

      await expect(lifecycle.checkIrreversibleApproval(makeTask({
        reversibility: "reversible",
        risk_profile: {
          external_action: {
            required: false,
            approval_required: false,
            action_kind: "unknown",
            rationale: "Classifier could not determine side effects.",
          },
        },
      }), 0.9)).resolves.toBe(false);

      expect(approvalCalls).toBe(2);
    });

    it("uses default confidence of 0.5 when not provided", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
      });

      // Set trust to exactly threshold (20)
      await trustManager.setOverride("normal", 20, "test");

      const task = makeTask({ reversibility: "reversible" });
      // Default confidence is 0.5, which is >= HIGH_CONFIDENCE_THRESHOLD (0.5)
      // So with trust=20 (>= threshold) + confidence=0.5 → autonomous → no approval needed
      const result = await lifecycle.checkIrreversibleApproval(task);
      expect(result).toBe(true);
    });
  });

  // ─────────────────────────────────────────────
  // Constructor
  // ─────────────────────────────────────────────

  describe("constructor", () => {
    it("accepts all required dependencies", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      expect(lifecycle).toBeDefined();
    });

    it("accepts optional approvalFn", () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        approvalFn: async () => true,
      });
      expect(lifecycle).toBeDefined();
    });
  });
});
