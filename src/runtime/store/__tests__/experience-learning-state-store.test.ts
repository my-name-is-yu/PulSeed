import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  type ExperienceFrame,
  type ExperienceLearningRuntimeEventPayload,
  type LearningPriorSnapshot,
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
    expect(snapshot.values).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "experience_frames_created",
        numerator_value: 1,
        denominator_value: 1,
        value: 1,
      }),
    ]));
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
});

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

function makePriorGeneratedPayload(): Extract<ExperienceLearningRuntimeEventPayload, { event_kind: "prior_generated" }> {
  const trust = defaultRuntimeEvidenceTrust({
    targetRef: {
      kind: "learning_prior",
      id: "prior-1",
      scope: { goal_id: "goal-learning", run_id: "run-learning" },
    },
    provenanceRefs: ["evidence-1", "evidence-2"],
  });
  const prior: LearningPriorSnapshot = {
    id: "prior-1",
    goalId: "goal-learning",
    runId: "run-learning",
    generatedAt: "2026-05-17T00:00:00.000Z",
    sourceLoopIndex: 1,
    eligibleFromIteration: 2,
    generationEventRef: "runtime-event-projection:experience-learning:prior-1",
    sourceCandidateTransitionIds: ["transition-1"],
    scope: { refs: { goalId: "goal-learning", runId: "run-learning" } },
    compatibility: {
      decision: "compatible",
      reasonCode: "matched_exact_refs",
      matchedRefs: ["goalId:goal-learning"],
      missingRefs: [],
    },
    sourceArtifactIds: ["artifact-1"],
    suggestions: [
      learningPriorSuggestion({
        id: "suggestion-task",
        kind: "strategy_preference",
        consumerPhase: "task_generation",
        targetRef: { kind: "dimension", id: "dim-prior" },
        rationale: redactedLearningLabel({
          label: "Use typed prior dimension bias",
          sourceRefs: ["evidence-1", "evidence-2"],
        }),
        sourceArtifactIds: ["artifact-1"],
        experimentPlanIds: ["experiment-plan-1"],
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
    sourceTrustStates: [{ sourceRef: "artifact-1", trust }],
    filterDecision: {
      decision: "activated",
      reasonCodes: ["eligible"],
      evaluatedAt: "2026-05-17T00:00:00.000Z",
    },
    confidence: 0.7,
  };
  return {
    schema_version: "runtime-event-payload/experience-learning/v1",
    event_kind: "prior_generated",
    idempotency_key: "experience-learning:test:prior-1",
    goal_id: "goal-learning",
    run_id: "run-learning",
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
      node_refs: [{ kind: "learning_prior", ref: "prior-1" }],
      edge_refs: [],
    },
    prior_id: "prior-1",
    artifact_ids: ["artifact-1"],
    eligible_from_iteration: 2,
    prior,
  };
}
