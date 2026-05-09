import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { CLIRunner } from "../cli-runner.js";
import { StateManager } from "../../../base/state/state-manager.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { ScheduleHistoryStore } from "../../../runtime/schedule/history.js";
import { openControlDatabase } from "../../../runtime/store/index.js";

async function runCLI(tmpDir: string, ...args: string[]): Promise<number> {
  const runner = new CLIRunner(tmpDir);
  return runner.run(args);
}

async function saveScheduleHistory(tmpDir: string, records: Array<Record<string, unknown>>): Promise<void> {
  const now = new Date().toISOString();
  await new ScheduleHistoryStore(tmpDir).save(records.map((record, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    entry_id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    entry_name: "Daily brief",
    layer: "cron",
    status: "ok",
    duration_ms: 0,
    fired_at: record["fired_at"] ?? record["finished_at"] ?? now,
    reason: "manual_run",
    attempt: 0,
    scheduled_for: null,
    started_at: record["started_at"] ?? record["finished_at"] ?? now,
    finished_at: record["finished_at"] ?? now,
    retry_at: null,
    tokens_used: 0,
    escalated_to: null,
    activation_kind: null,
    strategy_id: null,
    wait_strategy_id: null,
    internal: false,
    ...record,
  }) as never));
}

async function insertRawScheduleHistoryRecord(tmpDir: string, record: Record<string, unknown>): Promise<void> {
  const db = await openControlDatabase({ baseDir: tmpDir });
  try {
    const finishedAt = typeof record["finished_at"] === "string" ? record["finished_at"] : new Date().toISOString();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO schedule_run_history (
          history_id,
          entry_id,
          entry_name,
          layer,
          reason,
          started_at,
          finished_at,
          internal,
          tokens_used,
          sort_order,
          record_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
      `).run(
        "raw-invalid-record",
        "10000000-0000-4000-8000-000000000001",
        "Daily brief",
        "cron",
        "manual_run",
        finishedAt,
        finishedAt,
        0,
        0,
        0,
        JSON.stringify(record)
      );
    });
  } finally {
    db.close();
  }
}

async function dropScheduleHistoryTable(tmpDir: string): Promise<void> {
  const db = await openControlDatabase({ baseDir: tmpDir });
  try {
    db.transaction((sqlite) => {
      sqlite.prepare("DROP TABLE schedule_run_history").run();
    });
  } finally {
    db.close();
  }
}

describe("CLI usage command", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let origApiKey: string | undefined;

  beforeEach(async () => {
    tmpDir = makeTempDir("pulseed-cli-usage-");
    stateManager = new StateManager(tmpDir);
    await stateManager.init();
    origApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-api-key";
    process.env.PULSEED_LLM_PROVIDER = "anthropic";
  });

  afterEach(() => {
    if (origApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = origApiKey;
    }
    delete process.env.PULSEED_LLM_PROVIDER;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    vi.restoreAllMocks();
  });

  it("reports session usage totals and phase breakdown", async () => {
    await stateManager.writeRaw("chat/sessions/session-usage.json", {
      id: "session-usage",
      cwd: "/repo",
      createdAt: new Date().toISOString(),
      messages: [],
      usage: {
        totals: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
        byPhase: {
          execution: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
        },
      },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCLI(tmpDir, "usage", "session", "session-usage");

    expect(code).toBe(0);
    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Usage summary (session session-usage)");
    expect(output).toContain("Session total tokens:  9");
    expect(output).toContain("execution: 9");
  });

  it("normalizes unsafe session usage counters before reporting", async () => {
    await stateManager.writeRaw("chat/sessions/session-unsafe-usage.json", {
      id: "session-unsafe-usage",
      cwd: "/repo",
      createdAt: new Date().toISOString(),
      messages: [],
      usage: {
        totals: {
          inputTokens: Number.MAX_SAFE_INTEGER + 1,
          outputTokens: "4",
          totalTokens: 1.5,
        },
        byPhase: {
          execution: {
            inputTokens: 2,
            outputTokens: Number.MAX_SAFE_INTEGER,
          },
        },
      },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCLI(tmpDir, "usage", "session", "session-unsafe-usage");

    expect(code).toBe(0);
    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Session total tokens:  0");
    expect(output).toContain("Session input tokens:  0");
    expect(output).toContain("Session output tokens: 0");
    expect(output).toContain(`execution: ${Number.MAX_SAFE_INTEGER}`);
    expect(output).not.toContain(String(Number.MAX_SAFE_INTEGER + 1));
  });

  it("reports goal usage totals from task ledgers and accepts daemon alias", async () => {
    await stateManager.writeRaw("tasks/goal-usage/ledger/task-1.json", {
      task_id: "task-1",
      goal_id: "goal-usage",
      events: [{ type: "succeeded", ts: "2026-01-01T00:00:00.000Z", tokens_used: 77 }],
      summary: {
        latest_event_type: "succeeded",
        tokens_used: 77,
        latencies: {
          created_to_acked_ms: null,
          acked_to_started_ms: null,
          started_to_completed_ms: null,
          completed_to_verification_ms: null,
          created_to_completed_ms: null,
        },
      },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCLI(tmpDir, "usage", "daemon", "goal-usage");

    expect(code).toBe(0);
    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Usage summary (daemon scope)");
    expect(output).toContain("Goal: goal-usage");
    expect(output).toContain("Total tokens: 77");
  });

  it("caps accumulated goal usage totals at the maximum safe integer", async () => {
    await stateManager.writeRaw("tasks/goal-overflow/ledger/task-1.json", {
      task_id: "task-1",
      goal_id: "goal-overflow",
      summary: { latest_event_type: "succeeded", tokens_used: Number.MAX_SAFE_INTEGER },
    });
    await stateManager.writeRaw("tasks/goal-overflow/ledger/task-2.json", {
      task_id: "task-2",
      goal_id: "goal-overflow",
      summary: { latest_event_type: "failed", tokens_used: 1 },
    });
    await stateManager.writeRaw("tasks/goal-overflow/ledger/task-3.json", {
      task_id: "task-3",
      goal_id: "goal-overflow",
      summary: { latest_event_type: "succeeded", tokens_used: 1.5 },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCLI(tmpDir, "usage", "goal", "goal-overflow");

    expect(code).toBe(0);
    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain(`Total tokens: ${Number.MAX_SAFE_INTEGER}`);
    expect(output).toContain("Terminal tasks: 3");
  });

  it("reports schedule usage for a requested period", async () => {
    await saveScheduleHistory(tmpDir, [
      {
        entry_name: "Daily brief",
        duration_ms: 1200,
        fired_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        tokens_used: 88,
      },
    ]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCLI(tmpDir, "usage", "schedule", "--period", "24h");

    expect(code).toBe(0);
    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Usage summary (schedule, 24h)");
    expect(output).toContain("Runs: 1");
    expect(output).toContain("Total tokens: 88");
  });

  it("caps accumulated schedule usage totals at the maximum safe integer", async () => {
    const now = new Date().toISOString();
    await saveScheduleHistory(tmpDir, [
      {
        finished_at: now,
        tokens_used: Number.MAX_SAFE_INTEGER,
      },
      {
        finished_at: now,
        tokens_used: 1,
      },
    ]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCLI(tmpDir, "usage", "schedule", "--period", "24h");

    expect(code).toBe(0);
    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Runs: 2");
    expect(output).toContain(`Total tokens: ${Number.MAX_SAFE_INTEGER}`);
    expect(output).not.toContain(String(Number.MAX_SAFE_INTEGER + 1));
  });

  it("treats invalid schedule history rows as zero usage", async () => {
    await insertRawScheduleHistoryRecord(tmpDir, {
      finished_at: new Date().toISOString(),
      tokens_used: Number.MAX_SAFE_INTEGER + 1,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runCLI(tmpDir, "usage", "schedule", "--period", "24h");

    expect(code).toBe(0);
    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Usage summary (schedule, 24h)");
    expect(output).toContain("Runs: 0");
    expect(output).toContain("Total tokens: 0");
  });

  it("surfaces schedule history read errors instead of reporting zero usage", async () => {
    await dropScheduleHistoryTable(tmpDir);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCLI(tmpDir, "usage", "schedule", "--period", "24h");

    expect(code).toBe(1);
    expect(errSpy.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("Error:");
    expect(logSpy.mock.calls.map((call) => call.join(" ")).join("\n")).not.toContain("Runs: 0");
  });

  it("returns 1 for an unknown usage scope", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCLI(tmpDir, "usage", "nonsense");

    expect(code).toBe(1);
    expect(errSpy.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("Unknown usage scope.");
    expect(logSpy.mock.calls.map((call) => call.join(" ")).join("\n")).toContain(
      "Usage: pulseed usage <session|goal|daemon|schedule> [args]"
    );
  });

  it("returns 1 when session scope is missing an id", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCLI(tmpDir, "usage", "session");

    expect(code).toBe(1);
    expect(errSpy.mock.calls.map((call) => call.join(" ")).join("\n")).toContain(
      "Usage: pulseed usage session <session-id>"
    );
  });

  it("returns 1 when schedule period is invalid", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCLI(tmpDir, "usage", "schedule", "--period", "oops");

    expect(code).toBe(1);
    expect(errSpy.mock.calls.map((call) => call.join(" ")).join("\n")).toContain(
      "Error: period must look like 7d, 24h, or 2w"
    );
  });

  it("returns 1 when schedule period is not a safe integer", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCLI(tmpDir, "usage", "schedule", "--period", "9007199254740993d");

    expect(code).toBe(1);
    expect(errSpy.mock.calls.map((call) => call.join(" ")).join("\n")).toContain(
      "Error: period value must be a positive safe integer"
    );
  });

  it("returns 1 when schedule period overflows safe milliseconds", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCLI(tmpDir, "usage", "schedule", "--period", "9007199254740991d");

    expect(code).toBe(1);
    expect(errSpy.mock.calls.map((call) => call.join(" ")).join("\n")).toContain(
      "Error: period value is too large"
    );
  });
});
