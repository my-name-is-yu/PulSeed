import { describe, expect, it, vi, afterEach } from "vitest";
import { executeHeartbeatEntry } from "../engine-heartbeat.js";
import { ScheduleEntrySchema } from "../../types/schedule.js";

function makeProcessHeartbeat(pid: unknown) {
  return ScheduleEntrySchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    name: "process-heartbeat",
    layer: "heartbeat",
    trigger: { type: "interval", seconds: 60, jitter_factor: 0 },
    enabled: true,
    heartbeat: {
      check_type: "process",
      check_config: { pid },
      failure_threshold: 3,
      timeout_ms: 5000,
    },
    baseline_results: [],
    created_at: "2026-04-08T00:00:00.000Z",
    updated_at: "2026-04-08T00:00:00.000Z",
    last_fired_at: null,
    next_fire_at: "2026-04-08T00:01:00.000Z",
    consecutive_failures: 0,
    last_escalation_at: null,
    escalation_timestamps: [],
    total_executions: 0,
    total_tokens_used: 0,
    max_tokens_per_day: 100000,
    tokens_used_today: 0,
    budget_reset_at: null,
  });
}

describe("executeHeartbeatEntry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects unsafe process heartbeat pids before probing the process table", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number | NodeJS.Signals, signal?: NodeJS.Signals | number) => {
      if (pid === -1 && signal === 0) {
        return true;
      }
      throw new Error(`unexpected process probe for ${String(pid)}`);
    }) as typeof process.kill);
    const logger = { error: vi.fn() };

    const result = await executeHeartbeatEntry(makeProcessHeartbeat(-1), logger);

    expect(result.status).toBe("down");
    expect(result.error_message).toContain("positive safe integer");
    expect(result.failure_kind).toBe("transient");
    expect(killSpy).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("positive safe integer")
    );
  });
});
