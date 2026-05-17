import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_EVAL_THRESHOLDS, computeEvalMetrics, mergeMetricAccumulators, thresholdFailures } from "./metrics.js";
import { runEvalScenario, writeEvalFailureArtifacts } from "./runner.js";
import { evalLabScenarios } from "./scenarios.js";
import {
  EvalCoverageSchema,
  EvalRunArtifactSchema,
  type EvalCoverage,
  type EvalRunArtifact,
} from "./types.js";

describe("Long-run Evaluation Lab", () => {
  it("defines a reusable scenario catalog with all required companion-quality coverage", () => {
    expect(evalLabScenarios.length).toBeGreaterThanOrEqual(10);
    const coverage = new Set<EvalCoverage>(evalLabScenarios.flatMap((scenario) => scenario.coverage));
    for (const required of EvalCoverageSchema.options) {
      expect(coverage.has(required)).toBe(true);
    }
    for (const scenario of evalLabScenarios) {
      expect(scenario.fake_controls.network).toEqual({ blocked: true });
      expect(scenario.fake_controls.provider_model).toBe("scripted-local-eval-model");
      expect(scenario.fake_controls.telegram_gateway.platform).toBe("telegram");
      expect(scenario.fake_controls.plugin_capability.capability_id).toContain(scenario.scenario_id);
    }
  });

  it("runs deterministic local scenarios through production caller paths and event-log replay", async () => {
    const results = [];
    for (const scenario of evalLabScenarios) {
      results.push(await runEvalScenario(scenario));
    }

    const metrics = computeEvalMetrics(mergeMetricAccumulators(results.map((result) => result.metricAccumulator)));
    expect(thresholdFailures(metrics, DEFAULT_EVAL_THRESHOLDS)).toEqual([]);

    const productionPaths = new Set(results.flatMap((result) => result.artifact.production_caller_paths));
    for (const requiredPath of [
      "ApprovalBroker.resolveConversationalApproval",
      "ChatRunner.execute",
      "InteractionAuthorityStore.recordDecision",
      "KnowledgeManager.saveAgentMemory",
      "OutboxStore.append",
      "RuntimeEventLogStore.rebuildProjections",
      "ScheduleEngine.tick",
      "ToolExecutor.execute",
      "runUserMemoryOperation",
    ]) {
      expect(productionPaths.has(requiredPath)).toBe(true);
    }

    for (const result of results) {
      expect(EvalRunArtifactSchema.parse(result.artifact)).toBeTruthy();
      expect(result.artifact.replay_summary).toMatchObject({
        event_log_rebuild_path: "RuntimeEventLogStore.rebuildProjections",
        replay_equivalent: true,
      });
      expect(result.artifact.runtime_event_refs.length).toBeGreaterThan(0);
      expect(result.artifact.runtime_graph_refs.length).toBeGreaterThan(0);
      await expect(fsp.access(result.artifactPath)).resolves.toBeUndefined();
    }
  });

  it("exports PR-blocking failure artifacts with the reproduction command", async () => {
    const artifact = EvalRunArtifactSchema.parse({
      schema_version: "pulseed.eval-lab.run-artifact/v1",
      scenario_id: "eval-lab-artifact-export-contract",
      seed: "eval-lab-artifact-seed",
      started_at: "2026-05-17T00:00:00.000Z",
      fake_clock: {
        started_at: "2026-05-17T00:00:00.000Z",
        ended_at: "2026-05-17T00:00:00.000Z",
      },
      runtime_event_refs: ["runtime-event:artifact"],
      runtime_graph_refs: ["runtime-graph:artifact"],
      surface_projections: [{ status: "failed" }],
      operator_projections: [{ status: "failed", raw_ref: "runtime-event:artifact" }],
      transcript: [{ role: "assistant", content: "failure" }],
      replay_summary: { replay_equivalent: false },
      metrics: {
        overreach_rate: 1,
        missed_help_rate: 0,
        duplicate_side_effect_rate: 0,
        stale_action_rejection_rate: 1,
        memory_retrieval_hit_rate: 1,
        corrected_memory_reuse_rate: 1,
        sensitive_leak_rate: 0,
        approval_bypass_rate: 0,
        replay_equivalence_rate: 0,
        scenario_pass_rate: 0,
      },
      failures: [{ kind: "metric_threshold", message: "overreach_rate above threshold" }],
      reproduction_command: "npm run test:eval-lab -- --run tests/eval-lab/eval-lab.test.ts -t eval-lab-artifact-export-contract",
      production_caller_paths: ["RuntimeEventLogStore.rebuildProjections"],
    } satisfies EvalRunArtifact);
    const dir = await writeEvalFailureArtifacts(artifact);
    try {
      for (const fileName of [
        "scenario.json",
        "normal-projection.json",
        "operator-projection.json",
        "event-log-replay-trace.json",
        "transcript.json",
        "metrics.json",
        "reproduction-command.txt",
      ]) {
        await expect(fsp.access(path.join(dir, fileName))).resolves.toBeUndefined();
      }
      await expect(fsp.readFile(path.join(dir, "reproduction-command.txt"), "utf8"))
        .resolves.toContain("npm run test:eval-lab");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
