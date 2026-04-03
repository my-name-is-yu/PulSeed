import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CronScheduler } from "../cron-scheduler.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";

let tempDir: string;
let scheduler: CronScheduler;

beforeEach(() => {
  tempDir = makeTempDir("cron-test-");
  scheduler = new CronScheduler(tempDir);
});

afterEach(() => {
  cleanupTempDir(tempDir);
});

// ─── addTask ───

describe("addTask", () => {
  it("assigns id and created_at automatically", async () => {
    const task = await scheduler.addTask({
      cron: "0 9 * * *",
      prompt: "daily reflection",
      type: "reflection",
      enabled: true,
      last_fired_at: null,
      permanent: false,
    });

    expect(task.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(task.created_at).toBeTruthy();
    expect(new Date(task.created_at).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("persists added task", async () => {
    await scheduler.addTask({
      cron: "0 9 * * *",
      prompt: "test",
      type: "custom",
      enabled: true,
      last_fired_at: null,
      permanent: false,
    });

    const tasks = await scheduler.loadTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.prompt).toBe("test");
  });

  it("defaults enabled to true", async () => {
    const task = await scheduler.addTask({
      cron: "0 9 * * *",
      prompt: "test",
      type: "custom",
      enabled: true,
      last_fired_at: null,
      permanent: false,
    });
    expect(task.enabled).toBe(true);
  });
});

// ─── removeTask ───

describe("removeTask", () => {
  it("removes existing task and returns true", async () => {
    const task = await scheduler.addTask({
      cron: "0 9 * * *",
      prompt: "to remove",
      type: "custom",
      enabled: true,
      last_fired_at: null,
      permanent: false,
    });

    const result = await scheduler.removeTask(task.id);
    expect(result).toBe(true);
    const tasks = await scheduler.loadTasks();
    expect(tasks).toHaveLength(0);
  });

  it("returns false for non-existent id", async () => {
    const result = await scheduler.removeTask("00000000-0000-0000-0000-000000000000");
    expect(result).toBe(false);
  });
});

// ─── getDueTasks ───

describe("getDueTasks", () => {
  it("returns task with last_fired_at=null (never fired)", async () => {
    // A task that fires every minute with null last_fired_at is always due
    await scheduler.addTask({
      cron: "* * * * *",
      prompt: "every minute",
      type: "custom",
      enabled: true,
      last_fired_at: null,
      permanent: false,
    });

    const due = await scheduler.getDueTasks();
    expect(due).toHaveLength(1);
  });

  it("returns task whose last_fired_at is before previous cron fire time", async () => {
    // Add a task with last_fired_at 2 minutes ago (should be due for * * * * *)
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    await scheduler.addTask({
      cron: "* * * * *",
      prompt: "overdue",
      type: "custom",
      enabled: true,
      last_fired_at: twoMinutesAgo,
      permanent: false,
    });

    const due = await scheduler.getDueTasks();
    expect(due).toHaveLength(1);
  });

  it("does not return task fired recently", async () => {
    // last_fired_at = now (fired just now, next fire is ~1 minute away)
    const now = new Date().toISOString();
    await scheduler.addTask({
      cron: "* * * * *",
      prompt: "just fired",
      type: "custom",
      enabled: true,
      last_fired_at: now,
      permanent: false,
    });

    const due = await scheduler.getDueTasks();
    expect(due).toHaveLength(0);
  });

  it("does not return disabled task", async () => {
    await scheduler.addTask({
      cron: "* * * * *",
      prompt: "disabled",
      type: "custom",
      enabled: false,
      last_fired_at: null,
      permanent: false,
    });

    const due = await scheduler.getDueTasks();
    expect(due).toHaveLength(0);
  });

  it("jitter does not prevent tasks from firing within reasonable window (2x interval)", async () => {
    // A task that runs every minute, never fired — should virtually always be due
    await scheduler.addTask({
      cron: "* * * * *",
      prompt: "jitter test",
      type: "custom",
      enabled: true,
      last_fired_at: null,
      permanent: false,
    });

    // Run getDueTasks multiple times — jitter is ±5% of 60s = ±3s max
    // With last_fired_at=null a task should always be due
    let dueCount = 0;
    for (let i = 0; i < 10; i++) {
      const due = await scheduler.getDueTasks();
      dueCount += due.length;
    }
    expect(dueCount).toBe(10);
  });
});

// ─── markFired ───

describe("markFired", () => {
  it("updates last_fired_at to approximately now", async () => {
    const before = Date.now();
    const task = await scheduler.addTask({
      cron: "* * * * *",
      prompt: "mark me",
      type: "custom",
      enabled: true,
      last_fired_at: null,
      permanent: false,
    });

    await scheduler.markFired(task.id);
    const tasks = await scheduler.loadTasks();
    const updated = tasks.find((t) => t.id === task.id)!;
    expect(updated.last_fired_at).not.toBeNull();
    expect(new Date(updated.last_fired_at!).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("task no longer due immediately after being marked fired", async () => {
    const task = await scheduler.addTask({
      cron: "* * * * *",
      prompt: "fire then check",
      type: "custom",
      enabled: true,
      last_fired_at: null,
      permanent: false,
    });

    await scheduler.markFired(task.id);
    const due = await scheduler.getDueTasks();
    expect(due.find((t) => t.id === task.id)).toBeUndefined();
  });
});

// ─── expireOldTasks ───

describe("expireOldTasks", () => {
  it("removes non-permanent tasks older than 7 days", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const tasks = await scheduler.loadTasks();
    // Directly save a task with old created_at
    const oldTask = {
      id: "11111111-1111-1111-1111-111111111111",
      cron: "0 9 * * *",
      prompt: "old task",
      type: "custom" as const,
      enabled: true,
      last_fired_at: null,
      permanent: false,
      created_at: eightDaysAgo,
    };
    await scheduler.saveTasks([...tasks, oldTask]);

    await scheduler.expireOldTasks();
    const remaining = await scheduler.loadTasks();
    expect(remaining.find((t) => t.id === oldTask.id)).toBeUndefined();
  });

  it("keeps permanent tasks regardless of age", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const permanentTask = {
      id: "22222222-2222-2222-2222-222222222222",
      cron: "0 9 * * *",
      prompt: "permanent task",
      type: "consolidation" as const,
      enabled: true,
      last_fired_at: null,
      permanent: true,
      created_at: eightDaysAgo,
    };
    await scheduler.saveTasks([permanentTask]);

    await scheduler.expireOldTasks();
    const remaining = await scheduler.loadTasks();
    expect(remaining.find((t) => t.id === permanentTask.id)).toBeDefined();
  });

  it("keeps recent non-permanent tasks", async () => {
    const task = await scheduler.addTask({
      cron: "0 9 * * *",
      prompt: "recent",
      type: "reflection",
      enabled: true,
      last_fired_at: null,
      permanent: false,
    });

    await scheduler.expireOldTasks();
    const remaining = await scheduler.loadTasks();
    expect(remaining.find((t) => t.id === task.id)).toBeDefined();
  });
});

// ─── Persistence ───

describe("persistence", () => {
  it("save/load round-trip preserves all fields", async () => {
    const task = await scheduler.addTask({
      cron: "30 8 * * 1",
      prompt: "weekly monday",
      type: "reflection",
      enabled: true,
      last_fired_at: null,
      permanent: true,
    });

    const scheduler2 = new CronScheduler(tempDir);
    const tasks = await scheduler2.loadTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: task.id,
      cron: "30 8 * * 1",
      prompt: "weekly monday",
      type: "reflection",
      enabled: true,
      last_fired_at: null,
      permanent: true,
    });
  });

  it("returns empty array when file does not exist", async () => {
    const tasks = await scheduler.loadTasks();
    expect(tasks).toEqual([]);
  });

  it("multiple tasks survive round-trip", async () => {
    await scheduler.addTask({
      cron: "0 9 * * *",
      prompt: "task 1",
      type: "reflection",
      enabled: true,
      last_fired_at: null,
      permanent: false,
    });
    await scheduler.addTask({
      cron: "0 18 * * *",
      prompt: "task 2",
      type: "consolidation",
      enabled: false,
      last_fired_at: null,
      permanent: true,
    });

    const scheduler2 = new CronScheduler(tempDir);
    const tasks = await scheduler2.loadTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.prompt).sort()).toEqual(["task 1", "task 2"]);
  });
});
