import type { ScheduleEntry, ScheduleResult } from "../../src/runtime/types/schedule.js";

export function makeScheduleEntry(
  id = "11111111-1111-4111-8111-111111111111",
  overrides: Partial<ScheduleEntry> = {},
): ScheduleEntry {
  return {
    id,
    name: `Schedule ${id}`,
    layer: "heartbeat",
    trigger: { type: "interval", seconds: 60, jitter_factor: 0 },
    enabled: true,
    heartbeat: {
      check_type: "http",
      check_config: { url: "https://example.com/health" },
      failure_threshold: 3,
      timeout_ms: 5000,
    },
    probe: undefined,
    cron: undefined,
    goal_trigger: undefined,
    escalation: undefined,
    baseline_results: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_fired_at: null,
    next_fire_at: "2026-01-01T00:01:00.000Z",
    consecutive_failures: 0,
    last_escalation_at: null,
    escalation_timestamps: [],
    total_executions: 0,
    total_tokens_used: 0,
    max_tokens_per_day: 100000,
    tokens_used_today: 0,
    budget_reset_at: null,
    ...overrides,
  };
}

export function makeCronScheduleEntry(
  id = "11111111-1111-4111-8111-111111111111",
  overrides: Partial<ScheduleEntry> = {},
): ScheduleEntry {
  return makeScheduleEntry(id, {
    layer: "cron",
    trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
    heartbeat: undefined,
    cron: {
      job_kind: "prompt",
      prompt_template: "Summarize daily changes.",
      context_sources: ["memory://daily"],
      output_format: "notification",
      max_tokens: 1200,
    },
    next_fire_at: "2026-01-01T09:00:00.000Z",
    ...overrides,
  });
}

export function makeScheduleResult(
  entryId = "11111111-1111-4111-8111-111111111111",
  overrides: Partial<ScheduleResult> = {},
): ScheduleResult {
  return {
    entry_id: entryId,
    status: "ok",
    duration_ms: 3,
    fired_at: "2026-01-01T00:00:00.000Z",
    layer: "heartbeat",
    tokens_used: 0,
    escalated_to: null,
    ...overrides,
  };
}
