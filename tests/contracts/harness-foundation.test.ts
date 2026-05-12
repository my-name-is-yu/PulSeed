import { describe, expect, it } from "vitest";
import { exportArtifactTree } from "../harness/artifact-exporter.js";
import { HarnessClock } from "../harness/fake-clock.js";
import { runGoldenTrace } from "../harness/golden-trace-runner.js";
import { createIsolatedStateRoot } from "../harness/isolated-state-root.js";
import { installNoNetworkGuard } from "../harness/network-guard.js";
import { runReplayFixture } from "../harness/replay-runner.js";
import { RuntimeFixtureBuilder } from "../harness/runtime-fixture-builder.js";
import { ScriptedLlm } from "../harness/scripted-llm.js";
import { ScriptedToolRunner } from "../harness/scripted-tools.js";
import type { ReplayFixture } from "../harness/types.js";

describe("test redesign harness foundation", () => {
  it("keeps fake clock output deterministic", () => {
    const clock = new HarnessClock("2026-05-13T00:00:00.000Z");
    expect(clock.nowIso()).toBe("2026-05-13T00:00:00.000Z");
    expect(clock.advance(1500)).toBe("2026-05-13T00:00:01.500Z");
  });

  it("creates isolated state roots and exports deterministic artifact trees", async () => {
    const root = await createIsolatedStateRoot("harness-foundation", {
      "state/runtime.json": { ok: true },
    });
    try {
      await root.writeJson("runtime/event.json", { type: "ready" });
      const tree = await exportArtifactTree(root.root);
      expect(tree.map((entry) => entry.path)).toEqual([
        "pulseed-home",
        "runtime",
        "runtime/event.json",
        "state",
        "state/runtime.json",
        "workspace",
      ]);
      expect(root.env.PULSEED_HOME).toBe(root.pulseedHome);
    } finally {
      await root.cleanup();
    }
  });

  it("rejects real provider usage by default", () => {
    expect(() => new ScriptedLlm([], { allowRealLlm: true })).toThrow(/Real LLM/);
  });

  it("blocks network access with the default network guard", async () => {
    const guard = installNoNetworkGuard();
    try {
      await expect(fetch("https://example.com")).rejects.toThrow(/Network access is disabled/);
    } finally {
      guard.restore();
    }
  });

  it("returns denied tool envelopes before approved mutation artifacts", () => {
    const denied = new ScriptedToolRunner([{
      name: "write_file",
      approval_required: true,
      approved: false,
      result: { success: true },
    }]);
    expect(denied.run("write_file")).toMatchObject({ success: false, reason: "approval_denied" });
    expect(denied.mutationArtifacts()).toEqual([]);

    const approved = new ScriptedToolRunner([{
      name: "write_file",
      approval_required: true,
      approved: true,
      result: { success: true },
      side_effect_artifact: { path: "workspace/file.txt" },
    }]);
    expect(approved.run("write_file")).toEqual({ success: true });
    expect(approved.mutationArtifacts()).toEqual([{
      tool: "write_file",
      args: {},
      artifact: { path: "workspace/file.txt" },
    }]);
  });

  it("runs a normalized golden trace fixture", async () => {
    const fixture = new RuntimeFixtureBuilder(
      "harness_foundation_pending_fixture",
      "harness",
      "pending runner gate",
      "unwired harness foundation boundary",
    )
      .event({ type: "lifecycle_start", at: "2026-05-13T00:00:00.000Z", visible: false, payload: { turn_id: "turn-1" } })
      .event({ type: "assistant_delta", at: "2026-05-13T00:00:00.000Z", visible: true, payload: { text: "hello" } })
      .event({ type: "assistant_final", at: "2026-05-13T00:00:00.000Z", visible: true, payload: { text: "hello" } })
      .final({ text: "hello" })
      .controlDb({ runtime_operations: [] })
      .build();

    const result = await runGoldenTrace(fixture);
    expect(result.control_db_export.runner).toMatchObject({ status: "pending_real_runner" });
    expect(result.events).not.toEqual(fixture.input.steps);
    expect(result.events.map((event) => event.type)).toContain("pending_real_runner");
    expect(result.surface.visible_events.map((event) => event.type)).toContain("assistant_final");
  });

  it("runs a replay fixture and requires fresh/restart equivalence", async () => {
    const fixture: ReplayFixture = {
      schema_version: "pulseed.replay.v1",
      contract_name: "harness_foundation_pending_replay",
      domain: "harness",
      p0_failure_mode: "pending replay runner gate",
      production_boundary: "unwired harness replay boundary",
      input: {
        entrypoint: "runtime startup/replay",
        fake_now: "2026-05-13T00:00:00.000Z",
        seed: "harness_foundation_pending_replay",
      },
      initial_state: {
        "state/pulseed-control.json": { schema_version: 999 },
      },
      expected: {
        fresh_state: { status: "blocked", reason: "schema_ahead" },
        restarted_state: { status: "blocked", reason: "schema_ahead" },
        audit: [{ disposition: "blocked", reason: "schema_ahead" }],
        artifact_tree: [],
      },
    };

    const result = await runReplayFixture(fixture);
    expect(result.fresh_state).toEqual(result.restarted_state);
    expect(result.fresh_state.runner).toMatchObject({ status: "pending_real_runner" });
    expect(result.audit[0]).toMatchObject({ disposition: "pending_real_runner" });
  });
});
