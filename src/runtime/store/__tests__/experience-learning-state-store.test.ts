import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import {
  ExperienceLearningStateStore,
} from "../experience-learning-state-store.js";
import { RuntimeEventLogStore } from "../runtime-event-log.js";
import {
  ExperienceLearningRuntimeEventPayloadSchema,
  defaultRuntimeEvidenceTrust,
  learningPriorSuggestion,
  redactedLearningLabel,
  type CandidateTransition,
  type ExperienceFrame,
  type ExperienceLearningMetricBaselineObservation,
  type ExperienceLearningMetricBaselineRunKind,
  type ExperienceLearningMetricScenarioClass,
  type ExperienceLearningRuntimeEventPayload,
  type LearningConsumerPhase,
  type LearningPriorSnapshot,
  type LearningPriorSuggestionKind,
  type TrialReuseBudgetConsumptionRecord,
  type TrialReuseReadinessGate,
} from "../../learning/index.js";

describe("ExperienceLearningStateStore", () => {
  let tmpDir: string;
  let runtimeRoot: string;
  let store: ExperienceLearningStateStore;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-experience-learning-");
    runtimeRoot = path.join(tmpDir, "runtime");
    store = new ExperienceLearningStateStore(runtimeRoot, { controlBaseDir: tmpDir });
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("persists frame projection through a closed RuntimeEventLog payload in one idempotent path", async () => {
    const payload = makeFramePayload();

    const first = await store.appendLifecycleEvent(payload);
    const second = await store.appendLifecycleEvent(payload);

    expect(first.runtimeEvent.disposition).toBe("inserted");
    expect(second.runtimeEvent.disposition).toBe("deduplicated_by_event_id");
    await expect(store.listFrames("goal-learning")).resolves.toEqual([payload.frame]);
    const sqlite = new Database(path.join(tmpDir, "state", "pulseed-control.sqlite"), { readonly: true });
    try {
      expect(sqlite.prepare(`
        SELECT created_at, updated_at
        FROM experience_learning_frames
        WHERE frame_id = ?
      `).get(payload.frame_id)).toEqual({
        created_at: payload.frame!.createdAt,
        updated_at: payload.frame!.updatedAt,
      });
    } finally {
      sqlite.close();
    }

    const eventLog = new RuntimeEventLogStore(runtimeRoot, { controlBaseDir: tmpDir });
    try {
      const events = await eventLog.listEvents({ eventType: "experience_learning.frame.activated", limit: null });
      expect(events).toHaveLength(1);
      expect(events[0]?.payload_schema).toBe("runtime-event-payload/experience-learning/v1");
      expect(events[0]?.payload).toMatchObject({
        event_kind: "frame_activated",
        frame_id: payload.frame_id,
        activated_evidence_refs: ["evidence-1", "evidence-2"],
      });
    } finally {
      await eventLog.close();
    }
  });

  it("rebuilds learning projections from RuntimeEventLog in a fresh store process", async () => {
    const payload = makeFramePayload();
    await store.appendLifecycleEvent(payload);
    await store.close();

    const fresh = new ExperienceLearningStateStore(runtimeRoot, { controlBaseDir: tmpDir });
    try {
      const summary = await fresh.rebuildFromRuntimeEventLog();
      expect(summary.frames).toBe(1);
      await expect(fresh.listFrames("goal-learning")).resolves.toEqual([payload.frame]);
    } finally {
      await fresh.close();
    }
  });

  it("exposes metric definitions and read-path values from projection tables", async () => {
    await store.appendLifecycleEvent(makeFramePayload());
    const snapshot = await store.getMetricsSnapshot("goal-learning");

    expect(snapshot.definitions.map((definition) => definition.name)).toContain("experience_frames_created");
    expect(snapshot.definitions.every((definition) => definition.read_path === "ExperienceLearningStateStore.getMetricsSnapshot")).toBe(true);
    expect(snapshot.definitions.find((definition) => definition.name === "prior_outcome_delta")?.baseline_requirement).toEqual({
      required: true,
      scenario_classes: ["task_work", "stall_recovery", "companion_interaction"],
      run_kinds: ["no_prior", "prior_enabled"],
    });
    expect(snapshot.values).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "experience_frames_created",
        numerator_value: 1,
        denominator_value: 1,
        value: 1,
        validity: { decision: "valid", baseline_ids: [], baseline_observation_ids: [] },
      }),
    ]));
    expect(snapshot.values.find((value) => value.name === "prior_outcome_delta")?.validity).toEqual({
      decision: "invalid",
      reason_codes: [
        "paired_baseline_required",
        "missing_task_work_pair",
        "missing_stall_recovery_pair",
        "missing_companion_interaction_pair",
      ],
      missing_scenario_classes: ["task_work", "stall_recovery", "companion_interaction"],
      baseline_ids: [],
      baseline_observation_ids: [],
    });
  });

  it("requires paired no-prior and prior-enabled baselines before outcome-delta metrics are valid", async () => {
    for (const scenarioClass of ["task_work", "stall_recovery", "companion_interaction"] as const) {
      for (const runKind of ["no_prior", "prior_enabled"] as const) {
        await store.recordMetricBaselineObservation(makeBaselineObservation(scenarioClass, runKind));
      }
    }

    const snapshot = await store.getMetricsSnapshot("goal-learning");
    const priorOutcomeValidity = snapshot.values.find((value) => value.name === "prior_outcome_delta")?.validity;
    expect(priorOutcomeValidity).toMatchObject({
      decision: "valid",
      baseline_ids: ["baseline:ordinary-pulseed"],
    });
    expect(priorOutcomeValidity?.baseline_observation_ids).toEqual(expect.arrayContaining([
      "metric-baseline:task_work:no_prior",
      "metric-baseline:task_work:prior_enabled",
      "metric-baseline:stall_recovery:no_prior",
      "metric-baseline:stall_recovery:prior_enabled",
      "metric-baseline:companion_interaction:no_prior",
      "metric-baseline:companion_interaction:prior_enabled",
    ]));
    expect(priorOutcomeValidity?.baseline_observation_ids).toHaveLength(6);
    expect(snapshot.values.find((value) => value.name === "interaction_policy_bias_outcome_delta")?.validity.decision).toBe("valid");
  });

  it("upserts metric baseline observations by logical scenario key when retry ids change", async () => {
    await store.recordMetricBaselineObservation(makeBaselineObservation("task_work", "no_prior"));
    await store.recordMetricBaselineObservation({
      ...makeBaselineObservation("task_work", "no_prior"),
      id: "metric-baseline:task_work:no_prior:retry",
      observedAt: "2026-05-17T00:20:00.000Z",
      numeratorValue: 3,
      denominatorValue: 4,
      value: 0.75,
    });

    const snapshot = await store.getMetricsSnapshot("goal-learning");
    expect(snapshot.values.find((value) => value.name === "prior_outcome_delta")?.validity).toMatchObject({
      decision: "invalid",
      baseline_observation_ids: ["metric-baseline:task_work:no_prior:retry"],
    });
  });

  it("projects experience-learning refs into RuntimeGraph explanations", async () => {
    const payload = makeFramePayload();
    const append = await store.appendLifecycleEvent(payload);
    const eventLog = new RuntimeEventLogStore(runtimeRoot, { controlBaseDir: tmpDir });
    try {
      const explanation = await eventLog.explainTrace(append.runtimeEvent.event.trace_id);
      expect(explanation.runtime_graph.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ node_kind: "experience_frame", ref: { kind: "experience_frame", ref: payload.frame_id } }),
      ]));
      expect(explanation.runtime_graph.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ edge_kind: "derived_from" }),
      ]));
      expect(explanation.projection_rebuild.experience_learning_summary.frame_count).toBe(1);
    } finally {
      await eventLog.close();
    }
  });

  it("normalizes candidate transition target kinds into RuntimeGraph node kinds", async () => {
    const cases = [
      { targetKind: "frame", targetId: "frame-target-1", expectedKind: "experience_frame" },
      { targetKind: "hypothesis", targetId: "hypothesis-target-1", expectedKind: "learning_hypothesis" },
      { targetKind: "artifact", targetId: "artifact-target-1", expectedKind: "learning_artifact" },
      { targetKind: "prior", targetId: "prior-target-1", expectedKind: "learning_prior" },
    ] as const;
    const eventLog = new RuntimeEventLogStore(runtimeRoot, { controlBaseDir: tmpDir });
    try {
      for (const testCase of cases) {
        const append = await store.appendLifecycleEvent(makeCandidateTransitionPayload({
          transitionId: `transition-${testCase.targetKind}`,
          targetKind: testCase.targetKind,
          targetId: testCase.targetId,
        }));
        const explanation = await eventLog.explainTrace(append.runtimeEvent.event.trace_id);
        expect(explanation.runtime_graph.nodes).toEqual(expect.arrayContaining([
          expect.objectContaining({
            node_kind: testCase.expectedKind,
            ref: { kind: testCase.expectedKind, ref: testCase.targetId },
          }),
        ]));
        expect(explanation.runtime_graph.nodes).not.toEqual(expect.arrayContaining([
          expect.objectContaining({
            node_kind: "artifact",
            ref: { kind: testCase.targetKind, ref: testCase.targetId },
          }),
        ]));
      }
    } finally {
      await eventLog.close();
    }
  });

  it("rejects legacy consumed-prior event names and broad payloads", () => {
    expect(() =>
      ExperienceLearningRuntimeEventPayloadSchema.parse({
        ...makeFramePayload(),
        event_kind: "prior_consumed",
      })
    ).toThrow();

    expect(() =>
      ExperienceLearningRuntimeEventPayloadSchema.parse({
        ...makeFramePayload(),
        frame_id: undefined,
      })
    ).toThrow();
  });

  it("reserves, applies, and max-use suppresses typed phase prior projections", async () => {
    const payload = makePriorGeneratedPayload();
    await store.appendLifecycleEvent(payload);

    const first = await store.resolvePriorForPhase({
      goalId: "goal-learning",
      runId: "run-learning",
      consumerPhase: "task_generation",
      consumerScope: {
        refs: { goalId: "goal-learning", runId: "run-learning" },
        semantic: {
          taskKind: "task_generation",
          environmentKind: "pulseed_runtime",
          classifierVersion: "test",
          confidence: 1,
        },
      },
      loopIndex: 2,
      consumerAttemptId: "attempt-1",
      consumerDecisionRef: "task-generation:goal-learning:2",
      now: "2026-05-17T00:05:00.000Z",
    });

    expect(first?.record.stage).toBe("reserved");
    expect(first?.projection).toEqual(expect.objectContaining({
      phase: "task_generation",
      preferredTargetDimension: "dim-prior",
      consumptionRecordId: first?.record.id,
    }));

    const duplicate = await store.resolvePriorForPhase({
      goalId: "goal-learning",
      runId: "run-learning",
      consumerPhase: "task_generation",
      consumerScope: { refs: { goalId: "goal-learning", runId: "run-learning" } },
      loopIndex: 2,
      consumerAttemptId: "attempt-1",
      consumerDecisionRef: "task-generation:goal-learning:2",
      now: "2026-05-17T00:05:00.000Z",
    });
    expect(duplicate?.runtimeEventId).toBeNull();
    expect(duplicate?.record.id).toBe(first?.record.id);

    await store.markPriorConsumptionApplied({
      consumptionId: first!.record.id,
      generatedDecisionRefs: ["task:task-from-prior"],
      completedAt: "2026-05-17T00:06:00.000Z",
    });
    const records = await store.listPriorConsumptionRecords(payload.prior_id);
    expect(records).toEqual([
      expect.objectContaining({
        id: first?.record.id,
        stage: "applied",
        generatedDecisionRefs: ["task:task-from-prior"],
      }),
    ]);
    await expect(store.markPriorConsumptionApplied({
      consumptionId: first!.record.id,
      generatedDecisionRefs: ["task:replayed-prior"],
      completedAt: "2026-05-17T00:07:00.000Z",
    })).resolves.toBeNull();
    await expect(store.listPriorConsumptionRecords(payload.prior_id)).resolves.toEqual([
      expect.objectContaining({
        id: first?.record.id,
        stage: "applied",
        generatedDecisionRefs: ["task:task-from-prior"],
      }),
    ]);
    const eventLog = new RuntimeEventLogStore(runtimeRoot, { controlBaseDir: tmpDir });
    try {
      await expect(eventLog.listEvents({ eventType: "experience_learning.prior.applied", limit: null })).resolves.toHaveLength(1);
    } finally {
      await eventLog.close();
    }

    const exhausted = await store.resolvePriorForPhase({
      goalId: "goal-learning",
      runId: "run-learning",
      consumerPhase: "task_generation",
      consumerScope: { refs: { goalId: "goal-learning", runId: "run-learning" } },
      loopIndex: 2,
      consumerAttemptId: "attempt-2",
      consumerDecisionRef: "task-generation:goal-learning:2:retry",
      now: "2026-05-17T00:07:00.000Z",
    });
    expect(exhausted?.record.stage).toBe("suppressed");
    expect(exhausted?.record.reasonCodes).toEqual(["max_uses_exhausted"]);
    expect(exhausted?.projection).toBeNull();
  });

  it("continues past suppressed older priors to reserve a newer eligible prior", async () => {
    const older = makePriorGeneratedPayload();
    await store.appendLifecycleEvent(older);
    const first = await store.resolvePriorForPhase({
      goalId: "goal-learning",
      runId: "run-learning",
      consumerPhase: "task_generation",
      consumerScope: { refs: { goalId: "goal-learning", runId: "run-learning" } },
      loopIndex: 2,
      consumerAttemptId: "attempt-old",
      consumerDecisionRef: "task-generation:goal-learning:2:old",
      now: "2026-05-17T00:05:00.000Z",
    });
    await store.markPriorConsumptionApplied({
      consumptionId: first!.record.id,
      generatedDecisionRefs: ["task:old-prior"],
      completedAt: "2026-05-17T00:06:00.000Z",
    });
    const newer = makePriorGeneratedPayload({
      priorId: "prior-2",
      suggestionId: "suggestion-task-2",
      artifactId: "artifact-2",
      idempotencyKey: "experience-learning:test:prior-2",
      generatedAt: "2026-05-17T00:07:00.000Z",
      targetDimension: "dim-newer",
    });
    await store.appendLifecycleEvent(newer);

    const second = await store.resolvePriorForPhase({
      goalId: "goal-learning",
      runId: "run-learning",
      consumerPhase: "task_generation",
      consumerScope: { refs: { goalId: "goal-learning", runId: "run-learning" } },
      loopIndex: 2,
      consumerAttemptId: "attempt-new",
      consumerDecisionRef: "task-generation:goal-learning:2:new",
      now: "2026-05-17T00:08:00.000Z",
    });

    expect(second?.prior.id).toBe("prior-2");
    expect(second?.record.stage).toBe("reserved");
    expect(second?.projection).toEqual(expect.objectContaining({
      phase: "task_generation",
      preferredTargetDimension: "dim-newer",
    }));
    await expect(store.listPriorConsumptionRecords("prior-1")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: "suppressed",
        reasonCodes: ["max_uses_exhausted"],
      }),
    ]));
  });

  it("does not inject run-scoped priors into consumers without the matching run id", async () => {
    await store.appendLifecycleEvent(makePriorGeneratedPayload({
      runId: "run-specific",
      idempotencyKey: "experience-learning:test:run-specific-prior",
    }));

    await expect(store.resolvePriorForPhase({
      goalId: "goal-learning",
      consumerPhase: "task_generation",
      consumerScope: { refs: { goalId: "goal-learning" } },
      loopIndex: 2,
      consumerAttemptId: "attempt-without-run",
      consumerDecisionRef: "task-generation:goal-learning:2:no-run",
      now: "2026-05-17T00:05:00.000Z",
    })).resolves.toBeNull();

    const matched = await store.resolvePriorForPhase({
      goalId: "goal-learning",
      runId: "run-specific",
      consumerPhase: "task_generation",
      consumerScope: { refs: { goalId: "goal-learning", runId: "run-specific" } },
      loopIndex: 2,
      consumerAttemptId: "attempt-with-run",
      consumerDecisionRef: "task-generation:goal-learning:2:with-run",
      now: "2026-05-17T00:06:00.000Z",
    });

    expect(matched?.prior.runId).toBe("run-specific");
    expect(matched?.record.stage).toBe("reserved");
  });

  it("projects stall hypotheses with experiment plan ids rather than source artifacts", async () => {
    await store.appendLifecycleEvent(makePriorGeneratedPayload({
      priorId: "prior-stall-hypothesis",
      suggestionId: "suggestion-stall-hypothesis",
      artifactId: "artifact-stall-hypothesis",
      idempotencyKey: "experience-learning:test:stall-hypothesis-prior",
      consumerPhase: "stall_investigation",
      suggestionKind: "hypothesis_to_test",
      experimentPlanIds: ["experiment-plan-stall-hypothesis"],
    }));

    const resolved = await store.resolvePriorForPhase({
      goalId: "goal-learning",
      runId: "run-learning",
      consumerPhase: "stall_investigation",
      consumerScope: { refs: { goalId: "goal-learning", runId: "run-learning" } },
      loopIndex: 2,
      consumerAttemptId: "stall-investigation:run:run-learning:loop:2",
      consumerDecisionRef: "stall-investigation:run:run-learning:loop:2",
      now: "2026-05-17T00:06:00.000Z",
    });

    expect(resolved?.projection).toEqual(expect.objectContaining({
      phase: "stall_investigation",
      projectionKind: "stall_focus_bias",
      experimentPlanIds: ["experiment-plan-stall-hypothesis"],
    }));
    expect(resolved?.projection).not.toEqual(expect.objectContaining({
      experimentPlanIds: ["artifact-stall-hypothesis"],
    }));
  });

  it("keeps goal-scoped metric snapshots from counting other goals' prior consumption", async () => {
    const otherGoalPrior = makePriorGeneratedPayload({
      goalId: "goal-other",
      runId: "run-other",
      priorId: "prior-other",
      suggestionId: "suggestion-other",
      artifactId: "artifact-other",
      idempotencyKey: "experience-learning:test:prior-other",
      targetDimension: "dim-other",
    });
    await store.appendLifecycleEvent(otherGoalPrior);
    const otherGoalResolution = await store.resolvePriorForPhase({
      goalId: "goal-other",
      runId: "run-other",
      consumerPhase: "task_generation",
      consumerScope: { refs: { goalId: "goal-other", runId: "run-other" } },
      loopIndex: 2,
      consumerAttemptId: "attempt-other",
      consumerDecisionRef: "task-generation:goal-other:2",
      now: "2026-05-17T00:05:00.000Z",
    });
    await store.markPriorConsumptionApplied({
      consumptionId: otherGoalResolution!.record.id,
      generatedDecisionRefs: ["task:other-goal"],
      completedAt: "2026-05-17T00:06:00.000Z",
    });

    const scopedSnapshot = await store.getMetricsSnapshot("goal-learning");
    expect(scopedSnapshot.values.find((value) => value.name === "action_savings_after_reuse")?.numerator_value).toBe(0);
    expect(scopedSnapshot.values.find((value) => value.name === "learning_prior_injections")?.numerator_value).toBe(0);
    expect(scopedSnapshot.values.find((value) => value.name === "prior_consumed_by_phase")?.numerator_value).toBe(0);
    const unscopedSnapshot = await store.getMetricsSnapshot();
    expect(unscopedSnapshot.values.find((value) => value.name === "action_savings_after_reuse")?.numerator_value).toBe(1);
  });

  it("suppresses failed consumer reservations without exhausting prior reuse budget", async () => {
    await store.appendLifecycleEvent(makePriorGeneratedPayload());
    const failedReservation = await store.resolvePriorForPhase({
      goalId: "goal-learning",
      runId: "run-learning",
      consumerPhase: "task_generation",
      consumerScope: { refs: { goalId: "goal-learning", runId: "run-learning" } },
      loopIndex: 2,
      consumerAttemptId: "attempt-failed-consumer",
      consumerDecisionRef: "task-generation:goal-learning:2:failed-consumer",
      now: "2026-05-17T00:05:00.000Z",
    });
    expect(failedReservation?.record.stage).toBe("reserved");

    await store.markPriorConsumptionSuppressed({
      consumptionId: failedReservation!.record.id,
      reasonCodes: ["consumer_execution_failed"],
      completedAt: "2026-05-17T00:06:00.000Z",
    });
    await expect(store.listPriorConsumptionRecords("prior-1")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: failedReservation!.record.id,
        stage: "suppressed",
        reasonCodes: ["consumer_execution_failed"],
      }),
    ]));

    const retryReservation = await store.resolvePriorForPhase({
      goalId: "goal-learning",
      runId: "run-learning",
      consumerPhase: "task_generation",
      consumerScope: { refs: { goalId: "goal-learning", runId: "run-learning" } },
      loopIndex: 2,
      consumerAttemptId: "attempt-retry-consumer",
      consumerDecisionRef: "task-generation:goal-learning:2:retry-consumer",
      now: "2026-05-17T00:07:00.000Z",
    });

    expect(retryReservation?.record.stage).toBe("reserved");
    expect(retryReservation?.record.id).not.toBe(failedReservation?.record.id);
    expect(retryReservation?.projection).toEqual(expect.objectContaining({
      preferredTargetDimension: "dim-prior",
    }));
  });

  it("rolls back RuntimeEventLog append when a trial-reuse budget projection double-reserves", async () => {
    const first = makeTrialReuseBudgetPayload({
      transitionId: "transition-budget-1",
      eventIdempotencyKey: "experience-learning:test:budget-transition-1",
      consumptionId: "budget-consumption-1",
      consumptionIdempotencyKey: "trial-reuse-budget:test:first",
    });
    const second = makeTrialReuseBudgetPayload({
      transitionId: "transition-budget-2",
      eventIdempotencyKey: "experience-learning:test:budget-transition-2",
      consumptionId: "budget-consumption-2",
      consumptionIdempotencyKey: "trial-reuse-budget:test:second",
    });

    await store.appendLifecycleEvent(first);
    await expect(store.appendLifecycleEvent(second)).rejects.toThrow(/trial reuse budget exhausted/);

    await expect(store.listTrialReuseBudgetConsumptions("candidate-budget")).resolves.toEqual([
      expect.objectContaining({
        id: "budget-consumption-1",
        decision: "reserved",
        idempotencyKey: "trial-reuse-budget:test:first",
      }),
    ]);
    const eventLog = new RuntimeEventLogStore(runtimeRoot, { controlBaseDir: tmpDir });
    try {
      const events = await eventLog.listEvents({ eventType: "experience_learning.candidate_transition.recorded", limit: null });
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({
        event_kind: "candidate_transition_recorded",
        transition_id: "transition-budget-1",
        trial_reuse_budget_consumption: expect.objectContaining({
          id: "budget-consumption-1",
        }),
      });
      expect(events.some((event) =>
        (event.payload as Record<string, unknown>)["idempotency_key"] === "experience-learning:test:budget-transition-2"
      )).toBe(false);
    } finally {
      await eventLog.close();
    }
  });
});

