import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StateManager } from "../../base/state/state-manager.js";
import {
  createRuntimeDreamSidecarReview,
} from "../dream-sidecar-review.js";
import { BackgroundRunLedger } from "../store/background-run-store.js";
import { RuntimeEvidenceLedger } from "../store/evidence-ledger.js";
import { SupervisorStateStore } from "../store/supervisor-state-store.js";
import { makeTempDir } from "../../../tests/helpers/temp-dir.js";

describe("Runtime Dream sidecar review", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(async () => {
    tmpDir = makeTempDir("pulseed-dream-sidecar-");
    stateManager = new StateManager(tmpDir, undefined, { walEnabled: false });
    await stateManager.init();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("attaches to an active background run and returns a read-only review shape", async () => {
    await seedActiveRun("run:coreloop:sidecar");
    const ledger = new RuntimeEvidenceLedger(path.join(tmpDir, "runtime"));
    await ledger.append({
      kind: "metric",
      scope: { run_id: "run:coreloop:sidecar", loop_index: 0 },
      metrics: [{
        label: "accuracy",
        value: 0.72,
        direction: "maximize",
        observed_at: "2026-04-30T00:00:00.000Z",
      }],
      summary: "Initial accuracy.",
      outcome: "continued",
    });
    await ledger.append({
      kind: "dream_checkpoint",
      scope: { run_id: "run:coreloop:sidecar", loop_index: 3, phase: "dream_review_checkpoint" },
      metrics: [{
        label: "accuracy",
        value: 0.91,
        direction: "maximize",
        observed_at: "2026-04-30T00:10:00.000Z",
      }],
      dream_checkpoints: [{
        trigger: "breakthrough",
        summary: "Dream checkpoint found a metric breakthrough.",
        current_goal: "Improve benchmark",
        active_dimensions: ["accuracy"],
        recent_strategy_families: ["bounded ablation"],
        exhausted: ["repeat baseline"],
        promising: ["lock current approach"],
        relevant_memories: [{
          source_type: "soil",
          ref: "soil://run/sidecar",
          summary: "Prior run preserved a breakthrough before finalization.",
          authority: "advisory_only",
        }],
        active_hypotheses: [],
        rejected_approaches: [],
        next_strategy_candidates: [{
          title: "Lock current approach",
          rationale: "Confirm the breakthrough is stable before broadening.",
          target_dimensions: ["accuracy"],
        }],
        guidance: "Preserve the breakthrough before generating broader tasks.",
        uncertainty: [],
        context_authority: "advisory_only",
        confidence: 0.88,
      }],
      raw_refs: [{ kind: "dream_soil_memory", id: "soil://run/sidecar" }],
      summary: "Breakthrough checkpoint saved.",
      outcome: "improved",
    });

    const review = await createRuntimeDreamSidecarReview({
      stateManager,
      runId: "run:coreloop:sidecar",
    });

    expect(review).toMatchObject({
      schema_version: "runtime-dream-sidecar-review-v1",
      attach_status: "active",
      read_only_enforced: true,
      run: { id: "run:coreloop:sidecar", status: "running" },
      runtime_session: { id: "session:coreloop:sidecar-worker", attachable: true },
      trend_state: { state: "breakthrough", metric_key: "accuracy" },
      best_evidence: { kind: "dream_checkpoint", outcome: "improved" },
      guidance_injection: { status: "not_requested", approval_required: false },
    });
    expect(review.strategy_families).toContain("bounded ablation");
    expect(review.advisory_memories).toContainEqual(expect.objectContaining({
      ref: "soil://run/sidecar",
      authority: "advisory_only",
    }));
    expect(review.suggested_next_moves).toContainEqual(expect.objectContaining({
      title: "Lock current approach",
      source: "dream_checkpoint",
    }));
    expect(review.evidence_refs).toContainEqual(expect.objectContaining({
      kind: "evidence_ledger",
      id: "run:coreloop:sidecar",
    }));
  });

  it("does not surface Dream checkpoint moves or memories backed by retracted memory refs", async () => {
    await seedActiveRun("run:coreloop:retracted-memory");
    const ledger = new RuntimeEvidenceLedger(path.join(tmpDir, "runtime"));
    await ledger.append({
      id: "checkpoint-retracted-memory",
      occurred_at: "2026-05-02T00:00:00.000Z",
      kind: "dream_checkpoint",
      scope: { run_id: "run:coreloop:retracted-memory", loop_index: 1, phase: "dream_review_checkpoint" },
      dream_checkpoints: [{
        trigger: "iteration",
        summary: "Checkpoint relied on a stale memory ref.",
        current_goal: "Avoid stale memory",
        active_dimensions: ["accuracy"],
        recent_strategy_families: ["stale-memory-plan"],
        exhausted: [],
        promising: ["Use stale memory plan"],
        relevant_memories: [{
          source_type: "soil",
          ref: "soil://memory/retracted",
          summary: "Retracted memory.",
          authority: "advisory_only",
          relevance_score: 0.95,
          source_reliability: 0.95,
        }, {
          source_type: "soil",
          ref: "soil://memory/active",
          summary: "Active memory.",
          authority: "advisory_only",
          relevance_score: 0.8,
          source_reliability: 0.8,
        }],
        active_hypotheses: [],
        rejected_approaches: [],
        next_strategy_candidates: [{
          title: "Use stale memory plan",
          rationale: "This move is only justified by the retracted memory.",
          target_dimensions: ["accuracy"],
        }],
        guidance: "Follow stale memory.",
        uncertainty: [],
        context_authority: "advisory_only",
        confidence: 0.9,
      }],
      raw_refs: [{ kind: "dream_soil_memory", id: "soil://memory/retracted" }],
      summary: "Checkpoint with retracted memory.",
      outcome: "continued",
    });
    await ledger.appendCorrection({
      correction_id: "corr-sidecar-retracted-memory",
      scope: { run_id: "run:coreloop:retracted-memory" },
      target_ref: {
        kind: "dream_checkpoint",
        id: "soil://memory/retracted",
        scope: { run_id: "run:coreloop:retracted-memory" },
      },
      correction_kind: "retracted",
      replacement_ref: null,
      actor: "dream_lint",
      reason: "Memory ref was retracted before sidecar review.",
      created_at: "2026-05-02T00:01:00.000Z",
      provenance: { source: "dream_lint", evidence_ref: "checkpoint-retracted-memory", confidence: 1 },
    });

    const review = await createRuntimeDreamSidecarReview({
      stateManager,
      runId: "run:coreloop:retracted-memory",
    });

    expect(review.advisory_memories).not.toContainEqual(expect.objectContaining({
      ref: "soil://memory/retracted",
    }));
    expect(review.advisory_memories).toContainEqual(expect.objectContaining({
      ref: "soil://memory/active",
    }));
    expect(review.suggested_next_moves).not.toContainEqual(expect.objectContaining({
      title: "Use stale memory plan",
      source: "dream_checkpoint",
    }));
  });

  it("does not blindly re-suggest a rejected Dream approach", async () => {
    await seedActiveRun("run:coreloop:rejected");
    const ledger = new RuntimeEvidenceLedger(path.join(tmpDir, "runtime"));
    await ledger.append({
      kind: "dream_checkpoint",
      scope: { run_id: "run:coreloop:rejected", loop_index: 4, phase: "dream_review_checkpoint" },
      dream_checkpoints: [{
        trigger: "plateau",
        summary: "Dream checkpoint rejected the repeated sweep.",
        current_goal: "Improve benchmark",
        active_dimensions: ["balanced_accuracy"],
        recent_strategy_families: ["threshold_sweep"],
        exhausted: ["Repeat threshold sweep"],
        promising: ["feature ablation"],
        relevant_memories: [],
        active_hypotheses: [{
          hypothesis: "Feature ablation may expose a stronger path.",
          supporting_evidence_ref: "metric:balanced_accuracy",
          target_metric_or_dimension: "balanced_accuracy",
          expected_next_observation: "Ablation moves balanced accuracy.",
          status: "active",
        }],
        rejected_approaches: [{
          approach: "Repeat threshold sweep",
          rejection_reason: "Three sweeps stayed within metric noise.",
          candidate_ref: "candidate:threshold-sweep-repeat",
          evidence_ref: "lineage:threshold-sweep",
          revisit_condition: "new calibration evidence appears",
          confidence: 0.9,
        }],
        next_strategy_candidates: [
          {
            candidate_ref: "candidate:threshold-sweep-repeat",
            title: "Repeat threshold sweep",
            rationale: "Try the same exploration again.",
            target_dimensions: ["balanced_accuracy"],
          },
          {
            title: "Feature ablation",
            rationale: "Test a different mechanism for balanced_accuracy.",
            target_dimensions: ["balanced_accuracy"],
          },
        ],
        guidance: "Avoid repeating threshold sweeps.",
        uncertainty: [],
        context_authority: "advisory_only",
        confidence: 0.88,
      }],
      summary: "Plateau checkpoint saved.",
      outcome: "continued",
    });

    const review = await createRuntimeDreamSidecarReview({
      stateManager,
      runId: "run:coreloop:rejected",
    });

    expect(review.known_gaps).toContainEqual(expect.stringContaining("Rejected approach: Repeat threshold sweep"));
    expect(review.suggested_next_moves).not.toContainEqual(expect.objectContaining({
      title: "Repeat threshold sweep",
    }));
    expect(review.suggested_next_moves).toContainEqual(expect.objectContaining({
      title: "Feature ablation",
      source: "dream_checkpoint",
    }));
  });

  it("ranks advisory memories across checkpoints and exposes ranking traces", async () => {
    await seedActiveRun("run:coreloop:memory-rank");
    const ledger = new RuntimeEvidenceLedger(path.join(tmpDir, "runtime"));
    await ledger.append({
      id: "old-high-memory",
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "dream_checkpoint",
      scope: { run_id: "run:coreloop:memory-rank", loop_index: 1, phase: "dream_review_checkpoint" },
      dream_checkpoints: [{
        trigger: "plateau",
        summary: "Older checkpoint with strong Soil memory.",
        current_goal: "Improve benchmark",
        active_dimensions: ["balanced_accuracy"],
        recent_strategy_families: [],
        exhausted: [],
        promising: [],
        relevant_memories: [{
          source_type: "soil",
          ref: "soil://old-high",
          summary: "Older high-confidence route memory with prior success.",
          relevance_score: 0.92,
          source_reliability: 0.95,
          recency_score: 0.1,
          prior_success_contribution: 0.9,
          retrieval: { kind: "route_hit", score: 0.92, confidence: 0.95 },
          ranking_trace: {
            score: 0.9,
            decision: "rejected",
            reason: "Rejected by checkpoint memory admission cap 1.",
          },
          authority: "advisory_only",
        }],
        active_hypotheses: [],
        rejected_approaches: [],
        next_strategy_candidates: [{
          title: "Use old high memory",
          rationale: "Follow the high-confidence Soil route memory.",
          target_dimensions: ["balanced_accuracy"],
        }],
        guidance: "Preserve useful memory.",
        uncertainty: [],
        context_authority: "advisory_only",
        confidence: 0.8,
      }],
      summary: "Old memory checkpoint saved.",
    });
    await ledger.append({
      id: "recent-low-memory",
      occurred_at: "2026-04-30T00:10:00.000Z",
      kind: "dream_checkpoint",
      scope: { run_id: "run:coreloop:memory-rank", loop_index: 2, phase: "dream_review_checkpoint" },
      dream_checkpoints: [{
        trigger: "iteration",
        summary: "Recent checkpoint with weak memory.",
        current_goal: "Improve benchmark",
        active_dimensions: ["balanced_accuracy"],
        recent_strategy_families: [],
        exhausted: [],
        promising: [],
        relevant_memories: [{
          source_type: "runtime_evidence",
          ref: "checkpoint://recent-low",
          summary: "Recent but weak checkpoint memory.",
          relevance_score: 0.25,
          source_reliability: 0.4,
          recency_score: 1,
          retrieval: { kind: "checkpoint", confidence: 0.4 },
          authority: "advisory_only",
        }],
        active_hypotheses: [],
        rejected_approaches: [],
        next_strategy_candidates: [{
          title: "Use recent low memory",
          rationale: "Follow the recent checkpoint memory.",
          target_dimensions: ["balanced_accuracy"],
        }],
        guidance: "Preserve recency.",
        uncertainty: [],
        context_authority: "advisory_only",
        confidence: 0.8,
      }],
      summary: "Recent memory checkpoint saved.",
    });

    const review = await createRuntimeDreamSidecarReview({
      stateManager,
      runId: "run:coreloop:memory-rank",
    });

    expect(review.advisory_memories.map((memory) => memory.ref).slice(0, 2)).toEqual([
      "soil://old-high",
      "checkpoint://recent-low",
    ]);
    expect(review.advisory_memories[0]).toMatchObject({
      authority: "advisory_only",
      ranking_trace: {
        decision: "admitted",
        reason: expect.stringContaining("checkpoint_decision=rejected"),
      },
    });
    expect(review.suggested_next_moves[0]).toMatchObject({
      title: "Use old high memory",
      source: "dream_checkpoint",
    });
    expect(review.advisory_memories[0]?.ranking_trace?.reason).not.toContain("Rejected by checkpoint memory admission cap 1.");
    expect(review.advisory_memories[0]).toMatchObject({
      authority: "advisory_only",
      ranking_trace: {
        decision: "admitted",
        reason: expect.stringContaining("kind=route_hit"),
      },
    });
  });

  it("uses usage outcomes when sidecar re-ranks advisory memories", async () => {
    await seedActiveRun("run:coreloop:sidecar-usage-rank");
    const ledger = new RuntimeEvidenceLedger(path.join(tmpDir, "runtime"));
    await ledger.append({
      id: "usage-aware-memories",
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "dream_checkpoint",
      scope: { run_id: "run:coreloop:sidecar-usage-rank", loop_index: 1, phase: "dream_review_checkpoint" },
      dream_checkpoints: [{
        trigger: "plateau",
        summary: "Checkpoint with usage-aware Soil memories.",
        current_goal: "Improve benchmark",
        active_dimensions: ["balanced_accuracy"],
        recent_strategy_families: [],
        exhausted: [],
        promising: [],
        relevant_memories: [
          {
            source_type: "soil",
            ref: "soil://validated",
            summary: "Validated memory with slightly lower base score.",
            relevance_score: 0.7,
            source_reliability: 0.75,
            recency_score: 0.5,
            retrieval: { kind: "route_hit", score: 0.7, confidence: 0.75 },
            usage_stats: {
              last_used_at: "2026-05-02T00:00:00.000Z",
              use_count: 5,
              validated_count: 5,
              negative_outcome_count: 0,
            },
            authority: "advisory_only",
          },
          {
            source_type: "soil",
            ref: "soil://negative",
            summary: "Negative memory with higher base score.",
            relevance_score: 0.75,
            source_reliability: 0.78,
            recency_score: 0.5,
            retrieval: { kind: "route_hit", score: 0.75, confidence: 0.78 },
            usage_stats: {
              last_used_at: "2026-05-02T00:00:00.000Z",
              use_count: 9,
              validated_count: 0,
              negative_outcome_count: 5,
            },
            authority: "advisory_only",
          },
        ],
        active_hypotheses: [],
        rejected_approaches: [],
        next_strategy_candidates: [],
        guidance: "Prefer validated memory.",
        uncertainty: [],
        context_authority: "advisory_only",
        confidence: 0.8,
      }],
      summary: "Usage-aware checkpoint saved.",
    });

    const review = await createRuntimeDreamSidecarReview({
      stateManager,
      runId: "run:coreloop:sidecar-usage-rank",
    });

    expect(review.advisory_memories.map((memory) => memory.ref).slice(0, 2)).toEqual([
      "soil://validated",
      "soil://negative",
    ]);
    expect(review.advisory_memories[0]).toMatchObject({
      authority: "advisory_only",
      usage_stats: expect.objectContaining({
        validated_count: 5,
        negative_outcome_count: 0,
      }),
      ranking_trace: {
        decision: "admitted",
        reason: expect.stringContaining("usage_outcome=0.0500"),
      },
    });
  });

  it("summarizes repeated failed lineages and avoids suggesting them without retry evidence", async () => {
    await seedActiveRun("run:coreloop:failed-lineage");
    const ledger = new RuntimeEvidenceLedger(path.join(tmpDir, "runtime"));
    for (let index = 0; index < 3; index += 1) {
      await ledger.append({
        id: `failed-threshold-${index + 1}`,
        occurred_at: `2026-04-30T00:0${index}:00.000Z`,
        kind: "failure",
        scope: { run_id: "run:coreloop:failed-lineage", task_id: `task-threshold-${index + 1}` },
        strategy: "threshold_sweep",
        hypothesis: "Repeat threshold sweep improves balanced accuracy",
        task: {
          id: `task-threshold-${index + 1}`,
          action: "threshold_sweep",
          primary_dimension: "balanced_accuracy",
        },
        verification: { verdict: "fail", summary: "Balanced accuracy stayed inside noise." },
        summary: "Threshold sweep failed.",
        outcome: "failed",
      });
    }
    await ledger.append({
      kind: "dream_checkpoint",
      scope: { run_id: "run:coreloop:failed-lineage", loop_index: 4, phase: "dream_review_checkpoint" },
      dream_checkpoints: [{
        trigger: "plateau",
        summary: "Dream checkpoint proposed next moves.",
        current_goal: "Improve benchmark",
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
            rationale: "Try the same threshold_sweep again.",
            target_dimensions: ["balanced_accuracy"],
            failed_lineage_warning: {
              fingerprint: "threshold sweep|balanced accuracy|threshold sweep",
              count: 3,
              reason: "Repeated failed lineage.",
            },
          },
          {
            title: "Feature ablation",
            rationale: "Test a different mechanism.",
            target_dimensions: ["balanced_accuracy"],
          },
        ],
        guidance: "Avoid repeated failed lineages.",
        uncertainty: [],
        context_authority: "advisory_only",
        confidence: 0.88,
      }],
      summary: "Plateau checkpoint saved.",
      outcome: "continued",
    });

    const review = await createRuntimeDreamSidecarReview({
      stateManager,
      runId: "run:coreloop:failed-lineage",
    });

    expect(review.known_gaps).toContainEqual(expect.stringContaining("Repeated failed lineage: threshold_sweep (count=3)"));
    expect(review.suggested_next_moves).not.toContainEqual(expect.objectContaining({
      title: "threshold_sweep retry",
    }));
    expect(review.suggested_next_moves).toContainEqual(expect.objectContaining({
      title: "Feature ablation",
      source: "dream_checkpoint",
    }));
  });

  it("can promote near-miss follow-ups without retrying a repeated failed lineage", async () => {
    await seedActiveRun("run:coreloop:near-miss-follow-up");
    const ledger = new RuntimeEvidenceLedger(path.join(tmpDir, "runtime"));
    for (let index = 0; index < 3; index += 1) {
      await ledger.append({
        id: `failed-threshold-near-miss-${index + 1}`,
        occurred_at: `2026-04-30T00:0${index}:00.000Z`,
        kind: "failure",
        scope: { run_id: "run:coreloop:near-miss-follow-up", task_id: `task-threshold-${index + 1}` },
        strategy: "threshold_sweep",
        hypothesis: "Repeat threshold sweep improves balanced accuracy",
        task: {
          id: `task-threshold-${index + 1}`,
          action: "threshold_sweep",
          primary_dimension: "balanced_accuracy",
        },
        verification: { verdict: "fail", summary: "Balanced accuracy stayed inside noise." },
        summary: "Threshold sweep failed.",
        outcome: "failed",
      });
    }
    await ledger.append({
      id: "near-miss-follow-up-snapshot",
      occurred_at: "2026-04-30T00:10:00.000Z",
      kind: "metric",
      scope: { run_id: "run:coreloop:near-miss-follow-up", loop_index: 4 },
      candidates: [
        {
          candidate_id: "raw-best-threshold",
          lineage: {
            strategy_family: "threshold_sweep",
            feature_lineage: ["base"],
            model_lineage: ["catboost"],
            config_lineage: ["manual-threshold"],
            seed_lineage: ["seed-42"],
            fold_lineage: ["5-fold"],
            postprocess_lineage: ["threshold-0.48"],
          },
          metrics: [{ label: "balanced_accuracy", value: 0.97042, direction: "maximize", confidence: 0.78 }],
          artifacts: [],
          similarity: [],
          disposition: "promoted",
        },
        {
          candidate_id: "threshold-near-miss",
          lineage: {
            strategy_family: "threshold_sweep",
            feature_lineage: ["base"],
            model_lineage: ["catboost"],
            config_lineage: ["manual-threshold"],
            seed_lineage: ["seed-99"],
            fold_lineage: ["5-fold"],
            postprocess_lineage: ["threshold-0.49"],
          },
          metrics: [{ label: "balanced_accuracy", value: 0.9702, direction: "maximize", confidence: 0.8 }],
          artifacts: [],
          similarity: [{ candidate_id: "raw-best-threshold", similarity: 0.91, signal: "declared" }],
          near_miss: {
            status: "retained",
            reason_to_keep: ["close_to_best"],
            weak_dimensions: [],
            complementary_candidate_ids: [],
            follow_up: {
              title: "Run close near-miss follow-up",
              rationale: "Retry the close-to-best candidate with a wider local validation pass.",
              target_dimensions: ["balanced_accuracy"],
            },
            evidence_refs: ["threshold sweep|repeat threshold sweep improves balanced accuracy|balanced accuracy|threshold sweep"],
            summary: "Close but from a repeatedly failed lineage.",
          },
          disposition: "retained",
        },
        {
          candidate_id: "feature-ablation-near-miss",
          lineage: {
            strategy_family: "feature_ablation",
            feature_lineage: ["remove-leaky-counts"],
            model_lineage: ["catboost"],
            config_lineage: ["smoke"],
            seed_lineage: ["seed-314"],
            fold_lineage: ["5-fold"],
            postprocess_lineage: [],
          },
          metrics: [{ label: "balanced_accuracy", value: 0.9699, direction: "maximize", confidence: 0.88 }],
          artifacts: [],
          similarity: [{ candidate_id: "raw-best-threshold", similarity: 0.35, signal: "declared" }],
          robustness: {
            stability_score: 0.86,
            risk_penalty: 0.02,
            evidence_confidence: 0.88,
            weak_dimensions: ["minority_class_recall"],
            provenance_refs: ["runs/feature-ablation/per-class.json"],
            summary: "Near miss improves minority class recall through a different mechanism.",
          },
          near_miss: {
            status: "retained",
            reason_to_keep: ["weak_dimension_improvement", "novelty"],
            weak_dimensions: ["minority_class_recall"],
            complementary_candidate_ids: [],
            follow_up: {
              title: "Feature ablation larger follow-up",
              rationale: "Promote the distinct feature-ablation near miss that improved the weak class.",
              target_dimensions: ["minority_class_recall", "balanced_accuracy"],
            },
            evidence_refs: ["runs/feature-ablation/per-class.json"],
            summary: "Promising non-winner from a distinct strategy family.",
          },
          disposition: "retained",
        },
      ],
      summary: "Near-miss snapshot after plateau.",
      outcome: "continued",
    });

    const review = await createRuntimeDreamSidecarReview({
      stateManager,
      runId: "run:coreloop:near-miss-follow-up",
    });

    expect(review.status_summary).toContain("promising non-winners");
    expect(review.promising_non_winners).toContainEqual(expect.objectContaining({
      candidate_id: "feature-ablation-near-miss",
      reason_to_keep: expect.arrayContaining(["weak_dimension_improvement", "novelty"]),
      follow_up_title: "Feature ablation larger follow-up",
    }));
    expect(review.suggested_next_moves).not.toContainEqual(expect.objectContaining({
      title: "Run close near-miss follow-up",
    }));
    expect(review.suggested_next_moves).toContainEqual(expect.objectContaining({
      title: "Feature ablation larger follow-up",
      source: "near_miss",
    }));
  });

  it("rejects a missing background run", async () => {
    await expect(createRuntimeDreamSidecarReview({
      stateManager,
      runId: "run:missing",
    })).rejects.toMatchObject({
      code: "missing_run",
    });
  });

  it("rejects a stale non-active background run", async () => {
    await seedActiveRun("run:coreloop:stale");
    await new BackgroundRunLedger(path.join(tmpDir, "runtime")).terminal("run:coreloop:stale", {
      status: "succeeded",
      completed_at: "2026-04-30T01:00:00.000Z",
      summary: "Done.",
    });

    await expect(createRuntimeDreamSidecarReview({
      stateManager,
      runId: "run:coreloop:stale",
    })).rejects.toMatchObject({
      code: "stale_run",
    });
  });

  it("keeps optional guidance injection approval-gated", async () => {
    await seedActiveRun("run:coreloop:inject");

    const review = await createRuntimeDreamSidecarReview({
      stateManager,
      runId: "run:coreloop:inject",
      requestGuidanceInjection: true,
    });

    expect(review.read_only_enforced).toBe(true);
    expect(review.guidance_injection).toMatchObject({
      status: "approval_required",
      approval_required: true,
      target_run_id: "run:coreloop:inject",
    });
    expect(review.operator_decisions).toContainEqual(expect.objectContaining({
      source: "guidance_injection",
      approval_required: true,
    }));
    expect(await new BackgroundRunLedger(path.join(tmpDir, "runtime")).load("run:coreloop:inject")).toMatchObject({
      status: "running",
      summary: "Active sidecar target.",
    });
  });

  it("does not signal or pid-probe a process sidecar while reviewing a ledger run", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    await stateManager.writeRaw("runtime/process-sessions/proc-sidecar.json", {
      session_id: "proc-sidecar",
      label: "training",
      command: "node",
      args: ["train.js"],
      cwd: "/repo",
      pid: 424242,
      running: true,
      exitCode: null,
      signal: null,
      startedAt: "2026-04-30T00:00:00.000Z",
      bufferedChars: 0,
      metadataRef: "control-db://process-sessions/proc-sidecar",
      artifactRefs: [],
    });
    const ledger = new BackgroundRunLedger(path.join(tmpDir, "runtime"));
    await ledger.create({
      id: "run:process:proc-sidecar",
      kind: "process_run",
      notify_policy: "silent",
      reply_target_source: "none",
      process_session_id: "proc-sidecar",
      status: "running",
      title: "Training",
      workspace: "/repo",
      started_at: "2026-04-30T00:00:00.000Z",
      updated_at: "2026-04-30T00:10:00.000Z",
      source_refs: [{
        kind: "process_session",
        id: "proc-sidecar",
        path: null,
        relative_path: "control-db://process-sessions/proc-sidecar",
        updated_at: "2026-04-30T00:10:00.000Z",
      }],
    });

    try {
      const review = await createRuntimeDreamSidecarReview({
        stateManager,
        runId: "run:process:proc-sidecar",
      });

      expect(review.run).toMatchObject({
        id: "run:process:proc-sidecar",
        status: "running",
        process_session_id: "proc-sidecar",
      });
      expect(review.read_only_enforced).toBe(true);
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("rejects a ledger-running process run when the process sidecar is terminal", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    await stateManager.writeRaw("runtime/process-sessions/proc-stale.json", {
      session_id: "proc-stale",
      label: "training",
      command: "node",
      args: ["train.js"],
      cwd: "/repo",
      pid: 424243,
      running: false,
      exitCode: 0,
      signal: null,
      startedAt: "2026-04-30T00:00:00.000Z",
      exitedAt: "2026-04-30T00:12:00.000Z",
      bufferedChars: 0,
      metadataRef: "control-db://process-sessions/proc-stale",
      artifactRefs: [],
    });
    const ledger = new BackgroundRunLedger(path.join(tmpDir, "runtime"));
    await ledger.create({
      id: "run:process:proc-stale",
      kind: "process_run",
      notify_policy: "silent",
      reply_target_source: "none",
      process_session_id: "proc-stale",
      status: "running",
      title: "Training",
      workspace: "/repo",
      started_at: "2026-04-30T00:00:00.000Z",
      updated_at: "2026-04-30T00:10:00.000Z",
      source_refs: [{
        kind: "process_session",
        id: "proc-stale",
        path: null,
        relative_path: "control-db://process-sessions/proc-stale",
        updated_at: "2026-04-30T00:10:00.000Z",
      }],
    });

    try {
      await expect(createRuntimeDreamSidecarReview({
        stateManager,
        runId: "run:process:proc-stale",
      })).rejects.toMatchObject({
        code: "stale_run",
      });
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  async function seedActiveRun(runId: string): Promise<void> {
    const runtimeRoot = path.join(tmpDir, "runtime");
    await new SupervisorStateStore(runtimeRoot, { controlBaseDir: tmpDir }).save({
      workers: [{
        workerId: "sidecar-worker",
        goalId: "goal-sidecar",
        startedAt: Date.parse("2026-04-30T00:00:00.000Z"),
        iterations: 3,
      }],
      crashCounts: {},
      suspendedGoals: [],
      updatedAt: Date.parse("2026-04-30T00:30:00.000Z"),
    });
    const ledger = new BackgroundRunLedger(runtimeRoot);
    await ledger.create({
      id: runId,
      kind: "coreloop_run",
      notify_policy: "silent",
      reply_target_source: "none",
      child_session_id: "session:coreloop:sidecar-worker",
      title: "Sidecar target",
      workspace: "/repo",
      status: "running",
      started_at: "2026-04-30T00:00:00.000Z",
      updated_at: "2026-04-30T00:30:00.000Z",
      summary: "Active sidecar target.",
      artifacts: [{ label: "metrics.json", path: "/repo/runs/metrics.json", url: null, kind: "metrics" }],
      source_refs: [{
        kind: "supervisor_state",
        id: null,
        path: null,
        relative_path: "runtime/supervisor-state.json",
        updated_at: "2026-04-30T00:30:00.000Z",
      }],
    });
  }
});
