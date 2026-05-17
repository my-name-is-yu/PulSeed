import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { makeDimension, makeGoal } from "../../../../../tests/helpers/fixtures.js";
import { makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import {
  runTaskLifecycleCycle,
  type TaskLifecycleTaskCycleContext,
} from "../task-lifecycle-runner.js";

describe("runTaskLifecycleCycle", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    tmpDir = null;
  });

  it("falls back to selector when a learning-prior target dimension is stale", async () => {
    const { context, selectTargetDimension, generateTaskWithTokens } = makeContext({
      learningProjectionTargetDimension: "stale-dimension",
      selectedDimension: "dim1",
    });

    const result = await runTaskLifecycleCycle(context);

    expect(selectTargetDimension).toHaveBeenCalled();
    expect(generateTaskWithTokens.mock.calls[0]?.[1]).toBe("dim1");
    expect(result.task.primary_dimension).toBe("dim1");
    expect(result.learningPriorApplication).toEqual({
      consumptionRecordId: "consumption-task-prior",
      status: "suppressed",
      reason: "preferred_target_dimension_stale",
    });
  });

  it("uses a learning-prior target dimension only when it exists on the current goal", async () => {
    const { context, selectTargetDimension, generateTaskWithTokens } = makeContext({
      learningProjectionTargetDimension: "dim-prior",
      selectedDimension: "dim1",
    });

    const result = await runTaskLifecycleCycle(context);

    expect(selectTargetDimension).not.toHaveBeenCalled();
    expect(generateTaskWithTokens.mock.calls[0]?.[1]).toBe("dim-prior");
    expect(result.task.primary_dimension).toBe("dim-prior");
    expect(result.learningPriorApplication).toEqual({
      consumptionRecordId: "consumption-task-prior",
      status: "suppressed",
      reason: "task_generation_skipped",
    });
  });

  it("reports an applied learning prior when a current projected dimension changes the generated task", async () => {
    const { context, selectTargetDimension, generateTaskWithTokens } = makeContext({
      learningProjectionTargetDimension: "dim-prior",
      selectedDimension: "dim1",
      generateTask: true,
      approveIrreversible: false,
    });

    const result = await runTaskLifecycleCycle(context);

    expect(selectTargetDimension).not.toHaveBeenCalled();
    expect(generateTaskWithTokens.mock.calls[0]?.[1]).toBe("dim-prior");
    expect(result.task.primary_dimension).toBe("dim-prior");
    expect(result.learningPriorApplication).toEqual({
      consumptionRecordId: "consumption-task-prior",
      status: "applied",
      reason: "preferred_target_dimension_applied",
      generatedDecisionRefs: ["task:task-dim-prior"],
    });
  });

  it("does not classify projected dimensions as stale when goal loading fails", async () => {
    const { context, selectTargetDimension, generateTaskWithTokens } = makeContext({
      learningProjectionTargetDimension: "dim-prior",
      selectedDimension: "dim1",
      generateTask: true,
      approveIrreversible: false,
      failGoalLoad: true,
    });

    const result = await runTaskLifecycleCycle(context);

    expect(selectTargetDimension).not.toHaveBeenCalled();
    expect(generateTaskWithTokens.mock.calls[0]?.[1]).toBe("dim-prior");
    expect(result.learningPriorApplication).toEqual({
      consumptionRecordId: "consumption-task-prior",
      status: "applied",
      reason: "preferred_target_dimension_applied",
      generatedDecisionRefs: ["task:task-dim-prior"],
    });
  });

  function makeContext(input: {
    learningProjectionTargetDimension: string;
    selectedDimension: string;
    generateTask?: boolean;
    approveIrreversible?: boolean;
    failGoalLoad?: boolean;
  }): {
    context: TaskLifecycleTaskCycleContext;
    selectTargetDimension: ReturnType<typeof vi.fn>;
    generateTaskWithTokens: ReturnType<typeof vi.fn>;
  } {
    tmpDir = makeTempDir("pulseed-task-lifecycle-runner-");
    const goal = makeGoal({
      dimensions: [
        makeDimension({ name: "dim1", current_value: 0 }),
        makeDimension({ name: "dim-prior", current_value: 0 }),
      ],
    });
    const stateManager = {
      loadGoal: input.failGoalLoad
        ? vi.fn().mockRejectedValue(new Error("goal load unavailable"))
        : vi.fn().mockResolvedValue(goal),
      getBaseDir: () => tmpDir ?? "",
      loadTaskOutcomeLedger: vi.fn().mockResolvedValue(null),
      saveTaskOutcomeLedger: vi.fn().mockResolvedValue(undefined),
    };
    const selectTargetDimension = vi.fn().mockReturnValue(input.selectedDimension);
    const generateTaskWithTokens = vi.fn().mockImplementation(async (
      runGoalId: string,
      targetDimension: string
    ) => ({
      task: input.generateTask
        ? {
            id: `task-${targetDimension}`,
            goal_id: runGoalId,
            strategy_id: null,
            target_dimensions: [targetDimension],
            primary_dimension: targetDimension,
            work_description: "Generated task",
            rationale: "Use the selected dimension",
            approach: "Execute a bounded change",
            success_criteria: [],
            scope_boundary: { in_scope: ["src"], out_of_scope: [], blast_radius: "low" },
            constraints: [],
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
            created_at: "2026-05-17T00:00:00.000Z",
          }
        : null,
      tokensUsed: 0,
      playbookIdsUsed: [],
    }));
    const context = {
      goalId: goal.id,
      gapVector: { goal_id: goal.id, gaps: [], timestamp: "2026-05-17T00:00:00.000Z" },
      driveContext: {},
      adapter: { adapterType: "openai_codex_cli", execute: vi.fn() },
      options: {
        learningProjection: {
          phase: "task_generation",
          projectionKind: "task_generation_bias",
          consumptionRecordId: "consumption-task-prior",
          preferredTargetDimension: input.learningProjectionTargetDimension,
          taskBiasRefs: [],
          avoidTaskPatternRefs: [],
          requiredExperimentPlanIds: [],
          generalizationBodies: [],
          suppressedSuggestionIds: [],
        },
      },
      stateManager,
      healthCheckEnabled: false,
      runPostExecutionHealthCheck: vi.fn().mockResolvedValue({ healthy: true, output: "" }),
      verificationDeps: vi.fn().mockReturnValue({}),
      sideEffectDeps: vi.fn().mockReturnValue({ stateManager }),
      buildDimensionSelectionBackoff: vi.fn().mockResolvedValue({}),
      selectTargetDimension,
      generateTaskWithTokens,
      enrichmentDeps: vi.fn().mockReturnValue({}),
      checkIrreversibleApproval: vi.fn().mockResolvedValue(input.approveIrreversible ?? true),
      preExecution: {
        approvalFn: vi.fn().mockResolvedValue(true),
        recordPolicyDecision: vi.fn().mockResolvedValue(undefined),
      },
      hasNativeAgentLoop: false,
      executeTask: vi.fn(),
      executeTaskWithAgentLoop: vi.fn(),
      handleVerdict: vi.fn(),
    } as unknown as TaskLifecycleTaskCycleContext;
    return { context, selectTargetDimension, generateTaskWithTokens };
  }
});
