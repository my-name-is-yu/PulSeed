import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CoreLoop,
  type CoreLoopDeps,
  type GapCalculatorModule,
  type DriveScorerModule,
  type ReportingEngine,
} from "../durable-loop.js";
import { StateManager } from "../../../base/state/state-manager.js";
import type { ObservationEngine } from "../../../platform/observation/observation-engine.js";
import {
  TaskLifecycle as RealTaskLifecycle,
  type TaskLifecycle,
  type TaskCycleResult,
} from "../../execution/task/task-lifecycle.js";
import type { SatisficingJudge } from "../../../platform/drive/satisficing-judge.js";
import {
  StallDetector as RealStallDetector,
  type StallDetector,
} from "../../../platform/drive/stall-detector.js";
import {
  StrategyManager as RealStrategyManager,
  type StrategyManager,
} from "../../strategy/strategy-manager.js";
import { PortfolioManager } from "../../strategy/portfolio-manager.js";
import type { DriveSystem } from "../../../platform/drive/drive-system.js";
import type { AdapterRegistry, IAdapter } from "../../execution/adapter-layer.js";
import type { GapVector } from "../../../base/types/gap.js";
import type { CompletionJudgment } from "../../../base/types/satisficing.js";
import type { StallReport } from "../../../base/types/stall.js";
import type { DriveScore } from "../../../base/types/drive.js";
import { saveDreamConfig } from "../../../platform/dream/dream-config.js";
import {
  retractRelationshipProfileItem,
  upsertRelationshipProfileItem,
} from "../../../platform/profile/relationship-profile.js";
import { SessionManager } from "../../execution/session-manager.js";
import { TrustManager } from "../../../platform/traits/trust-manager.js";
import { ReportingEngine as RealReportingEngine } from "../../../reporting/reporting-engine.js";
import { CapabilityDetector } from "../../../platform/observation/capability-detector.js";
import { ApprovalStore } from "../../../runtime/store/approval-store.js";
import { ApprovalBroker } from "../../../runtime/approval-broker.js";
import { WaitDeadlineResolver, getDueWaitGoalIds } from "../../../runtime/daemon/wait-deadline-resolver.js";
import { RuntimeEvidenceLedger } from "../../../runtime/store/evidence-ledger.js";
import { RuntimeReproducibilityManifestStore } from "../../../runtime/store/reproducibility-manifest.js";
import { RuntimeOperatorHandoffStore } from "../../../runtime/store/operator-handoff-store.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { makeDimension, makeGoal } from "../../../../tests/helpers/fixtures.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";

function makeGapVector(goalId = "goal-1"): GapVector {
  return {
    goal_id: goalId,
    gaps: [
      {
        dimension_name: "dim1",
        raw_gap: 5,
        normalized_gap: 0.5,
        normalized_weighted_gap: 0.5,
        confidence: 0.8,
        uncertainty_weight: 1.0,
      },
      {
        dimension_name: "dim2",
        raw_gap: 5,
        normalized_gap: 0.625,
        normalized_weighted_gap: 0.625,
        confidence: 0.7,
        uncertainty_weight: 1.0,
      },
    ],
    timestamp: new Date().toISOString(),
  };
}

function makeDriveScores(): DriveScore[] {
  return [
    {
      dimension_name: "dim1",
      dissatisfaction: 0.5,
      deadline: 0,
      opportunity: 0,
      final_score: 0.5,
      dominant_drive: "dissatisfaction",
    },
    {
      dimension_name: "dim2",
      dissatisfaction: 0.625,
      deadline: 0,
      opportunity: 0,
      final_score: 0.625,
      dominant_drive: "dissatisfaction",
    },
  ];
}

