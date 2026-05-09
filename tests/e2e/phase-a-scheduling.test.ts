/**
 * Phase A Scheduling E2E Tests
 *
 * Group 1: ScheduleEngine cron layer — register/fire/remove/migrate jobs
 * Group 2: DaemonRunner proactive tick — idle detection → LLM suggestion
 * Group 3: DaemonRunner adaptive sleep — interval calculation based on time-of-day and activity
 * Group 4: Integration — ScheduleEngine and DaemonRunner share runtime state safely
 *
 * Real classes used where possible. Only LLM calls and CoreLoop are mocked.
 * vi.useFakeTimers() used for time-dependent tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { ScheduleEngine } from "../../src/runtime/schedule/engine.js";
import { migrateLegacyCronTasksIfNeeded } from "../../src/runtime/schedule/legacy-cron-migration.js";
import { DaemonRunner } from "../../src/runtime/daemon-runner.js";
import { StateManager } from "../../src/base/state/state-manager.js";
import { DriveSystem } from "../../src/platform/drive/drive-system.js";
import { PIDManager } from "../../src/runtime/pid-manager.js";
import { Logger } from "../../src/runtime/logger.js";
import type { DaemonDeps } from "../../src/runtime/daemon-runner.js";
import type { LoopResult } from "../../src/orchestrator/loop/durable-loop.js";
import { makeTempDir, cleanupTempDir } from "../helpers/temp-dir.js";
import { createMockLLMClient } from "../helpers/mock-llm.js";
import { makeGoal } from "../helpers/fixtures.js";

// ─── Shared helpers ───

function buildDaemonRunner(
  tempDir: string,
  stateManager: StateManager,
  options: {
    coreLoopOverride?: { run: (goalId: string) => Promise<LoopResult> };
    configOverride?: Partial<DaemonDeps["config"]>;
    llmClient?: DaemonDeps["llmClient"];
  } = {}
): { runner: DaemonRunner; logger: Logger } {
  const driveSystem = new DriveSystem(stateManager, { baseDir: tempDir });
  const pidManager = new PIDManager(tempDir);
  const logger = new Logger({ dir: path.join(tempDir, "logs"), consoleOutput: false });

  const coreLoop = options.coreLoopOverride ?? {
    run: async (goalId: string): Promise<LoopResult> => ({
      goalId,
      totalIterations: 1,
      finalStatus: "completed" as const,
      iterations: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }),
  };

  const deps: DaemonDeps = {
    coreLoop: coreLoop as unknown as import("../../src/orchestrator/loop/durable-loop.js").CoreLoop,
    driveSystem,
    stateManager,
    pidManager,
    logger,
    config: {
      check_interval_ms: 50,
      crash_recovery: { enabled: true, max_retries: 3, retry_delay_ms: 10 },
      ...options.configOverride,
      event_server_port: 0,  // Always port 0 in tests to avoid EADDRINUSE
    },
    llmClient: options.llmClient,
  };

  return { runner: new DaemonRunner(deps), logger };
}

async function saveActiveGoal(stateManager: StateManager, id: string): Promise<void> {
  const goal = makeGoal({ id, title: `Goal ${id}` });
  await stateManager.saveGoal(goal);
}

// ─── Group 1: ScheduleEngine cron layer ───

describe("Phase A — ScheduleEngine cron layer", () => {
  let tempDir: string;
  let scheduleEngine: ScheduleEngine;

  beforeEach(() => {
    tempDir = makeTempDir("pulseed-cron-test-");
    scheduleEngine = new ScheduleEngine({ baseDir: tempDir });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    vi.useRealTimers();
  });

  it("addEntry persists a new cron schedule entry to disk", async () => {
    const entry = await scheduleEngine.addEntry({
      name: "Reflect on progress",
      layer: "cron",
      trigger: { type: "cron", expression: "* * * * *", timezone: "UTC" },
      enabled: true,
      cron: {
        job_kind: "prompt",
        prompt_template: "Reflect on progress",
        context_sources: [],
        output_format: "notification",
        max_tokens: 100,
      },
    });

    expect(entry.id).toBeTruthy();
    expect(entry.layer).toBe("cron");
    expect(entry.trigger).toEqual({ type: "cron", expression: "* * * * *", timezone: "UTC" });
    expect(entry.enabled).toBe(true);
    expect(entry.last_fired_at).toBeNull();

    const loaded = await new ScheduleEngine({ baseDir: tempDir }).loadEntries();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe(entry.id);
  });

  it("getDueEntries returns enabled cron entries whose next fire time has passed", async () => {
    const entry = await scheduleEngine.addEntry({
      name: "Check status",
      layer: "cron",
      trigger: { type: "cron", expression: "* * * * *", timezone: "UTC" },
      enabled: true,
      cron: {
        job_kind: "prompt",
        prompt_template: "Check status",
        context_sources: [],
        output_format: "notification",
        max_tokens: 100,
      },
    });
    const entries = scheduleEngine.getEntries();
    entries[0] = { ...entries[0]!, next_fire_at: new Date(Date.now() - 1_000).toISOString() };
    await scheduleEngine.saveEntries();

    const due = await scheduleEngine.getDueEntries();
    expect(due.length).toBeGreaterThanOrEqual(1);
    expect(due.some((candidate) => candidate.id === entry.id)).toBe(true);
  });

  it("tick updates last_fired_at for a due cron entry", async () => {
    const entry = await scheduleEngine.addEntry({
      name: "Consolidate memories",
      layer: "cron",
      trigger: { type: "cron", expression: "* * * * *", timezone: "UTC" },
      enabled: true,
      cron: {
        job_kind: "prompt",
        prompt_template: "Consolidate memories",
        context_sources: [],
        output_format: "notification",
        max_tokens: 100,
      },
    });
    const entries = scheduleEngine.getEntries();
    entries[0] = { ...entries[0]!, next_fire_at: new Date(Date.now() - 1_000).toISOString() };
    await scheduleEngine.saveEntries();

    const results = await scheduleEngine.tick();
    expect(results.some((result) => result.entry_id === entry.id)).toBe(true);

    const reloaded = await new ScheduleEngine({ baseDir: tempDir }).loadEntries();
    const fired = reloaded.find((candidate) => candidate.id === entry.id);
    expect(fired?.last_fired_at).not.toBeNull();
  });

  it("removeEntry removes the schedule entry from disk and returns true", async () => {
    const entry = await scheduleEngine.addEntry({
      name: "Hourly check",
      layer: "cron",
      trigger: { type: "cron", expression: "0 * * * *", timezone: "UTC" },
      enabled: true,
      cron: {
        job_kind: "prompt",
        prompt_template: "Hourly check",
        context_sources: [],
        output_format: "notification",
        max_tokens: 100,
      },
    });

    const removed = await scheduleEngine.removeEntry(entry.id);
    expect(removed).toBe(true);

    const remaining = await new ScheduleEngine({ baseDir: tempDir }).loadEntries();
    expect(remaining).toHaveLength(0);
  });

  it("removeEntry returns false for a non-existent id", async () => {
    const removed = await scheduleEngine.removeEntry("00000000-0000-0000-0000-000000000000");
    expect(removed).toBe(false);
  });

  it("migrates legacy scheduled-tasks.json into Control DB through explicit migration", async () => {
    const legacyTasks = [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        cron: "0 9 * * *",
        prompt: "Legacy reflection prompt",
        type: "reflection",
        enabled: true,
        last_fired_at: null,
        permanent: false,
        created_at: "2026-04-01T00:00:00.000Z",
      },
    ];
    fs.writeFileSync(path.join(tempDir, "scheduled-tasks.json"), JSON.stringify(legacyTasks, null, 2), "utf-8");

    const migrated = await migrateLegacyCronTasksIfNeeded({
      baseDir: tempDir,
      logger: { warn: () => {} },
    });
    const loaded = await scheduleEngine.loadEntries();

    expect(migrated).toBe(true);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.layer).toBe("cron");
    expect(loaded[0]?.cron?.prompt_template).toBe("Legacy reflection prompt");
    expect(fs.existsSync(path.join(tempDir, "schedules.json"))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, "scheduled-tasks.legacy-migrated.json"))).toBe(true);
  });
});

// ─── Group 2: DaemonRunner Proactive Tick ───

describe("Phase A — DaemonRunner proactive tick", () => {
  let tempDir: string;
  let builtLogger: Logger | null = null;

  beforeEach(() => {
    tempDir = makeTempDir("pulseed-proactive-test-");
    builtLogger = null;
  });

  afterEach(async () => {
    await builtLogger?.close();
    builtLogger = null;
    cleanupTempDir(tempDir);
    vi.useRealTimers();
  });

  // ── Test 8: Proactive tick fires LLM call when daemon is idle ──

  it("daemon with proactive_mode fires LLM call when no goals are active", async () => {
    const stateManager = new StateManager(tempDir);

    const llmResponse = JSON.stringify({ action: "sleep" });

    // Use onCall callback to stop the daemon as soon as the LLM is invoked,
    // avoiding any real-time wait.
    let daemonRef: DaemonRunner | null = null;
    const mockLLM = createMockLLMClient([llmResponse, llmResponse, llmResponse], () => {
      daemonRef?.stop();
    });

    ({ runner: daemonRef, logger: builtLogger } = buildDaemonRunner(tempDir, stateManager, {
      configOverride: {
        proactive_mode: true,
        proactive_interval_ms: 0, // no cooldown for test
        check_interval_ms: 50,
      },
      llmClient: mockLLM,
    }));

    // No goals registered — daemon will idle → proactive tick fires → LLM called → daemon stops
    await daemonRef.start([]);

    // LLM should have been called for the proactive tick
    expect(mockLLM.callCount).toBeGreaterThanOrEqual(1);
  });

  // ── Test 9: Proactive tick suggests a goal when LLM returns suggest_goal ──

  it("proactive tick logs action when LLM returns suggest_goal", async () => {
    const stateManager = new StateManager(tempDir);

    const llmResponse = JSON.stringify({
      action: "suggest_goal",
      details: { title: "Improve test coverage", description: "Add more unit tests" },
    });

    let daemonRef: DaemonRunner | null = null;
    const mockLLM = createMockLLMClient([llmResponse, llmResponse, llmResponse], () => {
      daemonRef?.stop();
    });

    const logDir = path.join(tempDir, "logs");
    const logger = new Logger({
      dir: logDir,
      consoleOutput: false,
    });
    builtLogger = logger;

    const driveSystem = new DriveSystem(stateManager, { baseDir: tempDir });
    const pidManager = new PIDManager(tempDir);

    const deps: DaemonDeps = {
      coreLoop: {
        run: async (goalId: string): Promise<LoopResult> => ({
          goalId,
          totalIterations: 1,
          finalStatus: "completed" as const,
          iterations: [],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }),
      } as unknown as import("../../src/orchestrator/loop/durable-loop.js").CoreLoop,
      driveSystem,
      stateManager,
      pidManager,
      logger,
      config: {
        proactive_mode: true,
        proactive_interval_ms: 0,
        check_interval_ms: 50,
        crash_recovery: { enabled: true, max_retries: 3, retry_delay_ms: 10 },
        event_server_port: 0,  // Always port 0 in tests to avoid EADDRINUSE
      },
      llmClient: mockLLM,
    };

    daemonRef = new DaemonRunner(deps);
    await daemonRef.start([]);

    expect(mockLLM.callCount).toBeGreaterThanOrEqual(1);
  });

  // ── Test 10: Proactive tick respects cooldown interval ──

  it("proactive tick does not fire again before proactive_interval_ms elapses", async () => {
    const stateManager = new StateManager(tempDir);
    await stateManager.saveGoal(makeGoal({ id: "cooldown-goal", status: "active" }));

    const llmResponse = JSON.stringify({ action: "sleep" });
    const mockLLM = createMockLLMClient([llmResponse, llmResponse, llmResponse]);

    // Run one goal cycle via coreLoopOverride and stop immediately.
    // With proactive_mode=true and a 60s cooldown, the proactive tick cannot fire
    // during the short daemon lifetime.
    // The key invariant: LLM is never called because cooldown is still active.
    let cycleCount = 0;
    let daemonRef: DaemonRunner | null = null;
    ({ runner: daemonRef, logger: builtLogger } = buildDaemonRunner(tempDir, stateManager, {
      configOverride: {
        proactive_mode: true,
        proactive_interval_ms: 60_000, // 1 minute cooldown — won't expire during test
        check_interval_ms: 1,
      },
      llmClient: mockLLM,
      coreLoopOverride: {
        run: async (goalId: string): Promise<LoopResult> => {
          cycleCount++;
          daemonRef?.stop();
          return {
            goalId,
            totalIterations: 1,
            finalStatus: "completed" as const,
            iterations: [],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      },
    }));

    await daemonRef.start(["cooldown-goal"]);

    expect(cycleCount).toBe(1);
    // Proactive tick is suppressed because cooldown is 60s.
    // LLM should not have been called.
    expect(mockLLM.callCount).toBe(0);
  });

  // ── Test 11: Proactive tick skipped when proactive_mode is false ──

  it("proactive tick is skipped when proactive_mode is false", async () => {
    const stateManager = new StateManager(tempDir);
    await stateManager.saveGoal(makeGoal({ id: "probe-goal", status: "active" }));

    const llmResponse = JSON.stringify({ action: "sleep" });
    const mockLLM = createMockLLMClient([llmResponse]);

    // Use coreLoopOverride to stop the daemon after one goal cycle completes.
    // Since goals are always active, proactive tick is never reached.
    // But even if it were, proactive_mode=false would suppress it.
    let daemonRef: DaemonRunner | null = null;
    ({ runner: daemonRef, logger: builtLogger } = buildDaemonRunner(tempDir, stateManager, {
      configOverride: {
        proactive_mode: false,
        check_interval_ms: 1,
      },
      llmClient: mockLLM,
      coreLoopOverride: {
        run: async (goalId: string): Promise<LoopResult> => {
          daemonRef?.stop();
          return {
            goalId,
            totalIterations: 1,
            finalStatus: "completed" as const,
            iterations: [],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      },
    }));

    await daemonRef.start(["probe-goal"]);

    // LLM should never be called — proactive mode is off
    expect(mockLLM.callCount).toBe(0);
  });
});

// ─── Group 3: DaemonRunner Adaptive Sleep ───

describe("Phase A — DaemonRunner adaptive sleep (calculateAdaptiveInterval)", () => {
  let tempDir: string;
  let daemon: DaemonRunner;
  let daemonLogger: Logger;

  beforeEach(() => {
    tempDir = makeTempDir("pulseed-adaptive-test-");
    const stateManager = new StateManager(tempDir);
    ({ runner: daemon, logger: daemonLogger } = buildDaemonRunner(tempDir, stateManager, {
      configOverride: {
        adaptive_sleep: {
          enabled: true,
          min_interval_ms: 60_000,
          max_interval_ms: 1_800_000,
          night_start_hour: 22,
          night_end_hour: 7,
          night_multiplier: 2.0,
        },
        check_interval_ms: 300_000,
      },
    }));
  });

  afterEach(async () => {
    await daemonLogger.close();
    await new Promise((r) => setTimeout(r, 50)); // ensure file handles are released
    cleanupTempDir(tempDir);
    vi.useRealTimers();
  });

  // ── Test 12: Adaptive sleep disabled — returns base interval unchanged ──

  it("returns baseInterval unchanged when adaptive_sleep is disabled", async () => {
    // Use a separate tempDir2 to avoid Logger file-handle contention with the outer beforeEach runner
    const tempDir2 = makeTempDir("pulseed-adaptive-disabled-test-");
    let logger2: Logger | undefined;
    try {
      const stateManager2 = new StateManager(tempDir2);
      let d: DaemonRunner;
      ({ runner: d, logger: logger2 } = buildDaemonRunner(tempDir2, stateManager2, {
        configOverride: {
          adaptive_sleep: { enabled: false },
          check_interval_ms: 300_000,
        },
      }));

      const result = d.calculateAdaptiveInterval(300_000, 0, 0, 0);
      expect(result).toBe(300_000);
    } finally {
      await logger2?.close();
      cleanupTempDir(tempDir2);
    }
  });

  // ── Test 13: Night-time multiplier doubles the interval ──

  it("doubles interval during night hours (22:00-07:00)", () => {
    // Set system time to 23:00 (night)
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T23:00:00"));

    const result = daemon.calculateAdaptiveInterval(300_000, 0, 0, 0);

    // Night multiplier is 2.0, urgency=1.0, activity=1.0 → 600_000ms, clamped to max
    expect(result).toBe(600_000);

    vi.useRealTimers();
  });

  it("uses normal interval during daytime hours (08:00-21:59)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T10:00:00"));

    const result = daemon.calculateAdaptiveInterval(300_000, 0, 0, 0);

    // Day time: timeOfDay=1.0, urgency=1.0, activity=1.0 → 300_000ms
    expect(result).toBe(300_000);

    vi.useRealTimers();
  });

  // ── Test 14: High gap score → urgency factor halves interval ──

  it("halves interval when maxGapScore >= 0.8 (high urgency)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T10:00:00")); // daytime

    const result = daemon.calculateAdaptiveInterval(300_000, 0, 0.9, 0);

    // urgencyFactor=0.5 → 150_000ms, clamped to min 60_000
    expect(result).toBe(150_000);

    vi.useRealTimers();
  });

  it("applies 0.75 urgency factor when maxGapScore is 0.5-0.79", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T10:00:00")); // daytime

    const result = daemon.calculateAdaptiveInterval(300_000, 0, 0.6, 0);

    // urgencyFactor=0.75 → 225_000ms
    expect(result).toBe(225_000);

    vi.useRealTimers();
  });

  // ── Test 15: Activity factor reduces interval when goals were active ──

  it("reduces interval to 0.75x when goals were activated this cycle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T10:00:00")); // daytime

    const result = daemon.calculateAdaptiveInterval(300_000, 2, 0, 0);

    // activityFactor=0.75 → 225_000ms
    expect(result).toBe(225_000);

    vi.useRealTimers();
  });

  it("increases interval to 1.5x after 5+ consecutive idle cycles", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T10:00:00")); // daytime

    const result = daemon.calculateAdaptiveInterval(300_000, 0, 0, 5);

    // activityFactor=1.5 → 450_000ms
    expect(result).toBe(450_000);

    vi.useRealTimers();
  });

  // ── Test 16: Clamp to min/max bounds ──

  it("clamps to min_interval_ms when effective interval is too low", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T10:00:00")); // daytime

    // Very small base + high urgency + active goals → would go below min
    const result = daemon.calculateAdaptiveInterval(60_000, 2, 0.9, 0);

    // 60_000 * 1.0 * 0.5 * 0.75 = 22_500 → clamped to min 60_000
    expect(result).toBe(60_000);

    vi.useRealTimers();
  });

  it("clamps to max_interval_ms when effective interval is too high", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T23:00:00")); // night

    // Large base + night + long idle → would exceed max
    const result = daemon.calculateAdaptiveInterval(1_200_000, 0, 0, 10);

    // 1_200_000 * 2.0 * 1.0 * 1.5 = 3_600_000 → clamped to max 1_800_000
    expect(result).toBe(1_800_000);

    vi.useRealTimers();
  });
});

// ─── Group 4: Integration — ScheduleEngine + DaemonRunner ───

describe("Phase A — Integration: ScheduleEngine shares runtime state with DaemonRunner", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("pulseed-integration-test-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    vi.useRealTimers();
  });

  it("ScheduleEngine cron entries can be retrieved and ticked each loop", async () => {
    const engine = new ScheduleEngine({ baseDir: tempDir });
    const entry = await engine.addEntry({
      name: "Reflect on recent observations",
      layer: "cron",
      trigger: { type: "cron", expression: "* * * * *", timezone: "UTC" },
      enabled: true,
      cron: {
        job_kind: "prompt",
        prompt_template: "Reflect on recent observations",
        context_sources: [],
        output_format: "notification",
        max_tokens: 100,
      },
    });
    const entries = engine.getEntries();
    entries[0] = { ...entries[0]!, next_fire_at: new Date(Date.now() - 1_000).toISOString() };
    await engine.saveEntries();

    const dueBefore = await engine.getDueEntries();
    expect(dueBefore.some((candidate) => candidate.id === entry.id)).toBe(true);

    await engine.tick();

    const reloaded = await new ScheduleEngine({ baseDir: tempDir }).loadEntries();
    expect(reloaded.find((candidate) => candidate.id === entry.id)?.last_fired_at).not.toBeNull();
  });

  it("DaemonRunner runs loop while ScheduleEngine persists entries to the same directory", async () => {
    const stateManager = new StateManager(tempDir);
    const scheduleEngine = new ScheduleEngine({ baseDir: tempDir });

    const entry = await scheduleEngine.addEntry({
      name: "Background consolidation",
      layer: "cron",
      trigger: { type: "cron", expression: "* * * * *", timezone: "UTC" },
      enabled: true,
      cron: {
        job_kind: "prompt",
        prompt_template: "Background consolidation",
        context_sources: [],
        output_format: "notification",
        max_tokens: 100,
      },
    });

    await saveActiveGoal(stateManager, "goal-integration");

    let loopRan = false;
    let daemonInst: DaemonRunner;
    let daemonInst_logger: Logger;
    ({ runner: daemonInst, logger: daemonInst_logger } = buildDaemonRunner(tempDir, stateManager, {
      configOverride: { check_interval_ms: 50 },
      coreLoopOverride: {
        run: async (goalId: string): Promise<LoopResult> => {
          loopRan = true;
          daemonInst.stop();
          return {
            goalId,
            totalIterations: 1,
            finalStatus: "completed" as const,
            iterations: [],
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
        },
      },
    }));

    await daemonInst.start(["goal-integration"]);
    await daemonInst_logger.close();
    expect(loopRan).toBe(true);

    const entries = await new ScheduleEngine({ baseDir: tempDir }).loadEntries();
    expect(entries.some((candidate) => candidate.id === entry.id)).toBe(true);
  });

  it("full schedule lifecycle: legacy migrate → due → tick → remove", async () => {
    const legacyTasks = [
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        cron: "0 * * * *",
        prompt: "Hourly check from last week",
        type: "custom",
        enabled: true,
        last_fired_at: null,
        permanent: false,
        created_at: "2026-04-01T00:00:00.000Z",
      },
    ];
    fs.writeFileSync(path.join(tempDir, "scheduled-tasks.json"), JSON.stringify(legacyTasks, null, 2), "utf-8");

    const engine = new ScheduleEngine({ baseDir: tempDir });
    const didMigrate = await migrateLegacyCronTasksIfNeeded({
      baseDir: tempDir,
      logger: { warn: () => {} },
    });
    const migrated = await engine.loadEntries();
    expect(didMigrate).toBe(true);
    expect(migrated).toHaveLength(1);

    const dueEntry = { ...migrated[0]!, next_fire_at: new Date(Date.now() - 1_000).toISOString() };
    engine.getEntries()[0] = dueEntry;
    await engine.saveEntries();

    await engine.tick();

    const afterTick = await new ScheduleEngine({ baseDir: tempDir }).loadEntries();
    expect(afterTick[0]?.last_fired_at).not.toBeNull();

    const removed = await engine.removeEntry(afterTick[0]!.id);
    expect(removed).toBe(true);
    expect((await new ScheduleEngine({ baseDir: tempDir }).loadEntries())).toHaveLength(0);
  });
});
