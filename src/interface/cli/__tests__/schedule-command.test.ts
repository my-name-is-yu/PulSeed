import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cmdSchedule } from "../commands/schedule.js";
import { ScheduleEngine } from "../../../runtime/schedule-engine.js";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import type { StateManager } from "../../../base/state/state-manager.js";

function makeStateManager(baseDir: string): StateManager {
  return {
    getBaseDir: () => baseDir,
  } as unknown as StateManager;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cmdSchedule", () => {
  it("adds a preset-backed schedule entry", async () => {
    const tempDir = makeTempDir("schedule-command-");
    try {
      vi.spyOn(console, "log").mockImplementation(() => {});

      await cmdSchedule(makeStateManager(tempDir), ["add", "--preset", "daily_brief"]);

      const engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      expect(engine.getEntries()).toHaveLength(1);
      expect(engine.getEntries()[0]?.metadata).toEqual(expect.objectContaining({
        source: "preset",
        preset_key: "daily_brief",
      }));
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("passes probe_dimension through the goal_probe preset", async () => {
    const tempDir = makeTempDir("schedule-command-goal-probe-");
    try {
      vi.spyOn(console, "log").mockImplementation(() => {});

      await cmdSchedule(makeStateManager(tempDir), [
        "add",
        "--preset",
        "goal_probe",
        "--data-source-id",
        "db-source",
        "--probe-dimension",
        "open_issue_count",
        "--threshold-value",
        "12.5",
      ]);

      const engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      expect(engine.getEntries()).toHaveLength(1);
      expect(engine.getEntries()[0]?.probe).toEqual(expect.objectContaining({
        data_source_id: "db-source",
        probe_dimension: "open_issue_count",
        change_detector: expect.objectContaining({
          threshold_value: 12.5,
        }),
      }));
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("applies a dream suggestion through the CLI flow", async () => {
    const tempDir = makeTempDir("schedule-command-suggestion-");
    try {
      vi.spyOn(console, "log").mockImplementation(() => {});
      await fs.mkdir(path.join(tempDir, "dream"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, "dream", "schedule-suggestions.json"),
        JSON.stringify({
          generated_at: "2026-04-08T00:00:00.000Z",
          suggestions: [
            {
              id: "dream-1",
              type: "goal_trigger",
              goalId: "goal-123",
              confidence: 0.9,
              reason: "Morning runs perform best.",
              proposal: "0 9 * * *",
              status: "pending",
            },
          ],
        }),
        "utf8",
      );

      await cmdSchedule(makeStateManager(tempDir), ["suggestions", "apply", "dream-1"]);

      const engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      expect(engine.getEntries()).toHaveLength(1);
      expect(engine.getEntries()[0]?.goal_trigger?.goal_id).toBe("goal-123");
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("prints schedule token cost from history", async () => {
    const tempDir = makeTempDir("schedule-command-cost-");
    try {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      const entry = await engine.addEntry({
        name: "Daily digest",
        layer: "cron",
        trigger: { type: "interval", seconds: 3600 },
        metadata: {
          source: "manual",
          dependency_hints: [],
        },
        cron: {
          job_kind: "prompt",
          prompt_template: "Summarize work",
          context_sources: [],
          output_format: "notification",
          max_tokens: 500,
        },
      });
      const now = new Date().toISOString();
      await fs.writeFile(
        path.join(tempDir, "schedule-history.json"),
        JSON.stringify([
          {
            id: "11111111-1111-4111-8111-111111111111",
            entry_id: entry.id,
            entry_name: entry.name,
            layer: entry.layer,
            reason: "manual_run",
            attempt: 0,
            scheduled_for: now,
            started_at: now,
            finished_at: now,
            retry_at: null,
            status: "ok",
            duration_ms: 10,
            fired_at: now,
            tokens_used: 42,
            escalated_to: null,
          },
        ]),
        "utf8",
      );

      await cmdSchedule(makeStateManager(tempDir), ["cost", "--period", "7d"]);

      expect(logSpy.mock.calls.flat().join("\n")).toContain("tokens:     42");
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("pauses, resumes, and edits a schedule entry", async () => {
    const tempDir = makeTempDir("schedule-command-lifecycle-");
    try {
      vi.spyOn(console, "log").mockImplementation(() => {});

      await cmdSchedule(makeStateManager(tempDir), [
        "add",
        "--name",
        "custom-check",
        "--type",
        "custom",
        "--command",
        "echo ok",
        "--interval",
        "60",
      ]);

      let engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      const id = engine.getEntries()[0]!.id;

      await cmdSchedule(makeStateManager(tempDir), ["pause", id.slice(0, 8)]);
      engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      expect(engine.getEntries()[0]!.enabled).toBe(false);

      await cmdSchedule(makeStateManager(tempDir), ["resume", id.slice(0, 8)]);
      engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      expect(engine.getEntries()[0]!.enabled).toBe(true);

      await cmdSchedule(makeStateManager(tempDir), [
        "edit",
        id.slice(0, 8),
        "--name",
        "renamed-check",
        "--cron",
        "0 9 * * *",
        "--timezone",
        "Asia/Tokyo",
        "--disabled",
      ]);

      engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      expect(engine.getEntries()[0]).toEqual(expect.objectContaining({
        name: "renamed-check",
        enabled: false,
        trigger: { type: "cron", expression: "0 9 * * *", timezone: "Asia/Tokyo" },
      }));
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it.each([
    ["heartbeat interval", ["add", "--name", "invalid", "--type", "custom", "--command", "echo ok", "--interval", "60s"], "--interval must be a positive integer"],
    ["bare heartbeat interval", ["add", "--name", "invalid", "--interval"], "--interval must be a positive integer"],
    ["missing http url", ["add", "--name", "invalid", "--type", "http"], "--url must be a non-empty string"],
    ["tcp port", ["add", "--name", "invalid", "--type", "tcp", "--host", "localhost", "--port", "3000abc"], "--port must be a positive integer"],
    ["process pid", ["add", "--name", "invalid", "--type", "process", "--pid", "123abc"], "--pid must be a positive integer"],
    ["unsafe process pid", ["add", "--name", "invalid", "--type", "process", "--pid", String(Number.MAX_SAFE_INTEGER + 1)], "--pid must be a positive integer"],
    ["failure threshold", ["add", "--name", "invalid", "--type", "custom", "--command", "echo ok", "--threshold", "3abc"], "--threshold must be a positive integer"],
    ["preset interval", ["add", "--preset", "daily_brief", "--interval", "60s"], "--interval must be a positive integer"],
    ["preset baseline window", ["add", "--preset", "goal_probe", "--data-source-id", "db-source", "--baseline-window", "5days"], "--baseline-window must be a positive integer"],
    ["preset threshold value", ["add", "--preset", "goal_probe", "--data-source-id", "db-source", "--threshold-value", "5days"], "--threshold-value must be a finite number"],
    ["preset non-finite threshold value", ["add", "--preset", "goal_probe", "--data-source-id", "db-source", "--threshold-value", "Infinity"], "--threshold-value must be a finite number"],
  ])("rejects invalid schedule add numeric input before persisting: %s", async (_label, argv, message) => {
    const tempDir = makeTempDir("schedule-command-invalid-add-");
    try {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const code = await cmdSchedule(makeStateManager(tempDir), argv);

      const engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      expect(code).toBe(1);
      expect(engine.getEntries()).toHaveLength(0);
      expect(errSpy).toHaveBeenCalledWith(`Error: ${message}`);
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("runs a paused schedule entry immediately without resuming it and exposes history", async () => {
    const tempDir = makeTempDir("schedule-command-run-now-");
    try {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await cmdSchedule(makeStateManager(tempDir), [
        "add",
        "--name",
        "manual-run-check",
        "--type",
        "custom",
        "--command",
        "echo ok",
        "--interval",
        "60",
      ]);

      let engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      const id = engine.getEntries()[0]!.id;

      await cmdSchedule(makeStateManager(tempDir), ["pause", id]);
      await cmdSchedule(makeStateManager(tempDir), ["run", id]);

      engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      expect(engine.getEntries()[0]!.enabled).toBe(false);
      expect(engine.getEntries()[0]!.total_executions).toBe(1);

      const history = await engine.getRecentHistory(10, id);
      expect(history).toHaveLength(1);
      expect(history[0]!.reason).toBe("manual_run");
      expect(history[0]!.status).toBe("ok");

      await cmdSchedule(makeStateManager(tempDir), ["history", id, "--limit", "1"]);
      expect(logSpy.mock.calls.some((call) => String(call[0]).includes("manual_run"))).toBe(true);
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("shows wait-resume activation metadata in history output", async () => {
    const tempDir = makeTempDir("schedule-command-history-wait-resume-");
    try {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      const entry = await engine.addEntry({
        name: "Wait resume goal-1/wait-1",
        layer: "goal_trigger",
        trigger: { type: "interval", seconds: 3600, jitter_factor: 0 },
        enabled: true,
        metadata: {
          source: "manual",
          internal: true,
          activation_kind: "wait_resume",
          goal_id: "goal-1",
          strategy_id: "wait-1",
          wait_strategy_id: "wait-1",
          dependency_hints: [],
        },
        goal_trigger: {
          goal_id: "goal-1",
          max_iterations: 10,
          skip_if_active: false,
        },
      });
      const now = new Date().toISOString();
      await fs.writeFile(
        path.join(tempDir, "schedule-history.json"),
        JSON.stringify([
          {
            id: "11111111-1111-4111-8111-111111111111",
            entry_id: entry.id,
            entry_name: entry.name,
            layer: entry.layer,
            reason: "cadence",
            attempt: 0,
            scheduled_for: now,
            started_at: now,
            finished_at: now,
            retry_at: null,
            status: "ok",
            duration_ms: 10,
            fired_at: now,
            tokens_used: 0,
            escalated_to: null,
            activation_kind: "wait_resume",
            strategy_id: "wait-1",
            wait_strategy_id: "wait-1",
            internal: true,
            internal_attention_projection: {
              kind: "wait_resume_attention_projection",
              projected_at: now,
              signal_context_id: "signal:schedule-wake:test",
              signal_sources: ["schedule_tick", "wait_expiry"],
              urge_candidate_refs: ["urge:schedule-wake:test"],
              agenda_item_refs: ["agenda:test"],
              inhibition_decisions: [{ ref: "inhibition:test", decision: "watch" }],
              initiative_gate_decisions: [{ ref: "gate:test", status: "delayed" }],
              runtime_items: [{
                ref: "agenda:test",
                type: "agent_agenda_item",
                status: "active",
                posture: "holding",
                visibility_display: "hidden",
                inspectable: true,
                auditable: true,
              }],
              non_execution_states: ["held", "delayed", "inspectable_hidden", "silent_runtime_item"],
              summary: "test wait-resume attention projection",
            },
          },
        ]),
        "utf8",
      );

      await cmdSchedule(makeStateManager(tempDir), ["history", entry.id, "--limit", "1"]);
      const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("internal");
      expect(output).toContain("activation=wait_resume:wait-1");
      expect(output).toContain("attention=wait_resume_attention_projection");
      expect(output).toContain("gates=delayed");
      expect(output).toContain("state=held,delayed,inspectable_hidden,silent_runtime_item");
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("does not print schedule history records with unsafe persisted attempt counts", async () => {
    const tempDir = makeTempDir("schedule-command-history-unsafe-attempt-");
    try {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      const entry = await engine.addEntry({
        name: "Retry digest",
        layer: "cron",
        trigger: { type: "interval", seconds: 3600 },
        metadata: {
          source: "manual",
          dependency_hints: [],
        },
        cron: {
          job_kind: "prompt",
          prompt_template: "Summarize retry state",
          context_sources: [],
          output_format: "notification",
          max_tokens: 500,
        },
      });
      const now = new Date().toISOString();
      await fs.writeFile(
        path.join(tempDir, "schedule-history.json"),
        JSON.stringify([
          {
            id: "11111111-1111-4111-8111-111111111111",
            entry_id: entry.id,
            entry_name: entry.name,
            layer: entry.layer,
            reason: "retry",
            attempt: Number.MAX_SAFE_INTEGER + 1,
            scheduled_for: now,
            started_at: now,
            finished_at: now,
            retry_at: null,
            status: "ok",
            duration_ms: 10,
            fired_at: now,
            tokens_used: 0,
            escalated_to: null,
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            entry_id: entry.id,
            entry_name: entry.name,
            layer: entry.layer,
            reason: "retry",
            attempt: 2,
            scheduled_for: now,
            started_at: now,
            finished_at: now,
            retry_at: null,
            status: "ok",
            duration_ms: 10,
            fired_at: now,
            tokens_used: 0,
            escalated_to: null,
          },
        ]),
        "utf8",
      );

      await cmdSchedule(makeStateManager(tempDir), ["history", entry.id, "--limit", "10"]);
      const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("attempt=2");
      expect(output).not.toContain(String(Number.MAX_SAFE_INTEGER + 1));
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("hides internal wait-resume schedules from list by default and shows them with --all", async () => {
    const tempDir = makeTempDir("schedule-command-internal-filter-");
    try {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      await engine.addEntry({
        name: "visible-check",
        layer: "heartbeat",
        trigger: { type: "interval", seconds: 60, jitter_factor: 0 },
        enabled: true,
        metadata: {
          source: "manual",
          dependency_hints: [],
        },
        heartbeat: {
          check_type: "custom",
          check_config: { command: "echo ok" },
          failure_threshold: 3,
          timeout_ms: 5000,
        },
      });
      await engine.addEntry({
        name: "Wait resume goal-1/wait-1",
        layer: "goal_trigger",
        trigger: { type: "interval", seconds: 3600, jitter_factor: 0 },
        enabled: true,
        metadata: {
          source: "manual",
          internal: true,
          activation_kind: "wait_resume",
          goal_id: "goal-1",
          strategy_id: "wait-1",
          wait_strategy_id: "wait-1",
          dependency_hints: [],
        },
        goal_trigger: {
          goal_id: "goal-1",
          max_iterations: 10,
          skip_if_active: false,
        },
      });

      await cmdSchedule(makeStateManager(tempDir), ["list"]);
      const defaultOutput = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(defaultOutput).toContain("visible-check");
      expect(defaultOutput).not.toContain("Wait resume goal-1/wait-1");
      expect(defaultOutput).toContain("internal schedule entry hidden");

      logSpy.mockClear();
      await cmdSchedule(makeStateManager(tempDir), ["list", "--all"]);
      const allOutput = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(allOutput).toContain("visible-check");
      expect(allOutput).toContain("Wait resume goal-1/wait-1");
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("shows internal wait projection details in schedule show output", async () => {
    const tempDir = makeTempDir("schedule-command-show-internal-");
    try {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const engine = new ScheduleEngine({ baseDir: tempDir });
      await engine.loadEntries();
      const entry = await engine.addEntry({
        name: "Wait resume goal-1/wait-1",
        layer: "goal_trigger",
        trigger: { type: "interval", seconds: 3600, jitter_factor: 0 },
        enabled: true,
        metadata: {
          source: "manual",
          internal: true,
          activation_kind: "wait_resume",
          goal_id: "goal-1",
          strategy_id: "wait-1",
          wait_strategy_id: "wait-1",
          dependency_hints: [],
        },
        goal_trigger: {
          goal_id: "goal-1",
          max_iterations: 10,
          skip_if_active: false,
        },
      });

      await cmdSchedule(makeStateManager(tempDir), ["show", entry.id]);
      const output = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
      expect(output.internal_projection).toEqual({
        kind: "wait_resume",
        goal_id: "goal-1",
        strategy_id: "wait-1",
        wait_strategy_id: "wait-1",
      });
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});
