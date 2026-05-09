import { describe, expect, it } from "vitest";
import {
  MAX_SCHEDULE_RETRY_ATTEMPTS,
  MAX_SCHEDULE_RETRY_DELAY_MS,
  MAX_SCHEDULE_RETRY_MULTIPLIER,
  MAX_SCHEDULE_RETRY_WINDOW_MS,
  ScheduleRetryPolicySchema,
  ScheduleRetryStateSchema,
} from "../schedule.js";

describe("ScheduleRetryPolicySchema", () => {
  it("bounds retry policy numbers to finite operational ranges", () => {
    const parsed = ScheduleRetryPolicySchema.parse({});
    expect(parsed.initial_delay_ms).toBe(30_000);
    expect(parsed.max_delay_ms).toBe(15 * 60 * 1000);
    expect(parsed.multiplier).toBe(2);
    expect(parsed.jitter_factor).toBe(0.2);
    expect(parsed.max_attempts).toBe(3);
    expect(parsed.max_retry_window_ms).toBe(24 * 60 * 60 * 1000);

    expect(ScheduleRetryPolicySchema.safeParse({
      initial_delay_ms: MAX_SCHEDULE_RETRY_DELAY_MS,
      max_delay_ms: MAX_SCHEDULE_RETRY_DELAY_MS,
      multiplier: MAX_SCHEDULE_RETRY_MULTIPLIER,
      jitter_factor: 1,
      max_attempts: MAX_SCHEDULE_RETRY_ATTEMPTS,
      max_retry_window_ms: MAX_SCHEDULE_RETRY_WINDOW_MS,
    }).success).toBe(true);

    const invalidPolicies = [
      { initial_delay_ms: -1 },
      { initial_delay_ms: 1.5 },
      { initial_delay_ms: Infinity },
      { initial_delay_ms: Number.MAX_SAFE_INTEGER },
      { max_delay_ms: 0 },
      { max_delay_ms: Infinity },
      { max_delay_ms: Number.MAX_SAFE_INTEGER },
      { multiplier: 0 },
      { multiplier: Infinity },
      { multiplier: MAX_SCHEDULE_RETRY_MULTIPLIER + 1 },
      { jitter_factor: Number.NaN },
      { jitter_factor: 1.1 },
      { max_attempts: 0 },
      { max_attempts: 1.5 },
      { max_attempts: MAX_SCHEDULE_RETRY_ATTEMPTS + 1 },
      { max_retry_window_ms: 0 },
      { max_retry_window_ms: Infinity },
      { max_retry_window_ms: Number.MAX_SAFE_INTEGER },
    ];

    for (const policy of invalidPolicies) {
      expect(ScheduleRetryPolicySchema.safeParse(policy).success).toBe(false);
    }
  });
});

describe("ScheduleRetryStateSchema", () => {
  it("rejects non-finite and oversized persisted attempt counters", () => {
    expect(ScheduleRetryStateSchema.safeParse({ attempts: 0 }).success).toBe(true);
    expect(ScheduleRetryStateSchema.safeParse({ attempts: MAX_SCHEDULE_RETRY_ATTEMPTS }).success).toBe(true);

    for (const attempts of [
      -1,
      1.5,
      Infinity,
      Number.MAX_SAFE_INTEGER,
      MAX_SCHEDULE_RETRY_ATTEMPTS + 1,
    ]) {
      expect(ScheduleRetryStateSchema.safeParse({ attempts }).success).toBe(false);
    }
  });
});
