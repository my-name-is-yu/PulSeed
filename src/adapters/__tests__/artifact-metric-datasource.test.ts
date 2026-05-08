import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir } from "../../../tests/helpers/temp-dir.js";
import { makeDimension, makeGoal } from "../../../tests/helpers/fixtures.js";
import { StateManager } from "../../base/state/state-manager.js";
import { ObservationEngine } from "../../platform/observation/observation-engine.js";
import {
  ArtifactMetricDataSourceAdapter,
  createWorkspaceArtifactMetricDataSource,
} from "../datasources/artifact-metric-datasource.js";

describe("ArtifactMetricDataSourceAdapter", () => {
  let tmpDir: string;
  let workspace: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("scans nested workspace metrics and selects the best metric value", async () => {
    writeJson(path.join(workspace, "artifacts", "probe_balanced_default", "metrics.json"), {
      oof_balanced_accuracy: 0.9623128530945794,
    });
    writeJson(path.join(workspace, "artifacts", "probe_sweep", "base_d7_lr007_i700_l26", "metrics.json"), {
      metrics: { balanced_accuracy: 0.94 },
    });
    writeJson(path.join(workspace, "artifacts", "experiments", "older", "metrics.json"), {
      all_metrics: { balanced_accuracy: 0.91 },
    });
    writeJson(path.join(workspace, "data", "raw", "ignored", "metrics.json"), {
      oof_balanced_accuracy: 0.99,
    });
    writeJson(path.join(workspace, ".venv", "ignored", "metrics.json"), {
      oof_balanced_accuracy: 0.98,
    });

    const adapter = createWorkspaceArtifactMetricDataSource(workspace);
    const result = await adapter.query({ dimension_name: "best_oof_balanced_accuracy", timeout_ms: 10000 });

    expect(result.value).toBe(0.9623128530945794);
    expect(result.raw).toMatchObject({
      inspected_metric_files: 3,
      selected_key: "oof_balanced_accuracy",
      selected: {
        path: path.join(workspace, "artifacts", "probe_balanced_default", "metrics.json"),
        keyPath: "oof_balanced_accuracy",
        parser: "json",
        extractionConfidence: 0.95,
        stale: false,
      },
      strategic_correctness: "not_evaluated",
    });
  });

  it("discovers Kaggle experiment metrics and maps plain metric_name to cv_score", async () => {
    writeJson(path.join(workspace, "experiments", "smoke-hgb-50k", "metrics.json"), {
      metric_name: "roc_auc",
      direction: "maximize",
      cv_score: 0.9331832527157385,
      status: "completed",
    });

    const adapter = createWorkspaceArtifactMetricDataSource(workspace);
    const result = await adapter.query({ dimension_name: "roc_auc", timeout_ms: 10000 });

    expect(result.value).toBe(0.9331832527157385);
    expect(result.raw).toMatchObject({
      inspected_metric_files: 1,
      selected_key: "roc_auc",
      selected: {
        relativePath: "experiments/smoke-hgb-50k/metrics.json",
        key: "roc_auc",
        keyPath: "cv_score",
      },
      discovery: {
        artifact_roots: expect.arrayContaining(["experiments"]),
      },
    });
  });

  it("counts validated metric artifacts when no experiment log exists", async () => {
    writeJson(path.join(workspace, "artifacts", "probe-a", "metrics.json"), { score: 0.8 });
    writeJson(path.join(workspace, "artifacts", "probe-b", "metrics.json"), { metrics: { accuracy: 0.7 } });
    writeJson(path.join(workspace, "artifacts", "broken", "metrics.json"), { notes: "no numeric metrics" });

    const adapter = createWorkspaceArtifactMetricDataSource(workspace);
    const result = await adapter.query({ dimension_name: "validated_experiment_count", timeout_ms: 10000 });

    expect(result.value).toBe(2);
    expect(result.raw).toMatchObject({
      inspected_metric_files: 3,
      matched_metric_files: 2,
      strategic_correctness: "not_evaluated",
    });
  });

  it("updates CoreLoop-observed goal dimensions through ObservationEngine.observe", async () => {
    writeJson(path.join(workspace, "artifacts", "probe-balanced", "metrics.json"), {
      oof_balanced_accuracy: 0.88,
      status: "completed",
    });
    const stateManager = new StateManager(tmpDir);
    const goal = makeGoal({
      id: "goal-artifact-metrics",
      constraints: [`workspace_path:${workspace}`],
      dimensions: [
        makeDimension({
          name: "best_oof_balanced_accuracy",
          label: "Best OOF balanced accuracy",
          current_value: 0,
          threshold: { type: "min", value: 0.95 },
        }),
      ],
    });
    await stateManager.saveGoal(goal);

    const engine = new ObservationEngine(stateManager, [createWorkspaceArtifactMetricDataSource(workspace)]);
    await engine.observe("goal-artifact-metrics", []);

    const updated = await stateManager.loadGoal("goal-artifact-metrics");
    expect(updated?.dimensions[0]?.current_value).toBe(0.88);
    expect(updated?.dimensions[0]?.last_observed_layer).toBe("mechanical");
  });

  it("uses goal workspace artifacts for numeric threshold dimensions before a current value exists", async () => {
    const stalePath = path.join(workspace, "experiments", "stale", "metrics.json");
    const freshPath = path.join(workspace, "experiments", "fresh", "metrics.json");
    writeJson(stalePath, { accuracy: 0.99, status: "completed" });
    writeJson(freshPath, { accuracy: 0.93, status: "completed" });
    setModifiedTime(stalePath, new Date(Date.now() - 48 * 60 * 60 * 1000));
    const stateManager = new StateManager(tmpDir);
    const goal = makeGoal({
      id: "goal-artifact-metrics-unknown-current",
      constraints: [`workspace_path:${workspace}`],
      dimensions: [
        makeDimension({
          name: "accuracy",
          label: "Accuracy",
          current_value: null,
          threshold: { type: "min", value: 0.9 },
        }),
      ],
    });
    await stateManager.saveGoal(goal);

    const engine = new ObservationEngine(stateManager, []);
    await engine.observe("goal-artifact-metrics-unknown-current", []);

    const updated = await stateManager.loadGoal("goal-artifact-metrics-unknown-current");
    expect(updated?.dimensions[0]?.current_value).toBe(0.93);
    expect(updated?.dimensions[0]?.last_observed_layer).toBe("mechanical");
    const observations = await stateManager.loadObservationLog("goal-artifact-metrics-unknown-current");
    expect(observations?.entries[0]?.raw_result).toMatchObject({
      selected: {
        relativePath: "experiments/fresh/metrics.json",
        key: "accuracy",
      },
      stale_candidates: [
        {
          path: "experiments/stale/metrics.json",
        },
      ],
    });
  });

  it("reuses artifact metric discovery across dimensions in one ObservationEngine.observe pass", async () => {
    writeJson(path.join(workspace, "artifacts", "probe", "metrics.json"), {
      balanced_accuracy: 0.88,
      f1_score: 0.81,
      status: "completed",
    });
    const stateManager = new StateManager(tmpDir);
    const goal = makeGoal({
      id: "goal-artifact-metrics-cache",
      constraints: [`workspace_path:${workspace}`],
      dimensions: [
        makeDimension({
          name: "balanced_accuracy",
          current_value: 0,
          threshold: { type: "min", value: 0.9 },
        }),
        makeDimension({
          name: "f1_score",
          current_value: 0,
          threshold: { type: "min", value: 0.9 },
        }),
      ],
    });
    await stateManager.saveGoal(goal);
    const adapter = createWorkspaceArtifactMetricDataSource(workspace);

    const engine = new ObservationEngine(stateManager, [adapter]);
    await engine.observe("goal-artifact-metrics-cache", []);

    const updated = await stateManager.loadGoal("goal-artifact-metrics-cache");
    expect(updated?.dimensions.map((dimension) => dimension.current_value)).toEqual([0.88, 0.81]);
    writeJson(path.join(workspace, "artifacts", "probe-new", "metrics.json"), {
      balanced_accuracy: 0.91,
      f1_score: 0.87,
      status: "completed",
    });

    await engine.observe("goal-artifact-metrics-cache", []);

    const refreshed = await stateManager.loadGoal("goal-artifact-metrics-cache");
    expect(refreshed?.dimensions.map((dimension) => dimension.current_value)).toEqual([0.91, 0.87]);
  });

  it("keeps per-dimension max_candidates bounds when reusing pass discovery", async () => {
    writeJson(path.join(workspace, "artifacts", "best-balanced_accuracy", "metrics.json"), {
      balanced_accuracy: 0.95,
      status: "completed",
    });
    writeJson(path.join(workspace, "artifacts", "best-f1_score", "metrics.json"), {
      f1_score: 0.91,
      status: "completed",
    });
    const adapter = new ArtifactMetricDataSourceAdapter({
      id: "bounded-artifacts",
      name: "bounded artifacts",
      type: "artifact_metric",
      connection: {
        path: workspace,
        max_candidates: 1,
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    adapter.beginObservationPass();
    try {
      const balanced = await adapter.query({ dimension_name: "balanced_accuracy", timeout_ms: 10000 });
      const f1 = await adapter.query({ dimension_name: "f1_score", timeout_ms: 10000 });

      expect(balanced.value).toBe(0.95);
      expect(f1.value).toBe(0.91);
      expect(balanced.raw).toMatchObject({ inspected_metric_files: 1 });
      expect(f1.raw).toMatchObject({ inspected_metric_files: 1 });
    } finally {
      adapter.endObservationPass();
    }
  });

  it("rereads lifecycle state for later dimensions within the same observation pass", async () => {
    const metricPath = path.join(workspace, "artifacts", "probe", "metrics.json");
    writeJson(metricPath, {
      balanced_accuracy: 0.88,
      f1_score: 0.81,
      status: "running",
    });
    const adapter = new ArtifactMetricDataSourceAdapter({
      id: "fresh-lifecycle-artifacts",
      name: "fresh lifecycle artifacts",
      type: "artifact_metric",
      connection: {
        path: workspace,
        current_progress_policy: "completed_fresh_only",
        require_metric_match: true,
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    adapter.beginObservationPass();
    try {
      await expect(adapter.query({ dimension_name: "balanced_accuracy", timeout_ms: 10000 }))
        .rejects.toThrow(/No artifact metric found/);

      writeJson(metricPath, {
        balanced_accuracy: 0.88,
        f1_score: 0.81,
        status: "completed",
      });
      const completed = await adapter.query({ dimension_name: "f1_score", timeout_ms: 10000 });

      expect(completed.value).toBe(0.81);
    } finally {
      adapter.endObservationPass();
    }
  });

  it("does not claim unrelated best-prefixed dimensions in the CoreLoop observation path", async () => {
    const stateManager = new StateManager(tmpDir);
    const goal = makeGoal({
      id: "goal-non-metric-best",
      constraints: [`workspace_path:${workspace}`],
      dimensions: [
        makeDimension({
          name: "best_next_action",
          label: "Best next action",
          current_value: "investigate",
          threshold: { type: "present" },
        }),
      ],
    });
    await stateManager.saveGoal(goal);

    const engine = new ObservationEngine(stateManager, [createWorkspaceArtifactMetricDataSource(workspace)]);
    await engine.observe("goal-non-metric-best", []);

    const updated = await stateManager.loadGoal("goal-non-metric-best");
    expect(updated?.dimensions[0]?.current_value).toBe("investigate");
    expect(updated?.dimensions[0]?.last_observed_layer).toBeUndefined();
  });

  it("supports explicit metric keys and lower-is-better aggregation", async () => {
    writeJson(path.join(workspace, "runs", "a", "result.json"), {
      evidence: [{ kind: "metric", label: "validation_loss", value: 0.42 }],
    });
    writeJson(path.join(workspace, "runs", "b", "result.json"), {
      evidence: [{ kind: "metric", label: "validation_loss", value: 0.31 }],
    });
    const adapter = new ArtifactMetricDataSourceAdapter({
      id: "loss-artifacts",
      name: "loss artifacts",
      type: "artifact_metric",
      connection: {
        path: workspace,
        dimension_metrics: { best_validation_loss: ["validation_loss"] },
        dimension_aggregations: { best_validation_loss: "min" },
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const result = await adapter.query({ dimension_name: "best_validation_loss", timeout_ms: 10000 });

    expect(result.value).toBe(0.31);
    expect(result.raw).toMatchObject({
      selected_key: "validation_loss",
    });
  });

  it("discovers configured include paths without requiring a predeclared exact metric file path", async () => {
    writeJson(path.join(workspace, "custom", "nested", "trial-a", "metrics.json"), {
      metrics: { accuracy: 0.81 },
    });
    const adapter = new ArtifactMetricDataSourceAdapter({
      id: "custom-artifacts",
      name: "Custom artifacts",
      type: "artifact_metric",
      connection: {
        path: workspace,
        include_paths: ["custom/nested"],
        dimension_metrics: { best_accuracy: ["accuracy"] },
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const result = await adapter.query({ dimension_name: "best_accuracy", timeout_ms: 10000 });

    expect(result.value).toBe(0.81);
    expect(result.raw).toMatchObject({
      inspected_metric_files: 1,
      selected: {
        relativePath: "custom/nested/trial-a/metrics.json",
        key: "accuracy",
      },
    });
  });

  it("does not let stale higher values silently override fresh evidence", async () => {
    const stalePath = path.join(workspace, "artifacts", "old", "metrics.json");
    const freshPath = path.join(workspace, "artifacts", "fresh", "metrics.json");
    writeJson(stalePath, { score: 0.99 });
    writeJson(freshPath, { score: 0.75 });
    setModifiedTime(stalePath, new Date(Date.now() - 60_000));
    const adapter = new ArtifactMetricDataSourceAdapter({
      id: "stale-artifacts",
      name: "Stale artifacts",
      type: "artifact_metric",
      connection: {
        path: workspace,
        stale_after_ms: 1_000,
        dimension_metrics: { best_score: ["score"] },
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const result = await adapter.query({ dimension_name: "best_score", timeout_ms: 10000 });

    expect(result.value).toBe(0.75);
    expect(result.raw).toMatchObject({
      selected: {
        path: freshPath,
        stale: false,
      },
      stale_candidates: [
        {
          path: "artifacts/old/metrics.json",
        },
      ],
    });
  });

  it("marks pre-scope metrics uncertain instead of reporting high-confidence current progress", async () => {
    const taskStart = new Date(Date.now() - 60_000);
    const preScopePath = path.join(workspace, "experiments", "full-hgb-5fold-600", "metrics.json");
    writeJson(preScopePath, {
      metric_name: "balanced_accuracy",
      cv_score: 0.9473134912423415,
      status: "completed",
    });
    setModifiedTime(preScopePath, new Date(taskStart.getTime() - 5_000));
    const adapter = new ArtifactMetricDataSourceAdapter({
      id: "task-scoped-artifacts",
      name: "Task scoped artifacts",
      type: "artifact_metric",
      connection: {
        path: workspace,
        current_progress_policy: "completed_fresh_only",
        dimension_metrics: { best_balanced_accuracy: ["balanced_accuracy"] },
        require_metric_match: true,
        fresh_after_time: taskStart.toISOString(),
        freshness_scope: "task",
        freshness_scope_id: "task-current",
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const result = await adapter.query({ dimension_name: "best_balanced_accuracy", timeout_ms: 10000 });

    expect(result.value).toBe(0);
    expect(result.metadata).toMatchObject({
      confidence: 0.35,
    });
    expect(result.raw).toMatchObject({
      selected: null,
      freshness: {
        scope: "task",
        scope_id: "task-current",
        fresh_after_time: taskStart.toISOString(),
        current_progress_status: "ineligible_artifact_metrics_only",
      },
      ineligible_candidates: [
        {
          path: "experiments/full-hgb-5fold-600/metrics.json",
          freshness_status: "pre_scope",
          current_run: false,
          reason: "artifact precedes task freshness scope",
        },
      ],
    });
  });

  it("marks age-stale current-scope metrics uncertain instead of throwing into fallback", async () => {
    const taskStart = new Date(Date.now() - 72 * 60 * 60 * 1000);
    const stalePath = path.join(workspace, "reports", "current-task", "metrics.json");
    writeJson(stalePath, {
      balanced_accuracy: 0.94,
      status: "completed",
    });
    setModifiedTime(stalePath, new Date(Date.now() - 48 * 60 * 60 * 1000));
    const adapter = new ArtifactMetricDataSourceAdapter({
      id: "age-stale-task-scoped-artifacts",
      name: "Age stale task scoped artifacts",
      type: "artifact_metric",
      connection: {
        path: workspace,
        current_progress_policy: "completed_fresh_only",
        dimension_metrics: { best_balanced_accuracy: ["balanced_accuracy"] },
        require_metric_match: true,
        stale_after_ms: 24 * 60 * 60 * 1000,
        fresh_after_time: taskStart.toISOString(),
        freshness_scope: "task",
        freshness_scope_id: "task-current",
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const result = await adapter.query({ dimension_name: "best_balanced_accuracy", timeout_ms: 10000 });

    expect(result.value).toBe(0);
    expect(result.metadata).toMatchObject({ confidence: 0.35 });
    expect(result.raw).toMatchObject({
      selected: null,
      freshness: {
        scope: "task",
        scope_id: "task-current",
        current_progress_status: "ineligible_artifact_metrics_only",
      },
      ineligible_candidates: [
        {
          path: "reports/current-task/metrics.json",
          freshness_status: "stale",
          current_run: true,
          reason: "artifact is stale for current progress",
        },
      ],
    });
  });

  it("requires completed current-progress artifacts unless live progress is explicitly allowed", async () => {
    writeJson(path.join(workspace, "artifacts", "live", "metrics.json"), {
      score: 0.7,
      status: "running",
    });
    const completedOnly = new ArtifactMetricDataSourceAdapter({
      id: "completed-only-artifacts",
      name: "Completed-only artifacts",
      type: "artifact_metric",
      connection: {
        path: workspace,
        current_progress_policy: "completed_fresh_only",
        dimension_metrics: { best_score: ["score"] },
        require_metric_match: true,
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    await expect(completedOnly.query({ dimension_name: "best_score", timeout_ms: 10000 }))
      .rejects.toThrow(/No artifact metric found/);

    const liveAllowed = new ArtifactMetricDataSourceAdapter({
      id: "live-artifacts",
      name: "Live artifacts",
      type: "artifact_metric",
      connection: {
        path: workspace,
        current_progress_policy: "allow_live",
        dimension_metrics: { best_score: ["score"] },
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const result = await liveAllowed.query({ dimension_name: "best_score", timeout_ms: 10000 });

    expect(result.value).toBe(0.7);
    expect(result.raw).toMatchObject({
      discovery: {
        current_progress_policy: "allow_live",
      },
      selected: {
        relativePath: "artifacts/live/metrics.json",
      },
    });
  });

  it("accepts fresh canonical Kaggle metrics without lifecycle flags for completed current progress", async () => {
    writeJson(path.join(workspace, "experiments", "hgb_cv_auc_fast", "metrics.json"), {
      roc_auc: 0.9078005508190139,
    });
    const adapter = new ArtifactMetricDataSourceAdapter({
      id: "fresh-kaggle-artifacts",
      name: "Fresh Kaggle artifacts",
      type: "artifact_metric",
      connection: {
        path: workspace,
        current_progress_policy: "completed_fresh_only",
        dimension_metrics: { roc_auc: ["roc_auc"] },
        require_metric_match: true,
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const result = await adapter.query({ dimension_name: "roc_auc", timeout_ms: 10000 });

    expect(result.value).toBe(0.9078005508190139);
    expect(result.raw).toMatchObject({
      selected: {
        relativePath: "experiments/hgb_cv_auc_fast/metrics.json",
        key: "roc_auc",
        keyPath: "roc_auc",
        freshnessStatus: "fresh",
      },
      ineligible_candidates: [],
    });
  });

  it("surfaces conflicting metric candidates instead of treating one as uncontested truth", async () => {
    writeJson(path.join(workspace, "artifacts", "a", "metrics.json"), { score: 0.4 });
    writeJson(path.join(workspace, "artifacts", "b", "metrics.json"), { score: 0.6 });
    const adapter = new ArtifactMetricDataSourceAdapter({
      id: "conflict-artifacts",
      name: "Conflict artifacts",
      type: "artifact_metric",
      connection: {
        path: workspace,
        dimension_metrics: { best_score: ["score"] },
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const result = await adapter.query({ dimension_name: "best_score", timeout_ms: 10000 });

    expect(result.value).toBe(0.6);
    expect(result.raw).toMatchObject({
      conflicts: [
        {
          metricKey: "score",
        },
      ],
    });
    const raw = result.raw as { conflicts?: Array<{ candidates?: unknown[] }> };
    expect(raw.conflicts?.[0]?.candidates).toHaveLength(2);
  });

  it("surfaces alias conflicts for one requested dimension", async () => {
    writeJson(path.join(workspace, "artifacts", "a", "metrics.json"), { score: 0.4 });
    writeJson(path.join(workspace, "artifacts", "b", "metrics.json"), { cv_score: 0.6 });
    const adapter = new ArtifactMetricDataSourceAdapter({
      id: "alias-conflict-artifacts",
      name: "Alias conflict artifacts",
      type: "artifact_metric",
      connection: { path: workspace },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const result = await adapter.query({ dimension_name: "best_score", timeout_ms: 10000 });

    expect(result.raw).toMatchObject({
      conflicts: expect.arrayContaining([
        expect.objectContaining({
          metricKey: "dimension:best_score",
        }),
      ]),
    });
  });

  it("returns missing artifact evidence without falling back to a strategy conclusion", async () => {
    const adapter = new ArtifactMetricDataSourceAdapter({
      id: "missing-artifacts",
      name: "Missing artifacts",
      type: "artifact_metric",
      connection: {
        path: workspace,
        dimension_metrics: { best_score: ["score"] },
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const result = await adapter.query({ dimension_name: "best_score", timeout_ms: 10000 });

    expect(result.value).toBe(0);
    expect(result.raw).toMatchObject({
      inspected_metric_files: 0,
      selected: null,
      candidates: [],
      evidence_candidates: [],
      strategic_correctness: "not_evaluated",
    });
  });

  it("keeps extraction confidence separate from strategic correctness for lower-confidence evidence arrays", async () => {
    writeJson(path.join(workspace, "reports", "trial", "result.json"), {
      evidence: [{ kind: "metric", label: "validation_score", value: 0.62 }],
    });
    const adapter = new ArtifactMetricDataSourceAdapter({
      id: "evidence-artifacts",
      name: "Evidence artifacts",
      type: "artifact_metric",
      connection: {
        path: workspace,
        dimension_metrics: { best_validation_score: ["validation_score"] },
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const result = await adapter.query({ dimension_name: "best_validation_score", timeout_ms: 10000 });

    expect(result.value).toBe(0.62);
    expect(result.raw).toMatchObject({
      selected: {
        key: "validation_score",
        keyPath: "evidence.0.value",
        extractionConfidence: 0.8,
      },
      evidence_candidates: [
        {
          extraction_confidence: 0.8,
          strategic_correctness: "not_evaluated",
        },
      ],
      strategic_correctness: "not_evaluated",
    });
  });

  it("orders evidence candidates by lower-is-better aggregation for loss dimensions", async () => {
    writeJson(path.join(workspace, "runs", "bad", "result.json"), {
      metrics: { validation_loss: 0.8 },
    });
    writeJson(path.join(workspace, "runs", "good", "result.json"), {
      metrics: { validation_loss: 0.2 },
    });
    const adapter = new ArtifactMetricDataSourceAdapter({
      id: "loss-evidence-artifacts",
      name: "Loss evidence artifacts",
      type: "artifact_metric",
      connection: {
        path: workspace,
        dimension_metrics: { best_validation_loss: ["validation_loss"] },
        dimension_aggregations: { best_validation_loss: "min" },
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const result = await adapter.query({ dimension_name: "best_validation_loss", timeout_ms: 10000 });

    expect(result.value).toBe(0.2);
    const raw = result.raw as { evidence_candidates?: Array<{ value?: number }> };
    expect(raw.evidence_candidates?.[0]?.value).toBe(0.2);
  });
});

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function setModifiedTime(filePath: string, date: Date): void {
  fs.utimesSync(filePath, date, date);
}
