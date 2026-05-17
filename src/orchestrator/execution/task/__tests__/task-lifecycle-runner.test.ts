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
  });

  function makeContext(input: {
    learningProjectionTargetDimension: string;
    selectedDimension: string;
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
      loadGoal: vi.fn().mockResolvedValue(goal),
      getBaseDir: () => tmpDir ?? "",
    };
    const selectTargetDimension = vi.fn().mockReturnValue(input.selectedDimension);
    const generateTaskWithTokens = vi.fn().mockResolvedValue({
      task: null,
      tokensUsed: 0,
      playbookIdsUsed: [],
    });
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
      checkIrreversibleApproval: vi.fn().mockResolvedValue(true),
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