function makeCompletionJudgment(
  overrides: Partial<CompletionJudgment> = {}
): CompletionJudgment {
  return {
    is_complete: false,
    blocking_dimensions: ["dim1", "dim2"],
    low_confidence_dimensions: [],
    needs_verification_task: false,
    checked_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeTaskCycleResult(
  overrides: Partial<TaskCycleResult> = {}
): TaskCycleResult {
  return {
    task: {
      id: "task-1",
      goal_id: "goal-1",
      strategy_id: null,
      target_dimensions: ["dim1"],
      primary_dimension: "dim1",
      work_description: "Test task",
      rationale: "Test rationale",
      approach: "Test approach",
      success_criteria: [
        {
          description: "Test criterion",
          verification_method: "manual check",
          is_blocking: true,
        },
      ],
      scope_boundary: {
        in_scope: ["test"],
        out_of_scope: [],
        blast_radius: "none",
      },
      constraints: [],
      plateau_until: null,
      estimated_duration: null,
      consecutive_failure_count: 0,
      reversibility: "reversible",
      task_category: "normal",
      status: "completed",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      timeout_at: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
    },
    verificationResult: {
      task_id: "task-1",
      verdict: "pass",
      confidence: 0.9,
      evidence: [
        {
          layer: "mechanical",
          description: "Pass",
          confidence: 0.9,
        },
      ],
      dimension_updates: [],
      timestamp: new Date().toISOString(),
    },
    action: "completed",
    ...overrides,
  };
}

function makeStallReport(overrides: Partial<StallReport> = {}): StallReport {
  return {
    stall_type: "dimension_stall",
    goal_id: "goal-1",
    dimension_name: "dim1",
    task_id: null,
    detected_at: new Date().toISOString(),
    escalation_level: 0,
    suggested_cause: "approach_failure",
    decay_factor: 0.6,
    ...overrides,
  };
}

function makeGeneratedTaskResponse(): string {
  return JSON.stringify({
    work_description: "Deploy the service to production",
    rationale: "The goal requires production deployment to close the gap",
    approach: "Run the production deployment workflow",
    success_criteria: [
      {
        description: "Production deployment has completed",
        verification_method: "manual check",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["production deployment"],
      out_of_scope: ["unrelated infrastructure changes"],
      blast_radius: "production service",
    },
    constraints: ["requires explicit deployment permission"],
    reversibility: "reversible",
    estimated_duration: { value: 30, unit: "minutes" },
  });
}

function createMockAdapter(): IAdapter {
  return {
    adapterType: "openai_codex_cli",
    execute: vi.fn().mockResolvedValue({
      success: true,
      output: "Task completed",
      error: null,
      exit_code: null,
      elapsed_ms: 1000,
      stopped_reason: "completed",
    }),
  };
}

function createMockDeps(tmpDir: string): {
  deps: CoreLoopDeps;
  mocks: {
    stateManager: StateManager;
    observationEngine: Record<string, ReturnType<typeof vi.fn>>;
    gapCalculator: Record<string, ReturnType<typeof vi.fn>>;
    driveScorer: Record<string, ReturnType<typeof vi.fn>>;
    taskLifecycle: Record<string, ReturnType<typeof vi.fn>>;
    satisficingJudge: Record<string, ReturnType<typeof vi.fn>>;
    stallDetector: Record<string, ReturnType<typeof vi.fn>>;
    strategyManager: Record<string, ReturnType<typeof vi.fn>>;
    reportingEngine: Record<string, ReturnType<typeof vi.fn>>;
    driveSystem: Record<string, ReturnType<typeof vi.fn>>;
    adapterRegistry: Record<string, ReturnType<typeof vi.fn>>;
    adapter: IAdapter;
  };
} {
  const stateManager = new StateManager(tmpDir);

  const adapter = createMockAdapter();

  const observationEngine = {
    observe: vi.fn(),
    applyObservation: vi.fn(),
    createObservationEntry: vi.fn(),
    getObservationLog: vi.fn(),
    saveObservationLog: vi.fn(),
    applyProgressCeiling: vi.fn(),
    getConfidenceTier: vi.fn(),
    resolveContradiction: vi.fn(),
    needsVerificationTask: vi.fn(),
  };

  const gapCalculator = {
    calculateGapVector: vi.fn().mockReturnValue(makeGapVector()),
    aggregateGaps: vi.fn().mockReturnValue(0.625),
  };

  const driveScorer = {
    scoreAllDimensions: vi.fn().mockReturnValue(makeDriveScores()),
    rankDimensions: vi.fn().mockImplementation((scores: DriveScore[]) =>
      [...scores].sort((a, b) => b.final_score - a.final_score)
    ),
  };

  const taskLifecycle = {
    runTaskCycle: vi.fn().mockResolvedValue(makeTaskCycleResult()),
    selectTargetDimension: vi.fn(),
    generateTask: vi.fn(),
    checkIrreversibleApproval: vi.fn(),
    executeTask: vi.fn(),
    verifyTask: vi.fn(),
    handleVerdict: vi.fn(),
    handleFailure: vi.fn(),
  };

  const satisficingJudge = {
    isGoalComplete: vi.fn().mockReturnValue(makeCompletionJudgment()),
    isDimensionSatisfied: vi.fn(),
    applyProgressCeiling: vi.fn(),
    selectDimensionsForIteration: vi.fn(),
    detectThresholdAdjustmentNeeded: vi.fn(),
    propagateSubgoalCompletion: vi.fn(),
  };

  const stallDetector = {
    checkDimensionStall: vi.fn().mockReturnValue(null),
    checkGlobalStall: vi.fn().mockReturnValue(null),
    checkTimeExceeded: vi.fn().mockReturnValue(null),
    checkConsecutiveFailures: vi.fn().mockReturnValue(null),
    getEscalationLevel: vi.fn().mockReturnValue(0),
    incrementEscalation: vi.fn().mockReturnValue(1),
    resetEscalation: vi.fn(),
    getStallState: vi.fn(),
    saveStallState: vi.fn(),
    classifyStallCause: vi.fn(),
    computeDecayFactor: vi.fn(),
    isSuppressed: vi.fn(),
  };

  const strategyManager = {
    onStallDetected: vi.fn().mockResolvedValue(null),
    getActiveStrategy: vi.fn().mockReturnValue(null),
    getPortfolio: vi.fn(),
    generateCandidates: vi.fn(),
    activateBestCandidate: vi.fn(),
    updateState: vi.fn(),
    getStrategyHistory: vi.fn(),
  };

  const reportingEngine = {
    generateExecutionSummary: vi.fn().mockReturnValue({ type: "execution_summary" }),
    saveReport: vi.fn(),
  };

  const driveSystem = {
    shouldActivate: vi.fn().mockReturnValue(true),
    processEvents: vi.fn().mockReturnValue([]),
    readEventQueue: vi.fn().mockReturnValue([]),
    archiveEvent: vi.fn(),
    getSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    isScheduleDue: vi.fn(),
    createDefaultSchedule: vi.fn(),
    prioritizeGoals: vi.fn(),
  };

  const adapterRegistry = {
    getAdapter: vi.fn().mockReturnValue(adapter),
    register: vi.fn(),
    listAdapters: vi.fn().mockReturnValue(["openai_codex_cli"]),
  };

  const deps: CoreLoopDeps = {
    stateManager,
    observationEngine: observationEngine as unknown as ObservationEngine,
    gapCalculator: gapCalculator as unknown as GapCalculatorModule,
    driveScorer: driveScorer as unknown as DriveScorerModule,
    taskLifecycle: taskLifecycle as unknown as TaskLifecycle,
    satisficingJudge: satisficingJudge as unknown as SatisficingJudge,
    stallDetector: stallDetector as unknown as StallDetector,
    strategyManager: strategyManager as unknown as StrategyManager,
    reportingEngine: reportingEngine as unknown as ReportingEngine,
    driveSystem: driveSystem as unknown as DriveSystem,
    adapterRegistry: adapterRegistry as unknown as AdapterRegistry,
  };

  return {
    deps,
    mocks: {
      stateManager,
      observationEngine,
      gapCalculator,
      driveScorer,
      taskLifecycle,
      satisficingJudge,
      stallDetector,
      strategyManager,
      reportingEngine,
      driveSystem,
      adapterRegistry,
      adapter,
    },
  };
}

async function waitForPendingApproval(
  store: ApprovalStore,
  approvalId: string,
  timeoutMs = 1_000
) {
  const startedAt = Date.now();
  for (;;) {
    const record = await store.loadPending(approvalId);
    if (record) return record;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for pending approval ${approvalId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeWaitStrategyForCoreLoop(overrides: Record<string, unknown> = {}) {
  return {
    id: "wait-strategy-1",
    goal_id: "goal-1",
    target_dimensions: ["dim1"],
    primary_dimension: "dim1",
    hypothesis: "Wait for the training run to finish",
    expected_effect: [],
    resource_estimate: {
      sessions: 0,
      duration: { value: 1, unit: "hours" },
      llm_calls: null,
    },
    state: "active",
    allocation: 1,
    created_at: "2026-04-24T00:00:00.000Z",
    started_at: "2026-04-24T00:00:00.000Z",
    completed_at: null,
    gap_snapshot_at_start: 0.8,
    tasks_generated: [],
    effectiveness_score: null,
    consecutive_stall_count: 0,
    source_template_id: null,
    cross_goal_context: null,
    rollback_target_id: null,
    max_pivot_count: 2,
    pivot_count: 0,
    toolset_locked: false,
    allowed_tools: [],
    required_tools: [],
    wait_reason: "Observe Kaggle training completion",
    wait_until: new Date(Date.now() - 100_000).toISOString(),
    measurement_plan: "Resume when process exits and inspect metrics",
    fallback_strategy_id: null,
    ...overrides,
  };
}

// ─── Tests ───

describe("CoreLoop", async () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
  });

  describe("runtime evidence ledger contracts", () => {
    it("writes task-cycle runtime evidence through a real loop iteration with real stores", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const runtimeRoot = path.join(tmpDir, "runtime");
      const evidenceLedger = new RuntimeEvidenceLedger(runtimeRoot);

      const loop = new CoreLoop(
        { ...deps, evidenceLedger },
        { delayBetweenLoopsMs: 0, autoDecompose: false },
      );
      const result = await loop.run("goal-1", {
        maxIterations: 1,
        activation: {
          backgroundRun: { backgroundRunId: "run-coreloop-evidence-contract" },
        },
      });

      const runEvidence = await evidenceLedger.readByRun("run-coreloop-evidence-contract");
      const goalEvidence = await evidenceLedger.readByGoal("goal-1");
      const taskGeneration = runEvidence.entries.find((entry) => entry.kind === "task_generation");
      const verification = runEvidence.entries.find((entry) => entry.kind === "verification");

      expect(result.totalIterations).toBe(1);
      expect(taskGeneration).toMatchObject({
        kind: "task_generation",
        scope: {
          goal_id: "goal-1",
          run_id: "run-coreloop-evidence-contract",
          loop_index: 0,
          task_id: "task-1",
        },
      });
      expect(verification).toMatchObject({
        kind: "verification",
        scope: {
          goal_id: "goal-1",
          run_id: "run-coreloop-evidence-contract",
          loop_index: 0,
          task_id: "task-1",
        },
      });
      expect(goalEvidence.entries.map((entry) => entry.id)).toContain(taskGeneration!.id);
    });

    it("persists wait approvals through a real ApprovalStore when the loop routes through the broker", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const waitStrategy = {
        id: "wait-real-approval-store",
        state: "active",
        goal_id: "goal-1",
      };
      mocks.strategyManager.getPortfolio.mockReturnValue({
        goal_id: "goal-1",
        strategies: [waitStrategy],
        rebalance_interval: { value: 7, unit: "days" },
        last_rebalanced_at: new Date().toISOString(),
      });
      const portfolioManager = {
        selectNextStrategyForTask: vi.fn().mockReturnValue(null),
        recordTaskCompletion: vi.fn(),
        shouldRebalance: vi.fn().mockReturnValue(null),
        rebalance: vi.fn().mockReturnValue({
          triggered_by: "periodic",
          adjustments: [],
          new_generation_needed: false,
          timestamp: new Date().toISOString(),
        }),
        isWaitStrategy: vi.fn().mockReturnValue(true),
        handleWaitStrategyExpiry: vi.fn().mockReturnValue({
          status: "approval_required",
          goal_id: "goal-1",
          strategy_id: waitStrategy.id,
          details: "Approve external submission",
        }),
        getRebalanceHistory: vi.fn().mockReturnValue([]),
      };
      const runtimeRoot = path.join(tmpDir, "runtime");
      const approvalStore = new ApprovalStore(runtimeRoot);
      const evidenceLedger = new RuntimeEvidenceLedger(runtimeRoot);
      const approvalBroker = new ApprovalBroker({
        store: approvalStore,
        defaultTimeoutMs: 60_000,
      });

      try {
        const loop = new CoreLoop(
          {
            ...deps,
            evidenceLedger,
            portfolioManager: portfolioManager as any,
            waitApprovalBroker: approvalBroker,
          },
          { delayBetweenLoopsMs: 0, autoDecompose: false },
        );
        const result = await loop.runOneIteration("goal-1", 0);
        const pending = await waitForPendingApproval(approvalStore, result.waitApprovalId!);

        expect(result.waitExpired).toBe(true);
        expect(result.waitApprovalId).toBe(`wait-goal-1-${waitStrategy.id}`);
        expect(pending).toMatchObject({
          approval_id: result.waitApprovalId,
          goal_id: "goal-1",
          state: "pending",
          payload: {
            task: {
              id: `wait:${waitStrategy.id}`,
              action: "wait_strategy_resume_approval",
              description: "Approve external submission",
            },
          },
        });
        const rejectBindingId = approvalBroker.getPendingApprovalEvents()
          .find((approval) => approval.requestId === result.waitApprovalId)
          ?.surface_projection?.actions.find((action) => action.kind === "reject")
          ?.binding_id;
        expect(rejectBindingId).toBeDefined();
        await approvalBroker.resolveApproval(result.waitApprovalId!, false, "test", {
          surfaceActionBindingId: rejectBindingId,
        });
      } finally {
        await approvalBroker.stop();
      }
    });

    it("logs real runtime evidence ledger write failures without aborting the iteration", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const runtimeRootFile = path.join(tmpDir, "runtime-file");
      fs.writeFileSync(runtimeRootFile, "not a directory");
      const evidenceLedger = new RuntimeEvidenceLedger(runtimeRootFile);
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      const loop = new CoreLoop(
        { ...deps, evidenceLedger, logger: logger as any },
        { delayBetweenLoopsMs: 0, autoDecompose: false },
      );
      const result = await loop.run("goal-1", {
        maxIterations: 1,
        activation: {
          backgroundRun: { backgroundRunId: "run-coreloop-evidence-failure" },
        },
      });

      expect(result.totalIterations).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "CoreLoop: failed to append runtime evidence ledger entry",
        expect.objectContaining({
          goalId: "goal-1",
          loopIndex: 0,
          error: expect.any(String),
        }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        "CoreLoop: failed to append runtime evidence ledger entry",
        expect.objectContaining({
          goalId: "goal-1",
          loopIndex: 0,
          kind: "task_generation",
          error: expect.any(String),
        }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        "CoreLoop: failed to append runtime evidence ledger entry",
        expect.objectContaining({
          goalId: "goal-1",
          loopIndex: 0,
          kind: "verification",
          error: expect.any(String),
        }),
      );
    });
  });

  describe("deadline finalization", () => {
    it("skips exploratory task generation at the finalization buffer and exposes the handoff plan", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
      await mocks.stateManager.saveGoal(makeGoal({
        deadline,
        finalization_policy: {
          minimum_buffer_ms: 30 * 60_000,
          consolidation_buffer_ms: 0,
          deliverable_contract: "Package the latest benchmark report",
          best_artifact_selection: "best_evidence",
          require_reproducibility_manifest: false,
          verification_steps: ["Run final smoke test"],
          external_actions: [
            {
              id: "publish-report",
              label: "Publish report",
              tool_name: "publish_report",
              payload_ref: "artifact:best",
              approval_required: true,
            },
          ],
        },
      }));
      const evidenceLedger = {
        append: vi.fn().mockResolvedValue([]),
        summarizeGoal: vi.fn().mockResolvedValue({
          best_evidence: {
            id: "evidence-1",
            occurred_at: new Date().toISOString(),
            kind: "artifact",
            scope: { goal_id: "goal-1" },
            metrics: [],
            artifacts: [
              {
                label: "reports/final.md",
                path: "reports/final.md",
                kind: "report",
              },
            ],
            raw_refs: [],
            summary: "Best benchmark report",
          },
        }),
      };
      const operatorHandoffStore = new RuntimeOperatorHandoffStore(path.join(tmpDir, "runtime"));

      const loop = new CoreLoop(
        { ...deps, evidenceLedger: evidenceLedger as any, operatorHandoffStore },
        { delayBetweenLoopsMs: 0, autoDecompose: false }
      );
      const result = await loop.run("goal-1", { maxIterations: 3 });
      const iteration = result.iterations[0]!;

      expect(result.finalStatus).toBe("finalization");
      expect(result.totalIterations).toBe(1);
      expect(iteration.skipped).toBe(true);
      expect(iteration.skipReason).toBe("deadline_finalization");
      expect(iteration.finalizationStatus).toMatchObject({
        mode: "finalization",
        finalization_plan: {
          deliverable_contract: "Package the latest benchmark report",
          best_artifact: { label: "reports/final.md" },
          verification_steps: ["Run final smoke test"],
          approval_required_actions: [
            {
              id: "publish-report",
              label: "Publish report",
              tool_name: "publish_report",
              payload_ref: "artifact:best",
              approval_required: true,
            },
          ],
        },
      });
      expect(iteration.executionMode).toMatchObject({
        mode: "finalization",
        source: "deadline_finalization",
        approval_required_to_explore: true,
      });
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
      expect(evidenceLedger.append).toHaveBeenCalledWith(expect.objectContaining({
        kind: "decision",
        scope: expect.objectContaining({ phase: "deadline_finalization" }),
        result: expect.objectContaining({ status: "finalization" }),
      }));
      expect(mocks.reportingEngine.generateExecutionSummary).toHaveBeenCalledWith(
        expect.objectContaining({
          finalizationStatus: expect.objectContaining({ mode: "finalization" }),
          executionMode: expect.objectContaining({ mode: "finalization" }),
        })
      );
      expect(await operatorHandoffStore.listOpen()).toEqual([
        expect.objectContaining({
          goal_id: "goal-1",
          triggers: ["deadline", "finalization", "external_action"],
          required_approvals: ["Publish report"],
          next_action: expect.objectContaining({
            label: "Publish report",
            tool_name: "publish_report",
            approval_required: true,
          }),
          gate: expect.objectContaining({
            autonomous_task_generation: "pause",
            external_action_requires_approval: true,
          }),
        }),
      ]);
    });

    it("passes consolidation execution mode into task generation before the finalization cutoff", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      const deadline = new Date(Date.now() + 35 * 60_000).toISOString();
      await mocks.stateManager.saveGoal(makeGoal({
        deadline,
        finalization_policy: {
          minimum_buffer_ms: 30 * 60_000,
          consolidation_buffer_ms: 10 * 60_000,
          best_artifact_selection: "best_evidence",
          require_reproducibility_manifest: false,
          verification_steps: [],
          external_actions: [],
        },
      }));

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0, autoDecompose: false });
      const result = await loop.run("goal-1", { maxIterations: 1 });
      const iteration = result.iterations[0]!;

      expect(iteration.executionMode).toMatchObject({
        mode: "consolidation",
        source: "deadline_finalization",
      });
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
      const callArgs = mocks.taskLifecycle.runTaskCycle.mock.calls[0];
      expect(callArgs[7]).toMatchObject({
        executionMode: expect.objectContaining({ mode: "consolidation" }),
      });
    });

    it("uses the goal artifact selection rule instead of always using best_evidence", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
      await mocks.stateManager.saveGoal(makeGoal({
        deadline,
        finalization_policy: {
          minimum_buffer_ms: 30 * 60_000,
          consolidation_buffer_ms: 0,
          best_artifact_selection: "latest_artifact",
          require_reproducibility_manifest: false,
          verification_steps: [],
          external_actions: [],
        },
      }));
      const oldBestEvidence = {
        id: "best-evidence",
        occurred_at: "2026-04-30T00:00:00.000Z",
        kind: "artifact",
        scope: { goal_id: "goal-1" },
        metrics: [],
        artifacts: [{ label: "reports/best.md", path: "reports/best.md", kind: "report" }],
        raw_refs: [],
        summary: "Best evidence",
      };
      const latestArtifact = {
        id: "latest-artifact",
        occurred_at: "2026-04-30T00:10:00.000Z",
        kind: "artifact",
        scope: { goal_id: "goal-1" },
        metrics: [],
        artifacts: [{ label: "reports/latest.md", path: "reports/latest.md", kind: "report" }],
        raw_refs: [],
        summary: "Latest artifact",
      };
      const evidenceLedger = {
        append: vi.fn().mockResolvedValue([]),
        summarizeGoal: vi.fn().mockResolvedValue({ best_evidence: oldBestEvidence, recent_entries: [latestArtifact, oldBestEvidence] }),
        readByGoal: vi.fn().mockResolvedValue({ entries: [oldBestEvidence, latestArtifact], warnings: [] }),
      };

      const loop = new CoreLoop(
        { ...deps, evidenceLedger: evidenceLedger as any },
        { delayBetweenLoopsMs: 0, autoDecompose: false }
      );
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.finalizationStatus?.finalization_plan?.best_artifact).toMatchObject({
        label: "reports/latest.md",
      });
      expect(evidenceLedger.readByGoal).toHaveBeenCalledWith("goal-1");
    });

    it("uses metric-aware best evidence for best_evidence finalization artifacts", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
      await mocks.stateManager.saveGoal(makeGoal({
        deadline,
        finalization_policy: {
          minimum_buffer_ms: 30 * 60_000,
          consolidation_buffer_ms: 0,
          best_artifact_selection: "best_evidence",
          require_reproducibility_manifest: false,
          verification_steps: [],
          external_actions: [],
        },
      }));
      const evidenceLedger = new RuntimeEvidenceLedger(path.join(tmpDir, "runtime"));
      await evidenceLedger.append({
        id: "old-improved",
        occurred_at: "2026-04-30T00:00:00.000Z",
        kind: "metric",
        scope: { goal_id: "goal-1" },
        metrics: [{ label: "accuracy", value: 0.72, direction: "maximize" }],
        artifacts: [{ label: "reports/old.md", path: "reports/old.md", kind: "report" }],
        summary: "Old improved artifact.",
        outcome: "improved",
      });
      await evidenceLedger.append({
        id: "new-best",
        occurred_at: "2026-04-30T00:10:00.000Z",
        kind: "metric",
        scope: { goal_id: "goal-1" },
        metrics: [{ label: "accuracy", value: 0.91, direction: "maximize" }],
        artifacts: [{ label: "reports/new.md", path: "reports/new.md", kind: "report" }],
        summary: "New best metric artifact.",
        outcome: "continued",
      });

      const loop = new CoreLoop(
        { ...deps, evidenceLedger },
        { delayBetweenLoopsMs: 0, autoDecompose: false }
      );
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.finalizationStatus?.finalization_plan?.best_artifact).toMatchObject({
        label: "reports/new.md",
      });
    });

    it("observes a ready reproducibility manifest before final handoff", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
      await mocks.stateManager.saveGoal(makeGoal({
        deadline,
        finalization_policy: {
          minimum_buffer_ms: 30 * 60_000,
          consolidation_buffer_ms: 0,
          best_artifact_selection: "latest_artifact",
          require_reproducibility_manifest: true,
          verification_steps: [],
          external_actions: [],
        },
      }));

      const runtimeRoot = path.join(tmpDir, "runtime");
      await fs.promises.mkdir(path.join(runtimeRoot, "runs/final"), { recursive: true });
      await fs.promises.writeFile(path.join(runtimeRoot, "runs/final/report.md"), "# Final report\n", "utf8");
      const evidenceLedger = new RuntimeEvidenceLedger(runtimeRoot);
      await evidenceLedger.append({
        id: "final-artifact",
        occurred_at: "2026-04-30T00:10:00.000Z",
        kind: "artifact",
        scope: { goal_id: "goal-1" },
        artifacts: [{ label: "reports/final.md", state_relative_path: "runs/final/report.md", kind: "report" }],
        summary: "Final artifact ready.",
        outcome: "improved",
      });
      const manifest = await new RuntimeReproducibilityManifestStore(runtimeRoot).createOrUpdateForCandidate({
        goalId: "goal-1",
        deliverableArtifact: {
          label: "reports/final.md",
          kind: "report",
          state_relative_path: "runs/final/report.md",
          source: "runtime_evidence_ledger",
        },
        codeState: { commit: "abc123", dirty: false },
      });

      const loop = new CoreLoop(
        { ...deps, evidenceLedger },
        { delayBetweenLoopsMs: 0, autoDecompose: false }
      );
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.finalizationStatus?.finalization_plan).toMatchObject({
        reproducibility_manifest: {
          required: true,
          status: "ready",
          manifest_id: manifest.manifest_id,
        },
        handoff_required: false,
      });
    });

    it("does not accept a ready manifest when no final artifact is selected", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
      await mocks.stateManager.saveGoal(makeGoal({
        deadline,
        finalization_policy: {
          minimum_buffer_ms: 30 * 60_000,
          consolidation_buffer_ms: 0,
          best_artifact_selection: "latest_verified",
          require_reproducibility_manifest: true,
          verification_steps: [],
          external_actions: [],
        },
      }));

      const runtimeRoot = path.join(tmpDir, "runtime");
      await fs.promises.mkdir(path.join(runtimeRoot, "runs/final"), { recursive: true });
      await fs.promises.writeFile(path.join(runtimeRoot, "runs/final/report.md"), "# Final report\n", "utf8");
      const evidenceLedger = new RuntimeEvidenceLedger(runtimeRoot);
      await evidenceLedger.append({
        id: "unverified-final-artifact",
        occurred_at: "2026-04-30T00:10:00.000Z",
        kind: "artifact",
        scope: { goal_id: "goal-1" },
        artifacts: [{ label: "reports/final.md", state_relative_path: "runs/final/report.md", kind: "report" }],
        summary: "Unverified artifact ready.",
        outcome: "continued",
      });
      await new RuntimeReproducibilityManifestStore(runtimeRoot).createOrUpdateForCandidate({
        goalId: "goal-1",
        deliverableArtifact: {
          label: "reports/final.md",
          kind: "report",
          state_relative_path: "runs/final/report.md",
          source: "runtime_evidence_ledger",
        },
        codeState: { commit: "abc123", dirty: false },
      });

      const loop = new CoreLoop(
        { ...deps, evidenceLedger },
        { delayBetweenLoopsMs: 0, autoDecompose: false }
      );
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.finalizationStatus?.finalization_plan).toMatchObject({
        best_artifact: null,
        reproducibility_manifest: {
          required: true,
          status: "required_missing",
        },
        handoff_required: true,
      });
    });

    it("can select the latest verified artifact for finalization", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
      await mocks.stateManager.saveGoal(makeGoal({
        deadline,
        finalization_policy: {
          minimum_buffer_ms: 30 * 60_000,
          consolidation_buffer_ms: 0,
          best_artifact_selection: "latest_verified",
          require_reproducibility_manifest: false,
          verification_steps: [],
          external_actions: [],
        },
      }));
      const latestArtifact = {
        id: "latest-artifact",
        occurred_at: "2026-04-30T00:10:00.000Z",
        kind: "artifact",
        scope: { goal_id: "goal-1" },
        metrics: [],
        artifacts: [{ label: "reports/latest-unverified.md", path: "reports/latest-unverified.md", kind: "report" }],
        raw_refs: [],
        summary: "Latest artifact without verification",
      };
      const latestVerified = {
        id: "latest-verified",
        occurred_at: "2026-04-30T00:05:00.000Z",
        kind: "verification",
        scope: { goal_id: "goal-1", task_id: "task-verified" },
        verification: { verdict: "pass", confidence: 0.9, summary: "smoke passed" },
        metrics: [],
        artifacts: [],
        raw_refs: [],
        outcome: "improved",
        summary: "Verification pass for task-verified",
      };
      const verifiedExecution = {
        id: "verified-execution",
        occurred_at: "2026-04-30T00:04:00.000Z",
        kind: "execution",
        scope: { goal_id: "goal-1", task_id: "task-verified" },
        metrics: [],
        artifacts: [{ label: "reports/verified.md", path: "reports/verified.md", kind: "report" }],
        raw_refs: [],
        outcome: "improved",
        summary: "Verified artifact execution",
      };
      const evidenceLedger = {
        append: vi.fn().mockResolvedValue([]),
        readByGoal: vi.fn().mockResolvedValue({
          entries: [latestArtifact, verifiedExecution, latestVerified],
          warnings: [],
        }),
      };

      const loop = new CoreLoop(
        { ...deps, evidenceLedger: evidenceLedger as any },
        { delayBetweenLoopsMs: 0, autoDecompose: false }
      );
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.finalizationStatus?.finalization_plan?.best_artifact).toMatchObject({
        label: "reports/verified.md",
      });
    });
  });

  // ─── KnowledgeManager integration ───

  describe("KnowledgeManager integration", async () => {
    function makeAcquisitionTask() {
      return {
        id: "acq-task-1",
        goal_id: "goal-1",
        strategy_id: null,
        target_dimensions: [],
        primary_dimension: "knowledge",
        work_description: "Research task: missing knowledge",
        rationale: "Knowledge gap detected",
        approach: "Research questions",
        success_criteria: [
          {
            description: "All questions answered",
            verification_method: "Manual review",
            is_blocking: true,
          },
        ],
        scope_boundary: {
          in_scope: ["Information collection"],
          out_of_scope: ["System modifications"],
          blast_radius: "None — read-only research task",
        },
        constraints: ["No system modifications allowed"],
        plateau_until: null,
        estimated_duration: { value: 4, unit: "hours" as const },
        consecutive_failure_count: 0,
        reversibility: "reversible" as const,
        task_category: "knowledge_acquisition" as const,
        status: "pending" as const,
        started_at: null,
        completed_at: null,
        timeout_at: null,
        heartbeat_at: null,
        created_at: new Date().toISOString(),
      };
    }

    it("generates acquisition task when knowledge gap detected", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const gapSignal = {
        signal_type: "interpretation_difficulty" as const,
        missing_knowledge: "Unknown domain",
        source_step: "gap_recognition",
        related_dimension: null,
      };

      const acquisitionTask = makeAcquisitionTask();

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockResolvedValue(gapSignal),
        generateAcquisitionTask: vi.fn().mockResolvedValue(acquisitionTask),
        getRelevantKnowledge: vi.fn().mockResolvedValue([]),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue([]),
        checkContradiction: vi.fn(),
      };

      const depsWithKM = { ...deps, knowledgeManager: knowledgeManager as any };
      const loop = new CoreLoop(depsWithKM, { delayBetweenLoopsMs: 0, adapterType: "test_adapter" as any });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(knowledgeManager.detectKnowledgeGap).toHaveBeenCalledOnce();
      expect(knowledgeManager.generateAcquisitionTask).toHaveBeenCalledWith(gapSignal, "goal-1");
      // runTaskCycle should NOT have been called — early return with acquisition task
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
      expect(result.taskResult).not.toBeNull();
      expect(result.taskResult?.task.task_category).toBe("knowledge_acquisition");
      expect(result.taskResult?.action).toBe("completed");
    });

    it("proceeds with normal task cycle when no knowledge gap detected", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockResolvedValue(null),
        generateAcquisitionTask: vi.fn(),
        getRelevantKnowledge: vi.fn().mockResolvedValue([]),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue([]),
        checkContradiction: vi.fn(),
      };

      const depsWithKM = { ...deps, knowledgeManager: knowledgeManager as any };
      const loop = new CoreLoop(depsWithKM, { delayBetweenLoopsMs: 0, adapterType: "test_adapter" as any });
      await loop.runOneIteration("goal-1", 0);

      expect(knowledgeManager.detectKnowledgeGap).toHaveBeenCalledOnce();
      expect(knowledgeManager.generateAcquisitionTask).not.toHaveBeenCalled();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });

    it("skips knowledge-gap diversion for workspace-backed code goals", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal({
        constraints: [`workspace_path:${tmpDir}`],
      }));

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockResolvedValue({
          signal_type: "interpretation_difficulty" as const,
          missing_knowledge: "Unknown domain",
          source_step: "gap_recognition",
          related_dimension: null,
        }),
        generateAcquisitionTask: vi.fn(),
        getRelevantKnowledge: vi.fn().mockResolvedValue([]),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue([]),
        checkContradiction: vi.fn(),
      };

      const depsWithKM = { ...deps, knowledgeManager: knowledgeManager as any };
      const loop = new CoreLoop(depsWithKM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(knowledgeManager.detectKnowledgeGap).not.toHaveBeenCalled();
      expect(knowledgeManager.generateAcquisitionTask).not.toHaveBeenCalled();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });

    it("injects relevant knowledge into task generation context", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      await saveDreamConfig({
        activation: {
          verifiedPlannerHintsOnly: false,
          semanticWorkingMemory: false,
          crossGoalLessons: false,
          semanticContext: false,
          autoAcquireKnowledge: false,
          learnedPatternHints: false,
          playbookHints: false,
          workflowHints: false,
          strategyTemplates: false,
          decisionHeuristics: false,
          graphTraversal: false,
        },
      }, mocks.stateManager.getBaseDir());

      const knowledgeEntries = [
        {
          entry_id: "e1",
          question: "What is the auth pattern?",
          answer: "JWT tokens",
          sources: [],
          confidence: 0.9,
          acquired_at: new Date().toISOString(),
          acquisition_task_id: "t1",
          superseded_by: null,
          tags: ["dim2"],
        },
      ];

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockResolvedValue(null),
        generateAcquisitionTask: vi.fn(),
        getRelevantKnowledge: vi.fn().mockResolvedValue(knowledgeEntries),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue(knowledgeEntries),
        checkContradiction: vi.fn(),
      };

      const depsWithKM = { ...deps, knowledgeManager: knowledgeManager as any };
      const loop = new CoreLoop(depsWithKM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(knowledgeManager.getRelevantKnowledge).toHaveBeenCalledWith(
        "goal-1",
        expect.any(String),
        expect.objectContaining({
          relationshipProfileContext: expect.objectContaining({ scope: "memory_retrieval" }),
        })
      );
      // runTaskCycle should receive knowledgeContext as the 5th argument
      const callArgs = mocks.taskLifecycle.runTaskCycle.mock.calls[0];
      expect(callArgs![4]).toContain("JWT tokens");
    });

    it("passes Surface-admitted relationship profile context through production task-cycle recall", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      await saveDreamConfig({
        activation: {
          verifiedPlannerHintsOnly: false,
          semanticWorkingMemory: false,
          crossGoalLessons: false,
          semanticContext: true,
          autoAcquireKnowledge: false,
          learnedPatternHints: false,
          playbookHints: false,
          workflowHints: false,
          strategyTemplates: false,
          decisionHeuristics: false,
          graphTraversal: false,
        },
      }, mocks.stateManager.getBaseDir());
      await upsertRelationshipProfileItem(mocks.stateManager.getBaseDir(), {
        stableKey: "user.preference.status",
        kind: "preference",
        value: "Prefer verbose status reports.",
        source: "cli_update",
        allowedScopes: ["memory_retrieval", "user_facing_review"],
        now: "2026-05-03T00:00:00.000Z",
      });
      await upsertRelationshipProfileItem(mocks.stateManager.getBaseDir(), {
        stableKey: "user.preference.status",
        kind: "preference",
        value: "Prefer concise status reports.",
        source: "cli_update",
        allowedScopes: ["memory_retrieval", "user_facing_review"],
        now: "2026-05-03T00:01:00.000Z",
      });
      await upsertRelationshipProfileItem(mocks.stateManager.getBaseDir(), {
        stableKey: "user.boundary.health",
        kind: "boundary",
        value: "Do not retrieve health context unless explicitly allowed.",
        source: "cli_update",
        sensitivity: "sensitive",
        allowedScopes: ["memory_retrieval", "user_facing_review"],
        now: "2026-05-03T00:02:00.000Z",
      });
      await upsertRelationshipProfileItem(mocks.stateManager.getBaseDir(), {
        stableKey: "user.preference.editor",
        kind: "preference",
        value: "Prefer VS Code.",
        source: "cli_update",
        allowedScopes: ["memory_retrieval", "user_facing_review"],
        now: "2026-05-03T00:03:00.000Z",
      });
      await retractRelationshipProfileItem(mocks.stateManager.getBaseDir(), {
        stableKey: "user.preference.editor",
        reason: "No longer current.",
        now: "2026-05-03T00:04:00.000Z",
      });

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockResolvedValue(null),
        generateAcquisitionTask: vi.fn(),
        getRelevantKnowledge: vi.fn().mockResolvedValue([]),
        searchKnowledge: vi.fn().mockResolvedValue([]),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue([]),
        checkContradiction: vi.fn(),
      };

      const loop = new CoreLoop({ ...deps, knowledgeManager: knowledgeManager as any }, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      const semanticQuery = knowledgeManager.searchKnowledge.mock.calls[0]?.[0] as string;
      const relevantOptions = knowledgeManager.getRelevantKnowledge.mock.calls[0]?.[2];
      const semanticOptions = knowledgeManager.searchKnowledge.mock.calls[0]?.[2];
      const expectedSurfaceHeader = "Relationship profile retrieval context Surface (surface_id=surface:relationship-profile:agent_loop:goal-1:memory_retrieval; requested_use=runtime_grounding)";
      const rawRetrievalHeader = "Relationship profile retrieval context (scope=memory_retrieval; include_sensitive=false)";
      expect(relevantOptions?.relationshipProfileContext).toMatchObject({
        scope: "memory_retrieval",
        includeSensitive: false,
      });
      expect(relevantOptions?.relationshipProfileContext.items.map((item: { value: string }) => item.value)).toEqual([
        "Prefer concise status reports.",
      ]);
      expect(semanticOptions?.relationshipProfileContext.items.map((item: { value: string }) => item.value)).toEqual([
        "Prefer concise status reports.",
      ]);
      expect(semanticOptions?.relationshipProfilePromptContext).toContain(expectedSurfaceHeader);
      expect(semanticOptions?.relationshipProfilePromptContext).toContain("Use only Surface-included relationship context below.");
      expect(semanticOptions?.relationshipProfilePromptContext).not.toContain(rawRetrievalHeader);
      expect(semanticQuery).toContain(expectedSurfaceHeader);
      expect(semanticQuery).toContain("Use only Surface-included relationship context below.");
      expect(semanticQuery).not.toContain(rawRetrievalHeader);
      expect(semanticQuery).toContain("Prefer concise status reports.");
      expect(semanticQuery).not.toContain("Prefer verbose status reports.");
      expect(semanticQuery).not.toContain("Do not retrieve health context");
      expect(semanticQuery).not.toContain("Prefer VS Code.");
      const callArgs = mocks.taskLifecycle.runTaskCycle.mock.calls[0];
      expect(callArgs![4]).toContain(expectedSurfaceHeader);
      expect(callArgs![4]).toContain("Use only Surface-included relationship context below.");
      expect(callArgs![4]).not.toContain(rawRetrievalHeader);
      expect(callArgs![4]).toContain("Prefer concise status reports.");
      expect(callArgs![4]).not.toContain("Prefer verbose status reports.");
      expect(callArgs![4]).not.toContain("Do not retrieve health context");
      expect(callArgs![4]).not.toContain("Prefer VS Code.");
    });

    it("does not inject legacy direct cross-goal lessons from task-cycle", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      await saveDreamConfig({
        activation: {
          verifiedPlannerHintsOnly: false,
          semanticWorkingMemory: false,
          crossGoalLessons: true,
          semanticContext: false,
          autoAcquireKnowledge: false,
          learnedPatternHints: false,
          playbookHints: false,
          workflowHints: false,
          strategyTemplates: false,
          decisionHeuristics: false,
          graphTraversal: false,
        },
      }, mocks.stateManager.getBaseDir());

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockResolvedValue(null),
        generateAcquisitionTask: vi.fn(),
        getRelevantKnowledge: vi.fn().mockResolvedValue([]),
        searchKnowledge: vi.fn().mockResolvedValue([]),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue([]),
        checkContradiction: vi.fn(),
      };
      const memoryLifecycleManager = {
        searchCrossGoalLessons: vi.fn().mockResolvedValue([
          { lesson: "Reuse the migration checklist before touching schemas" },
        ]),
        selectForWorkingMemoryTierAware: vi.fn().mockResolvedValue({ shortTerm: [], lessons: [] }),
        onSatisficingJudgment: vi.fn(),
      };

      const loop = new CoreLoop(
        { ...deps, knowledgeManager: knowledgeManager as any, memoryLifecycleManager: memoryLifecycleManager as any },
        { delayBetweenLoopsMs: 0 }
      );
      const result = await loop.runOneIteration("goal-1", 1);

      expect(result.error).toBeNull();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
      const callArgs = mocks.taskLifecycle.runTaskCycle.mock.calls[0];
      expect(memoryLifecycleManager.searchCrossGoalLessons).not.toHaveBeenCalled();
      expect(callArgs![4] ?? "").not.toContain("Cross-goal lessons");
      expect(callArgs![4] ?? "").not.toContain("migration checklist");
    });

    it("does not inject raw knowledge or semantic working memory when verified-only mode is enabled", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      await saveDreamConfig({
        activation: {
          verifiedPlannerHintsOnly: true,
          semanticWorkingMemory: true,
          crossGoalLessons: false,
          semanticContext: true,
          autoAcquireKnowledge: false,
          learnedPatternHints: false,
          playbookHints: false,
          workflowHints: false,
          strategyTemplates: false,
          decisionHeuristics: false,
          graphTraversal: false,
        },
      }, mocks.stateManager.getBaseDir());

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockResolvedValue(null),
        generateAcquisitionTask: vi.fn(),
        getRelevantKnowledge: vi.fn().mockResolvedValue([
          {
            entry_id: "e1",
            question: "Raw knowledge",
            answer: "should not be injected",
            sources: [],
            confidence: 0.9,
            acquired_at: new Date().toISOString(),
            acquisition_task_id: "t1",
            superseded_by: null,
            tags: ["dim1"],
          },
        ]),
        searchKnowledge: vi.fn().mockResolvedValue([
          {
            entry_id: "e2",
            question: "Semantic knowledge",
            answer: "should also stay out",
            sources: [],
            confidence: 0.7,
            acquired_at: new Date().toISOString(),
            acquisition_task_id: "t2",
            superseded_by: null,
            tags: ["dim1"],
          },
        ]),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue([]),
        checkContradiction: vi.fn(),
      };
      const memoryLifecycleManager = {
        selectForWorkingMemoryTierAware: vi.fn().mockResolvedValue({
          shortTerm: [{ data_type: "note", data: { value: "raw working memory" } }],
          lessons: [],
        }),
        selectForWorkingMemorySemantic: vi.fn().mockResolvedValue({
          shortTerm: [{ data_type: "note", data: { value: "semantic working memory" } }],
          lessons: [],
        }),
        onSatisficingJudgment: vi.fn(),
      };

      const loop = new CoreLoop(
        {
          ...deps,
          knowledgeManager: knowledgeManager as any,
          memoryLifecycleManager: memoryLifecycleManager as any,
        },
        { delayBetweenLoopsMs: 0 }
      );
      await loop.runOneIteration("goal-1", 0);

      expect(knowledgeManager.getRelevantKnowledge).not.toHaveBeenCalled();
      expect(knowledgeManager.searchKnowledge).not.toHaveBeenCalled();
      expect(memoryLifecycleManager.selectForWorkingMemoryTierAware).not.toHaveBeenCalled();
      expect(memoryLifecycleManager.selectForWorkingMemorySemantic).not.toHaveBeenCalled();
      const callArgs = mocks.taskLifecycle.runTaskCycle.mock.calls[0];
      expect(callArgs![4]).toBeUndefined();
    });

    it("restores raw knowledge injection when verified-only mode is disabled", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      await saveDreamConfig({
        activation: {
          verifiedPlannerHintsOnly: false,
          semanticWorkingMemory: true,
          crossGoalLessons: false,
          semanticContext: true,
          autoAcquireKnowledge: false,
          learnedPatternHints: false,
          playbookHints: false,
          workflowHints: false,
          strategyTemplates: false,
          decisionHeuristics: false,
          graphTraversal: false,
        },
      }, mocks.stateManager.getBaseDir());

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockResolvedValue(null),
        generateAcquisitionTask: vi.fn(),
        getRelevantKnowledge: vi.fn().mockResolvedValue([
          {
            entry_id: "e1",
            question: "Raw knowledge",
            answer: "allowed when gate is off",
            sources: [],
            confidence: 0.9,
            acquired_at: new Date().toISOString(),
            acquisition_task_id: "t1",
            superseded_by: null,
            tags: ["dim1"],
          },
        ]),
        searchKnowledge: vi.fn().mockResolvedValue([
          {
            entry_id: "e2",
            question: "Semantic knowledge",
            answer: "also allowed when gate is off",
            sources: [],
            confidence: 0.7,
            acquired_at: new Date().toISOString(),
            acquisition_task_id: "t2",
            superseded_by: null,
            tags: ["dim1"],
          },
        ]),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue([]),
        checkContradiction: vi.fn(),
      };
      const memoryLifecycleManager = {
        selectForWorkingMemoryTierAware: vi.fn().mockResolvedValue({ shortTerm: [], lessons: [] }),
        selectForWorkingMemorySemantic: vi.fn().mockResolvedValue({
          shortTerm: [{ data_type: "note", data: { value: "semantic working memory" } }],
          lessons: [],
        }),
        onSatisficingJudgment: vi.fn(),
      };

      const loop = new CoreLoop(
        {
          ...deps,
          knowledgeManager: knowledgeManager as any,
          memoryLifecycleManager: memoryLifecycleManager as any,
        },
        { delayBetweenLoopsMs: 0 }
      );
      await loop.runOneIteration("goal-1", 0);

      expect(knowledgeManager.getRelevantKnowledge).toHaveBeenCalledOnce();
      expect(knowledgeManager.searchKnowledge).toHaveBeenCalledOnce();
      expect(memoryLifecycleManager.selectForWorkingMemoryTierAware).toHaveBeenCalledOnce();
      expect(memoryLifecycleManager.selectForWorkingMemorySemantic).toHaveBeenCalledOnce();
      const callArgs = mocks.taskLifecycle.runTaskCycle.mock.calls[0];
      expect(callArgs![4]).toContain("allowed when gate is off");
      expect(callArgs![4]).toContain("semantic working memory");
    });

    it("skips knowledge injection gracefully when getRelevantKnowledge returns empty", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockResolvedValue(null),
        generateAcquisitionTask: vi.fn(),
        getRelevantKnowledge: vi.fn().mockResolvedValue([]),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue([]),
        checkContradiction: vi.fn(),
      };

      const depsWithKM = { ...deps, knowledgeManager: knowledgeManager as any };
      const loop = new CoreLoop(depsWithKM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      const callArgs = mocks.taskLifecycle.runTaskCycle.mock.calls[0];
      // knowledgeContext should be undefined when no entries found
      expect(callArgs![4]).toBeUndefined();
    });

    it("continues normally when knowledgeManager is undefined", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      // No knowledgeManager in deps
      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toBeNull();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });

    it("non-fatal: continues when detectKnowledgeGap throws", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockRejectedValue(new Error("LLM failure")),
        generateAcquisitionTask: vi.fn(),
        getRelevantKnowledge: vi.fn().mockResolvedValue([]),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue([]),
        checkContradiction: vi.fn(),
      };

      const depsWithKM = { ...deps, knowledgeManager: knowledgeManager as any };
      const loop = new CoreLoop(depsWithKM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      // Should fall through to normal task cycle
      expect(result.error).toBeNull();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });

    it("auto-acquires knowledge and skips execution when enabled and stalled", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      await saveDreamConfig({
        activation: {
          verifiedPlannerHintsOnly: true,
          semanticWorkingMemory: false,
          crossGoalLessons: false,
          semanticContext: false,
          autoAcquireKnowledge: true,
          learnedPatternHints: false,
          playbookHints: false,
          workflowHints: false,
          strategyTemplates: false,
          decisionHeuristics: false,
          graphTraversal: false,
        },
      }, mocks.stateManager.getBaseDir());
      mocks.stallDetector.checkDimensionStall.mockReturnValue({
        stall_type: "plateau",
        confidence: 0.9,
        escalation_level: 1,
        suggested_cause: "information_deficit",
      });

      const knowledgeManager = {
        detectKnowledgeGap: vi.fn().mockResolvedValue({
          signal_type: "stall_information_deficit",
          missing_knowledge: "Need database migration constraints",
          source_step: "stall_detection",
          related_dimension: "dim1",
        }),
        generateAcquisitionTask: vi.fn(),
        acquireWithTools: vi.fn().mockResolvedValue([
          {
            entry_id: "k-1",
            question: "Need database migration constraints",
            answer: "Run schema diff before applying migrations",
            sources: [],
            confidence: 0.8,
            acquired_at: new Date().toISOString(),
            acquisition_task_id: "tool_direct",
            superseded_by: null,
            tags: ["db"],
            embedding_id: null,
          },
        ]),
        getRelevantKnowledge: vi.fn().mockResolvedValue([]),
        searchKnowledge: vi.fn().mockResolvedValue([]),
        saveKnowledge: vi.fn(),
        loadKnowledge: vi.fn().mockResolvedValue([]),
        checkContradiction: vi.fn(),
      };
      const toolExecutor = { executeBatch: vi.fn() };

      const hookManager = {
        emit: vi.fn().mockResolvedValue(undefined),
        getDreamCollector: vi.fn(),
      };
      const loop = new CoreLoop(
        { ...deps, knowledgeManager: knowledgeManager as any, toolExecutor: toolExecutor as any, hookManager: hookManager as any },
        { delayBetweenLoopsMs: 0 }
      );
      const result = await loop.runOneIteration("goal-1", 1);

      expect(result.error).toBeNull();
      expect(result.stallDetected).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe("dream_auto_acquire_knowledge");
      expect(knowledgeManager.acquireWithTools).toHaveBeenCalledOnce();
      expect(knowledgeManager.saveKnowledge).toHaveBeenCalledOnce();
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
      expect(hookManager.emit).toHaveBeenCalledWith("StallDetected", expect.any(Object));
    });
  });

  // ─── CapabilityDetector integration ───

  describe("CapabilityDetector integration", async () => {
    it("contract: real TaskLifecycle turns a detected permission gap into CoreLoop escalation", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const llmClient = createMockLLMClient([
        "```json\n" + makeGeneratedTaskResponse() + "\n```",
        JSON.stringify({
          has_deficiency: true,
          missing_capability: {
            name: "Production deployment approval",
            type: "permission",
          },
          reason: "Deploying this service requires explicit production approval.",
          alternatives: ["Request approval from the operator"],
          impact_description: "The deployment task cannot proceed safely without approval.",
        }),
      ]);
      const sessionManager = new SessionManager(mocks.stateManager);
      const trustManager = new TrustManager(mocks.stateManager);
      const stallDetector = new RealStallDetector(mocks.stateManager);
      const strategyManager = new RealStrategyManager(mocks.stateManager, llmClient);
      const reportingEngine = new RealReportingEngine(mocks.stateManager);
      const capabilityDetector = new CapabilityDetector(
        mocks.stateManager,
        llmClient,
        reportingEngine
      );
      const taskLifecycle = new RealTaskLifecycle(
        mocks.stateManager,
        llmClient,
        sessionManager,
        trustManager,
        strategyManager,
        stallDetector,
        {
          approvalFn: async () => true,
          capabilityDetector,
          healthCheckEnabled: false,
        }
      );

      const loop = new CoreLoop(
        {
          ...deps,
          taskLifecycle,
          stallDetector,
          strategyManager,
          reportingEngine,
          capabilityDetector,
        },
        { delayBetweenLoopsMs: 0 }
      );
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toBeNull();
      expect(result.taskResult?.action).toBe("escalate");
      expect(result.taskResult?.verificationResult.evidence[0]?.description).toContain(
        "Capability deficiency: Production deployment approval"
      );
      expect(mocks.adapter.execute).not.toHaveBeenCalled();
      expect(llmClient.callCount).toBe(2);
    });

    it("delegates capability detection to TaskLifecycle when capabilityDetector provided and deficiency detected", async () => {
      // Capability detection is handled inside TaskLifecycle.runTaskCycle, not CoreLoop.
      // CoreLoop must still call runTaskCycle and return whatever result TaskLifecycle produces.
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const escalateResult = makeTaskCycleResult({ action: "escalate" });
      mocks.taskLifecycle.runTaskCycle.mockResolvedValue(escalateResult);

      const capabilityDetector = {
        detectDeficiency: vi.fn(),
        escalateToUser: vi.fn(),
        loadRegistry: vi.fn(),
        saveRegistry: vi.fn(),
        registerCapability: vi.fn(),
        confirmDeficiency: vi.fn(),
      };

      const depsWithCD = { ...deps, capabilityDetector: capabilityDetector as any };
      const loop = new CoreLoop(depsWithCD, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      // CoreLoop must delegate to runTaskCycle — capability detection is TaskLifecycle's concern
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
      // CoreLoop must NOT call detectDeficiency directly (avoids duplicate calls + orphan tasks)
      expect(capabilityDetector.detectDeficiency).not.toHaveBeenCalled();
      expect(result.taskResult?.action).toBe("escalate");
    });

    it("proceeds with runTaskCycle when capabilityDetector provided and no deficiency", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const capabilityDetector = {
        detectDeficiency: vi.fn(),
        escalateToUser: vi.fn(),
        loadRegistry: vi.fn(),
        saveRegistry: vi.fn(),
        registerCapability: vi.fn(),
        confirmDeficiency: vi.fn(),
      };

      const depsWithCD = { ...deps, capabilityDetector: capabilityDetector as any };
      const loop = new CoreLoop(depsWithCD, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      // CoreLoop delegates to runTaskCycle; capability detection is inside TaskLifecycle
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
      expect(capabilityDetector.detectDeficiency).not.toHaveBeenCalled();
      expect(capabilityDetector.escalateToUser).not.toHaveBeenCalled();
    });

    it("continues normally when capabilityDetector is undefined", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toBeNull();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });

    it("always calls runTaskCycle even when capabilityDetector is present", async () => {
      // CoreLoop no longer calls detectDeficiency directly — TaskLifecycle owns that.
      // Verify CoreLoop always reaches runTaskCycle regardless of capabilityDetector presence.
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const capabilityDetector = {
        detectDeficiency: vi.fn(),
        escalateToUser: vi.fn(),
        loadRegistry: vi.fn(),
        saveRegistry: vi.fn(),
        registerCapability: vi.fn(),
        confirmDeficiency: vi.fn(),
      };

      const depsWithCD = { ...deps, capabilityDetector: capabilityDetector as any };
      const loop = new CoreLoop(depsWithCD, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toBeNull();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });
  });

  // ─── PortfolioManager integration ───

  describe("PortfolioManager integration", async () => {
    function createMockPortfolioManager() {
      return {
        selectNextStrategyForTask: vi.fn().mockReturnValue(null),
        recordTaskCompletion: vi.fn(),
        shouldRebalance: vi.fn().mockReturnValue(null),
        rebalance: vi.fn().mockReturnValue({ triggered_by: "periodic", adjustments: [], new_generation_needed: false, timestamp: new Date().toISOString() }),
        isWaitStrategy: vi.fn().mockReturnValue(false),
        handleWaitStrategyExpiry: vi.fn().mockReturnValue(null),
        getRebalanceHistory: vi.fn().mockReturnValue([]),
      };
    }

    it("works without portfolioManager (backward compat)", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      // deps has no portfolioManager
      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.error).toBeNull();
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });

    it("calls selectNextStrategyForTask when portfolioManager provided", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const portfolioManager = createMockPortfolioManager();
      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.selectNextStrategyForTask).toHaveBeenCalledWith("goal-1");
    });

    it("calls setOnTaskComplete when selectNextStrategyForTask returns a result", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const selectionResult = { strategy_id: "strategy-1", allocation: 0.6 };
      const portfolioManager = createMockPortfolioManager();
      portfolioManager.selectNextStrategyForTask.mockReturnValue(selectionResult);

      // Add setOnTaskComplete to taskLifecycle mock
      mocks.taskLifecycle.setOnTaskComplete = vi.fn();

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(mocks.taskLifecycle.setOnTaskComplete).toHaveBeenCalledWith(expect.any(Function));
    });

    it("calls recordTaskCompletion after task completion when strategy_id present", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      // Task result has a strategy_id
      const taskResultWithStrategy = makeTaskCycleResult({
        action: "completed",
        task: {
          ...makeTaskCycleResult().task,
          strategy_id: "strategy-abc",
        },
      });
      mocks.taskLifecycle.runTaskCycle.mockResolvedValue(taskResultWithStrategy);

      const portfolioManager = createMockPortfolioManager();
      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.recordTaskCompletion).toHaveBeenCalledWith("strategy-abc");
    });

    it("does not call recordTaskCompletion when task action is not completed", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const taskResultKeep = makeTaskCycleResult({
        action: "keep",
        task: {
          ...makeTaskCycleResult().task,
          strategy_id: "strategy-abc",
        },
      });
      mocks.taskLifecycle.runTaskCycle.mockResolvedValue(taskResultKeep);

      const portfolioManager = createMockPortfolioManager();
      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.recordTaskCompletion).not.toHaveBeenCalled();
    });

    it("checks shouldRebalance after stall detection", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());
      mocks.stallDetector.checkDimensionStall.mockReturnValue(makeStallReport());

      const portfolioManager = createMockPortfolioManager();
      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.shouldRebalance).toHaveBeenCalledWith("goal-1");
    });

    it("calls rebalance when shouldRebalance returns a trigger", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const trigger = { type: "periodic" as const, details: "interval elapsed" };
      const portfolioManager = createMockPortfolioManager();
      portfolioManager.shouldRebalance.mockReturnValue(trigger);

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.rebalance).toHaveBeenCalledWith("goal-1", trigger);
    });

    it("calls onStallDetected when rebalance requires new generation", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const trigger = { type: "periodic" as const, details: "interval elapsed" };
      const portfolioManager = createMockPortfolioManager();
      portfolioManager.shouldRebalance.mockReturnValue(trigger);
      portfolioManager.rebalance.mockReturnValue({
        triggered_by: "periodic",
        adjustments: [],
        new_generation_needed: true,
        timestamp: new Date().toISOString(),
      });

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(mocks.strategyManager.onStallDetected).toHaveBeenCalledWith("goal-1", 3, expect.any(String), undefined);
    });

    it("uses the real wait expiry path through PortfolioManager when the current process session has exited", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal({
        dimensions: [makeDimension({ name: "dim1" })],
      }));

      const waitStrategy = makeWaitStrategyForCoreLoop();
      const processSessionId = "sess-current";
      await mocks.stateManager.writeRaw(`runtime/process-sessions/${processSessionId}.json`, {
        session_id: processSessionId,
        command: "node",
        args: [],
        cwd: tmpDir,
        running: false,
        exitCode: 0,
        signal: null,
        startedAt: "2026-05-10T00:00:00.000Z",
        exitedAt: "2026-05-10T00:01:00.000Z",
        pid: 4242,
        bufferedChars: 0,
      });

      mocks.strategyManager.getPortfolio.mockReturnValue({
        goal_id: "goal-1",
        strategies: [waitStrategy],
        rebalance_interval: { value: 7, unit: "days" },
        last_rebalanced_at: new Date().toISOString(),
      });
      await mocks.stateManager.appendGapHistoryEntry("goal-1", {
        iteration: 0,
        timestamp: new Date().toISOString(),
        gap_vector: [{ dimension_name: "dim1", normalized_weighted_gap: 0.4 }],
        confidence_vector: [{ dimension_name: "dim1", confidence: 0.9 }],
      });
      await mocks.stateManager.writeRaw(`strategies/goal-1/wait-meta/${waitStrategy.id}.json`, {
        schema_version: 1,
        wait_until: waitStrategy.wait_until,
        conditions: [{ type: "process_session_exited", session_id: processSessionId }],
        resume_plan: { action: "complete_wait" },
        process_refs: [{
          session_id: processSessionId,
          metadata_ref: `control-db://process-sessions/${processSessionId}`,
        }],
      });

      const portfolioManager = new PortfolioManager(
        mocks.strategyManager as unknown as RealStrategyManager,
        mocks.stateManager,
      );
      const depsWithPM = { ...deps, portfolioManager };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);
      const persistedWaitMeta = await mocks.stateManager.readRaw(`strategies/goal-1/wait-meta/${waitStrategy.id}.json`) as Record<string, unknown>;

      expect(result.waitExpired).toBe(true);
      expect(result.waitStrategyId).toBe(waitStrategy.id);
      expect(result.waitExpiryOutcome).toMatchObject({ status: "improved", strategy_id: waitStrategy.id });
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe("wait_observe_only");
      expect(mocks.strategyManager.updateState).toHaveBeenCalledWith(waitStrategy.id, "completed");
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
      expect(persistedWaitMeta["latest_observation"]).toMatchObject({
        status: "satisfied",
        resume_hint: "wait_conditions_satisfied",
      });
    });

    it("does not resume from a stale previous process session when the current session is still running", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal({
        dimensions: [makeDimension({ name: "dim1" })],
      }));

      const waitStrategy = makeWaitStrategyForCoreLoop();
      const currentSessionId = "sess-current";
      const staleSessionId = "sess-previous";
      await mocks.stateManager.writeRaw(`runtime/process-sessions/${currentSessionId}.json`, {
        session_id: currentSessionId,
        command: "node",
        args: [],
        cwd: tmpDir,
        running: true,
        exitCode: null,
        signal: null,
        startedAt: "2026-05-10T00:00:00.000Z",
        bufferedChars: 0,
      });
      await mocks.stateManager.writeRaw(`runtime/process-sessions/${staleSessionId}.json`, {
        session_id: staleSessionId,
        command: "node",
        args: [],
        cwd: tmpDir,
        running: false,
        exitCode: 0,
        signal: null,
        startedAt: "2026-05-10T00:00:00.000Z",
        exitedAt: "2026-05-10T00:01:00.000Z",
        pid: 4141,
        bufferedChars: 0,
      });

      mocks.strategyManager.getPortfolio.mockReturnValue({
        goal_id: "goal-1",
        strategies: [waitStrategy],
        rebalance_interval: { value: 7, unit: "days" },
        last_rebalanced_at: new Date().toISOString(),
      });
      mocks.stallDetector.isSuppressed.mockReturnValue(true);
      await mocks.stateManager.appendGapHistoryEntry("goal-1", {
        iteration: 0,
        timestamp: new Date().toISOString(),
        gap_vector: [{ dimension_name: "dim1", normalized_weighted_gap: 0.4 }],
        confidence_vector: [{ dimension_name: "dim1", confidence: 0.9 }],
      });
      await mocks.stateManager.writeRaw(`strategies/goal-1/wait-meta/${waitStrategy.id}.json`, {
        schema_version: 1,
        wait_until: waitStrategy.wait_until,
        conditions: [{ type: "process_session_exited", session_id: currentSessionId }],
        resume_plan: { action: "complete_wait" },
        process_refs: [
          {
            session_id: staleSessionId,
            metadata_ref: `control-db://process-sessions/${staleSessionId}`,
          },
          {
            session_id: currentSessionId,
            metadata_ref: `control-db://process-sessions/${currentSessionId}`,
          },
        ],
      });

      const portfolioManager = new PortfolioManager(
        mocks.strategyManager as unknown as RealStrategyManager,
        mocks.stateManager,
      );
      const depsWithPM = { ...deps, portfolioManager };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);
      const persistedWaitMeta = await mocks.stateManager.readRaw(`strategies/goal-1/wait-meta/${waitStrategy.id}.json`) as Record<string, unknown>;

      expect(result.waitSuppressed).toBe(true);
      expect(result.waitStrategyId).toBe(waitStrategy.id);
      expect(result.waitExpiryOutcome).toMatchObject({
        status: "not_due",
        strategy_id: waitStrategy.id,
      });
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe("wait_not_due");
      expect(mocks.strategyManager.updateState).not.toHaveBeenCalled();
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
      expect(persistedWaitMeta["latest_observation"]).toMatchObject({
        status: "stale",
        resume_hint: `process session still running: ${currentSessionId}`,
      });
    });

    it("handles WaitStrategy expiry check — calls rebalance when handleWaitStrategyExpiry returns a trigger", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const waitStrategy = {
        id: "wait-strategy-1",
        state: "active",
        goal_id: "goal-1",
      };
      // Return a portfolio with a wait strategy
      mocks.strategyManager.getPortfolio.mockReturnValue({
        goal_id: "goal-1",
        strategies: [waitStrategy],
        rebalance_interval: { value: 7, unit: "days" },
        last_rebalanced_at: new Date().toISOString(),
      });

      const waitTrigger = {
        type: "stall_detected" as const,
        strategy_id: waitStrategy.id,
        details: "wait period elapsed",
      };
      const portfolioManager = createMockPortfolioManager();
      portfolioManager.isWaitStrategy.mockReturnValue(true);
      portfolioManager.handleWaitStrategyExpiry.mockReturnValue({
        status: "worsened",
        goal_id: "goal-1",
        strategy_id: waitStrategy.id,
        rebalance_trigger: waitTrigger,
      });

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.handleWaitStrategyExpiry).toHaveBeenCalledWith("goal-1", waitStrategy.id, undefined);
      expect(portfolioManager.rebalance).toHaveBeenCalledWith("goal-1", waitTrigger);
    });

    it("continues to task generation when wait rebalance requests a new strategy generation", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const waitStrategy = {
        id: "wait-strategy-1",
        state: "active",
        goal_id: "goal-1",
      };
      mocks.strategyManager.getPortfolio.mockReturnValue({
        goal_id: "goal-1",
        strategies: [waitStrategy],
        rebalance_interval: { value: 7, unit: "days" },
        last_rebalanced_at: new Date().toISOString(),
      });

      const waitTrigger = {
        type: "stall_detected" as const,
        strategy_id: waitStrategy.id,
        details: "observation capability missing",
      };
      const portfolioManager = createMockPortfolioManager();
      portfolioManager.isWaitStrategy.mockReturnValue(true);
      portfolioManager.handleWaitStrategyExpiry.mockReturnValue({
        status: "unknown",
        goal_id: "goal-1",
        strategy_id: waitStrategy.id,
        rebalance_trigger: waitTrigger,
      });
      portfolioManager.rebalance.mockReturnValue({
        triggered_by: "stall_detected",
        adjustments: [],
        terminated_strategies: [waitStrategy.id],
        new_generation_needed: true,
        timestamp: new Date().toISOString(),
      });

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.waitExpired).toBe(true);
      expect(result.waitObserveOnly).toBe(false);
      expect(mocks.strategyManager.onStallDetected).toHaveBeenCalledWith("goal-1", 3, expect.any(String), undefined);
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
    });

    it("marks waitExpired when WaitStrategy expiry does not require rebalance", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const waitStrategy = {
        id: "wait-strategy-1",
        state: "active",
        goal_id: "goal-1",
      };
      mocks.strategyManager.getPortfolio.mockReturnValue({
        goal_id: "goal-1",
        strategies: [waitStrategy],
        rebalance_interval: { value: 7, unit: "days" },
        last_rebalanced_at: new Date().toISOString(),
      });

      const portfolioManager = createMockPortfolioManager();
      portfolioManager.isWaitStrategy.mockReturnValue(true);
      portfolioManager.handleWaitStrategyExpiry.mockReturnValue({
        status: "improved",
        goal_id: "goal-1",
        strategy_id: waitStrategy.id,
      });

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.waitExpired).toBe(true);
      expect(result.waitStrategyId).toBe(waitStrategy.id);
      expect(result.waitExpiryOutcome).toMatchObject({ status: "improved" });
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe("wait_observe_only");
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
      expect(portfolioManager.rebalance).not.toHaveBeenCalled();
    });

    it("keeps a not-due WaitStrategy observe-only and does not generate a task", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal({
        dimensions: [makeDimension({ name: "dim1" })],
      }));

      const waitUntil = new Date(Date.now() + 100_000).toISOString();
      const waitStrategy = {
        id: "wait-strategy-1",
        state: "active",
        goal_id: "goal-1",
        primary_dimension: "dim1",
        wait_until: waitUntil,
      };
      mocks.strategyManager.getPortfolio.mockReturnValue({
        goal_id: "goal-1",
        strategies: [waitStrategy],
        rebalance_interval: { value: 7, unit: "days" },
        last_rebalanced_at: new Date().toISOString(),
      });
      mocks.stallDetector.isSuppressed.mockReturnValue(true);

      const portfolioManager = createMockPortfolioManager();
      portfolioManager.isWaitStrategy.mockReturnValue(true);
      portfolioManager.handleWaitStrategyExpiry.mockReturnValue({
        status: "not_due",
        goal_id: "goal-1",
        strategy_id: waitStrategy.id,
      });

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.waitSuppressed).toBe(true);
      expect(result.waitStrategyId).toBe(waitStrategy.id);
      expect(result.waitExpiryOutcome).toMatchObject({ status: "not_due" });
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe("wait_not_due");
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
    });

    it("observes a due WaitStrategy even when an earlier active wait is not due", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const notDueWait = {
        id: "wait-not-due",
        state: "active",
        goal_id: "goal-1",
      };
      const dueWait = {
        id: "wait-due",
        state: "active",
        goal_id: "goal-1",
      };
      mocks.strategyManager.getPortfolio.mockReturnValue({
        goal_id: "goal-1",
        strategies: [notDueWait, dueWait],
        rebalance_interval: { value: 7, unit: "days" },
        last_rebalanced_at: new Date().toISOString(),
      });

      const waitTrigger = {
        type: "stall_detected" as const,
        strategy_id: dueWait.id,
        details: "due wait worsened",
      };
      const portfolioManager = createMockPortfolioManager();
      portfolioManager.isWaitStrategy.mockReturnValue(true);
      portfolioManager.handleWaitStrategyExpiry
        .mockReturnValueOnce({
          status: "not_due",
          goal_id: "goal-1",
          strategy_id: notDueWait.id,
        })
        .mockReturnValueOnce({
          status: "worsened",
          goal_id: "goal-1",
          strategy_id: dueWait.id,
          rebalance_trigger: waitTrigger,
        });

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.handleWaitStrategyExpiry).toHaveBeenCalledTimes(2);
      expect(result.waitExpired).toBe(true);
      expect(result.waitStrategyId).toBe(dueWait.id);
      expect(result.waitExpiryOutcome).toMatchObject({ status: "worsened" });
      expect(portfolioManager.rebalance).toHaveBeenCalledWith("goal-1", waitTrigger);
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
    });

    it("persists approval_required wait outcomes as pending runtime approvals", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const overdueWaitUntil = new Date(Date.now() - 100_000).toISOString();
      const waitStrategy = {
        id: "wait-approval",
        state: "active",
        goal_id: "goal-1",
        target_dimensions: ["dim1"],
        primary_dimension: "dim1",
        hypothesis: "Wait for external approval",
        expected_effect: [],
        resource_estimate: { sessions: 0, duration: { value: 0, unit: "hours" }, llm_calls: null },
        allocation: 1,
        created_at: new Date(Date.now() - 200_000).toISOString(),
        started_at: new Date(Date.now() - 200_000).toISOString(),
        completed_at: null,
        gap_snapshot_at_start: 0.5,
        tasks_generated: [],
        effectiveness_score: null,
        consecutive_stall_count: 0,
        wait_reason: "Approval required",
        wait_until: overdueWaitUntil,
        measurement_plan: "Resume after approval",
        fallback_strategy_id: null,
      };
      mocks.strategyManager.getPortfolio.mockReturnValue({
        goal_id: "goal-1",
        strategies: [waitStrategy],
        rebalance_interval: { value: 7, unit: "days" },
        last_rebalanced_at: new Date().toISOString(),
      });
      await mocks.stateManager.writeRaw("strategies/goal-1/portfolio.json", {
        goal_id: "goal-1",
        strategies: [waitStrategy],
        rebalance_interval: { value: 7, unit: "days" },
        last_rebalanced_at: new Date().toISOString(),
      });
      await mocks.stateManager.writeRaw(`strategies/goal-1/wait-meta/${waitStrategy.id}.json`, {
        schema_version: 1,
        wait_until: overdueWaitUntil,
        conditions: [{ type: "time_until", until: overdueWaitUntil }],
        resume_plan: { action: "complete_wait" },
      });

      const portfolioManager = createMockPortfolioManager();
      portfolioManager.isWaitStrategy.mockReturnValue(true);
      portfolioManager.handleWaitStrategyExpiry.mockReturnValue({
        status: "approval_required",
        goal_id: "goal-1",
        strategy_id: waitStrategy.id,
        details: "Approve external submission",
      });

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      const approvalStore = new ApprovalStore(path.join(tmpDir, "runtime"));
      const pending = await approvalStore.listPending();
      const metadata = await mocks.stateManager.readRaw(`strategies/goal-1/wait-meta/${waitStrategy.id}.json`) as Record<string, unknown>;
      const resolution = await new WaitDeadlineResolver(mocks.stateManager).resolve(["goal-1"]);

      expect(result.waitExpired).toBe(true);
      expect(result.waitApprovalId).toBe(`wait-goal-1-${waitStrategy.id}`);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        approval_id: result.waitApprovalId,
        goal_id: "goal-1",
        state: "pending",
      });
      expect(pending[0]!.payload).toMatchObject({
        task: {
          id: `wait:${waitStrategy.id}`,
          action: "wait_strategy_resume_approval",
          description: "Approve external submission",
        },
        wait_strategy_id: waitStrategy.id,
      });
      expect(Date.parse(metadata["next_observe_at"] as string)).toBeGreaterThan(Date.now());
      expect(metadata["approval_pending"]).toMatchObject({
        approval_id: result.waitApprovalId,
      });
      expect(metadata["latest_observation"]).toMatchObject({
        status: "pending",
        evidence: {
          approval_pending: true,
          approval_id: result.waitApprovalId,
        },
        resume_hint: "waiting_for_approval",
      });
      expect(getDueWaitGoalIds(resolution)).toEqual([]);
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
    });

    it("routes approval_required wait outcomes through the live approval broker when available", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const waitStrategy = {
        id: "wait-live-approval",
        state: "active",
        goal_id: "goal-1",
      };
      mocks.strategyManager.getPortfolio.mockReturnValue({
        goal_id: "goal-1",
        strategies: [waitStrategy],
        rebalance_interval: { value: 7, unit: "days" },
        last_rebalanced_at: new Date().toISOString(),
      });

      const portfolioManager = createMockPortfolioManager();
      portfolioManager.isWaitStrategy.mockReturnValue(true);
      portfolioManager.handleWaitStrategyExpiry.mockReturnValue({
        status: "approval_required",
        goal_id: "goal-1",
        strategy_id: waitStrategy.id,
        details: "Approve external submission",
      });
      const waitApprovalBroker = {
        requestApproval: vi.fn().mockResolvedValue(false),
      };

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any, waitApprovalBroker };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.waitApprovalId).toBe(`wait-goal-1-${waitStrategy.id}`);
      expect(waitApprovalBroker.requestApproval).toHaveBeenCalledWith(
        "goal-1",
        {
          id: `wait:${waitStrategy.id}`,
          description: "Approve external submission",
          action: "wait_strategy_resume_approval",
        },
        24 * 60 * 60 * 1000,
        result.waitApprovalId
      );
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
    });

    it("handles active WaitStrategy before stall checks", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal({
        dimensions: [makeDimension({ name: "dim1" })],
      }));

      const waitUntil = new Date(Date.now() + 100_000).toISOString();
      const waitStrategy = {
        id: "wait-strategy-1",
        state: "active",
        goal_id: "goal-1",
        primary_dimension: "dim1",
        wait_until: waitUntil,
      };
      mocks.strategyManager.getPortfolio.mockReturnValue({
        goal_id: "goal-1",
        strategies: [waitStrategy],
        rebalance_interval: { value: 7, unit: "days" },
        last_rebalanced_at: new Date().toISOString(),
      });
      mocks.stallDetector.isSuppressed.mockReturnValue(true);

      const portfolioManager = createMockPortfolioManager();
      portfolioManager.isWaitStrategy.mockReturnValue(true);
      portfolioManager.handleWaitStrategyExpiry.mockReturnValue({
        status: "not_due",
        goal_id: "goal-1",
        strategy_id: waitStrategy.id,
      });

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(portfolioManager.handleWaitStrategyExpiry).toHaveBeenCalledWith("goal-1", waitStrategy.id, undefined);
      expect(mocks.stallDetector.isSuppressed).not.toHaveBeenCalled();
      expect(mocks.stallDetector.checkDimensionStall).not.toHaveBeenCalled();
      expect(result.waitSuppressed).toBe(true);
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
    });

    it("portfolio rebalance errors are non-fatal", async () => {
      const { deps, mocks } = createMockDeps(tmpDir);
      await mocks.stateManager.saveGoal(makeGoal());

      const portfolioManager = createMockPortfolioManager();
      portfolioManager.shouldRebalance.mockImplementation(() => {
        throw new Error("rebalance check failed");
      });

      const depsWithPM = { ...deps, portfolioManager: portfolioManager as any };
      const loop = new CoreLoop(depsWithPM, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      // Should still reach task cycle
      expect(mocks.taskLifecycle.runTaskCycle).toHaveBeenCalledOnce();
      expect(result.error).toBeNull();
    });
  });
});
