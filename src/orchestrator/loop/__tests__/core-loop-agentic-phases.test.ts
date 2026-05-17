import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../../../base/state/state-manager.js";
import { CoreLoop, type CoreLoopDeps } from "../durable-loop.js";
import type { ObservationEngine } from "../../../platform/observation/observation-engine.js";
import type { TaskLifecycle, TaskCycleResult } from "../../execution/task/task-lifecycle.js";
import type { SatisficingJudge } from "../../../platform/drive/satisficing-judge.js";
import type { StallDetector } from "../../../platform/drive/stall-detector.js";
import type { StrategyManager } from "../../strategy/strategy-manager.js";
import type { DriveSystem } from "../../../platform/drive/drive-system.js";
import type { AdapterRegistry, IAdapter } from "../../execution/adapter-layer.js";
import type { GapCalculatorModule, DriveScorerModule, ReportingEngine } from "../durable-loop.js";
import type { GapVector } from "../../../base/types/gap.js";
import type { CompletionJudgment } from "../../../base/types/satisficing.js";
import type { DriveScore } from "../../../base/types/drive.js";
import { makeDimension, makeGoal } from "../../../../tests/helpers/fixtures.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { StaticCorePhasePolicyRegistry } from "../durable-loop/phase-policy.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { createBuiltinTools } from "../../../tools/builtin/index.js";
import { ToolRegistryAgentLoopToolRouter } from "../../execution/agent-loop/agent-loop-tool-router.js";
import {
  ProcessSessionListTool,
  ProcessSessionReadTool,
} from "../../../tools/system/ProcessSessionTool/ProcessSessionTool.js";
import { ProcessStatusTool } from "../../../tools/system/ProcessStatusTool/ProcessStatusTool.js";
import { InteractiveAutomationRegistry } from "../../../runtime/interactive-automation/index.js";
import {
  RuntimeEvidenceEntrySchema,
  type RuntimeEvidenceEntryInput,
} from "../../../runtime/store/evidence-ledger.js";
import { ExperienceLearningStateStore } from "../../../runtime/store/experience-learning-state-store.js";

function makeGapVector(goalId = "goal-1"): GapVector {
  return {
    goal_id: goalId,
    gaps: [{
      dimension_name: "dim1",
      raw_gap: 4,
      normalized_gap: 0.4,
      normalized_weighted_gap: 0.4,
      confidence: 0.8,
      uncertainty_weight: 1,
    }],
    timestamp: new Date().toISOString(),
  };
}

function makeDriveScores(): DriveScore[] {
  return [{
    dimension_name: "dim1",
    dissatisfaction: 0.4,
    deadline: 0,
    opportunity: 0,
    final_score: 0.4,
    dominant_drive: "dissatisfaction",
  }];
}

