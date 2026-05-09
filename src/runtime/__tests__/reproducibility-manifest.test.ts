import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../tests/helpers/temp-dir.js";
import { RuntimeEvidenceLedger } from "../store/evidence-ledger.js";
import {
  RuntimeReproducibilityManifestSchema,
  RuntimeReproducibilityManifestStore,
} from "../store/reproducibility-manifest.js";
import { RuntimeEvidenceArtifactRefSchema } from "../store/evidence-types.js";

describe("RuntimeReproducibilityManifestStore", () => {
  let runtimeRoot: string;
  let workspaceDir: string;

  beforeEach(async () => {
    runtimeRoot = makeTempDir("pulseed-runtime-manifest-");
    workspaceDir = makeTempDir("pulseed-workspace-manifest-");
    await fsp.mkdir(path.join(runtimeRoot, "runs/final"), { recursive: true });
    await fsp.mkdir(path.join(workspaceDir, "configs"), { recursive: true });
    await fsp.mkdir(path.join(workspaceDir, "data"), { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(runtimeRoot, { recursive: true, force: true });
    await fsp.rm(workspaceDir, { recursive: true, force: true });
  });

  it("creates a manifest for a selected candidate with artifact, config, data, and code provenance", async () => {
    await fsp.writeFile(path.join(runtimeRoot, "runs/final/submission.csv"), "id,target\n1,0\n", "utf8");
    await fsp.writeFile(path.join(runtimeRoot, "runs/final/metrics.json"), "{\"balanced_accuracy\":0.976}\n", "utf8");
    await fsp.writeFile(path.join(workspaceDir, "configs/train.json"), "{\"seed\":314}\n", "utf8");
    await fsp.writeFile(path.join(workspaceDir, "data/train.csv"), "id,x\n1,2\n", "utf8");

    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "candidate-final-snapshot",
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-manifest", run_id: "run:coreloop:manifest" },
      candidates: [{
        candidate_id: "cb_focus_base_default_rs314",
        label: "CatBoost default rs314",
        lineage: {
          parent_candidate_id: "cb_focus_base",
          source_strategy_id: "strategy-catboost-default",
          strategy_family: "catboost_default",
          feature_lineage: ["focus-base"],
          model_lineage: ["catboost"],
          config_lineage: ["configs/train.json"],
          seed_lineage: ["seed-314"],
          fold_lineage: ["5-fold-oof"],
          postprocess_lineage: ["none"],
        },
        metrics: [{ label: "balanced_accuracy", value: 0.976, direction: "maximize", confidence: 0.9 }],
        artifacts: [
          { label: "submission", state_relative_path: "runs/final/submission.csv", kind: "other" },
          { label: "metrics", state_relative_path: "runs/final/metrics.json", kind: "metrics" },
        ],
        similarity: [],
        robustness: {
          stability_score: 0.91,
          diversity_score: 0.58,
          risk_penalty: 0.02,
          evidence_confidence: 0.9,
          weak_dimensions: [],
          provenance_refs: ["runs/final/metrics.json"],
        },
        disposition: "promoted",
        disposition_reason: "Selected robust final candidate.",
      }],
      summary: "Final candidate snapshot.",
      outcome: "improved",
    });

    const manifest = await new RuntimeReproducibilityManifestStore(runtimeRoot).createOrUpdateForCandidate({
      goalId: "goal-manifest",
      runId: "run:coreloop:manifest",
      candidateId: "cb_focus_base_default_rs314",
      workspaceDir,
      command: {
        command: "npm run train -- --config configs/train.json",
        tool_name: "shell_command",
        cwd: workspaceDir,
      },
      configPaths: ["configs/train.json"],
      dataPaths: ["data/train.csv"],
      codeState: {
        commit: "abc123",
        dirty: true,
        diff: "diff --git a/train.ts b/train.ts\n",
        source: "test-fixture",
      },
      runtime: { node: "v22.0.0", platform: "darwin" },
      dependencies: { pulseed: "0.5.4" },
    });

    expect(manifest).toMatchObject({
      schema_version: "runtime-reproducibility-manifest-v1",
      scope: { goal_id: "goal-manifest", run_id: "run:coreloop:manifest" },
      selected_candidate: {
        candidate_id: "cb_focus_base_default_rs314",
        evidence_entry_id: "candidate-final-snapshot",
        lineage: {
          strategy_family: "catboost_default",
          seed_lineage: ["seed-314"],
        },
      },
      finalization_preflight: {
        manifest_required_before_delivery: true,
        approval_required_before_external_submission: true,
        status: "manifest_ready",
        missing: [],
      },
      code_state: {
        commit: "abc123",
        dirty: true,
      },
      command: {
        tool_name: "shell_command",
      },
      runtime: { node: "v22.0.0" },
      dependencies: { pulseed: "0.5.4" },
    });
    expect(manifest.code_state.diff_sha256).toBe(createHash("sha256").update("diff --git a/train.ts b/train.ts\n").digest("hex"));
    expect(manifest.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "submission",
        state_relative_path: "runs/final/submission.csv",
        hash_status: "hashed",
        sha256: createHash("sha256").update("id,target\n1,0\n").digest("hex"),
      }),
      expect.objectContaining({
        label: "metrics",
        hash_status: "hashed",
      }),
    ]));
    expect(manifest.configs[0]).toMatchObject({
      label: "train.json",
      hash_status: "hashed",
    });
    expect(manifest.data_inputs[0]).toMatchObject({
      label: "train.csv",
      hash_status: "hashed",
    });
  });

  it("rejects non-finite evaluator record scores in the manifest schema", () => {
    const baseManifest = {
      schema_version: "runtime-reproducibility-manifest-v1",
      manifest_id: "manifest-evaluator-score",
      generated_at: "2026-04-30T00:00:00.000Z",
      updated_at: "2026-04-30T00:00:00.000Z",
      scope: { run_id: "run:coreloop:manifest-score" },
      finalization_preflight: {
        manifest_required_before_delivery: true,
        approval_required_before_external_submission: true,
        status: "manifest_ready",
        missing: [],
      },
      code_state: { source: "test-fixture" },
      evaluator_records: [{
        evaluator_id: "leaderboard",
        signal: "external",
        source: "public-leaderboard",
        candidate_id: "candidate-final",
        status: "passed",
        score: 0.9692,
        evidence_entry_id: "external-feedback-final",
        linked_manifest_id: "manifest-evaluator-score",
      }],
    };

    expect(RuntimeReproducibilityManifestSchema.safeParse(baseManifest).success).toBe(true);
    expect(RuntimeReproducibilityManifestSchema.safeParse({
      ...baseManifest,
      evaluator_records: [{
        ...baseManifest.evaluator_records[0],
        score: Number.POSITIVE_INFINITY,
      }],
    }).success).toBe(false);
  });

  it("rejects unsafe artifact byte counts in evidence and manifest schemas", () => {
    const unsafeSizeBytes = Number.MAX_SAFE_INTEGER + 1;
    const baseManifest = {
      schema_version: "runtime-reproducibility-manifest-v1",
      manifest_id: "manifest-artifact-size",
      generated_at: "2026-04-30T00:00:00.000Z",
      updated_at: "2026-04-30T00:00:00.000Z",
      scope: { run_id: "run:coreloop:manifest-artifact-size" },
      finalization_preflight: {
        manifest_required_before_delivery: true,
        approval_required_before_external_submission: true,
        status: "manifest_ready",
        missing: [],
      },
      code_state: { source: "test-fixture" },
      artifacts: [{
        label: "final-report",
        state_relative_path: "runs/final/report.md",
        kind: "report",
        size_bytes: 42,
      }],
    };

    expect(RuntimeEvidenceArtifactRefSchema.safeParse({
      label: "unsafe-artifact",
      state_relative_path: "runs/unsafe.bin",
      kind: "other",
      size_bytes: unsafeSizeBytes,
    }).success).toBe(false);
    expect(RuntimeReproducibilityManifestSchema.safeParse(baseManifest).success).toBe(true);
    expect(RuntimeReproducibilityManifestSchema.safeParse({
      ...baseManifest,
      artifacts: [{
        ...baseManifest.artifacts[0],
        size_bytes: unsafeSizeBytes,
      }],
    }).success).toBe(false);
  });

  it("treats malformed or unsafe persisted manifests as missing on load", async () => {
    const store = new RuntimeReproducibilityManifestStore(runtimeRoot);
    const manifestId = "manifest-unsafe-artifact-size";
    const manifestPath = store.pathFor(manifestId);
    await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
    await fsp.writeFile(manifestPath, "{", "utf8");

    await expect(store.load(manifestId)).resolves.toBeNull();

    await fsp.writeFile(manifestPath, `${JSON.stringify({
      schema_version: "runtime-reproducibility-manifest-v1",
      manifest_id: manifestId,
      generated_at: "2026-04-30T00:00:00.000Z",
      updated_at: "2026-04-30T00:00:00.000Z",
      scope: { run_id: "run:coreloop:manifest-unsafe-size" },
      finalization_preflight: {
        manifest_required_before_delivery: true,
        approval_required_before_external_submission: true,
        status: "manifest_ready",
        missing: [],
      },
      code_state: { source: "test-fixture" },
      artifacts: [{
        label: "unsafe-artifact",
        state_relative_path: "runs/unsafe.bin",
        kind: "other",
        size_bytes: Number.MAX_SAFE_INTEGER + 1,
      }],
    })}\n`, "utf8");

    await expect(store.load(manifestId)).resolves.toBeNull();
  });

  it("skips malformed persisted manifests while preserving ready finalization lookup", async () => {
    const store = new RuntimeReproducibilityManifestStore(runtimeRoot);
    const malformedPath = store.pathFor("manifest-malformed");
    const unsafePath = store.pathFor("manifest-unsafe");
    const readyPath = store.pathFor("manifest-ready");
    await fsp.mkdir(path.dirname(readyPath), { recursive: true });
    await fsp.writeFile(malformedPath, "{", "utf8");
    await fsp.writeFile(unsafePath, `${JSON.stringify({
      schema_version: "runtime-reproducibility-manifest-v1",
      manifest_id: "manifest-unsafe",
      generated_at: "2026-04-30T00:00:00.000Z",
      updated_at: "2026-04-30T00:10:00.000Z",
      scope: { run_id: "run:coreloop:manifest-ready" },
      selected_deliverable: {
        label: "final-report",
        state_relative_path: "runs/final/report.md",
        source: "test-fixture",
      },
      finalization_preflight: {
        manifest_required_before_delivery: true,
        approval_required_before_external_submission: true,
        status: "manifest_ready",
        missing: [],
      },
      code_state: { source: "test-fixture" },
      artifacts: [{
        label: "final-report",
        state_relative_path: "runs/final/report.md",
        kind: "report",
        size_bytes: Number.MAX_SAFE_INTEGER + 1,
      }],
    })}\n`, "utf8");
    await fsp.writeFile(readyPath, `${JSON.stringify(RuntimeReproducibilityManifestSchema.parse({
      schema_version: "runtime-reproducibility-manifest-v1",
      manifest_id: "manifest-ready",
      generated_at: "2026-04-30T00:00:00.000Z",
      updated_at: "2026-04-30T00:05:00.000Z",
      scope: { run_id: "run:coreloop:manifest-ready" },
      selected_deliverable: {
        label: "final-report",
        state_relative_path: "runs/final/report.md",
        source: "test-fixture",
      },
      finalization_preflight: {
        manifest_required_before_delivery: true,
        approval_required_before_external_submission: true,
        status: "manifest_ready",
        missing: [],
      },
      code_state: { source: "test-fixture" },
      artifacts: [{
        label: "final-report",
        state_relative_path: "runs/final/report.md",
        kind: "report",
        hash_status: "hashed",
        sha256: "abc123",
        size_bytes: 12,
      }],
    }))}\n`, "utf8");

    const manifest = await store.findReadyForFinalization({
      runId: "run:coreloop:manifest-ready",
      deliverable: { label: "final-report" },
    });

    expect(manifest?.manifest_id).toBe("manifest-ready");
  });

  it("rethrows manifest read errors during finalization lookup", async () => {
    const store = new RuntimeReproducibilityManifestStore(runtimeRoot);
    const manifestPath = store.pathFor("manifest-directory-read-error");
    await fsp.mkdir(manifestPath, { recursive: true });

    await expect(store.findReadyForFinalization({})).rejects.toThrow();
  });

  it("updates the same manifest with linked external evaluator feedback", async () => {
    await fsp.writeFile(path.join(runtimeRoot, "runs/final/submission.csv"), "id,target\n1,0\n", "utf8");
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "candidate-manifest-before-feedback",
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-manifest-update", run_id: "run:coreloop:manifest-update" },
      candidates: [{
        candidate_id: "candidate-final",
        lineage: {
          strategy_family: "catboost_default",
          feature_lineage: ["focus-base"],
          model_lineage: ["catboost"],
          config_lineage: [],
          seed_lineage: ["seed-314"],
          fold_lineage: ["5-fold-oof"],
          postprocess_lineage: [],
        },
        metrics: [{ label: "balanced_accuracy", value: 0.976, direction: "maximize" }],
        artifacts: [{ label: "submission", state_relative_path: "runs/final/submission.csv", kind: "other" }],
        similarity: [],
        disposition: "promoted",
      }],
      summary: "Final candidate ready.",
      outcome: "improved",
    });

    const store = new RuntimeReproducibilityManifestStore(runtimeRoot);
    const before = await store.createOrUpdateForCandidate({
      goalId: "goal-manifest-update",
      runId: "run:coreloop:manifest-update",
      candidateId: "candidate-final",
      codeState: { commit: "abc123", dirty: false },
    });

    expect(before.evaluator_records).toEqual([]);

    await ledger.append({
      id: "external-feedback-final",
      occurred_at: "2026-04-30T00:30:00.000Z",
      kind: "evaluator",
      scope: { goal_id: "goal-manifest-update", run_id: "run:coreloop:manifest-update" },
      evaluators: [{
        evaluator_id: "leaderboard",
        signal: "external",
        source: "public-leaderboard",
        candidate_id: "candidate-final",
        status: "passed",
        score: 0.9692,
        score_label: "balanced_accuracy",
        direction: "maximize",
        observed_at: "2026-04-30T00:31:00.000Z",
        provenance: {
          kind: "external_url",
          url: "https://example.com/submissions/789",
          external_id: "submission-789",
        },
        candidate_snapshot: {
          evidence_entry_id: "candidate-manifest-before-feedback",
          primary_metric_label: "balanced_accuracy",
          local_metrics: [{ label: "balanced_accuracy", value: 0.976, direction: "maximize" }],
        },
        calibration: {
          mode: "calibration_only",
          use_for_selection: true,
          direct_optimization_allowed: false,
          minimum_observations: 1,
          conclusion: "External feedback linked to manifest.",
        },
      }],
      summary: "External evaluator feedback returned.",
    });

    const after = await store.createOrUpdateForCandidate({
      goalId: "goal-manifest-update",
      runId: "run:coreloop:manifest-update",
      candidateId: "candidate-final",
      codeState: { commit: "abc123", dirty: false },
    });

    expect(after.manifest_id).toBe(before.manifest_id);
    expect(after.generated_at).toBe(before.generated_at);
    expect(after.evaluator_records).toContainEqual(expect.objectContaining({
      evaluator_id: "leaderboard",
      signal: "external",
      candidate_id: "candidate-final",
      score: 0.9692,
      evidence_entry_id: "external-feedback-final",
      linked_manifest_id: before.manifest_id,
      provenance: expect.objectContaining({ external_id: "submission-789" }),
      calibration: expect.objectContaining({ mode: "calibration_only" }),
    }));
    expect(after.raw_evidence_refs.map((ref) => ref.entry_id)).toEqual([
      "candidate-manifest-before-feedback",
      "external-feedback-final",
    ]);
  });

  it("creates a manifest for a deliverable artifact without candidate evidence", async () => {
    await fsp.writeFile(path.join(runtimeRoot, "runs/final/report.md"), "# Final report\n", "utf8");
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "deliverable-report-entry",
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "artifact",
      scope: { goal_id: "goal-deliverable", run_id: "run:coreloop:deliverable" },
      artifacts: [{ label: "final-report", state_relative_path: "runs/final/report.md", kind: "report" }],
      summary: "Final report artifact ready.",
      outcome: "continued",
    });

    const manifest = await new RuntimeReproducibilityManifestStore(runtimeRoot).createOrUpdateForCandidate({
      goalId: "goal-deliverable",
      runId: "run:coreloop:deliverable",
      deliverableArtifact: {
        label: "final-report",
        kind: "report",
        state_relative_path: "runs/final/report.md",
        source: "runtime_evidence_ledger",
      },
      codeState: { commit: "def456", dirty: false },
    });

    expect(manifest.selected_candidate).toBeUndefined();
    expect(manifest.selected_deliverable).toMatchObject({
      label: "final-report",
      state_relative_path: "runs/final/report.md",
      source: "runtime_evidence_ledger",
    });
    expect(manifest.artifacts).toContainEqual(expect.objectContaining({
      label: "final-report",
      hash_status: "hashed",
      sha256: createHash("sha256").update("# Final report\n").digest("hex"),
    }));
    expect(manifest.raw_evidence_refs).toContainEqual(expect.objectContaining({
      entry_id: "deliverable-report-entry",
    }));
  });
});