function makeBaselineObservation(
  scenarioClass: ExperienceLearningMetricScenarioClass,
  runKind: ExperienceLearningMetricBaselineRunKind,
): ExperienceLearningMetricBaselineObservation {
  const priorEnabledGain = runKind === "prior_enabled" ? 2 : 1;
  return {
    id: `metric-baseline:${scenarioClass}:${runKind}`,
    baselineId: "baseline:ordinary-pulseed",
    goalId: "goal-learning",
    scenarioClass,
    runKind,
    runRef: `scenario-run:${scenarioClass}:${runKind}`,
    observedAt: "2026-05-17T00:10:00.000Z",
    metricNames: [
      "prior_outcome_delta",
      "interaction_policy_bias_outcome_delta",
      "action_savings_after_reuse",
      "experiences_to_trial_reuse_ready",
    ],
    numeratorValue: priorEnabledGain,
    denominatorValue: 2,
    value: priorEnabledGain / 2,
  };
}

function makeFramePayload(): Extract<ExperienceLearningRuntimeEventPayload, { event_kind: "frame_activated" }> {
  const trust = defaultRuntimeEvidenceTrust({
    targetRef: {
      kind: "learning_frame",
      id: "frame-1",
      scope: { goal_id: "goal-learning", run_id: "run-learning" },
    },
    provenanceRefs: ["evidence-1", "evidence-2"],
  });
  const frame: ExperienceFrame = {
    id: "frame-1",
    goalId: "goal-learning",
    runId: "run-learning",
    loopIndex: 3,
    createdAt: "2026-05-17T00:00:00.000Z",
    updatedAt: "2026-05-17T00:05:00.000Z",
    trigger: "repeated_failure",
    selectedBy: "deterministic_bridge",
    sourceAuthority: "runtime_evidence",
    summary: redactedLearningLabel({
      label: "Repeated failure frame",
      sourceRefs: ["evidence-1", "evidence-2"],
    }),
    evidenceRefs: ["evidence-1", "evidence-2"],
    cognitionEventRefs: [],
    runtimeGraphRefs: [],
    attentionRefs: [],
    taskRefs: ["task-1"],
    salience: {
      informationGain: 0.8,
      goalRelevance: 0.9,
      recurrence: 0.7,
      uncertainty: 0.5,
      risk: 0.3,
    },
    scope: {
      refs: { goalId: "goal-learning", runId: "run-learning", taskId: "task-1" },
      semantic: {
        taskKind: "durable_loop_iteration",
        environmentKind: "pulseed_runtime",
        classifierVersion: "test",
        confidence: 1,
      },
    },
    trust,
    correctionState: trust.correctionState,
    status: "candidate",
  };
  return {
    schema_version: "runtime-event-payload/experience-learning/v1",
    event_kind: "frame_activated",
    idempotency_key: "experience-learning:test:frame-1",
    goal_id: "goal-learning",
    run_id: "run-learning",
    loop_index: 3,
    source_refs: {
      evidence_refs: ["evidence-1", "evidence-2"],
      event_refs: [],
      runtime_graph_refs: [],
    },
    trust,
    correction_state: trust.correctionState,
    redaction_class: "refs_only",
    graph: {
      node_refs: [{ kind: "experience_frame", ref: "frame-1" }],
      edge_refs: [],
    },
    frame_id: "frame-1",
    activated_evidence_refs: ["evidence-1", "evidence-2"],
    frame,
  };
}