function makeCompletionJudgment(overrides: Partial<CompletionJudgment> = {}): CompletionJudgment {
  return {
    is_complete: false,
    blocking_dimensions: ["dim1"],
    low_confidence_dimensions: [],
    needs_verification_task: false,
    checked_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeTaskCycleResult(overrides: {
  taskId?: string;
  action?: TaskCycleResult["action"];
  verdict?: TaskCycleResult["verificationResult"]["verdict"];
} = {}): TaskCycleResult {
  const taskId = overrides.taskId ?? "task-1";
  const action = overrides.action ?? "completed";
  const verdict = overrides.verdict ?? "pass";
  return {
    task: {
      id: taskId,
      goal_id: "goal-1",
      strategy_id: null,
      target_dimensions: ["dim1"],
      primary_dimension: "dim1",
      work_description: "Implement the change",
      rationale: "Need progress",
      approach: "Edit and verify",
      success_criteria: [{ description: "Tests pass", verification_method: "run tests", is_blocking: true }],
      scope_boundary: { in_scope: ["src"], out_of_scope: [], blast_radius: "low" },
      constraints: [],
      plateau_until: null,
      estimated_duration: null,
      consecutive_failure_count: 0,
      reversibility: "reversible",
      task_category: "normal",
      status: action === "completed" ? "completed" : "error",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      timeout_at: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
    },
    verificationResult: {
      task_id: taskId,
      verdict,
      confidence: 0.9,
      evidence: [],
      dimension_updates: [],
      timestamp: new Date().toISOString(),
    },
    action,
  };
}

function makeAdapter(): IAdapter {
  return {
    adapterType: "openai_codex_cli",
    execute: vi.fn(),
  };
}

function createDeps(tmpDir: string, options?: { stall?: boolean; publicResearch?: boolean; dreamCheckpoint?: boolean }) {
  const stateManager = new StateManager(tmpDir);
  const adapter = makeAdapter();
  const observationEngine = {
    getDataSources: vi.fn().mockReturnValue([]),
    observe: vi.fn().mockResolvedValue(undefined),
  };
  const gapCalculator = {
    calculateGapVector: vi.fn().mockReturnValue(makeGapVector()),
    aggregateGaps: vi.fn().mockReturnValue(0.4),
  };
  const driveScorer = {
    scoreAllDimensions: vi.fn().mockReturnValue(makeDriveScores()),
    rankDimensions: vi.fn().mockImplementation((scores: DriveScore[]) => scores),
  };
  const taskLifecycle = {
    runTaskCycle: vi.fn().mockResolvedValue(makeTaskCycleResult()),
    setOnTaskComplete: vi.fn(),
  };
  const satisficingJudge = {
    isGoalComplete: vi.fn().mockReturnValue(makeCompletionJudgment()),
  };
  const stallDetector = {
    checkDimensionStall: vi.fn().mockReturnValue(options?.stall
      ? {
          stall_type: "dimension_stall",
          goal_id: "goal-1",
          dimension_name: "dim1",
          task_id: null,
          detected_at: new Date().toISOString(),
          escalation_level: 0,
          suggested_cause: "approach_failure",
          decay_factor: 0.5,
        }
      : null),
    checkGlobalStall: vi.fn().mockReturnValue(null),
    getEscalationLevel: vi.fn().mockResolvedValue(0),
    incrementEscalation: vi.fn().mockResolvedValue(1),
    resetEscalation: vi.fn().mockResolvedValue(undefined),
    isSuppressed: vi.fn().mockReturnValue(false),
  };
  const strategyManager = {
    getActiveStrategy: vi.fn().mockResolvedValue(null),
    getPortfolio: vi.fn().mockResolvedValue(null),
  };
  const reportingEngine = {
    generateExecutionSummary: vi.fn().mockReturnValue({ ok: true }),
    saveReport: vi.fn(),
  };
  const driveSystem = {
    shouldActivate: vi.fn().mockReturnValue(true),
  };
  const adapterRegistry = {
    getAdapter: vi.fn().mockReturnValue(adapter),
  };
  const corePhaseRunner = {
    run: vi.fn().mockImplementation(async (spec: { phase: string }) => {
      const outputs: Record<string, unknown> = {
        observe_evidence: { summary: "observe-summary", evidence: ["git clean"], missing_info: [], confidence: 0.8 },
        knowledge_refresh: {
          summary: "knowledge-summary",
          required_knowledge: ["recent architectural note"],
          acquisition_candidates: ["soil lookup"],
          confidence: 0.85,
          worthwhile: true,
        },
        replanning_options: {
          summary: "replan-summary",
          recommended_action: "continue",
          candidates: [{
            title: "Task A",
            rationale: "fast",
            expected_evidence_gain: "medium",
            blast_radius: "low",
            target_dimensions: ["dim1"],
            dependencies: [],
          }],
          confidence: 0.8,
        },
        dream_review_checkpoint: {
          summary: "dream-summary",
          trigger: "plateau",
          current_goal: "Improve benchmark score",
          active_dimensions: ["dim1"],
          best_evidence_so_far: "Focused test passed.",
          recent_strategy_families: ["continue"],
          exhausted: ["repeating the same implementation"],
          promising: ["bounded variant"],
          relevant_memories: [{
            source_type: "soil",
            ref: "soil://goal-1/checkpoint",
            summary: "A prior run succeeded after pivoting to a bounded variant.",
            authority: "advisory_only",
          }],
          next_strategy_candidates: [{
            title: "Bounded variant",
            rationale: "Changes one factor and preserves the current proof lane.",
            target_dimensions: ["dim1"],
            expected_evidence_gain: "Shows whether the plateau is strategy-driven.",
          }],
          run_control_recommendations: [{
            action: "widen_exploration",
            target_strategy_family: "bounded_variant",
            rationale: "Repeated same-lineage attempts have stopped moving the metric.",
            evidence: [{
              kind: "lineage",
              ref: "lineage:continue",
              summary: "Recent task history repeats the same implementation family.",
            }],
            risk: "low",
            confidence: 0.82,
          }],
          guidance: "Use the bounded variant before generating the next task.",
          uncertainty: ["Need one more metric sample."],
          context_authority: "advisory_only",
          confidence: 0.84,
        },
        public_research: {
          summary: "research-summary",
          trigger: "plateau",
          query: "Find plateau strategy evidence",
          sources: [{
            url: "https://example.com/research/plateau",
            title: "Plateau strategy",
            source_type: "official_docs",
            provenance: "paraphrased",
          }],
          findings: [{
            finding: "A bounded comparison can reveal whether the current approach is saturated.",
            source_urls: ["https://example.com/research/plateau"],
            applicability: "Applies when local changes stop moving the metric.",
            risks_constraints: ["Do not execute external submissions without approval."],
            proposed_experiment: "Run one local ablation and compare the tracked metric.",
            expected_metric_impact: "Improve accuracy if the plateau is strategy-driven.",
            fact_vs_adaptation: {
              facts: ["The source recommends bounded comparison."],
              adaptation: "Use a local ablation before external publication.",
            },
          }],
          candidate_playbook: {
            title: "Bounded ablation",
            steps: ["Run local ablation", "Compare metric trend"],
            source_urls: ["https://example.com/research/plateau"],
          },
          untrusted_content_policy: "webpage_instructions_are_untrusted",
          external_actions: [{
            label: "Submit benchmark result",
            reason: "External benchmark confirmation requires approval.",
            approval_required: true,
          }],
          confidence: 0.82,
        },
        verification_evidence: {
          summary: "verify-summary",
          supported_claims: ["tests pass"],
          unsupported_claims: [],
          blockers: [],
          confidence: 0.9,
        },
        stall_investigation: {
          summary: "stall-summary",
          suspected_causes: ["approach_failure"],
          recommended_next_evidence: ["inspect files"],
          relevant_actions: ["refine"],
          confidence: 0.7,
        },
      };

      return {
        success: true,
        output: outputs[spec.phase],
        finalText: "",
        stopReason: "completed",
        elapsedMs: 1,
        modelTurns: 1,
        toolCalls: 0,
        compactions: 0,
        changedFiles: [],
        commandResults: [],
        traceId: `trace-${spec.phase}`,
        sessionId: `session-${spec.phase}`,
        turnId: `turn-${spec.phase}`,
      };
    }),
  };

  const deps: CoreLoopDeps = {
    stateManager,
    observationEngine: observationEngine as never as ObservationEngine,
    gapCalculator: gapCalculator as never as GapCalculatorModule,
    driveScorer: driveScorer as never as DriveScorerModule,
    taskLifecycle: taskLifecycle as never as TaskLifecycle,
    satisficingJudge: satisficingJudge as never as SatisficingJudge,
    stallDetector: stallDetector as never as StallDetector,
    strategyManager: strategyManager as never as StrategyManager,
    reportingEngine: reportingEngine as never as ReportingEngine,
    driveSystem: driveSystem as never as DriveSystem,
    adapterRegistry: adapterRegistry as never as AdapterRegistry,
    contextProvider: vi.fn().mockResolvedValue("workspace-base"),
    corePhaseRunner: corePhaseRunner as never,
    corePhasePolicyRegistry: new StaticCorePhasePolicyRegistry({
      observe_evidence: {
        enabled: true,
        maxInvocationsPerIteration: 1,
        budget: {},
        allowedTools: [],
        requiredTools: [],
        failPolicy: "fallback_deterministic",
      },
      stall_investigation: {
        enabled: true,
        maxInvocationsPerIteration: 1,
        budget: {},
        allowedTools: [],
        requiredTools: [],
        failPolicy: "return_low_confidence",
      },
      replanning_options: {
        enabled: true,
        maxInvocationsPerIteration: 1,
        budget: {},
        allowedTools: [],
        requiredTools: [],
        failPolicy: "fallback_deterministic",
      },
      public_research: {
        enabled: options?.publicResearch === true,
        maxInvocationsPerIteration: 1,
        budget: {},
        allowedTools: ["research_web", "research_answer_with_sources"],
        requiredTools: ["research_answer_with_sources"],
        failPolicy: "return_low_confidence",
      },
      dream_review_checkpoint: {
        enabled: options?.dreamCheckpoint === true,
        maxInvocationsPerIteration: 1,
        budget: {
          maxModelTurns: 3,
          maxToolCalls: 5,
          maxWallClockMs: 45_000,
          maxRepeatedToolCalls: 1,
        },
        allowedTools: ["soil_query", "knowledge_query", "memory_recall"],
        requiredTools: ["soil_query"],
        failPolicy: "return_low_confidence",
      },
      verification_evidence: {
        enabled: true,
        maxInvocationsPerIteration: 1,
        budget: {},
        allowedTools: [],
        requiredTools: [],
        failPolicy: "fallback_deterministic",
      },
      knowledge_refresh: {
        enabled: true,
        maxInvocationsPerIteration: 1,
        budget: {},
        allowedTools: [],
        requiredTools: [],
        failPolicy: "return_low_confidence",
      },
      wait_observation: {
        enabled: true,
        maxInvocationsPerIteration: 1,
        budget: {},
        allowedTools: ["process_session_read", "process_session_list", "process-status"],
        requiredTools: ["process_session_read", "process_session_list"],
        failPolicy: "return_low_confidence",
      },
    }),
  };

  return {
    deps,
    mocks: {
      stateManager,
      taskLifecycle,
      corePhaseRunner,
      observationEngine,
    },
  };
}

describe("CoreLoop agentic phase hooks", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("feeds observe and replanning summaries into task cycle context and records phase results", async () => {
    const { deps, mocks } = createDeps(tmpDir);
    const evidenceLedger = { append: vi.fn().mockResolvedValue([]) };
    deps.evidenceLedger = evidenceLedger;
    await mocks.stateManager.saveGoal(makeGoal());

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    const result = await loop.runOneIteration("goal-1", 0);

    expect(result.error).toBeNull();
    expect(result.corePhaseResults?.some((phase) => phase.phase === "observe_evidence")).toBe(true);
    expect(result.corePhaseResults?.some((phase) => phase.phase === "knowledge_refresh")).toBe(true);
    expect(result.corePhaseResults?.some((phase) => phase.phase === "replanning_options")).toBe(true);
    expect(result.corePhaseResults?.some((phase) => phase.phase === "verification_evidence")).toBe(true);

    const taskCycleArgs = (mocks.taskLifecycle.runTaskCycle as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(taskCycleArgs[4]).toContain("knowledge-summary");
    expect(taskCycleArgs[4]).toContain("replan-summary");
    expect(taskCycleArgs[6]).toContain("observe-summary");
    expect(taskCycleArgs[7]).toEqual(expect.objectContaining({ targetDimensionOverride: "dim1" }));
    expect(taskCycleArgs[7]?.knowledgeContextPrefix).toContain("Replanning directive:");
    expect(evidenceLedger.append).toHaveBeenCalledWith(expect.objectContaining({
      kind: "task_generation",
      scope: expect.objectContaining({ goal_id: "goal-1", task_id: "task-1", loop_index: 0 }),
    }));
    expect(evidenceLedger.append).toHaveBeenCalledWith(expect.objectContaining({
      kind: "execution",
      outcome: "improved",
      scope: expect.objectContaining({ goal_id: "goal-1", task_id: "task-1", loop_index: 0 }),
    }));
    expect(evidenceLedger.append).toHaveBeenCalledWith(expect.objectContaining({
      kind: "verification",
      outcome: "improved",
      scope: expect.objectContaining({ goal_id: "goal-1", task_id: "task-1", loop_index: 0 }),
    }));
  });

  it("passes learning priors to task generation as typed projections instead of prompt context", async () => {
    const { deps, mocks } = createDeps(tmpDir);
    deps.evidenceLedger = { append: vi.fn().mockResolvedValue([]) };
    const resolvePriorForPhase = vi.fn().mockImplementation(async (input: { consumerPhase: string }) => {
      if (input.consumerPhase !== "task_generation") return null;
      return {
        prior: { id: "prior-1" },
        record: { id: "consumption-1", stage: "reserved" },
        runtimeEventId: "runtime-event:prior-reserved",
        projection: {
          phase: "task_generation",
          projectionKind: "task_generation_bias",
          consumptionRecordId: "consumption-1",
          preferredTargetDimension: "dim-prior",
          taskBiasRefs: ["evidence-1"],
          avoidTaskPatternRefs: [],
          requiredExperimentPlanIds: ["experiment-plan-1"],
          generalizationBodies: [],
          suppressedSuggestionIds: [],
        },
      };
    });
    const markPriorConsumptionApplied = vi.fn().mockResolvedValue(null);
    deps.experienceLearningStore = {
      resolvePriorForPhase,
      markPriorConsumptionApplied,
    } as never;
    await mocks.stateManager.saveGoal(makeGoal({ dimensions: [
      makeDimension({ name: "dim1", current_value: 0 }),
      makeDimension({ name: "dim-prior", label: "Prior Dimension", current_value: 0 }),
    ] }));

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    await loop.runOneIteration("goal-1", 0);

    const taskCycleArgs = (mocks.taskLifecycle.runTaskCycle as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(taskCycleArgs[7]).toEqual(expect.objectContaining({
      targetDimensionOverride: "dim-prior",
      learningPriorConsumptionRef: "consumption-1",
      learningProjection: expect.objectContaining({
        phase: "task_generation",
        preferredTargetDimension: "dim-prior",
        requiredExperimentPlanIds: ["experiment-plan-1"],
      }),
    }));
    expect(taskCycleArgs[7]?.knowledgeContextPrefix).not.toContain("prior-1");
    expect(markPriorConsumptionApplied).toHaveBeenCalledWith({
      consumptionId: "consumption-1",
      generatedDecisionRefs: ["task:task-1"],
    });
  });

  it("runs an N+1 trial-reuse learning prior through the public DurableLoop iteration path", async () => {
    const { deps, mocks } = createDeps(tmpDir);
    const experienceStore = new ExperienceLearningStateStore(path.join(tmpDir, "runtime"), { controlBaseDir: tmpDir });
    deps.experienceLearningStore = experienceStore;
    const ownerReviewEntries: unknown[] = [];
    deps.cognitionWritebackQueue = {
      enqueue: vi.fn(async (entry) => {
        ownerReviewEntries.push(entry);
        return entry;
      }),
      update: vi.fn(async (entry) => entry),
      list: vi.fn(async () => ownerReviewEntries as never),
    };
    let evidenceSeq = 0;
    deps.evidenceLedger = {
      append: vi.fn().mockImplementation(async (entry: RuntimeEvidenceEntryInput) => {
        evidenceSeq += 1;
        return [RuntimeEvidenceEntrySchema.parse({
          schema_version: "runtime-evidence-entry-v1",
          id: `experience-evidence-${evidenceSeq}`,
          occurred_at: "2026-05-17T00:00:00.000Z",
          kind: entry.kind,
          scope: entry.scope,
          task: entry.task,
          verification: entry.verification,
          metrics: entry.metrics ?? [],
          evaluators: entry.evaluators ?? [],
          research: entry.research ?? [],
          dream_checkpoints: entry.dream_checkpoints ?? [],
          divergent_exploration: entry.divergent_exploration ?? [],
          artifacts: entry.artifacts ?? [],
          outcome: entry.outcome,
          raw_refs: [{ kind: "runtime_event", id: `runtime-event:experience-evidence-${evidenceSeq}` }],
          summary: entry.summary ?? `evidence ${evidenceSeq}`,
        })];
      }),
    };
    let taskCall = 0;
    (mocks.taskLifecycle.runTaskCycle as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      taskCall += 1;
      return makeTaskCycleResult({
        taskId: `task-${taskCall}`,
        action: taskCall < 3 ? "discard" : "completed",
        verdict: taskCall < 3 ? "fail" : "pass",
      });
    });
    await mocks.stateManager.saveGoal(makeGoal({ dimensions: [
      makeDimension({ name: "dim1", current_value: 0 }),
      makeDimension({ name: "dim-other", label: "Other Dimension", current_value: 0 }),
    ] }));

    try {
      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });

      const first = await loop.runOneIteration("goal-1", 0);
      const second = await loop.runOneIteration("goal-1", 1);

      expect(first.experienceLearning?.status).toBe("processed");
      expect(second.experienceLearning?.status).toBe("processed");
      const trialReadyCandidates = await experienceStore.listGeneralizationCandidates("goal-1");
      expect(trialReadyCandidates).toEqual([
        expect.objectContaining({
          status: "trial_reuse_ready",
          invariantRefs: expect.arrayContaining([
            expect.stringContaining("experience-frame:"),
          ]),
          transferScopes: expect.arrayContaining([
            expect.objectContaining({ scopeRef: "goal:goal-1", status: "trial_allowed", maxTrials: 1 }),
            expect.objectContaining({ scopeRef: "adjacent:goal-1:dim1", status: "adjacent_candidate", maxTrials: 1 }),
          ]),
        }),
      ]);
      expect(trialReadyCandidates[0]!.invariantRefs.length).toBeLessThanOrEqual(2);
      const priors = await experienceStore.listPriorSnapshots("goal-1");
      expect(priors).toEqual([
        expect.objectContaining({
          eligibleFromIteration: 2,
          suggestions: [expect.objectContaining({
            kind: "trial_reuse_experiment",
            consumerPhase: "task_generation",
            experimentPlanIds: [expect.stringContaining("learning-experiment-plan:")],
          })],
        }),
      ]);
      expect((mocks.taskLifecycle.runTaskCycle as ReturnType<typeof vi.fn>).mock.calls[0]?.[7]?.learningProjection).toBeUndefined();

      await loop.runOneIteration("goal-1", 2);

      const thirdTaskCycleOptions = (mocks.taskLifecycle.runTaskCycle as ReturnType<typeof vi.fn>).mock.calls[2]?.[7];
      expect(thirdTaskCycleOptions).toEqual(expect.objectContaining({
        targetDimensionOverride: "dim1",
        learningPriorConsumptionRef: expect.stringContaining("learning-prior-consumption:"),
        learningProjection: expect.objectContaining({
          phase: "task_generation",
          preferredTargetDimension: "dim1",
          requiredExperimentPlanIds: [expect.stringContaining("learning-experiment-plan:")],
          taskBiasRefs: [],
        }),
      }));
      expect(thirdTaskCycleOptions?.knowledgeContextPrefix ?? "").not.toContain("learning-prior");

      const consumptions = await experienceStore.listPriorConsumptionRecords(priors[0]!.id);
      expect(consumptions).toEqual([
        expect.objectContaining({
          stage: "applied",
          generatedDecisionRefs: ["task:task-3"],
        }),
      ]);
      const experimentRecords = await experienceStore.listExperimentRecords("goal-1");
      expect(experimentRecords).toEqual([
        expect.objectContaining({
          planId: priors[0]!.suggestions[0]!.experimentPlanIds[0],
          taskId: "task-3",
          outcome: "supported",
        }),
      ]);
      const promotedArtifacts = (await experienceStore.listArtifacts("goal-1"))
        .filter((artifact) => artifact.status === "promoted");
      expect(promotedArtifacts).toEqual([
        expect.objectContaining({
          status: "promoted",
          evidence: expect.objectContaining({
            experimentRecordIds: [experimentRecords[0]!.id],
          }),
          guardrails: expect.objectContaining({
            authorityClass: "planning_hint_only",
            cannotGrantAuthority: true,
            requiresFreshEvidenceBeforePromotion: false,
          }),
        }),
      ]);
      expect(deps.cognitionWritebackQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        review_required: true,
        owner_write_performed: false,
        runtime_authority: false,
        state: "queued",
      }));
      await expect(experienceStore.listProjectionProposals(promotedArtifacts[0]!.id)).resolves.toEqual([
        expect.objectContaining({
          sourceArtifactIds: [promotedArtifacts[0]!.id],
          ownerReviewQueueRef: `queue:experience-learning:${promotedArtifacts[0]!.id}`,
          status: "queued",
        }),
      ]);
      const postExperimentPriors = await experienceStore.listPriorSnapshots("goal-1");
      expect(postExperimentPriors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          eligibleFromIteration: 3,
          sourceArtifactIds: [promotedArtifacts[0]!.id],
          suggestions: expect.arrayContaining([
            expect.objectContaining({
              kind: "strategy_preference",
              consumerPhase: "task_generation",
            }),
            expect.objectContaining({
              kind: "phase_focus",
              consumerPhase: "next_iteration_directive",
            }),
          ]),
        }),
      ]));
      const promotedCandidates = (await experienceStore.listGeneralizationCandidates("goal-1"))
        .filter((candidate) => candidate.status === "promoted");
      expect(promotedCandidates).toEqual([
        expect.objectContaining({
          status: "promoted",
          transferScopes: expect.arrayContaining([
            expect.objectContaining({ scopeRef: "goal:goal-1", status: "exact", attempts: 1 }),
            expect.objectContaining({ scopeRef: "adjacent:goal-1:dim1", status: "adjacent_candidate", attempts: 0 }),
          ]),
        }),
      ]);
    } finally {
      await experienceStore.close();
    }
  });

  it("narrows transfer scope and records counterexamples after a failed N+1 trial reuse", async () => {
    const { deps, mocks } = createDeps(tmpDir);
    const experienceStore = new ExperienceLearningStateStore(path.join(tmpDir, "runtime"), { controlBaseDir: tmpDir });
    deps.experienceLearningStore = experienceStore;
    let evidenceSeq = 0;
    deps.evidenceLedger = {
      append: vi.fn().mockImplementation(async (entry: RuntimeEvidenceEntryInput) => {
        evidenceSeq += 1;
        return [RuntimeEvidenceEntrySchema.parse({
          schema_version: "runtime-evidence-entry-v1",
          id: `negative-transfer-evidence-${evidenceSeq}`,
          occurred_at: "2026-05-17T00:00:00.000Z",
          kind: entry.kind,
          scope: entry.scope,
          task: entry.task,
          verification: entry.verification,
          metrics: entry.metrics ?? [],
          evaluators: entry.evaluators ?? [],
          research: entry.research ?? [],
          dream_checkpoints: entry.dream_checkpoints ?? [],
          divergent_exploration: entry.divergent_exploration ?? [],
          artifacts: entry.artifacts ?? [],
          outcome: entry.outcome,
          raw_refs: [{ kind: "runtime_event", id: `runtime-event:negative-transfer-evidence-${evidenceSeq}` }],
          summary: entry.summary ?? `negative transfer evidence ${evidenceSeq}`,
        })];
      }),
    };
    let taskCall = 0;
    (mocks.taskLifecycle.runTaskCycle as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      taskCall += 1;
      return makeTaskCycleResult({
        taskId: `negative-task-${taskCall}`,
        action: "discard",
        verdict: "fail",
      });
    });
    await mocks.stateManager.saveGoal(makeGoal({ dimensions: [
      makeDimension({ name: "dim1", current_value: 0 }),
      makeDimension({ name: "dim-other", label: "Other Dimension", current_value: 0 }),
    ] }));

    try {
      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });

      await loop.runOneIteration("goal-1", 0);
      await loop.runOneIteration("goal-1", 1);
      const priors = await experienceStore.listPriorSnapshots("goal-1");
      expect(priors).toEqual([
        expect.objectContaining({
          suggestions: [expect.objectContaining({ kind: "trial_reuse_experiment" })],
        }),
      ]);

      await loop.runOneIteration("goal-1", 2);

      const experimentRecords = await experienceStore.listExperimentRecords("goal-1");
      expect(experimentRecords).toEqual([
        expect.objectContaining({
          taskId: "negative-task-3",
          outcome: "falsified",
          testedGeneralizationCandidateIds: [expect.stringContaining("generalization-candidate:")],
          narrowedGeneralizationCandidateIds: [expect.stringContaining("generalization-candidate:")],
          negativeTransferRefs: expect.arrayContaining([expect.stringMatching(/^negative-transfer-evidence-/)]),
        }),
      ]);
      const narrowedCandidates = (await experienceStore.listGeneralizationCandidates("goal-1"))
        .filter((candidate) => candidate.status === "narrowed");
      expect(narrowedCandidates).toEqual([
        expect.objectContaining({
          status: "narrowed",
          counterexampleRefs: expect.arrayContaining([
            experimentRecords[0]!.id,
            expect.stringMatching(/^negative-transfer-evidence-/),
          ]),
          transferScopes: expect.arrayContaining([
            expect.objectContaining({
              scopeRef: "goal:goal-1",
              status: "narrowed",
              attempts: 1,
              negativeTransferRefs: expect.arrayContaining([
                experimentRecords[0]!.id,
                expect.stringMatching(/^negative-transfer-evidence-/),
              ]),
            }),
            expect.objectContaining({
              scopeRef: "adjacent:goal-1:dim1",
              status: "narrowed",
              attempts: 1,
              negativeTransferRefs: expect.arrayContaining([
                experimentRecords[0]!.id,
                expect.stringMatching(/^negative-transfer-evidence-/),
              ]),
            }),
          ]),
        }),
      ]);
      const artifacts = await experienceStore.listArtifacts("goal-1");
      expect(artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          status: "narrowed",
          guardrails: expect.objectContaining({
            requiresFreshEvidenceBeforePromotion: true,
            contradictionRefs: expect.arrayContaining([expect.stringMatching(/^negative-transfer-evidence-/)]),
          }),
        }),
      ]));
      expect((await experienceStore.listPriorSnapshots("goal-1")).filter((prior) =>
        prior.sourceArtifactIds.some((artifactId) =>
          artifacts.some((artifact) => artifact.id === artifactId && artifact.status === "narrowed")
        )
      )).toEqual([]);
    } finally {
      await experienceStore.close();
    }
  });

  it("runs stall investigation when stall is detected", async () => {
    const { deps, mocks } = createDeps(tmpDir, { stall: true });
    await mocks.stateManager.saveGoal(makeGoal());

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    const result = await loop.runOneIteration("goal-1", 0);

    expect(result.corePhaseResults?.some((phase) => phase.phase === "stall_investigation")).toBe(true);
    expect(mocks.corePhaseRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "stall_investigation" }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("passes stable goal identifiers into stall investigation for tool lookups", async () => {
    const { deps, mocks } = createDeps(tmpDir, { stall: true });
    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockReturnValue({
      stall_type: "dimension_stall",
      goal_id: "goal-1",
      dimension_name: "dim1",
      task_id: "task-1",
      detected_at: new Date().toISOString(),
      escalation_level: 0,
      suggested_cause: "approach_failure",
      decay_factor: 0.5,
    });
    await mocks.stateManager.saveGoal(makeGoal({
      id: "goal-1",
      title: "Kaggle S6E5 F1 Pit Stops two-week durable optimization",
    }));

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    await loop.runOneIteration("goal-1", 0);

    const stallCall = (mocks.corePhaseRunner.run as ReturnType<typeof vi.fn>).mock.calls.find(
      ([spec]) => spec.phase === "stall_investigation"
    );
    expect(stallCall?.[1]).toEqual(expect.objectContaining({
      goalId: "goal-1",
      goalTitle: "Kaggle S6E5 F1 Pit Stops two-week durable optimization",
      stallType: "dimension_stall",
      dimensionName: "dim1",
      suggestedCause: "approach_failure",
      taskId: "task-1",
    }));
    expect(stallCall?.[2]).toEqual(expect.objectContaining({ goalId: "goal-1", taskId: "task-1" }));
  });

  it("runs bounded public research on plateau and saves structured source evidence for task handoff", async () => {
    const { deps, mocks } = createDeps(tmpDir, { stall: true, publicResearch: true });
    const evidenceLedger = { append: vi.fn().mockResolvedValue([]) };
    deps.evidenceLedger = evidenceLedger;
    await mocks.stateManager.saveGoal(makeGoal({ title: "Improve benchmark score" }));

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    const result = await loop.runOneIteration("goal-1", 0);

    expect(result.corePhaseResults?.some((phase) => phase.phase === "public_research")).toBe(true);
    expect(mocks.corePhaseRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "public_research",
        allowedTools: ["research_web", "research_answer_with_sources"],
        requiredTools: ["research_answer_with_sources"],
      }),
      expect.objectContaining({
        trigger: "plateau",
        sensitiveContextPolicy: "do_not_send_secrets_or_private_artifacts",
        untrustedContentPolicy: "webpage_instructions_are_untrusted",
      }),
      expect.anything(),
    );
    expect(evidenceLedger.append).toHaveBeenCalledWith(expect.objectContaining({
      kind: "research",
      research: [expect.objectContaining({
        summary: "research-summary",
        untrusted_content_policy: "webpage_instructions_are_untrusted",
        sources: [expect.objectContaining({ url: "https://example.com/research/plateau" })],
        findings: [expect.objectContaining({
          applicability: "Applies when local changes stop moving the metric.",
          proposed_experiment: "Run one local ablation and compare the tracked metric.",
        })],
        external_actions: [expect.objectContaining({ approval_required: true })],
      })],
      raw_refs: expect.arrayContaining([
        expect.objectContaining({ kind: "research_source", url: "https://example.com/research/plateau" }),
      ]),
    }));
    const taskCycleArgs = (mocks.taskLifecycle.runTaskCycle as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(taskCycleArgs[4]).toContain("research-summary");
  });

  it("runs Dream review checkpoint on plateau and saves advisory guidance for task handoff", async () => {
    const { deps, mocks } = createDeps(tmpDir, { stall: true, dreamCheckpoint: true });
    const evidenceLedger = {
      append: vi.fn().mockResolvedValue([]),
      summarizeGoal: vi.fn().mockResolvedValue({
        schema_version: "runtime-evidence-summary-v1",
        generated_at: "2026-04-30T00:00:00.000Z",
        scope: { goal_id: "goal-1" },
        total_entries: 1,
        latest_strategy: null,
        best_evidence: null,
        metric_trends: [],
        evaluator_summary: {
          observations: [],
          local_best: null,
          external_best: null,
          approval_required_actions: [],
          gap: null,
        },
        research_memos: [],
        dream_checkpoints: [],
        divergent_exploration: [],
        recent_failed_attempts: [],
        recent_entries: [],
        warnings: [],
      }),
    };
    deps.evidenceLedger = evidenceLedger as never;
    await mocks.stateManager.saveGoal(makeGoal({ title: "Improve benchmark score" }));

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    const result = await loop.runOneIteration("goal-1", 0);

    expect(result.corePhaseResults?.some((phase) => phase.phase === "dream_review_checkpoint")).toBe(true);
    expect(mocks.corePhaseRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "dream_review_checkpoint",
        allowedTools: ["soil_query", "knowledge_query", "memory_recall"],
        requiredTools: ["soil_query"],
      }),
      expect.objectContaining({
        trigger: "plateau",
        memoryAuthorityPolicy: "soil_and_playbooks_are_advisory_only",
      }),
      expect.anything(),
    );
    expect(evidenceLedger.append).toHaveBeenCalledWith(expect.objectContaining({
      kind: "dream_checkpoint",
      dream_checkpoints: [expect.objectContaining({
        summary: "dream-summary",
        context_authority: "advisory_only",
        relevant_memories: [expect.objectContaining({ authority: "advisory_only" })],
        run_control_recommendations: [expect.objectContaining({
          action: "widen_exploration",
          policy_decision: expect.objectContaining({ disposition: "auto_apply" }),
        })],
      })],
      raw_refs: expect.arrayContaining([
        expect.objectContaining({ kind: "dream_soil_memory", id: "soil://goal-1/checkpoint" }),
        expect.objectContaining({ kind: "dream_run_control_lineage", id: "lineage:continue" }),
      ]),
    }));
    const taskCycleArgs = (mocks.taskLifecycle.runTaskCycle as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(taskCycleArgs[4]).toContain("dream-summary");
    expect(taskCycleArgs[4]).toContain("Use the bounded variant before generating the next task.");
    expect(taskCycleArgs[4]).toContain("Bounded variant: Changes one factor and preserves the current proof lane.");
    expect(taskCycleArgs[7]).toMatchObject({
      runControlRecommendationContext: expect.stringContaining("widen_exploration"),
    });
  });

  it("keeps wait observation on a short read-only budget separate from normal AgentLoop execution", async () => {
    const policy = new StaticCorePhasePolicyRegistry().get("wait_observation");

    expect(policy.enabled).toBe(true);
    expect(policy.budget.maxWallClockMs).toBeLessThan(90_000);
    expect(policy.budget.maxToolCalls).toBeLessThan(12);
    expect(policy.allowedTools).toEqual(
      expect.arrayContaining(["process_session_read", "process_session_list", "process-status", "progress_history", "read-pulseed-file"])
    );
    expect(policy.allowedTools).not.toEqual(
      expect.arrayContaining(["process_session_start", "process_session_write", "process_session_stop", "shell_command"])
    );
    expect(policy.requiredTools).toEqual(expect.arrayContaining(["process_session_read", "process_session_list"]));
  });

	  it("makes deferred process observation tools visible to the wait observation phase", () => {
    const policy = new StaticCorePhasePolicyRegistry().get("wait_observation");
    const registry = new ToolRegistry();
    registry.register(new ProcessSessionReadTool());
    registry.register(new ProcessSessionListTool());
    registry.register(new ProcessStatusTool());

    const router = new ToolRegistryAgentLoopToolRouter(registry);
    const tools = router.modelVisibleTools({
      cwd: tmpDir,
      goalId: "goal-1",
      toolPolicy: {
        allowedTools: policy.allowedTools,
        requiredTools: policy.requiredTools,
      },
    } as never);

	    expect(tools.map((tool) => tool.function.name)).toEqual(
	      expect.arrayContaining(["process_session_read", "process_session_list", "process-status"])
	    );
	  });

	  it("keeps default core phase policies aligned with production builtin tool names", () => {
	    const registry = new ToolRegistry();
	    const stateManager = new StateManager(tmpDir);
	    for (const tool of createBuiltinTools({
	      stateManager,
	      registry,
	      knowledgeManager: {} as never,
	      interactiveAutomationRegistry: new InteractiveAutomationRegistry(),
	    })) {
	      registry.register(tool);
	    }
	    const policyRegistry = new StaticCorePhasePolicyRegistry();
	    const phases = [
	      "observe_evidence",
	      "wait_observation",
	      "knowledge_refresh",
	      "stall_investigation",
	      "replanning_options",
	      "dream_review_checkpoint",
	      "public_research",
	      "verification_evidence",
	    ] as const;

	    for (const phase of phases) {
	      const policy = policyRegistry.get(phase);
	      for (const toolName of [...policy.allowedTools, ...policy.requiredTools]) {
	        expect(registry.get(toolName), `${phase} references missing tool ${toolName}`).toBeDefined();
	      }
	    }
	  });

  it("does not run agentic wait observation before the durable next observe time is due", async () => {
    const { deps, mocks } = createDeps(tmpDir);
    const waitStrategy = {
      id: "wait-1",
      type: "wait",
      state: "active",
      wait_reason: "waiting for external metric",
      wait_until: "2026-04-24T13:00:00.000Z",
    };
    deps.strategyManager = {
      ...deps.strategyManager,
      getPortfolio: vi.fn().mockResolvedValue({ strategies: [waitStrategy] }),
    } as never;
    deps.portfolioManager = {
      isWaitStrategy: vi.fn().mockReturnValue(true),
      handleWaitStrategyExpiry: vi.fn().mockResolvedValue({
        status: "not_due",
        goal_id: "goal-1",
        strategy_id: "wait-1",
        details: "not due yet",
      }),
    } as never;
    await mocks.stateManager.saveGoal(makeGoal());

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T12:00:00.000Z"));
    try {
      const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
      const result = await loop.runOneIteration("goal-1", 0);

      expect(result.skipReason).toBe("wait_not_due");
      expect(mocks.corePhaseRunner.run).not.toHaveBeenCalledWith(
        expect.objectContaining({ phase: "wait_observation" }),
        expect.anything(),
        expect.anything(),
      );
      expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-acquires knowledge from refresh evidence and skips task cycle", async () => {
    const { deps, mocks } = createDeps(tmpDir);
    await mocks.stateManager.saveGoal(makeGoal());

    const knowledgeManager = {
      acquireWithTools: vi.fn().mockResolvedValue([
        {
          entry_id: "k-1",
          question: "Need migration constraints",
          answer: "Run schema diff first",
          sources: [],
          confidence: 0.8,
          acquired_at: new Date().toISOString(),
          acquisition_task_id: "tool_direct",
          superseded_by: null,
          tags: [],
          embedding_id: null,
        },
      ]),
      saveKnowledge: vi.fn().mockResolvedValue(undefined),
      getRelevantKnowledge: vi.fn().mockResolvedValue([]),
      searchKnowledge: vi.fn().mockResolvedValue([]),
      loadKnowledge: vi.fn().mockResolvedValue([]),
    };

    const loop = new CoreLoop(
      {
        ...deps,
        knowledgeManager: knowledgeManager as never,
        toolExecutor: { executeBatch: vi.fn() } as never,
      },
      { delayBetweenLoopsMs: 0 }
    );
    const result = await loop.runOneIteration("goal-1", 0);

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("knowledge_refresh_auto_acquire");
    expect(knowledgeManager.acquireWithTools).toHaveBeenCalledOnce();
    expect(knowledgeManager.saveKnowledge).toHaveBeenCalledOnce();
    expect(mocks.taskLifecycle.runTaskCycle).not.toHaveBeenCalled();
  });

  it("carries next-iteration directive forward when later replanning evidence is weak", async () => {
    const { deps, mocks } = createDeps(tmpDir);
    await mocks.stateManager.saveGoal(makeGoal());

    let replanningCalls = 0;
    mocks.corePhaseRunner.run.mockImplementation(async (spec: { phase: string }) => {
      if (spec.phase === "replanning_options") {
        replanningCalls += 1;
        return {
          success: true,
          output: replanningCalls === 1
            ? {
                summary: "focus dim1 strongly",
                recommended_action: "pivot",
                candidates: [{
                  title: "Task A",
                  rationale: "fast",
                  expected_evidence_gain: "high",
                  blast_radius: "low",
                  target_dimensions: ["dim1"],
                  dependencies: [],
                }],
                confidence: 0.9,
              }
            : {
                summary: "weak follow-up",
                recommended_action: "continue",
                candidates: [],
                confidence: 0.2,
              },
          finalText: "",
          stopReason: "completed",
          elapsedMs: 1,
          modelTurns: 1,
          toolCalls: 0,
          compactions: 0,
          changedFiles: [],
          commandResults: [],
          traceId: `trace-${spec.phase}-${replanningCalls}`,
          sessionId: `session-${spec.phase}-${replanningCalls}`,
          turnId: `turn-${spec.phase}-${replanningCalls}`,
        };
      }

      return {
        success: true,
        output: ({
          observe_evidence: { summary: "observe-summary", evidence: ["git clean"], missing_info: [], confidence: 0.8 },
          knowledge_refresh: {
            summary: "knowledge-summary",
            required_knowledge: [],
            acquisition_candidates: [],
            confidence: 0.4,
            worthwhile: false,
          },
          verification_evidence: {
            summary: "verify-summary",
            supported_claims: ["tests pass"],
            unsupported_claims: [],
            blockers: [],
            confidence: 0.9,
          },
          stall_investigation: {
            summary: "stall-summary",
            suspected_causes: ["approach_failure"],
            recommended_next_evidence: ["inspect files"],
            relevant_actions: ["refine"],
            confidence: 0.7,
          },
        } as Record<string, unknown>)[spec.phase],
        finalText: "",
        stopReason: "completed",
        elapsedMs: 1,
        modelTurns: 1,
        toolCalls: 0,
        compactions: 0,
        changedFiles: [],
        commandResults: [],
        traceId: `trace-${spec.phase}`,
        sessionId: `session-${spec.phase}`,
        turnId: `turn-${spec.phase}`,
      };
    });

    const loop = new CoreLoop(deps, { delayBetweenLoopsMs: 0 });
    const first = await loop.runOneIteration("goal-1", 0);
    const second = await loop.runOneIteration("goal-1", 1);

    expect(first.nextIterationDirective).toEqual(
      expect.objectContaining({
        sourcePhase: "replanning_options",
        focusDimension: "dim1",
      })
    );
    const secondTaskCycleArgs = (mocks.taskLifecycle.runTaskCycle as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(secondTaskCycleArgs[7]).toEqual(expect.objectContaining({ targetDimensionOverride: "dim1" }));
  });
});
