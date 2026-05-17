import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeDimension, makeGoal } from "../../../../tests/helpers/fixtures.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { RuntimeEvidenceEntrySchema, type RuntimeEvidenceEntry } from "../../../runtime/store/evidence-ledger.js";
import { ExperienceLearningStateStore } from "../../../runtime/store/experience-learning-state-store.js";
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