function makePriorGeneratedPayload(input: {
  goalId?: string;
  runId?: string;
  priorId?: string;
  suggestionId?: string;
  artifactId?: string;
  idempotencyKey?: string;
  generatedAt?: string;
  targetDimension?: string;
  consumerPhase?: LearningConsumerPhase;
  suggestionKind?: LearningPriorSuggestionKind;
  sourceArtifactIds?: string[];
  experimentPlanIds?: string[];
} = {}): Extract<ExperienceLearningRuntimeEventPayload, { event_kind: "prior_generated" }> {
  const goalId = input.goalId ?? "goal-learning";
  const runId = input.runId ?? "run-learning";
  const priorId = input.priorId ?? "prior-1";
  const suggestionId = input.suggestionId ?? "suggestion-task";
  const artifactId = input.artifactId ?? "artifact-1";
  const sourceArtifactIds = input.sourceArtifactIds ?? [artifactId];
  const generatedAt = input.generatedAt ?? "2026-05-17T00:00:00.000Z";
  const targetDimension = input.targetDimension ?? "dim-prior";
  const trust = defaultRuntimeEvidenceTrust({
    targetRef: {
      kind: "learning_prior",
      id: priorId,
      scope: { goal_id: goalId, run_id: runId },
    },
    provenanceRefs: ["evidence-1", "evidence-2"],
  });
  const prior: LearningPriorSnapshot = {
    id: priorId,
    goalId,
    runId,
    generatedAt,
    sourceLoopIndex: 1,
    eligibleFromIteration: 2,
    generationEventRef: `runtime-event-projection:experience-learning:${priorId}`,
    sourceCandidateTransitionIds: ["transition-1"],
    scope: { refs: { goalId, runId } },
    compatibility: {
      decision: "compatible",
      reasonCode: "matched_exact_refs",
      matchedRefs: [`goalId:${goalId}`],
      missingRefs: [],
    },
    sourceArtifactIds: [artifactId],
    suggestions: [
      learningPriorSuggestion({
        id: suggestionId,
        kind: input.suggestionKind ?? "strategy_preference",
        consumerPhase: input.consumerPhase ?? "task_generation",
        targetRef: { kind: "dimension", id: targetDimension },
        rationale: redactedLearningLabel({
          label: "Use typed prior dimension bias",
          sourceRefs: ["evidence-1", "evidence-2"],
        }),
        sourceArtifactIds,
        experimentPlanIds: input.experimentPlanIds ?? ["experiment-plan-1"],
        evidenceRefs: ["evidence-1", "evidence-2"],
        strength: 0.6,
        risk: "low",
        expiresAt: "2026-05-18T00:00:00.000Z",
        maxUses: 1,
        sourceContext: { kind: "non_user_context", requestedUseClass: "goal_planning" },
      }),
    ],
    staleOrFalsifiedArtifactIds: [],
    suppressedByCorrectionIds: [],
    suppressedByQuarantineIds: [],
    trust,
    sourceTrustStates: [{ sourceRef: artifactId, trust }],
    filterDecision: {
      decision: "activated",
      reasonCodes: ["eligible"],
      evaluatedAt: generatedAt,
    },
    confidence: 0.7,
  };
  return {
    schema_version: "runtime-event-payload/experience-learning/v1",
    event_kind: "prior_generated",
    idempotency_key: input.idempotencyKey ?? "experience-learning:test:prior-1",
    goal_id: goalId,
    run_id: runId,
    loop_index: 1,
    source_refs: {
      evidence_refs: ["evidence-1", "evidence-2"],
      event_refs: [],
      runtime_graph_refs: [],
    },
    trust,
    correction_state: trust.correctionState,
    redaction_class: "refs_only",
    graph: {
      node_refs: [{ kind: "learning_prior", ref: priorId }],
      edge_refs: [],
    },
    prior_id: priorId,
    artifact_ids: [artifactId],
    eligible_from_iteration: 2,
    prior,
  };
}

