import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../tests/helpers/temp-dir.js";
import { RuntimeEvidenceLedger } from "../store/evidence-ledger.js";
import { RuntimeOperatorHandoffStore } from "../store/operator-handoff-store.js";
import {
  RuntimePostmortemReportSchema,
  RuntimePostmortemReportStore,
} from "../store/postmortem-report.js";
import { RuntimeReproducibilityManifestStore } from "../store/reproducibility-manifest.js";

describe("RuntimePostmortemReportStore", () => {
  let runtimeRoot: string;

  beforeEach(async () => {
    runtimeRoot = makeTempDir("pulseed-runtime-postmortem-");
    await fsp.mkdir(path.join(runtimeRoot, "runs/final"), { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(runtimeRoot, { recursive: true, force: true });
  });

  it("generates durable evidence-backed postmortem artifacts from synthetic run evidence", async () => {
    await fsp.writeFile(path.join(runtimeRoot, "runs/final/submission.csv"), "id,target\n1,0\n", "utf8");
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "metric-baseline",
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-postmortem", run_id: "run:coreloop:postmortem", loop_index: 0 },
      metrics: [{ label: "balanced_accuracy", value: 0.71, direction: "maximize", observed_at: "2026-04-30T00:00:00.000Z" }],
      summary: "Baseline metric recorded.",
      outcome: "continued",
    });
    await ledger.append({
      id: "candidate-final",
      occurred_at: "2026-04-30T01:00:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-postmortem", run_id: "run:coreloop:postmortem", loop_index: 3 },
      metrics: [{ label: "balanced_accuracy", value: 0.78, direction: "maximize", observed_at: "2026-04-30T01:00:00.000Z" }],
      candidates: [{
        candidate_id: "candidate-a",
        label: "Candidate A",
        lineage: {
          strategy_family: "catboost_default",
          feature_lineage: ["focus-base"],
          model_lineage: ["catboost"],
          config_lineage: ["configs/train.json"],
          seed_lineage: ["seed-314"],
          fold_lineage: ["5-fold"],
          postprocess_lineage: [],
        },
        metrics: [{ label: "balanced_accuracy", value: 0.78, direction: "maximize", confidence: 0.9 }],
        artifacts: [{
          label: "submission",
          state_relative_path: "runs/final/submission.csv",
          kind: "other",
          retention_class: "final_deliverable",
        }],
        similarity: [],
        disposition: "promoted",
        disposition_reason: "Best robust candidate.",
      }, {
        candidate_id: "candidate-near",
        label: "Near miss",
        lineage: {
          strategy_family: "lightgbm_variant",
          feature_lineage: ["focus-base"],
          model_lineage: ["lightgbm"],
          config_lineage: [],
          seed_lineage: ["seed-7"],
          fold_lineage: ["5-fold"],
          postprocess_lineage: [],
        },
        metrics: [{ label: "balanced_accuracy", value: 0.775, direction: "maximize", confidence: 0.8 }],
        artifacts: [],
        similarity: [],
        near_miss: {
          status: "retained",
          reason_to_keep: ["close_to_best"],
          margin_to_best: 0.005,
          weak_dimensions: ["stability"],
          complementary_candidate_ids: ["candidate-a"],
          evidence_refs: ["candidate-final"],
          follow_up: {
            title: "Re-test near miss with stability folds",
            rationale: "Near miss stayed close to the best candidate but needs stability evidence.",
            target_dimensions: ["stability"],
          },
        },
        disposition: "retained",
      }],
      artifacts: [{
        label: "submission",
        state_relative_path: "runs/final/submission.csv",
        kind: "other",
        retention_class: "final_deliverable",
      }],
      summary: "Final candidate and near miss recorded.",
      outcome: "improved",
    });
    await ledger.append({
      id: "external-gap",
      occurred_at: "2026-04-30T01:15:00.000Z",
      kind: "evaluator",
      scope: { goal_id: "goal-postmortem", run_id: "run:coreloop:postmortem" },
      evaluators: [{
        evaluator_id: "leaderboard",
        signal: "external",
        source: "public-leaderboard",
        candidate_id: "candidate-a",
        status: "approval_required",
        score_label: "balanced_accuracy",
        direction: "maximize",
        publish_action: {
          id: "submit-candidate-a",
          label: "Submit candidate A",
          approval_required: true,
        },
      }],
      summary: "External evaluator still requires approval.",
    });
    await ledger.append({
      id: "other-run-candidate",
      occurred_at: "2026-04-30T01:30:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-postmortem", run_id: "run:coreloop:other" },
      candidates: [{
        candidate_id: "candidate-other-run",
        label: "Other run candidate",
        lineage: {
          strategy_family: "other",
          feature_lineage: [],
          model_lineage: [],
          config_lineage: [],
          seed_lineage: [],
          fold_lineage: [],
          postprocess_lineage: [],
        },
        metrics: [{ label: "balanced_accuracy", value: 0.65, direction: "maximize" }],
        artifacts: [{
          label: "other-run-output",
          state_relative_path: "runs/final/other.csv",
          kind: "other",
          retention_class: "final_deliverable",
        }],
        similarity: [],
        disposition: "retired",
      }],
      artifacts: [{
        label: "other-run-output",
        state_relative_path: "runs/final/other.csv",
        kind: "other",
        retention_class: "final_deliverable",
      }],
      summary: "Other run candidate should not leak into this run postmortem.",
    });

    const manifest = await new RuntimeReproducibilityManifestStore(runtimeRoot).createOrUpdateForCandidate({
      goalId: "goal-postmortem",
      runId: "run:coreloop:postmortem",
      candidateId: "candidate-a",
      codeState: { commit: "abc123", dirty: false },
    });
    const otherRunManifest = await new RuntimeReproducibilityManifestStore(runtimeRoot).createOrUpdateForCandidate({
      goalId: "goal-postmortem",
      runId: "run:coreloop:other",
      candidateId: "candidate-other-run",
      codeState: { commit: "def456", dirty: false },
    });
    const manifestsDir = path.join(runtimeRoot, "reproducibility-manifests");
    await fsp.writeFile(path.join(manifestsDir, "manifest-malformed.json"), "{", "utf8");
    await fsp.writeFile(path.join(manifestsDir, "manifest-unsafe.json"), `${JSON.stringify({
      schema_version: "runtime-reproducibility-manifest-v1",
      manifest_id: "manifest-unsafe",
      generated_at: "2026-04-30T00:00:00.000Z",
      updated_at: "2026-04-30T00:10:00.000Z",
      scope: { goal_id: "goal-postmortem", run_id: "run:coreloop:postmortem" },
      finalization_preflight: {
        manifest_required_before_delivery: true,
        approval_required_before_external_submission: true,
        status: "manifest_ready",
        missing: [],
      },
      code_state: { source: "test-fixture" },
      artifacts: [{
        label: "unsafe-artifact",
        state_relative_path: "runs/final/unsafe.bin",
        kind: "other",
        size_bytes: Number.MAX_SAFE_INTEGER + 1,
      }],
    })}\n`, "utf8");
    await new RuntimeOperatorHandoffStore(runtimeRoot).create({
      handoff_id: "handoff-finalization",
      goal_id: "goal-postmortem",
      run_id: "run:coreloop:postmortem",
      triggers: ["finalization", "external_action"],
      title: "Review final submission",
      summary: "Final output needs operator review.",
      current_status: "manifest_ready",
      recommended_action: "Approve or pause final submission.",
      required_approvals: ["submit-candidate-a"],
      next_action: {
        label: "Approve final submission",
        approval_required: true,
      },
      evidence_refs: [{ kind: "reproducibility_manifest", ref: manifest.manifest_id, observed_at: manifest.updated_at }],
    });
    await new RuntimeOperatorHandoffStore(runtimeRoot).create({
      handoff_id: "handoff-goal-only-approval",
      goal_id: "goal-postmortem",
      triggers: ["external_action"],
      title: "Goal-scoped external action approval",
      summary: "External action was recorded before run linkage was available.",
      current_status: "approval_required",
      recommended_action: "Review the goal-scoped external action before final delivery.",
      required_approvals: ["external-submit"],
      next_action: {
        label: "Review goal-scoped external action",
        approval_required: true,
      },
      evidence_refs: [{ kind: "runtime_evidence", ref: "external-gap", observed_at: "2026-04-30T01:15:00.000Z" }],
    });
    await new RuntimeOperatorHandoffStore(runtimeRoot).create({
      handoff_id: "handoff-other-run",
      goal_id: "goal-postmortem",
      run_id: "run:coreloop:other",
      triggers: ["finalization"],
      title: "Other run handoff",
      summary: "This belongs to a different run.",
      current_status: "other_run",
      recommended_action: "Do not include in target run postmortem.",
      required_approvals: [],
      next_action: {
        label: "Review other run",
        approval_required: true,
      },
      evidence_refs: [{ kind: "reproducibility_manifest", ref: otherRunManifest.manifest_id }],
    });

    const store = new RuntimePostmortemReportStore(runtimeRoot);
    const report = await store.generate({
      goalId: "goal-postmortem",
      runId: "run:coreloop:postmortem",
      finalStatus: "finalization",
      trigger: "finalization",
    });

    expect(report).toMatchObject({
      schema_version: "runtime-postmortem-v1",
      scope: { goal_id: "goal-postmortem", run_id: "run:coreloop:postmortem" },
      final_status: "finalization",
      trigger: "finalization",
    });
    expect(report.metric_timeline).toContainEqual(expect.objectContaining({
      metric_key: "balanced_accuracy",
      best_value: 0.78,
      observation_count: 2,
      source_refs: expect.arrayContaining([
        expect.objectContaining({ ref: "metric-baseline", observed_at: "2026-04-30T00:00:00.000Z" }),
        expect.objectContaining({ ref: "candidate-final", observed_at: "2026-04-30T01:00:00.000Z" }),
      ]),
    }));
    expect(report.final_outputs).toContainEqual(expect.objectContaining({
      label: "submission",
      state_relative_path: "runs/final/submission.csv",
      manifest_id: manifest.manifest_id,
    }));
    expect(report.manifests).toContainEqual(expect.objectContaining({ manifest_id: manifest.manifest_id }));
    expect(report.manifests).not.toContainEqual(expect.objectContaining({ manifest_id: otherRunManifest.manifest_id }));
    expect(report.handoffs).toContainEqual(expect.objectContaining({ handoff_id: "handoff-finalization" }));
    expect(report.handoffs).toContainEqual(expect.objectContaining({ handoff_id: "handoff-goal-only-approval" }));
    expect(report.handoffs).not.toContainEqual(expect.objectContaining({ handoff_id: "handoff-other-run" }));
    expect(report.final_outputs).not.toContainEqual(expect.objectContaining({ label: "other-run-output" }));
    expect(report.follow_up_actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Re-test near miss with stability folds", auto_create: false }),
      expect.objectContaining({ title: "Approve final submission", approval_required: true, auto_create: false }),
      expect.objectContaining({ title: "Review goal-scoped external action", approval_required: true, auto_create: false }),
    ]));
    expect(report.evidence_refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "runtime_evidence", ref: "candidate-final", observed_at: "2026-04-30T01:00:00.000Z" }),
      expect.objectContaining({ kind: "reproducibility_manifest", ref: manifest.manifest_id }),
    ]));

    await expect(fsp.stat(report.artifact_paths.json_path)).resolves.toMatchObject({ isFile: expect.any(Function) });
    const markdown = await fsp.readFile(report.artifact_paths.markdown_path, "utf8");
    expect(markdown).toContain("Runtime Postmortem");
    expect(markdown).toContain("Metric Timeline");
    expect(markdown).toContain("candidate-final");

    const runEvidence = await ledger.readByRun("run:coreloop:postmortem");
    expect(runEvidence.entries).toContainEqual(expect.objectContaining({
      id: `${report.postmortem_id}:artifact`,
      kind: "artifact",
      artifacts: expect.arrayContaining([
        expect.objectContaining({ label: "postmortem.md", retention_class: "evidence_report" }),
      ]),
    }));
  });

  it("rethrows manifest read errors during postmortem generation", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "postmortem-manifest-read-error",
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-postmortem-manifest-read-error" },
      metrics: [{ label: "score", value: 0.6, direction: "maximize", observed_at: "2026-04-30T00:00:00.000Z" }],
      summary: "Score recorded.",
    });
    await fsp.mkdir(path.join(runtimeRoot, "reproducibility-manifests", "manifest-directory.json"), { recursive: true });

    await expect(new RuntimePostmortemReportStore(runtimeRoot).generate({
      goalId: "goal-postmortem-manifest-read-error",
      trigger: "operator_request",
    })).rejects.toThrow();
  });

  it("treats malformed or unsafe persisted postmortem JSON as missing", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "postmortem-corrupt-metric",
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-postmortem-corrupt" },
      metrics: [{ label: "score", value: 0.6, direction: "maximize", observed_at: "2026-04-30T00:00:00.000Z" }],
      summary: "Score recorded.",
    });
    const store = new RuntimePostmortemReportStore(runtimeRoot);
    const report = await store.generate({
      goalId: "goal-postmortem-corrupt",
      trigger: "operator_request",
    });
    expect(report.metric_timeline).toHaveLength(1);

    await fsp.writeFile(report.artifact_paths.json_path, "{bad", "utf8");
    await expect(store.load(report.postmortem_id)).resolves.toBeNull();
    await expect(store.latestFor({ goalId: "goal-postmortem-corrupt" })).resolves.toBeNull();

    const unsafeMetricJson = JSON.stringify({
      ...report,
      metric_timeline: [{
        ...report.metric_timeline[0],
        latest_value: "__UNSAFE_VALUE__",
      }],
    }, null, 2).replace('"__UNSAFE_VALUE__"', "1e999");
    await fsp.writeFile(report.artifact_paths.json_path, unsafeMetricJson, "utf8");

    await expect(store.load(report.postmortem_id)).resolves.toBeNull();
    expect(RuntimePostmortemReportSchema.safeParse({
      ...report,
      metric_timeline: [{
        ...report.metric_timeline[0],
        observation_count: Number.MAX_SAFE_INTEGER + 1,
      }],
    }).success).toBe(false);
  });
});
