import { describe, expect, it } from "vitest";
import { DaemonConfigSchema } from "../daemon.js";

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
