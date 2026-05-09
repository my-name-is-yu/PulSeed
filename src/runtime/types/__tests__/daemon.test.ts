import { describe, expect, it } from "vitest";
import { DaemonConfigSchema, DaemonStateSchema, ResidentActivitySchema } from "../daemon.js";

describe("DaemonConfigSchema", () => {
  it("bounds the event server port to the valid TCP port range", () => {
    expect(DaemonConfigSchema.safeParse({ event_server_port: 0 }).success).toBe(true);
    expect(DaemonConfigSchema.safeParse({ event_server_port: 65_535 }).success).toBe(true);
    expect(DaemonConfigSchema.safeParse({ event_server_port: 65_536 }).success).toBe(false);
    expect(DaemonConfigSchema.safeParse({ event_server_port: 70_000 }).success).toBe(false);
  });

  it("bounds daemon timer controls to finite timer-safe integers", () => {
    expect(DaemonConfigSchema.safeParse({
      proactive_interval_ms: 0,
      goal_review_interval_ms: 0,
    }).success).toBe(true);

    const timerOverflowMs = 2_147_483_648;
    const invalidConfigs = [
      { check_interval_ms: Number.POSITIVE_INFINITY },
      { check_interval_ms: timerOverflowMs },
      { crash_recovery: { retry_delay_ms: Number.NaN } },
      { crash_recovery: { graceful_shutdown_timeout_ms: timerOverflowMs } },
      { goal_intervals: { "goal-a": timerOverflowMs } },
      { proactive_interval_ms: Number.NEGATIVE_INFINITY },
      { goal_review_interval_ms: timerOverflowMs },
      { adaptive_sleep: { min_interval_ms: 0 } },
      { adaptive_sleep: { max_interval_ms: timerOverflowMs } },
    ];

    for (const config of invalidConfigs) {
      expect(DaemonConfigSchema.safeParse(config).success).toBe(false);
    }
  });

  it("bounds daemon count and adaptive sleep controls to finite safe values", () => {
    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
    const invalidConfigs = [
      { log_rotation: { max_size_mb: Number.POSITIVE_INFINITY } },
      { log_rotation: { max_files: unsafeInteger } },
      { crash_recovery: { max_retries: unsafeInteger } },
      { iterations_per_cycle: unsafeInteger },
      { max_concurrent_goals: unsafeInteger },
      { run_policy: { max_iterations: unsafeInteger } },
      { adaptive_sleep: { night_start_hour: 24 } },
      { adaptive_sleep: { night_end_hour: -1 } },
      { adaptive_sleep: { night_multiplier: Number.NaN } },
    ];

    for (const config of invalidConfigs) {
      expect(DaemonConfigSchema.safeParse(config).success).toBe(false);
    }
  });
});

describe("DaemonStateSchema", () => {
  it("bounds daemon state counters to safe nonnegative integers", () => {
    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
    const invalidStates = [
      { loop_count: unsafeInteger },
      { crash_count: unsafeInteger },
      { approval_pending_count: unsafeInteger },
    ];

    for (const state of invalidStates) {
      expect(DaemonStateSchema.safeParse(makeDaemonState(state)).success).toBe(false);
    }
  });

  it("bounds resident activity surface counters to safe nonnegative integers", () => {
    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
    const invalidActivities = [
      { surface_included_count: unsafeInteger },
      { surface_excluded_count: unsafeInteger },
    ];

    for (const activity of invalidActivities) {
      expect(ResidentActivitySchema.safeParse(makeResidentActivity(activity)).success).toBe(false);
    }
  });
});

function makeDaemonState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: 12345,
    started_at: "2026-05-09T00:00:00.000Z",
    last_loop_at: null,
    loop_count: 0,
    active_goals: [],
    status: "running",
    crash_count: 0,
    last_error: null,
    ...overrides,
  };
}

function makeResidentActivity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "observation",
    trigger: "proactive_tick",
    summary: "Inspected resident activity.",
    recorded_at: "2026-05-09T00:00:00.000Z",
    ...overrides,
  };
}