function makeTrialReuseBudgetPayload(input: {
  transitionId: string;
  eventIdempotencyKey: string;
  consumptionId: string;
  consumptionIdempotencyKey: string;
}): Extract<ExperienceLearningRuntimeEventPayload, { event_kind: "candidate_transition_recorded" }> {
  const trust = defaultRuntimeEvidenceTrust({
    targetRef: {
      kind: "candidate_transition",
      id: input.transitionId,
      scope: { goal_id: "goal-learning", run_id: "run-learning" },
    },
    provenanceRefs: ["evidence-budget"],
  });
  const readinessGate: TrialReuseReadinessGate = {
    id: "gate-budget",
    candidateId: "candidate-budget",
    sourceLoopIndex: 1,
    eligibleFromIteration: 2,
    sourceTransitionId: input.transitionId,
    disjointSupportRefs: ["evidence-budget"],
    actionShape: "reversible",
    risk: "low",
    scopeDecision: "exact",
    transferScopeRef: "goal:goal-learning",
    trialReuseBudgetId: "trial-reuse-budget:test",
    remainingTrialUses: 1,
    decision: "ready",
    reasonCodes: ["independent_support", "n_plus_one", "low_risk"],
  };
  const consumption: TrialReuseBudgetConsumptionRecord = {
    id: input.consumptionId,
    gateId: readinessGate.id,
    candidateId: readinessGate.candidateId,
    planId: "experiment-plan-budget",
    consumerAttemptId: `trial-reuse-plan:${input.consumptionId}`,
    loopIndex: 2,
    reservedAt: "2026-05-17T00:04:00.000Z",
    decision: "reserved",
    reasonCodes: ["ready"],
    idempotencyKey: input.consumptionIdempotencyKey,
  };
  const transition: CandidateTransition = {
    id: input.transitionId,
    goalId: "goal-learning",
    runId: "run-learning",
    loopIndex: 1,
    targetKind: "generalization_candidate",
    targetId: readinessGate.candidateId,
    fromStatus: "candidate",
    toStatus: "trial_reuse_ready",
    reasonCode: "trial_reuse_ready",
    diagnosticLabel: "test budget reservation",
    microProbeRecordIds: ["probe-record-budget"],
    evidenceRefs: ["evidence-budget"],
    eventRefs: [],
    runtimeGraphRefs: [],
    readinessGateId: readinessGate.id,
  };
  return {
    schema_version: "runtime-event-payload/experience-learning/v1",
    event_kind: "candidate_transition_recorded",
    idempotency_key: input.eventIdempotencyKey,
    goal_id: "goal-learning",
    run_id: "run-learning",
    loop_index: 1,
    source_refs: {
      evidence_refs: ["evidence-budget"],
      event_refs: [],
      runtime_graph_refs: [],
    },
    trust,
    correction_state: trust.correctionState,
    redaction_class: "refs_only",
    graph: {
      node_refs: [
        { kind: "candidate_transition", ref: input.transitionId },
        { kind: "generalization_candidate", ref: readinessGate.candidateId },
      ],
      edge_refs: [],
    },
    transition_id: input.transitionId,
    target_kind: "generalization_candidate",
    target_id: readinessGate.candidateId,
    from_status: "candidate",
    to_status: "trial_reuse_ready",
    reason_code: "trial_reuse_ready",
    transition,
    readiness_gate: readinessGate,
    trial_reuse_budget_consumption: consumption,
  };
}

