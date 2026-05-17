import { performance } from "node:perf_hooks";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StateManager } from "../../src/base/state/state-manager.js";
import { createRuntimeDreamSidecarReview } from "../../src/runtime/dream-sidecar-review.js";
import { BackgroundRunLedger } from "../../src/runtime/store/background-run-store.js";
import {
  RuntimeEvidenceLedger,
  type RuntimeEvidenceEntry,
} from "../../src/runtime/store/evidence-ledger.js";
import { RuntimeEvidenceStateStore } from "../../src/runtime/store/runtime-evidence-state-store.js";
import { SupervisorStateStore } from "../../src/runtime/store/supervisor-state-store.js";
import { makeTempDir } from "../helpers/temp-dir.js";

const LONG_RUN_SIZES = [100, 500, 1000] as const;
const SUMMARY_BUDGET_MS = 10_000;

describe("runtime long-run degradation coverage", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let runtimeRoot: string;

  beforeEach(async () => {
    tmpDir = makeTempDir("pulseed-runtime-long-run-");
    runtimeRoot = path.join(tmpDir, "runtime");
    stateManager = new StateManager(tmpDir, undefined, { walEnabled: false });
    await stateManager.init();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("summarizes 100/500/1000 iteration fixtures inside the dedicated slow lane", async () => {
    const startedAt = performance.now();

    for (const size of LONG_RUN_SIZES) {
      const ledger = new RuntimeEvidenceLedger(runtimeRoot);
      const maximizeRunId = `run:long:maximize:${size}`;
      const minimizeRunId = `run:long:minimize:${size}`;

      await writeRunLedger(runtimeRoot, createMetricFixture({
        runId: maximizeRunId,
        size,
        label: "accuracy",
        direction: "maximize",
        valueAt: (index) => (index === 0 ? 0.99 : 0.5 + index / (size * 10)),
      }));
      await writeRunLedger(runtimeRoot, createMetricFixture({
        runId: minimizeRunId,
        size,
        label: "loss",
        direction: "minimize",
        valueAt: (index) => (index === 0 ? 0.01 : 1 - index / (size * 10)),
      }));

      const maximizeSummary = await ledger.rebuildSummaryIndexForRun(maximizeRunId);
      const minimizeSummary = await ledger.rebuildSummaryIndexForRun(minimizeRunId);

      expect(maximizeSummary.total_entries).toBe(size);
      expect(minimizeSummary.total_entries).toBe(size);
      expect(maximizeSummary.best_evidence?.id).toBe(`${maximizeRunId}:entry:0`);
      expect(minimizeSummary.best_evidence?.id).toBe(`${minimizeRunId}:entry:0`);
      expect(maximizeSummary.metric_trends[0]?.metric_key).toBe("accuracy");
      expect(minimizeSummary.metric_trends[0]?.metric_key).toBe("loss");
    }

    expect(performance.now() - startedAt).toBeLessThan(SUMMARY_BUDGET_MS);
  });

  it("keeps old important evidence and Soil memory selectable across 100/500/1000 iterations", async () => {
    for (const size of LONG_RUN_SIZES) {
      const runId = `run:long:memory-survival:${size}`;
      await seedActiveRun(runId, size);
      const ledger = new RuntimeEvidenceLedger(runtimeRoot);
      const summary = await writeIndexedRunLedger(runtimeRoot, ledger, runId, createMemorySurvivalFixture(runId, size));

      const review = await createRuntimeDreamSidecarReview({ stateManager, runId });
      const memoryRefs = summary.dream_checkpoints.flatMap((checkpoint) =>
        checkpoint.relevant_memories.map((memory) => memory.ref)
      );

      expect(summary.total_entries).toBe(size);
      expect(summary.dream_checkpoints.length).toBeGreaterThanOrEqual(1);
      expect(memoryRefs).toContain("soil://long-run/old-important");
      expect(review.status_summary).toContain(`${size} evidence entries`);
      expect(review.best_evidence?.id).toBe(`${runId}:entry:0`);
      expect(review.advisory_memories[0]).toMatchObject({
        ref: "soil://long-run/old-important",
        authority: "advisory_only",
        ranking_trace: {
          decision: "admitted",
        },
      });
      expect(review.suggested_next_moves[0]).toMatchObject({
        title: "Reuse old high-signal playbook",
        source: "dream_checkpoint",
      });
    }
  });

  it("summarizes repeated failed lineages without letting them dominate sidecar output", async () => {
    const runId = "run:long:failed-lineages";
    await seedActiveRun(runId, 1000);
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    const summary = await writeIndexedRunLedger(runtimeRoot, ledger, runId, createFailedLineageFixture(runId, 1000));

    const review = await createRuntimeDreamSidecarReview({ stateManager, runId });

    expect(summary.total_entries).toBe(1000);
    expect(summary.failed_lineages[0]).toMatchObject({
      strategy_family: "threshold_sweep",
      count: 60,
    });
    expect(summary.failed_lineages[0]?.evidence_entry_ids).toHaveLength(5);
    expect(summary.failed_lineages.length).toBeLessThanOrEqual(10);
    expect(review.known_gaps.filter((gap) => gap.includes("threshold_sweep"))).toHaveLength(1);
    expect(review.suggested_next_moves).not.toContainEqual(expect.objectContaining({
      title: "threshold_sweep retry",
    }));
    expect(review.suggested_next_moves).toContainEqual(expect.objectContaining({
      title: "Feature ablation",
      source: "dream_checkpoint",
    }));
  });

  async function seedActiveRun(runId: string, iterations: number): Promise<void> {
    await new SupervisorStateStore(runtimeRoot).save({
      workers: [{
        workerId: "long-run-worker",
        goalId: "goal-long-run",
        startedAt: Date.parse("2026-04-30T00:00:00.000Z"),
        iterations,
      }],
      crashCounts: {},
      suspendedGoals: [],
      updatedAt: Date.parse("2026-04-30T08:00:00.000Z"),
    });
    await new BackgroundRunLedger(runtimeRoot).create({
      id: runId,
      kind: "coreloop_run",
      notify_policy: "silent",
      reply_target_source: "none",
      child_session_id: "session:coreloop:long-run-worker",
      title: "Long-run target",
      workspace: "/repo",
      status: "running",
      started_at: "2026-04-30T00:00:00.000Z",
      updated_at: "2026-04-30T08:00:00.000Z",
      summary: "Active long-run target.",
      source_refs: [{
        kind: "supervisor_state",
        id: null,
        path: null,
        relative_path: "runtime/supervisor-state.json",
        updated_at: "2026-04-30T08:00:00.000Z",
      }],
    });
  }
});

interface MetricFixtureInput {
  runId: string;
  size: number;
  label: string;
  direction: "maximize" | "minimize";
  valueAt(index: number): number;
}

function createMetricFixture(input: MetricFixtureInput): RuntimeEvidenceEntry[] {
  return Array.from({ length: input.size }, (_, index) => evidenceEntry({
    id: `${input.runId}:entry:${index}`,
    occurred_at: timestampForIndex(index),
    kind: "metric",
    scope: { run_id: input.runId, loop_index: index },
    metrics: [{
      label: input.label,
      value: input.valueAt(index),
      direction: input.direction,
      confidence: index === 0 ? 0.95 : 0.7,
      observed_at: timestampForIndex(index),
    }],
    summary: `${input.label} iteration ${index}.`,
    outcome: index === 0 ? "improved" : "continued",
  }));
}

function createMemorySurvivalFixture(runId: string, size: number): RuntimeEvidenceEntry[] {
  const entries = createMetricFixture({
    runId,
    size,
    label: "loss",
    direction: "minimize",
    valueAt: (index) => (index === 0 ? 0.02 : 0.5 + index / (size * 20)),
  });
  entries[0] = evidenceEntry({
    ...entries[0],
    kind: "dream_checkpoint",
    dream_checkpoints: [{
      trigger: "breakthrough",
      summary: "Old checkpoint preserved the best evidence and memory.",
      current_goal: "Improve long-run benchmark",
      active_dimensions: ["loss"],
      best_evidence_so_far: `${runId}:entry:0`,
      recent_strategy_families: ["old_high_signal_playbook"],
      exhausted: [],
      promising: ["Reuse old high-signal playbook"],
      relevant_memories: [{
        source_type: "soil",
        ref: "soil://long-run/old-important",
        summary: "Old but reliable Soil memory contributed to a prior long-run success.",
        authority: "advisory_only",
        relevance_score: 0.98,
        source_reliability: 0.96,
        recency_score: 0.05,
        prior_success_contribution: 1,
        retrieval: { kind: "route_hit", score: 0.98, confidence: 0.96 },
      }],
      active_hypotheses: [],
      rejected_approaches: [],
      next_strategy_candidates: [{
        title: "Reuse old high-signal playbook",
        rationale: "Prior high-reliability Soil memory still explains the strongest loss result.",
        target_dimensions: ["loss"],
      }],
      guidance: "Keep the old high-signal memory in context despite 999 later iterations.",
      uncertainty: [],
      context_authority: "advisory_only",
      confidence: 0.94,
    }],
    raw_refs: [{ kind: "dream_soil_memory", id: "soil://long-run/old-important" }],
    summary: "Old best evidence and memory checkpoint.",
    outcome: "improved",
  });
  for (let index = 100; index < size; index += 100) {
    entries[index] = evidenceEntry({
      ...entries[index],
      kind: "dream_checkpoint",
      dream_checkpoints: [{
        trigger: "iteration",
        summary: `Recent low-signal checkpoint ${index}.`,
        current_goal: "Improve long-run benchmark",
        active_dimensions: ["loss"],
        recent_strategy_families: ["recent_low_signal"],
        exhausted: [],
        promising: [],
        relevant_memories: [{
          source_type: "runtime_evidence",
          ref: `checkpoint://recent-low/${index}`,
          summary: "Recent but weak checkpoint context.",
          authority: "advisory_only",
          relevance_score: 0.2,
          source_reliability: 0.35,
          recency_score: 1,
          prior_success_contribution: 0,
          retrieval: { kind: "checkpoint", confidence: 0.35 },
        }],
        active_hypotheses: [],
        rejected_approaches: [],
        next_strategy_candidates: [{
          title: `Recent low-signal continuation ${index}`,
          rationale: "Recency alone should not outrank the old successful memory.",
          target_dimensions: ["loss"],
        }],
        guidance: "Keep monitoring.",
        uncertainty: [],
        context_authority: "advisory_only",
        confidence: 0.5,
      }],
    });
  }
  return entries;
}

function createFailedLineageFixture(runId: string, size: number): RuntimeEvidenceEntry[] {
  const entries = createMetricFixture({
    runId,
    size,
    label: "balanced_accuracy",
    direction: "maximize",
    valueAt: (index) => 0.6 + index / (size * 100),
  });
  for (let index = 0; index < 60; index += 1) {
    entries[index] = evidenceEntry({
      id: `${runId}:threshold-failure:${index}`,
      occurred_at: timestampForIndex(index),
      kind: "failure",
      scope: { run_id: runId, task_id: `task-threshold-${index}`, loop_index: index },
      strategy: "threshold_sweep",
      hypothesis: "Repeating threshold sweep improves balanced accuracy",
      task: {
        id: `task-threshold-${index}`,
        action: "threshold_sweep",
        primary_dimension: "balanced_accuracy",
      },
      verification: { verdict: "fail", summary: "Balanced accuracy stayed inside noise." },
      result: { status: "failed", summary: "Threshold sweep remained inside noise." },
      summary: "Threshold sweep failed.",
      outcome: "failed",
    });
  }
  for (let index = 60; index < 75; index += 1) {
    entries[index] = evidenceEntry({
      id: `${runId}:divergent-failure:${index}`,
      occurred_at: timestampForIndex(index),
      kind: "failure",
      scope: { run_id: runId, task_id: `task-divergent-${index}`, loop_index: index },
      strategy: `divergent_family_${index}`,
      hypothesis: `Divergent hypothesis ${index}`,
      task: {
        id: `task-divergent-${index}`,
        action: `divergent_action_${index}`,
        primary_dimension: "balanced_accuracy",
      },
      verification: { verdict: "fail", summary: "Divergent candidate failed independently." },
      summary: "Divergent candidate failed independently.",
      outcome: "failed",
    });
  }
  entries[999] = evidenceEntry({
    ...entries[999],
    kind: "dream_checkpoint",
    dream_checkpoints: [{
      trigger: "plateau",
      summary: "Long-run checkpoint avoided repeated failed lineage.",
      current_goal: "Improve long-run benchmark",
      active_dimensions: ["balanced_accuracy"],
      recent_strategy_families: ["threshold_sweep"],
      exhausted: ["threshold_sweep"],
      promising: ["feature_ablation"],
      relevant_memories: [],
      active_hypotheses: [],
      rejected_approaches: [],
      next_strategy_candidates: [
        {
          title: "threshold_sweep retry",
          rationale: "Try threshold_sweep again.",
          target_dimensions: ["balanced_accuracy"],
          failed_lineage_warning: {
            fingerprint: "threshold sweep|repeating threshold sweep improves balanced accuracy|balanced accuracy|threshold sweep",
            count: 60,
            reason: "Synthetic fixture marks repeated failed lineage explicitly.",
          },
        },
        {
          title: "Feature ablation",
          rationale: "Test a different mechanism after repeated threshold failures.",
          target_dimensions: ["balanced_accuracy"],
        },
      ],
      guidance: "Do not let repeated failed lineages dominate the next move.",
      uncertainty: [],
      context_authority: "advisory_only",
      confidence: 0.82,
    }],
    summary: "Long-run plateau checkpoint.",
    outcome: "continued",
  });
  return entries;
}

async function writeRunLedger(
  runtimeRoot: string,
  entries: RuntimeEvidenceEntry[]
): Promise<void> {
  const store = new RuntimeEvidenceStateStore(runtimeRoot);
  for (const entry of entries) {
    await store.append(entry);
  }
}

async function writeIndexedRunLedger(
  runtimeRoot: string,
  ledger: RuntimeEvidenceLedger,
  runId: string,
  entries: RuntimeEvidenceEntry[]
) {
  await writeRunLedger(runtimeRoot, entries);
  return ledger.rebuildSummaryIndexForRun(runId);
}

function evidenceEntry(
  input: Partial<RuntimeEvidenceEntry> & Pick<RuntimeEvidenceEntry, "id" | "occurred_at" | "kind" | "scope">
): RuntimeEvidenceEntry {
  return {
    schema_version: "runtime-evidence-entry-v1",
    metrics: [],
    evaluators: [],
    research: [],
    dream_checkpoints: [],
    divergent_exploration: [],
    artifacts: [],
    raw_refs: [],
    ...input,
  };
}

function timestampForIndex(index: number): string {
  return new Date(Date.UTC(2026, 3, 30, 0, 0, index)).toISOString();
}
