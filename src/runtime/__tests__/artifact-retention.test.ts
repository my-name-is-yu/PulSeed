import { describe, expect, it } from "vitest";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { makeTempDir } from "../../../tests/helpers/temp-dir.js";
import { summarizeArtifactRetention } from "../store/artifact-retention.js";
import { RuntimeEvidenceLedger, type RuntimeEvidenceEntry } from "../store/evidence-ledger.js";
import { RuntimeReproducibilityManifestSchema, RuntimeReproducibilityManifestStore } from "../store/reproducibility-manifest.js";

describe("artifact retention planning", () => {
  it("protects best, robust, near-miss, and final artifacts while gating cleanup candidates", () => {
    const summary = summarizeArtifactRetention([
      entry({
        id: "candidate-entry",
        candidates: [
          {
            candidate_id: "raw-best",
            lineage: candidateLineage("catboost"),
            metrics: [{ label: "score", value: 0.98, direction: "maximize" }],
            artifacts: [{ label: "raw-best", state_relative_path: "runs/raw/submission.csv", kind: "other", size_bytes: 100 }],
            similarity: [],
            disposition: "retained",
          },
          {
            candidate_id: "robust-best",
            lineage: candidateLineage("linear-stack"),
            metrics: [{ label: "score", value: 0.96, direction: "maximize" }],
            artifacts: [{ label: "robust-best", state_relative_path: "runs/robust/submission.csv", kind: "other", size_bytes: 120 }],
            similarity: [],
            robustness: {
              stability_score: 0.94,
              diversity_score: 0.8,
              evidence_confidence: 0.9,
              weak_dimensions: [],
              provenance_refs: [],
            },
            disposition: "retained",
          },
          {
            candidate_id: "near-miss",
            lineage: candidateLineage("lightgbm"),
            metrics: [{ label: "score", value: 0.93, direction: "maximize" }],
            artifacts: [{ label: "near-miss", state_relative_path: "runs/near/submission.csv", kind: "other", size_bytes: 90 }],
            similarity: [],
            near_miss: {
              status: "retained",
              reason_to_keep: ["novelty"],
              weak_dimensions: [],
              complementary_candidate_ids: [],
              evidence_refs: [],
            },
            disposition: "retained",
          },
        ],
      }),
      entry({
        id: "artifact-entry",
        kind: "artifact",
        occurred_at: "2026-04-30T00:10:00.000Z",
        artifacts: [
          { label: "final-report", state_relative_path: "reports/final.md", kind: "report", retention_class: "final_deliverable", size_bytes: 80 },
          { label: "smoke-cache", state_relative_path: "runs/smoke/cache.bin", kind: "other", retention_class: "low_value_smoke", size_bytes: 500 },
        ],
      }),
    ] satisfies RuntimeEvidenceEntry[]);

    expect(summary.total_artifacts).toBe(5);
    expect(summary.protected_count).toBe(4);
    expect(summary.by_retention_class.best_candidate).toBe(1);
    expect(summary.by_retention_class.robust_candidate).toBe(1);
    expect(summary.by_retention_class.near_miss).toBe(1);
    expect(summary.by_retention_class.final_deliverable).toBe(1);
    expect(summary.cleanup_plan).toMatchObject({
      mode: "plan_only",
      destructive_actions_default: "approval_required",
    });
    expect(summary.cleanup_plan.actions).toContainEqual(expect.objectContaining({
      label: "smoke-cache",
      cleanup_action: "delete_candidate",
      destructive: true,
      approval_required: true,
    }));
  });

  it("protects artifacts linked from reproducibility manifests", () => {
    const manifest = RuntimeReproducibilityManifestSchema.parse({
      schema_version: "runtime-reproducibility-manifest-v1",
      manifest_id: "goal:goal-retention:deliverable:final-report",
      generated_at: "2026-04-30T00:00:00.000Z",
      updated_at: "2026-04-30T00:00:00.000Z",
      scope: { goal_id: "goal-retention" },
      selected_deliverable: {
        label: "final-report",
        state_relative_path: "runs/final/report.md",
        source: "runtime_evidence_ledger",
      },
      finalization_preflight: {
        manifest_required_before_delivery: true,
        approval_required_before_external_submission: true,
        status: "manifest_ready",
        missing: [],
      },
      code_state: { commit: "abc123", dirty: false, source: "test" },
      artifacts: [{ label: "final-report", state_relative_path: "runs/final/report.md", kind: "report", hash_status: "hashed" }],
    });

    const summary = summarizeArtifactRetention([
      entry({
        id: "report-entry",
        kind: "artifact",
        artifacts: [{ label: "final-report", state_relative_path: "runs/final/report.md", kind: "report", retention_class: "low_value_smoke" }],
      }),
    ] satisfies RuntimeEvidenceEntry[], { manifests: [manifest] });

    expect(summary.cleanup_plan.actions).toContainEqual(expect.objectContaining({
      label: "final-report",
      retention_class: "reproducibility_critical",
      protected: true,
      cleanup_action: "protect",
      approval_required: false,
      protection_reasons: expect.arrayContaining(["reproducibility_manifest"]),
    }));
  });

  it("keeps artifact retention byte totals within safe integer precision", () => {
    const summary = summarizeArtifactRetention([
      entry({
        id: "large-artifact-entry",
        artifacts: [{
          label: "large-artifact",
          state_relative_path: "runs/large.bin",
          kind: "other",
          size_bytes: Number.MAX_SAFE_INTEGER,
        }],
      }),
      entry({
        id: "overflow-artifact-entry",
        artifacts: [{
          label: "overflow-artifact",
          state_relative_path: "runs/overflow.bin",
          kind: "other",
          size_bytes: 1,
        }],
      }),
    ]);

    expect(summary.total_size_bytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(summary.unknown_size_count).toBe(1);
  });

  it("does not let explicit cleanup classes override protected candidate or final artifacts", () => {
    const summary = summarizeArtifactRetention([
      entry({
        id: "protected-overrides",
        kind: "artifact",
        outcome: "improved",
        artifacts: [{
          label: "final-report",
          state_relative_path: "reports/final.md",
          kind: "report",
          retention_class: "low_value_smoke",
        }],
        candidates: [{
          candidate_id: "near-miss",
          lineage: candidateLineage("tabnet"),
          metrics: [{ label: "score", value: 0.91, direction: "maximize" }],
          artifacts: [{
            label: "near-miss-submission",
            state_relative_path: "runs/near/submission.csv",
            kind: "other",
            retention_class: "duplicate_superseded",
          }],
          similarity: [],
          near_miss: {
            status: "retained",
            reason_to_keep: ["ensemble_potential"],
            weak_dimensions: [],
            complementary_candidate_ids: [],
            evidence_refs: [],
          },
          disposition: "retained",
        }],
      }),
    ]);

    expect(summary.cleanup_plan.actions).toContainEqual(expect.objectContaining({
      label: "final-report",
      retention_class: "final_deliverable",
      cleanup_action: "protect",
      destructive: false,
    }));
    expect(summary.cleanup_plan.actions).toContainEqual(expect.objectContaining({
      label: "near-miss-submission",
      retention_class: "near_miss",
      cleanup_action: "protect",
      destructive: false,
    }));
  });

  it("does not infer destructive cleanup class from artifact label or path substrings", () => {
    const summary = summarizeArtifactRetention([
      entry({
        id: "substring-only-artifacts",
        kind: "artifact",
        artifacts: [
          { label: "smoke-cache", state_relative_path: "runs/smoke/cache.bin", kind: "other", size_bytes: 500 },
          { label: "tmp-intermediate", state_relative_path: "tmp/intermediate/output.bin", kind: "other", size_bytes: 250 },
        ],
      }),
    ]);

    expect(summary.cleanup_plan.actions).toContainEqual(expect.objectContaining({
      label: "smoke-cache",
      retention_class: "other",
      retention_basis: "unknown",
      cleanup_action: "review",
      destructive: false,
      approval_required: false,
    }));
    expect(summary.cleanup_plan.actions).toContainEqual(expect.objectContaining({
      label: "tmp-intermediate",
      retention_class: "other",
      retention_basis: "unknown",
      cleanup_action: "review",
      destructive: false,
      approval_required: false,
    }));
  });

  it("uses explicit typed cleanup classes regardless of neutral artifact names", () => {
    const summary = summarizeArtifactRetention([
      entry({
        id: "typed-cleanup-artifact",
        kind: "artifact",
        artifacts: [
          { label: "run-output", state_relative_path: "runs/a/output.bin", kind: "other", retention_class: "cache_intermediate" },
        ],
      }),
    ]);

    expect(summary.cleanup_plan.actions).toContainEqual(expect.objectContaining({
      label: "run-output",
      retention_class: "cache_intermediate",
      retention_basis: "explicit_retention_class",
      cleanup_action: "delete_candidate",
      destructive: true,
      approval_required: true,
    }));
  });

  it("uses manifest protection in the runtime evidence summary path", async () => {
    const runtimeRoot = makeTempDir("pulseed-retention-runtime-");
    try {
      await fsp.mkdir(path.join(runtimeRoot, "runs/final"), { recursive: true });
      await fsp.writeFile(path.join(runtimeRoot, "runs/final/report.md"), "# Final report\n", "utf8");
      const ledger = new RuntimeEvidenceLedger(runtimeRoot);
      await ledger.append({
        id: "low-value-report",
        occurred_at: "2026-04-30T00:00:00.000Z",
        kind: "artifact",
        scope: { goal_id: "goal-retention" },
        artifacts: [{
          label: "final-report",
          state_relative_path: "runs/final/report.md",
          kind: "report",
          retention_class: "low_value_smoke",
        }],
        summary: "Report artifact.",
      });
      await new RuntimeReproducibilityManifestStore(runtimeRoot).createOrUpdateForCandidate({
        goalId: "goal-retention",
        deliverableArtifact: {
          label: "final-report",
          kind: "report",
          state_relative_path: "runs/final/report.md",
          source: "runtime_evidence_ledger",
        },
        codeState: { commit: "abc123", dirty: false },
      });

      const summary = await ledger.summarizeGoal("goal-retention");

      expect(summary.artifact_retention.cleanup_plan.actions).toContainEqual(expect.objectContaining({
        label: "final-report",
        retention_class: "reproducibility_critical",
        cleanup_action: "protect",
        destructive: false,
      }));
    } finally {
      await fsp.rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("does not read unrelated generated manifests when summarizing a scoped goal", async () => {
    const runtimeRoot = makeTempDir("pulseed-retention-runtime-scoped-manifest-");
    try {
      await fsp.mkdir(path.join(runtimeRoot, "runs/final"), { recursive: true });
      await fsp.writeFile(path.join(runtimeRoot, "runs/final/report.md"), "# Final report\n", "utf8");
      const manifestDir = path.join(runtimeRoot, "reproducibility-manifests");
      await fsp.mkdir(manifestDir, { recursive: true });
      for (let index = 0; index < 50; index += 1) {
        await fsp.writeFile(
          path.join(manifestDir, `goal%3Aunrelated-${index}%3Adeliverable%3Afinal-report.json`),
          "{",
          "utf8",
        );
      }

      const ledger = new RuntimeEvidenceLedger(runtimeRoot);
      await ledger.append({
        id: "low-value-report",
        occurred_at: "2026-04-30T00:00:00.000Z",
        kind: "artifact",
        scope: { goal_id: "goal-retention-scoped" },
        artifacts: [{
          label: "final-report",
          state_relative_path: "runs/final/report.md",
          kind: "report",
          retention_class: "low_value_smoke",
        }],
        summary: "Report artifact.",
      });
      await new RuntimeReproducibilityManifestStore(runtimeRoot).createOrUpdateForCandidate({
        goalId: "goal-retention-scoped",
        deliverableArtifact: {
          label: "final-report",
          kind: "report",
          state_relative_path: "runs/final/report.md",
          source: "runtime_evidence_ledger",
        },
        codeState: { commit: "abc123", dirty: false },
      });

      const summary = await ledger.summarizeGoal("goal-retention-scoped");

      expect(summary.artifact_retention.cleanup_plan.actions).toContainEqual(expect.objectContaining({
        label: "final-report",
        retention_class: "reproducibility_critical",
      }));
    } finally {
      await fsp.rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("includes run-prefixed manifests in goal summaries when they share the goal scope", async () => {
    const runtimeRoot = makeTempDir("pulseed-retention-runtime-run-goal-manifest-");
    try {
      await fsp.mkdir(path.join(runtimeRoot, "runs/final"), { recursive: true });
      await fsp.writeFile(path.join(runtimeRoot, "runs/final/report.md"), "# Final report\n", "utf8");
      const ledger = new RuntimeEvidenceLedger(runtimeRoot);
      await ledger.append({
        id: "run-report",
        occurred_at: "2026-04-30T00:00:00.000Z",
        kind: "artifact",
        scope: { goal_id: "goal-retention-run", run_id: "run-retention" },
        artifacts: [{
          label: "run-final-report",
          state_relative_path: "runs/final/report.md",
          kind: "report",
          retention_class: "low_value_smoke",
        }],
        summary: "Run report artifact.",
      });
      await new RuntimeReproducibilityManifestStore(runtimeRoot).createOrUpdateForCandidate({
        goalId: "goal-retention-run",
        runId: "run-retention",
        deliverableArtifact: {
          label: "run-final-report",
          kind: "report",
          state_relative_path: "runs/final/report.md",
          source: "runtime_evidence_ledger",
        },
        codeState: { commit: "abc123", dirty: false },
      });

      const summary = await ledger.summarizeGoal("goal-retention-run");

      expect(summary.artifact_retention.cleanup_plan.actions).toContainEqual(expect.objectContaining({
        label: "run-final-report",
        retention_class: "reproducibility_critical",
      }));
    } finally {
      await fsp.rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("matches generated manifest filenames for non-safe scope ids", async () => {
    const runtimeRoot = makeTempDir("pulseed-retention-runtime-safe-scope-");
    try {
      await fsp.mkdir(path.join(runtimeRoot, "runs/final"), { recursive: true });
      await fsp.writeFile(path.join(runtimeRoot, "runs/final/report.md"), "# Final report\n", "utf8");
      const goalId = "goal retention/日本語";
      const ledger = new RuntimeEvidenceLedger(runtimeRoot);
      await ledger.append({
        id: "safe-scope-report",
        occurred_at: "2026-04-30T00:00:00.000Z",
        kind: "artifact",
        scope: { goal_id: goalId },
        artifacts: [{
          label: "safe-scope-report",
          state_relative_path: "runs/final/report.md",
          kind: "report",
          retention_class: "low_value_smoke",
        }],
        summary: "Report artifact.",
      });
      await new RuntimeReproducibilityManifestStore(runtimeRoot).createOrUpdateForCandidate({
        goalId,
        deliverableArtifact: {
          label: "safe-scope-report",
          kind: "report",
          state_relative_path: "runs/final/report.md",
          source: "runtime_evidence_ledger",
        },
        codeState: { commit: "abc123", dirty: false },
      });

      const summary = await ledger.summarizeGoal(goalId);

      expect(summary.artifact_retention.cleanup_plan.actions).toContainEqual(expect.objectContaining({
        label: "safe-scope-report",
        retention_class: "reproducibility_critical",
      }));
    } finally {
      await fsp.rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("keeps substring-only artifacts non-destructive in the runtime evidence summary path", async () => {
    const runtimeRoot = makeTempDir("pulseed-retention-runtime-substrings-");
    try {
      const ledger = new RuntimeEvidenceLedger(runtimeRoot);
      await ledger.append({
        id: "substring-only-artifact",
        occurred_at: "2026-04-30T00:00:00.000Z",
        kind: "artifact",
        scope: { goal_id: "goal-retention-substrings" },
        artifacts: [{
          label: "smoke-cache-output",
          state_relative_path: "tmp/smoke/cache-output.bin",
          kind: "other",
        }],
        summary: "Artifact with cleanup-looking words in protocol path.",
      });

      const summary = await ledger.summarizeGoal("goal-retention-substrings");

      expect(summary.artifact_retention.cleanup_plan.actions).toContainEqual(expect.objectContaining({
        label: "smoke-cache-output",
        retention_class: "other",
        retention_basis: "unknown",
        cleanup_action: "review",
        destructive: false,
        approval_required: false,
      }));
    } finally {
      await fsp.rm(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("does not crash on manifest JSON that relies on defaults or contains invalid artifact refs", async () => {
    const runtimeRoot = makeTempDir("pulseed-retention-runtime-defaults-");
    try {
      const ledger = new RuntimeEvidenceLedger(runtimeRoot);
      await ledger.append({
        id: "report-entry",
        occurred_at: "2026-04-30T00:00:00.000Z",
        kind: "artifact",
        scope: { goal_id: "goal-retention-defaults" },
        artifacts: [{ label: "summary", state_relative_path: "runs/summary.md", kind: "report" }],
        summary: "Report artifact.",
      });
      await fsp.mkdir(path.join(runtimeRoot, "reproducibility-manifests"), { recursive: true });
      await fsp.writeFile(path.join(runtimeRoot, "reproducibility-manifests", "manifest-defaults.json"), JSON.stringify({
        schema_version: "runtime-reproducibility-manifest-v1",
        manifest_id: "manifest-defaults",
        generated_at: "2026-04-30T00:00:00.000Z",
        updated_at: "2026-04-30T00:00:00.000Z",
        scope: { goal_id: "goal-retention-defaults" },
        finalization_preflight: {
          manifest_required_before_delivery: true,
          approval_required_before_external_submission: true,
          status: "manifest_ready",
          missing: [],
        },
        code_state: { commit: "abc123", dirty: false, source: "test" },
      }), "utf8");
      await fsp.writeFile(path.join(runtimeRoot, "reproducibility-manifests", "manifest-invalid-artifacts.json"), JSON.stringify({
        schema_version: "runtime-reproducibility-manifest-v1",
        manifest_id: "manifest-invalid-artifacts",
        generated_at: "2026-04-30T00:00:00.000Z",
        updated_at: "2026-04-30T00:00:00.000Z",
        scope: { goal_id: "goal-retention-defaults" },
        finalization_preflight: {
          manifest_required_before_delivery: true,
          approval_required_before_external_submission: true,
          status: "manifest_ready",
          missing: [],
        },
        code_state: { commit: "abc123", dirty: false, source: "test" },
        artifacts: [null, "bad-ref", { label: "valid-manifest-ref", state_relative_path: "runs/valid.md", kind: "report" }],
      }), "utf8");

      await expect(ledger.summarizeGoal("goal-retention-defaults")).resolves.toMatchObject({
        artifact_retention: { total_artifacts: 1 },
      });
    } finally {
      await fsp.rm(runtimeRoot, { recursive: true, force: true });
    }
  });
});

function entry(overrides: Partial<RuntimeEvidenceEntry>): RuntimeEvidenceEntry {
  return {
    schema_version: "runtime-evidence-entry-v1",
    id: "entry",
    occurred_at: "2026-04-30T00:00:00.000Z",
    kind: "metric",
    scope: { goal_id: "goal-retention" },
    metrics: [],
    evaluators: [],
    research: [],
    dream_checkpoints: [],
    divergent_exploration: [],
    candidates: [],
    artifacts: [],
    raw_refs: [],
    ...overrides,
  };
}

function candidateLineage(strategyFamily: string) {
  return {
    strategy_family: strategyFamily,
    feature_lineage: [],
    model_lineage: [],
    config_lineage: [],
    seed_lineage: [],
    fold_lineage: [],
    postprocess_lineage: [],
  };
}
