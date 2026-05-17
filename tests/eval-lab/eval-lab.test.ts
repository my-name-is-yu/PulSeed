import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { longRunEvalLabScenarios } from "./scenarios.js";
import {
  evalLabFailureArtifactFiles,
  runArtifactPath,
  runEvalLabScenario,
  runEvalLabSuite,
} from "./runner.js";
import { EvalRunArtifactSchema, type EvalLabScenario } from "./types.js";

describe("long-run evaluation lab", () => {
  it("runs deterministic long-run scenarios through typed artifacts, metrics, and event-log replay", async () => {
    const result = await runEvalLabSuite(longRunEvalLabScenarios);

    expect(result.artifacts).toHaveLength(12);
    expect(result.artifacts.map((artifact) => artifact.scenario_id)).toEqual([
      "multi_turn_chat_with_memory_use",
      "corrected_memory_reuse",
      "stale_memory_rejected",
      "schedule_wake_after_fake_time_advance",
      "daemon_restart_during_pending_approval",
      "duplicate_notification_delivery_prevention_after_replay",
      "tool_capability_failure_and_recovery",
      "quiet_mode_proactivity_hold",
      "overreach_feedback_lowers_future_intervention",
      "missed_help_scenario_detection",
      "stale_action_binding_rejection",
      "gateway_telegram_projection_consistency",
    ]);
    for (const artifact of result.artifacts) {
      expect(EvalRunArtifactSchema.parse(artifact)).toBeTruthy();
      expect(await fsp.readFile(runArtifactPath(artifact.scenario_id), "utf8")).toContain(artifact.scenario_id);
      expect(artifact.reproduction_command).toContain("npm run test:eval-lab");
      expect(artifact.replay_summary.source).toBe("RuntimeEventLogStore.rebuildProjections");
    }

    const coverage = new Set(longRunEvalLabScenarios.flatMap((scenario) => scenario.covers));
    expect(Array.from(coverage)).toEqual(expect.arrayContaining([
      "fake user turns",
      "fake provider/model",
      "fake Telegram/gateway",
      "fake filesystem/workspace",
      "fake clock",
      "fake network",
      "fake plugin/MCP/capability",
      "daemon restart",
      "event-log replay",
      "schedule wake",
      "approval response",
      "memory correction",
      "feedback",
      "quiet mode",
      "proactivity control",
      "missed-help detection",
      "stale action binding rejection",
      "surface projection",
    ]));

    expect(result.metrics.duplicate_side_effect_rate).toBe(0);
    expect(result.metrics.sensitive_leak_rate).toBe(0);
    expect(result.metrics.approval_bypass_rate).toBe(0);
    expect(result.metrics.corrected_memory_reuse_rate).toBe(1);
    expect(result.metrics.replay_equivalence_rate).toBe(1);
    expect(result.metrics.overreach_rate).toBeGreaterThan(0);
    expect(result.metrics.missed_help_rate).toBeGreaterThan(0);
    expect(result.metrics.scenario_pass_rate).toBe(1);
  });

  it("writes eval failure artifacts with normal/operator projections, replay trace, transcript, metrics, and repro command", async () => {
    const scenario: EvalLabScenario = {
      schema_version: "pulseed.eval-lab.scenario/v1",
      scenario_id: "forced_failure_artifact_export",
      seed: "seed:forced_failure_artifact_export",
      title: "Forced failure artifact export",
      covers: ["failure artifact export"],
      started_at: "2026-05-17T00:00:00.000Z",
      steps: [{
        kind: "force_failure",
        id: "force-failure",
        input: { message: "forced artifact export" },
      }],
      model_script: [],
      tool_script: [],
      expectations: {
        metric_thresholds: { minimums: {}, maximums: {} },
        required_event_types: [],
        required_runtime_graph_edge_kinds: [],
        required_failure_codes: [],
      },
    };
    await fsp.rm(path.resolve("tmp", "eval-failures", scenario.scenario_id), { recursive: true, force: true });

    await expect(runEvalLabScenario(scenario)).rejects.toThrow(/forced artifact export/);

    for (const fileName of evalLabFailureArtifactFiles) {
      const stat = await fsp.stat(path.resolve("tmp", "eval-failures", scenario.scenario_id, fileName));
      expect(stat.isFile()).toBe(true);
    }
  });
});
