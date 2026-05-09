import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectGoalUsage,
  collectScheduleUsage,
  listRecoverableArchivedGoalIds,
  parseUsagePeriodMs,
  readTasksForGoal,
  resolveStatePath,
} from "../chat-runner-state.js";
import { ScheduleHistoryStore } from "../../../runtime/schedule/history.js";
import { openControlDatabase } from "../../../runtime/store/index.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJson(baseDir: string, relativePath: string, value: unknown): void {
  const target = path.join(baseDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2));
}

function writeRaw(baseDir: string, relativePath: string, value: string): void {
  const target = path.join(baseDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

async function saveScheduleHistory(baseDir: string, records: Array<Record<string, unknown>>): Promise<void> {
  const now = new Date().toISOString();
  await new ScheduleHistoryStore(baseDir).save(records.map((record, index) => ({
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

async function insertRawScheduleHistoryRecords(baseDir: string, records: Array<Record<string, unknown>>): Promise<void> {
  const db = await openControlDatabase({ baseDir });
  try {
    db.transaction((sqlite) => {
      const insert = sqlite.prepare(`
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
      `);
      records.forEach((record, index) => {
        const finishedAt = typeof record["finished_at"] === "string" ? record["finished_at"] : new Date().toISOString();
        insert.run(
          `raw-invalid-${index + 1}`,
          `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          "Daily brief",
          "cron",
          "manual_run",
          finishedAt,
          finishedAt,
          0,
          0,
          index,
          JSON.stringify(record)
        );
      });
    });
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("chat-runner-state helpers", () => {
  it("resolveStatePath blocks escaping the base dir", () => {
    const baseDir = makeTempDir("pulseed-chat-state-");
    expect(resolveStatePath(baseDir, "tasks", "goal-1")).toBe(path.join(baseDir, "tasks", "goal-1"));
    expect(resolveStatePath(baseDir, "..", "outside")).toBeNull();
  });

  it("listRecoverableArchivedGoalIds only returns archived goals with goal.json", async () => {
    const baseDir = makeTempDir("pulseed-chat-archive-");
    writeJson(baseDir, "archive/goal-a/goal/goal.json", { id: "goal-a" });
    fs.mkdirSync(path.join(baseDir, "archive", "goal-b", "goal"), { recursive: true });
    fs.mkdirSync(path.join(baseDir, "archive", ".staging"), { recursive: true });

    await expect(listRecoverableArchivedGoalIds(baseDir)).resolves.toEqual(["goal-a"]);
  });

  it("readTasksForGoal falls back to archived tasks and sorts newest first", async () => {
    const baseDir = makeTempDir("pulseed-chat-tasks-");
    writeJson(baseDir, "archive/goal-1/tasks/task-1.json", {
      id: "task-1",
      goal_id: "goal-1",
      strategy_id: null,
      target_dimensions: ["quality"],
      primary_dimension: "quality",
      status: "completed",
      task_category: "normal",
      created_at: "2026-04-01T00:00:00.000Z",
      work_description: "older",
      rationale: "test",
      approach: "ship",
      success_criteria: [{ description: "done", verification_method: "check", is_blocking: true }],
      scope_boundary: { in_scope: ["task"], out_of_scope: [], blast_radius: "low" },
      constraints: [],
    });
    writeJson(baseDir, "archive/goal-1/tasks/task-2.json", {
      id: "task-2",
      goal_id: "goal-1",
      strategy_id: null,
      target_dimensions: ["quality"],
      primary_dimension: "quality",
      status: "running",
      task_category: "normal",
      created_at: "2026-04-02T00:00:00.000Z",
      work_description: "newer",
      rationale: "test",
      approach: "ship",
      success_criteria: [{ description: "done", verification_method: "check", is_blocking: true }],
      scope_boundary: { in_scope: ["task"], out_of_scope: [], blast_radius: "low" },
      constraints: [],
    });

    const tasks = await readTasksForGoal(baseDir, "goal-1");
    expect(tasks.map((task) => task.id)).toEqual(["task-2", "task-1"]);
  });

  it("collectGoalUsage ignores malformed ledger records and counts terminal tasks", async () => {
    const baseDir = makeTempDir("pulseed-chat-usage-goal-");
    writeJson(baseDir, "tasks/goal-usage/ledger/task-1.json", {
      summary: { latest_event_type: "succeeded", tokens_used: 21 },
    });
    writeJson(baseDir, "tasks/goal-usage/ledger/task-2.json", {
      summary: { latest_event_type: "running", tokens_used: 8 },
    });
    const invalidPath = path.join(baseDir, "tasks", "goal-usage", "ledger", "task-3.json");
    fs.mkdirSync(path.dirname(invalidPath), { recursive: true });
    fs.writeFileSync(invalidPath, "{not-json");

    await expect(collectGoalUsage(baseDir, "goal-usage")).resolves.toEqual({
      goalId: "goal-usage",
      totalTokens: 29,
      taskCount: 3,
      terminalTaskCount: 1,
    });
  });

  it("collectGoalUsage ignores unsafe persisted token counts", async () => {
    const baseDir = makeTempDir("pulseed-chat-usage-goal-bounds-");
    writeJson(baseDir, "tasks/goal-usage/ledger/task-valid.json", {
      summary: { latest_event_type: "succeeded", tokens_used: 21 },
    });
    writeJson(baseDir, "tasks/goal-usage/ledger/task-negative.json", {
      summary: { latest_event_type: "failed", tokens_used: -5 },
    });
    writeJson(baseDir, "tasks/goal-usage/ledger/task-fractional.json", {
      summary: { latest_event_type: "abandoned", tokens_used: 2.5 },
    });
    writeJson(baseDir, "tasks/goal-usage/ledger/task-unsafe.json", {
      summary: { latest_event_type: "succeeded", tokens_used: Number.MAX_SAFE_INTEGER + 1 },
    });
    writeRaw(
      baseDir,
      "tasks/goal-usage/ledger/task-overflow.json",
      "{\"summary\":{\"latest_event_type\":\"succeeded\",\"tokens_used\":1e309}}"
    );

    await expect(collectGoalUsage(baseDir, "goal-usage")).resolves.toEqual({
      goalId: "goal-usage",
      totalTokens: 21,
      taskCount: 5,
      terminalTaskCount: 5,
    });
  });

  it("collectGoalUsage keeps aggregate token totals safe", async () => {
    const baseDir = makeTempDir("pulseed-chat-usage-goal-aggregate-");
    writeJson(baseDir, "tasks/goal-usage/ledger/task-a.json", {
      summary: { latest_event_type: "succeeded", tokens_used: Number.MAX_SAFE_INTEGER },
    });
    writeJson(baseDir, "tasks/goal-usage/ledger/task-b.json", {
      summary: { latest_event_type: "failed", tokens_used: Number.MAX_SAFE_INTEGER },
    });

    await expect(collectGoalUsage(baseDir, "goal-usage")).resolves.toEqual({
      goalId: "goal-usage",
      totalTokens: Number.MAX_SAFE_INTEGER,
      taskCount: 2,
      terminalTaskCount: 2,
    });
  });

  it("collectScheduleUsage filters by period", async () => {
    const baseDir = makeTempDir("pulseed-chat-usage-schedule-");
    await saveScheduleHistory(baseDir, [
      { finished_at: "2026-04-27T10:00:00.000Z", tokens_used: 13 },
      { finished_at: "2026-04-26T11:00:00.000Z", tokens_used: 7 },
      { finished_at: "2026-04-20T11:00:00.000Z", tokens_used: 99 },
    ]);

    await expect(
      collectScheduleUsage(baseDir, "24h", Date.parse("2026-04-27T12:00:00.000Z"))
    ).resolves.toEqual({
      period: "24h",
      runs: 1,
      totalTokens: 13,
    });
  });

  it("collectScheduleUsage skips invalid persisted schedule rows", async () => {
    const baseDir = makeTempDir("pulseed-chat-usage-schedule-bounds-");
    await saveScheduleHistory(baseDir, [
      { finished_at: "2026-04-27T10:00:00.000Z", tokens_used: 13 },
    ]);
    await insertRawScheduleHistoryRecords(baseDir, [
      { finished_at: "2026-04-27T10:05:00.000Z", tokens_used: -1 },
      { finished_at: "2026-04-27T10:10:00.000Z", tokens_used: 1.5 },
      { finished_at: "2026-04-27T10:15:00.000Z", tokens_used: Number.MAX_SAFE_INTEGER + 1 },
    ]);

    await expect(
      collectScheduleUsage(baseDir, "24h", Date.parse("2026-04-27T12:00:00.000Z"))
    ).resolves.toEqual({
      period: "24h",
      runs: 1,
      totalTokens: 13,
    });
  });

  it("parseUsagePeriodMs parses exact supported periods", () => {
    expect(parseUsagePeriodMs("24h")).toBe(24 * 60 * 60 * 1000);
    expect(parseUsagePeriodMs("7d")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseUsagePeriodMs("2w")).toBe(2 * 7 * 24 * 60 * 60 * 1000);
  });

  it("parseUsagePeriodMs rejects invalid periods", () => {
    expect(() => parseUsagePeriodMs("tomorrow")).toThrow("period must look like 7d, 24h, or 2w");
    expect(() => parseUsagePeriodMs("9007199254740993d")).toThrow("period value must be a positive safe integer");
    expect(() => parseUsagePeriodMs("9007199254740991d")).toThrow("period value is too large");
  });
});
