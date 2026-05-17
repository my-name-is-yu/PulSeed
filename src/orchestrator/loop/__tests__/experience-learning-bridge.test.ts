import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeDimension, makeGoal } from "../../../../tests/helpers/fixtures.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { RuntimeEvidenceEntrySchema, type RuntimeEvidenceEntry } from "../../../runtime/store/evidence-ledger.js";
import { ExperienceLearningStateStore } from "../../../runtime/store/experience-learning-state-store.js";
import { RuntimeEventLogStore } from "../../../runtime/store/runtime-event-log.js";
import { makeEmptyIterationResult } from "../loop-result-types.js";
import { ExperienceLearningBridge } from "../durable-loop/experience-learning-bridge.js";

describe("ExperienceLearningBridge", () => {
  let tmpDir: string;
  let store: ExperienceLearningStateStore;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-experience-learning-bridge-");
    store = new ExperienceLearningStateStore(path.join(tmpDir, "runtime"), { controlBaseDir: tmpDir });
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("turns exact repeated runtime evidence into an N+1 typed prior without seeding a prior directly", async () => {
    const bridge = new ExperienceLearningBridge(store);
    const goal = makeGoal({
      id: "goal-learning",
      dimensions: [
        makeDimension({ name: "dim-first", label: "First Dimension" }),
        makeDimension({ name: "dim-learning", label: "Learning Dimension" }),
      ],
    });

    const first = await bridge.processIteration({
      goal,
      goalId: goal.id,
      runId: "run-learning",
      loopIndex: 0,
      result: makeFailureResult(goal.id, 0),
      iterationEvidence: [makeEvidence("evidence-1", 0)],
      dryRun: false,
      hasEvidenceLedger: true,
    });
    expect(first.status).toBe("processed");
    expect(await store.listPriorSnapshots(goal.id)).toHaveLength(0);
    const firstEventLog = new RuntimeEventLogStore(path.join(tmpDir, "runtime"), { controlBaseDir: tmpDir });
    try {
      const hypothesisEvents = await firstEventLog.listEvents({ eventType: "experience_learning.hypothesis.transitioned", limit: null });
      expect(hypothesisEvents.length).toBeGreaterThan(0);
      for (const event of hypothesisEvents) {
        expect(event.payload).toEqual(expect.objectContaining({
          event_kind: "hypothesis_transitioned",
          source_refs: expect.objectContaining({
            evidence_refs: ["evidence-1"],
          }),
        }));
        expect((event.payload as { source_refs: { evidence_refs: string[] } }).source_refs.evidence_refs).not.toEqual(
          expect.arrayContaining([expect.stringContaining("experience-frame:")]),
        );
      }
    } finally {
      await firstEventLog.close();
    }

    const second = await bridge.processIteration({
      goal,
      goalId: goal.id,
      runId: "run-learning",
      loopIndex: 1,
      result: makeFailureResult(goal.id, 1),
      iterationEvidence: [makeEvidence("evidence-2", 1)],
      dryRun: false,
      hasEvidenceLedger: true,
    });

    expect(second.runtimeEventIds.length).toBeGreaterThan(5);
    const candidates = await store.listGeneralizationCandidates(goal.id);
    expect(candidates).toEqual([
      expect.objectContaining({
        status: "trial_reuse_ready",
        readinessGateIds: [expect.stringContaining("trial-reuse-gate:")],
      }),
    ]);
    const probeRecords = await store.listMicroProbeRecords(goal.id);
    expect(probeRecords).toEqual([
      expect.objectContaining({
        outcome: "inconclusive",
        usedIndependentSupport: false,
      }),
      expect.objectContaining({
        outcome: "supported",
        supportEvidenceRefs: ["evidence-2"],
        usedIndependentSupport: true,
      }),
    ]);
    const priors = await store.listPriorSnapshots(goal.id);
    expect(priors).toEqual([
      expect.objectContaining({
        sourceLoopIndex: 1,
        eligibleFromIteration: 2,
        sourceArtifactIds: [expect.stringContaining("learning-artifact:")],
      }),
    ]);

    const resolved = await store.resolvePriorForPhase({
      goalId: goal.id,
      runId: "run-learning",
      consumerPhase: "task_generation",
      consumerScope: { refs: { goalId: goal.id, runId: "run-learning" } },
      loopIndex: 2,
      consumerAttemptId: "attempt-n-plus-one",
      consumerDecisionRef: "task-generation:goal-learning:2",
      now: "2026-05-17T01:00:00.000Z",
    });
    expect(resolved?.projection).toEqual(expect.objectContaining({
      phase: "task_generation",
      preferredTargetDimension: "dim-learning",
      requiredExperimentPlanIds: [expect.stringContaining("learning-experiment-plan:")],
      taskBiasRefs: [],
    }));

    const third = await bridge.processIteration({
      goal,
      goalId: goal.id,
      runId: "run-learning",
      loopIndex: 2,
      result: makeFailureResult(goal.id, 2),
      iterationEvidence: [makeEvidence("evidence-3", 2)],
      dryRun: false,
      hasEvidenceLedger: true,
    });
    expect(third.status).toBe("processed");
    const activeHypothesis = (await store.listHypotheses(goal.id)).find((hypothesis) =>
      hypothesis.status === "active" && hypothesis.supportEvidenceRefs.includes("evidence-3")
    );
    expect(activeHypothesis?.supportEvidenceRefs).toEqual(["evidence-2", "evidence-3"]);
    const updatedCandidate = (await store.listGeneralizationCandidates(goal.id))[0];
    expect(updatedCandidate?.supportRefs).toEqual(["evidence-2", "evidence-3"]);
    const eventLog = new RuntimeEventLogStore(path.join(tmpDir, "runtime"), { controlBaseDir: tmpDir });
    try {
      const transitionEvents = await eventLog.listEvents({ eventType: "experience_learning.candidate_transition.recorded", limit: null });
      expect(transitionEvents.map((event) => event.payload)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event_kind: "candidate_transition_recorded",
          transition: expect.objectContaining({
            fromStatus: "trial_reuse_ready",
            toStatus: "trial_reuse_ready",
          }),
        }),
      ]));
    } finally {
      await eventLog.close();
    }
  });

  it("keeps same-trigger candidates separate across dimensions", async () => {
    const bridge = new ExperienceLearningBridge(store);
    const goal = makeGoal({
      id: "goal-learning",
      dimensions: [
        makeDimension({ name: "dim-alpha", label: "Alpha Dimension" }),
        makeDimension({ name: "dim-beta", label: "Beta Dimension" }),
      ],
    });

    await bridge.processIteration({
      goal,
      goalId: goal.id,
      runId: "run-learning",
      loopIndex: 0,
      result: makeFailureResult(goal.id, 0, "dim-alpha"),
      iterationEvidence: [makeEvidence("evidence-alpha-1", 0, "dim-alpha")],
      dryRun: false,
      hasEvidenceLedger: true,
    });
    await bridge.processIteration({
      goal,
      goalId: goal.id,
      runId: "run-learning",
      loopIndex: 1,
      result: makeFailureResult(goal.id, 1, "dim-alpha"),
      iterationEvidence: [makeEvidence("evidence-alpha-2", 1, "dim-alpha")],
      dryRun: false,
      hasEvidenceLedger: true,
    });
    await bridge.processIteration({
      goal,
      goalId: goal.id,
      runId: "run-learning",
      loopIndex: 2,
      result: makeFailureResult(goal.id, 2, "dim-beta"),
      iterationEvidence: [makeEvidence("evidence-beta-1", 2, "dim-beta")],
      dryRun: false,
      hasEvidenceLedger: true,
    });
    await bridge.processIteration({
      goal,
      goalId: goal.id,
      runId: "run-learning",
      loopIndex: 3,
      result: makeFailureResult(goal.id, 3, "dim-beta"),
      iterationEvidence: [makeEvidence("evidence-beta-2", 3, "dim-beta")],
      dryRun: false,
      hasEvidenceLedger: true,
    });

    const candidates = await store.listGeneralizationCandidates(goal.id);
    expect(new Set(candidates.map((candidate) => candidate.id)).size).toBe(candidates.length);
    expect(candidates.map((candidate) => candidate.body.reuseProposal.strategyBiasRefs[0])).toEqual(expect.arrayContaining([
      "dimension:dim-alpha",
      "dimension:dim-beta",
    ]));
  });

  it("does not aggregate unscoped legacy frames into run-scoped learning", async () => {
    const bridge = new ExperienceLearningBridge(store);
    const goal = makeGoal({
      id: "goal-learning",
      dimensions: [makeDimension({ name: "dim-learning", label: "Learning Dimension" })],
    });

    await bridge.processIteration({
      goal,
      goalId: goal.id,
      loopIndex: 0,
      result: makeFailureResult(goal.id, 0),
      iterationEvidence: [makeEvidence("evidence-legacy", 0)],
      dryRun: false,
      hasEvidenceLedger: true,
    });
    await bridge.processIteration({
      goal,
      goalId: goal.id,
      runId: "run-learning",
      loopIndex: 1,
      result: makeFailureResult(goal.id, 1),
      iterationEvidence: [makeEvidence("evidence-run", 1)],
      dryRun: false,
      hasEvidenceLedger: true,
    });

    const runHypotheses = (await store.listHypotheses(goal.id)).filter((hypothesis) =>
      hypothesis.runId === "run-learning"
    );
    expect(runHypotheses.length).toBeGreaterThan(0);
    expect(runHypotheses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "candidate",
        supportEvidenceRefs: [],
      }),
    ]));
    const runCandidates = (await store.listGeneralizationCandidates(goal.id)).filter((candidate) =>
      candidate.runId === "run-learning"
    );
    expect(runCandidates).toEqual([
      expect.objectContaining({
        status: "candidate",
        supportRefs: ["evidence-run"],
      }),
    ]);
  });
});

