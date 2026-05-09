import * as fs from "node:fs";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { StateManager } from "../../base/state/state-manager.js";
import { WaitDeadlineResolver, clampIntervalToNextWaitDeadline, getDueWaitGoalIds } from "../daemon/wait-deadline-resolver.js";
import { makeTempDir } from "../../../tests/helpers/temp-dir.js";
import { ScheduleEntryStore } from "../schedule/entry-store.js";
import { openControlDatabase } from "../store/control-db/index.js";
import {
  MAX_SCHEDULE_RETRY_ATTEMPTS,
  MAX_SCHEDULE_RETRY_DELAY_MS,
  MAX_SCHEDULE_RETRY_MULTIPLIER,
  MAX_SCHEDULE_RETRY_WINDOW_MS,
  ScheduleEntrySchema,
} from "../types/schedule.js";

let tempDir: string;
let stateManager: StateManager;

beforeEach(() => {
  tempDir = makeTempDir("pulseed-wait-deadline-");
  stateManager = new StateManager(tempDir);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function makeActiveWaitStrategy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "wait-1",
    goal_id: "goal-1",
    target_dimensions: ["quality"],
    primary_dimension: "quality",
    hypothesis: "Wait for external job completion",
    expected_effect: [],
    resource_estimate: {
      sessions: 0,
      duration: { value: 0, unit: "hours" },
      llm_calls: null,
    },
    state: "active",
    allocation: 1,
    created_at: "2026-04-24T12:00:00.000Z",
    started_at: "2026-04-24T12:00:00.000Z",
    completed_at: null,
    gap_snapshot_at_start: 0.5,
    tasks_generated: [],
    effectiveness_score: null,
    consecutive_stall_count: 0,
    wait_reason: "External job is still running",
    wait_until: "2026-04-24T12:10:00.000Z",
    measurement_plan: "Check the output file",
    fallback_strategy_id: null,
    ...overrides,
  };
}

function makeProjectedWaitSchedule(nextFireAt: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
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
      note: "Awaiting file completion",
    },
    goal_trigger: { goal_id: "goal-1", max_iterations: 10, skip_if_active: false },
    created_at: "2026-04-24T12:00:00.000Z",
    updated_at: "2026-04-24T12:00:00.000Z",
    last_fired_at: null,
    next_fire_at: nextFireAt,
    consecutive_failures: 0,
    last_escalation_at: null,
    escalation_timestamps: [],
    total_executions: 0,
    total_tokens_used: 0,
    max_tokens_per_day: 100000,
    tokens_used_today: 0,
    budget_reset_at: null,
    baseline_results: [],
    ...overrides,
  };
}

async function writeProjectedWaitSchedule(nextFireAt: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await new ScheduleEntryStore(tempDir, { warn: () => {} }).saveEntries([
    ScheduleEntrySchema.parse(makeProjectedWaitSchedule(nextFireAt, overrides)),
  ]);
}