function makeCandidateTransitionPayload(input: {
  transitionId: string;
  targetKind: CandidateTransition["targetKind"];
  targetId: string;
}): Extract<ExperienceLearningRuntimeEventPayload, { event_kind: "candidate_transition_recorded" }> {
  const trust = defaultRuntimeEvidenceTrust({
    targetRef: {
      kind: "candidate_transition",
      id: input.transitionId,
      scope: { goal_id: "goal-learning", run_id: "run-learning" },
    },
    provenanceRefs: ["evidence-transition"],
  });
  const transition: CandidateTransition = {
    id: input.transitionId,
    goalId: "goal-learning",
    runId: "run-learning",
    loopIndex: 1,
    targetKind: input.targetKind,
    targetId: input.targetId,
    fromStatus: "candidate",
    toStatus: "strengthened",
    reasonCode: "independent_support",
    diagnosticLabel: "test candidate transition target kind",
    microProbeRecordIds: [],
    evidenceRefs: ["evidence-transition"],
    eventRefs: [],
    runtimeGraphRefs: [],
  };
  return {
    schema_version: "runtime-event-payload/experience-learning/v1",
    event_kind: "candidate_transition_recorded",
    idempotency_key: `experience-learning:test:candidate-transition:${input.transitionId}`,
    goal_id: "goal-learning",
    run_id: "run-learning",
    loop_index: 1,
    source_refs: {
      evidence_refs: ["evidence-transition"],
      event_refs: [],
      runtime_graph_refs: [],
    },
    trust,
    correction_state: trust.correctionState,
    redaction_class: "refs_only",
    graph: {
      node_refs: [
        { kind: "candidate_transition", ref: input.transitionId },
        { kind: input.targetKind, ref: input.targetId },
      ],
      edge_refs: [],
    },
    transition_id: input.transitionId,
    target_kind: input.targetKind,
    target_id: input.targetId,
    from_status: "candidate",
    to_status: "strengthened",
    reason_code: "independent_support",
    transition,
  };
}