function makeFailureResult(goalId: string, loopIndex: number, dimensionName = "dim-learning") {
  const result = makeEmptyIterationResult(goalId, loopIndex);
  result.taskResult = {
    task: {
      id: `task-${loopIndex}`,
      goal_id: goalId,
      strategy_id: null,
      target_dimensions: [dimensionName],
      primary_dimension: dimensionName,
      work_description: "Attempt a bounded learning task",
      rationale: "Exercise learning bridge",
      approach: "Use a reversible local task",
      success_criteria: [],
      scope_boundary: { in_scope: ["test"], out_of_scope: [], blast_radius: "low" },
      constraints: [],
      plateau_until: null,
      estimated_duration: null,
      consecutive_failure_count: 0,
      reversibility: "reversible",
      task_category: "normal",
      status: "error",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      timeout_at: null,
      heartbeat_at: null,
      created_at: new Date().toISOString(),
    },
    verificationResult: {
      task_id: `task-${loopIndex}`,
      verdict: "fail",
      confidence: 0.8,
      evidence: [],
      dimension_updates: [],
      timestamp: new Date().toISOString(),
    },
    action: "discard",
  };
  return result;
}

function makeEvidence(id: string, loopIndex: number, dimensionName = "dim-learning"): RuntimeEvidenceEntry {
  return RuntimeEvidenceEntrySchema.parse({
    schema_version: "runtime-evidence-entry-v1",
    id,
    occurred_at: "2026-05-17T00:00:00.000Z",
    kind: "verification",
    scope: {
      goal_id: "goal-learning",
      run_id: "run-learning",
      loop_index: loopIndex,
      phase: "verification",
    },
    verification: {
      verdict: "fail",
      confidence: 0.8,
      summary: `verification failed ${loopIndex}`,
    },
    task: {
      id: `task-${loopIndex}`,
      primary_dimension: dimensionName,
    },
    outcome: "failed",
    raw_refs: [{ kind: "runtime_event", id: `runtime-event:${id}` }],
    summary: `failed evidence ${loopIndex}`,
  });
}