describe("WaitDeadlineResolver", () => {
  it("reads next_observe_at from projected internal wait schedules", async () => {
    await stateManager.writeRaw("strategies/goal-1/portfolio.json", {
      goal_id: "goal-1",
      strategies: [makeActiveWaitStrategy()],
      rebalance_interval: { value: 1, unit: "hours" },
      last_rebalanced_at: "2026-04-24T12:00:00.000Z",
    });
    await stateManager.writeRaw("strategies/goal-1/wait-meta/wait-1.json", {
      schema_version: 1,
      wait_until: "2026-04-24T12:10:00.000Z",
      conditions: [{ type: "time_until", until: "2026-04-24T12:03:00.000Z" }],
      resume_plan: { action: "complete_wait" },
    });
    await writeProjectedWaitSchedule("2026-04-24T12:03:00.000Z");

    const resolution = await new WaitDeadlineResolver(stateManager).resolve(["goal-1"]);

    expect(resolution.next_observe_at).toBe("2026-04-24T12:03:00.000Z");
    expect(resolution.waiting_goals).toEqual([
      expect.objectContaining({
        goal_id: "goal-1",
        strategy_id: "wait-1",
        next_observe_at: "2026-04-24T12:03:00.000Z",
      }),
    ]);
  });

  it("uses projected next_fire_at even when wait metadata has no conditions", async () => {
    await stateManager.writeRaw("strategies/goal-1/portfolio.json", {
      goal_id: "goal-1",
      strategies: [makeActiveWaitStrategy()],
      rebalance_interval: { value: 1, unit: "hours" },
      last_rebalanced_at: "2026-04-24T12:00:00.000Z",
    });
    await stateManager.writeRaw("strategies/goal-1/wait-meta/wait-1.json", {
      wait_until: "2026-04-24T12:10:00.000Z",
    });
    await writeProjectedWaitSchedule("2026-04-24T12:10:00.000Z");

    const resolution = await new WaitDeadlineResolver(stateManager).resolve(["goal-1"]);

    expect(resolution.next_observe_at).toBe("2026-04-24T12:10:00.000Z");
  });

  it("does not throw when wait metadata is malformed and keeps schedule timing", async () => {
    await stateManager.writeRaw("strategies/goal-1/portfolio.json", {
      goal_id: "goal-1",
      strategies: [makeActiveWaitStrategy()],
      rebalance_interval: { value: 1, unit: "hours" },
      last_rebalanced_at: "2026-04-24T12:00:00.000Z",
    });
    await stateManager.writeRaw("strategies/goal-1/wait-meta/wait-1.json", {
      schema_version: 1,
      wait_until: "2026-04-24T12:10:00.000Z",
      conditions: [{ type: "metric_threshold", metric: "quality", operator: "gte" }],
      resume_plan: { action: "complete_wait" },
    });
    await writeProjectedWaitSchedule("2026-04-24T12:10:00.000Z");

    const resolution = await new WaitDeadlineResolver(stateManager).resolve(["goal-1"]);

    expect(resolution.next_observe_at).toBe("2026-04-24T12:10:00.000Z");
    expect(resolution.waiting_goals).toEqual([
      expect.objectContaining({
        goal_id: "goal-1",
        strategy_id: "wait-1",
        next_observe_at: "2026-04-24T12:10:00.000Z",
      }),
    ]);
  });

  it("lets projected next_fire_at postpone an original wait_until after re-wait", async () => {
    await stateManager.writeRaw("strategies/goal-1/portfolio.json", {
      goal_id: "goal-1",
      strategies: [makeActiveWaitStrategy()],
      rebalance_interval: { value: 1, unit: "hours" },
      last_rebalanced_at: "2026-04-24T12:00:00.000Z",
    });
    await stateManager.writeRaw("strategies/goal-1/wait-meta/wait-1.json", {
      schema_version: 1,
      wait_until: "2026-04-24T12:10:00.000Z",
      conditions: [{ type: "time_until", until: "2026-04-24T12:10:00.000Z" }],
      next_observe_at: "2026-04-24T12:30:00.000Z",
      resume_plan: { action: "complete_wait" },
    });
    await writeProjectedWaitSchedule("2026-04-24T12:30:00.000Z");

    const resolution = await new WaitDeadlineResolver(stateManager).resolve(["goal-1"]);

    expect(resolution.next_observe_at).toBe("2026-04-24T12:30:00.000Z");
  });

  it("uses approval-pending next_observe_at instead of immediately redueing an expired wait", async () => {
    await stateManager.writeRaw("strategies/goal-1/portfolio.json", {
      goal_id: "goal-1",
      strategies: [makeActiveWaitStrategy({ wait_until: "2026-04-24T12:00:00.000Z" })],
      rebalance_interval: { value: 1, unit: "hours" },
      last_rebalanced_at: "2026-04-24T12:00:00.000Z",
    });
    await stateManager.writeRaw("strategies/goal-1/wait-meta/wait-1.json", {
      schema_version: 1,
      wait_until: "2026-04-24T12:00:00.000Z",
      conditions: [{ type: "time_until", until: "2026-04-24T12:00:00.000Z" }],
      next_observe_at: "2026-04-24T12:15:00.000Z",
      latest_observation: {
        status: "pending",
        evidence: { approval_pending: true, approval_id: "wait-goal-1-wait-1" },
        next_observe_at: "2026-04-24T12:15:00.000Z",
        confidence: 1,
        resume_hint: "waiting_for_approval",
      },
      approval_pending: {
        approval_id: "wait-goal-1-wait-1",
        requested_at: "2026-04-24T12:00:00.000Z",
        next_reminder_at: "2026-04-24T12:15:00.000Z",
        expires_at: "2026-04-25T12:00:00.000Z",
      },
      resume_plan: { action: "complete_wait" },
    });
    await writeProjectedWaitSchedule("2026-04-24T12:15:00.000Z");

    const resolution = await new WaitDeadlineResolver(stateManager).resolve(["goal-1"]);

    expect(resolution.next_observe_at).toBe("2026-04-24T12:15:00.000Z");
    expect(resolution.waiting_goals[0]).toEqual(expect.objectContaining({
      approval_pending: true,
    }));
    expect(getDueWaitGoalIds(resolution, Date.parse("2026-04-24T12:01:00.000Z"))).toEqual([]);
  });

  it("projects approval_pending from typed wait resume plans without reading wait text", async () => {
    await stateManager.writeRaw("strategies/goal-1/portfolio.json", {
      goal_id: "goal-1",
      strategies: [makeActiveWaitStrategy({ wait_reason: "External handoff is paused" })],
      rebalance_interval: { value: 1, unit: "hours" },
      last_rebalanced_at: "2026-04-24T12:00:00.000Z",
    });
    await stateManager.writeRaw("strategies/goal-1/wait-meta/wait-1.json", {
      schema_version: 1,
      wait_until: "2026-04-24T12:10:00.000Z",
      conditions: [{ type: "time_until", until: "2026-04-24T12:10:00.000Z" }],
      resume_plan: { action: "request_approval", reason: "external submission" },
    });
    await writeProjectedWaitSchedule("2026-04-24T12:10:00.000Z");

    const resolution = await new WaitDeadlineResolver(stateManager).resolve(["goal-1"]);

    expect(resolution.waiting_goals).toEqual([
      expect.objectContaining({
        wait_reason: "External handoff is paused",
        approval_pending: true,
      }),
    ]);
  });

  it("clamps interval so daemon sleep cannot overshoot the next wait deadline", () => {
    const clamped = clampIntervalToNextWaitDeadline(
      300_000,
      "2026-04-24T12:01:00.000Z",
      Date.parse("2026-04-24T12:00:00.000Z")
    );

    expect(clamped).toBe(60_000);
  });

  it("prefers projected internal wait schedules when available", async () => {
    await writeProjectedWaitSchedule("2026-04-24T12:03:00.000Z");

    const resolution = await new WaitDeadlineResolver(stateManager).resolve(["goal-1"]);

    expect(resolution).toEqual({
      next_observe_at: "2026-04-24T12:03:00.000Z",
      waiting_goals: [
        expect.objectContaining({
          goal_id: "goal-1",
          strategy_id: "wait-1",
          next_observe_at: "2026-04-24T12:03:00.000Z",
          wait_reason: "Awaiting file completion",
        }),
      ],
    });
  });

  it("keeps internal wait schedules with finite legacy retry bounds", async () => {
    await insertRawProjectedWaitSchedule(makeProjectedWaitSchedule("2026-04-24T12:03:00.000Z", {
        retry_policy: {
          enabled: true,
          initial_delay_ms: MAX_SCHEDULE_RETRY_DELAY_MS + 1,
          max_delay_ms: MAX_SCHEDULE_RETRY_DELAY_MS + 1,
          multiplier: MAX_SCHEDULE_RETRY_MULTIPLIER + 1,
          jitter_factor: 0,
          max_attempts: MAX_SCHEDULE_RETRY_ATTEMPTS + 1,
          max_retry_window_ms: MAX_SCHEDULE_RETRY_WINDOW_MS + 1,
          retryable_failure_kinds: ["transient"],
        },
        retry_state: {
          attempts: MAX_SCHEDULE_RETRY_ATTEMPTS + 1,
        },
      }));

    const resolution = await new WaitDeadlineResolver(stateManager).resolve(["goal-1"]);

    expect(resolution.next_observe_at).toBe("2026-04-24T12:03:00.000Z");
    expect(resolution.waiting_goals).toEqual([
      expect.objectContaining({
        goal_id: "goal-1",
        strategy_id: "wait-1",
        next_observe_at: "2026-04-24T12:03:00.000Z",
      }),
    ]);
  });
});

async function insertRawProjectedWaitSchedule(entry: Record<string, unknown>): Promise<void> {
  const database = await openControlDatabase({ baseDir: tempDir });
  const metadata = entry["metadata"] as Record<string, unknown> | undefined;
  try {
    database.transaction((db) => {
      db.prepare(`
        INSERT INTO schedule_entries (
          entry_id,
          name,
          layer,
          enabled,
          next_fire_at,
          updated_at,
          internal,
          activation_kind,
          goal_id,
          wait_strategy_id,
          sort_order,
          entry_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, json(?))
      `).run(
        entry["id"],
        entry["name"],
        entry["layer"],
        entry["enabled"] === false ? 0 : 1,
        entry["next_fire_at"],
        entry["updated_at"],
        metadata?.["internal"] === true ? 1 : 0,
        metadata?.["activation_kind"] ?? null,
        metadata?.["goal_id"] ?? null,
        metadata?.["wait_strategy_id"] ?? null,
        JSON.stringify(entry),
      );
    });
  } finally {
    database.close();
  }
}
