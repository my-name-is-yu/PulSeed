import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeBudgetLimitSchema, RuntimeBudgetStore, RuntimeBudgetUsageSchema } from "../store/budget-store.js";
import { openRuntimeControlDatabase, type SqliteDatabase } from "../store/control-db/index.js";

describe("RuntimeBudgetStore", () => {
  let tmpDir: string;
  let store: RuntimeBudgetStore;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-budget-store-"));
    store = new RuntimeBudgetStore(path.join(tmpDir, "runtime"));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("persists budget definitions and current usage across task/artifact/tool/evaluator updates", async () => {
    await store.create({
      budget_id: "budget-run",
      scope: { goal_id: "goal-a", run_id: "run-a" },
      created_at: "2026-05-01T00:00:00.000Z",
      limits: [
        { dimension: "iterations", limit: 10 },
        { dimension: "disk_bytes", limit: 1000 },
        { dimension: "llm_tokens", limit: 5000 },
        { dimension: "evaluator_attempts", limit: 3 },
      ],
    });
    await store.recordTaskExecution("budget-run", { iterations: 2, observed_at: "2026-05-01T00:01:00.000Z" });
    await store.recordArtifactGeneration("budget-run", { disk_bytes: 250, observed_at: "2026-05-01T00:02:00.000Z" });
    await store.recordToolUsage("budget-run", { llm_tokens: 1000, observed_at: "2026-05-01T00:03:00.000Z" });
    await store.recordEvaluatorCall("budget-run", { observed_at: "2026-05-01T00:04:00.000Z" });

    const restarted = new RuntimeBudgetStore(path.join(tmpDir, "runtime"));
    const budget = await restarted.load("budget-run");
    const status = restarted.status(budget!);

    await expect(fsp.stat(path.join(tmpDir, "runtime", "budgets", "budget-run.json"))).rejects.toThrow();
    expect(status.dimensions).toContainEqual(expect.objectContaining({ dimension: "iterations", used: 2, remaining: 8 }));
    expect(status.dimensions).toContainEqual(expect.objectContaining({ dimension: "disk_bytes", used: 250, remaining: 750 }));
    expect(status.dimensions).toContainEqual(expect.objectContaining({ dimension: "llm_tokens", used: 1000, remaining: 4000 }));
    expect(status.dimensions).toContainEqual(expect.objectContaining({ dimension: "evaluator_attempts", used: 1, remaining: 2 }));
    expect(status.recent_consumption[0]).toMatchObject({ source: "evaluator_call", amount: 1 });
  });

  it("rejects non-finite and unsafe budget values before persistence", async () => {
    expect(RuntimeBudgetLimitSchema.safeParse({
      dimension: "wall_clock_ms",
      limit: 1_000,
      warn_at_remaining: 100,
      mode_transition_at_remaining: { consolidation: 400, finalization: 100 },
    }).success).toBe(true);
    expect(RuntimeBudgetLimitSchema.safeParse({ dimension: "wall_clock_ms", limit: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(RuntimeBudgetLimitSchema.safeParse({ dimension: "wall_clock_ms", limit: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(RuntimeBudgetLimitSchema.safeParse({
      dimension: "wall_clock_ms",
      limit: 1_000,
      warn_at_remaining: Number.POSITIVE_INFINITY,
    }).success).toBe(false);
    expect(RuntimeBudgetUsageSchema.safeParse({
      dimension: "wall_clock_ms",
      used: Number.POSITIVE_INFINITY,
      updated_at: "2026-05-01T00:00:00.000Z",
    }).success).toBe(false);
    expect(RuntimeBudgetUsageSchema.safeParse({
      dimension: "wall_clock_ms",
      used: Number.MAX_SAFE_INTEGER + 1,
      updated_at: "2026-05-01T00:00:00.000Z",
    }).success).toBe(false);
    expect(RuntimeBudgetUsageSchema.safeParse({
      dimension: "wall_clock_ms",
      used: 0,
      updated_at: "2026-05-01T00:00:00.000Z",
      recent: [{
        amount: Number.POSITIVE_INFINITY,
        source: "manual",
        observed_at: "2026-05-01T00:00:00.000Z",
      }],
    }).success).toBe(false);

    await expect(store.create({
      budget_id: "budget-non-finite-limit",
      scope: { goal_id: "goal-a" },
      created_at: "2026-05-01T00:00:00.000Z",
      limits: [{ dimension: "tasks", limit: Number.POSITIVE_INFINITY }],
    })).rejects.toThrow();
    await expect(fsp.stat(path.join(tmpDir, "runtime", "budgets", "budget-non-finite-limit.json"))).rejects.toThrow();

    await store.create({
      budget_id: "budget-non-finite-usage",
      scope: { goal_id: "goal-a" },
      created_at: "2026-05-01T00:00:00.000Z",
      limits: [
        { dimension: "iterations", limit: 10 },
        { dimension: "tasks", limit: 10 },
        { dimension: "disk_bytes", limit: 100 },
        { dimension: "artifacts", limit: 10 },
        { dimension: "llm_tokens", limit: 100 },
        { dimension: "tool_calls", limit: 10 },
      ],
    });
    await expect(store.updateUsage("budget-non-finite-usage", {
      dimension: "tasks",
      amount: Number.POSITIVE_INFINITY,
      source: "manual",
      observed_at: "2026-05-01T00:01:00.000Z",
    })).rejects.toThrow("finite safe non-negative");

    expect((await store.load("budget-non-finite-usage"))?.usage[0]?.used).toBe(0);

    await expect(store.recordTaskExecution("budget-non-finite-usage", {
      iterations: 1,
      tasks: Number.NaN,
      observed_at: "2026-05-01T00:02:00.000Z",
    })).rejects.toThrow("finite safe non-negative");
    await expect(store.recordArtifactGeneration("budget-non-finite-usage", {
      disk_bytes: 1,
      artifacts: -1,
      observed_at: "2026-05-01T00:03:00.000Z",
    })).rejects.toThrow("finite safe non-negative");
    await expect(store.recordToolUsage("budget-non-finite-usage", {
      llm_tokens: 1,
      tool_calls: Number.MAX_SAFE_INTEGER + 1,
      observed_at: "2026-05-01T00:04:00.000Z",
    })).rejects.toThrow("finite safe non-negative");

    const usage = (await store.load("budget-non-finite-usage"))?.usage ?? [];
    expect(usage.every((entry) => entry.used === 0 && entry.recent.length === 0)).toBe(true);
  });

  it("rejects budget thresholds above their enclosing limit before persistence", async () => {
    expect(RuntimeBudgetLimitSchema.safeParse({
      dimension: "tasks",
      limit: 10,
      warn_at_remaining: 10,
      approval_at_remaining: 0,
      handoff_at_remaining: 0,
      finalization_at_remaining: 0,
      mode_transition_at_remaining: { consolidation: 10, finalization: 0 },
    }).success).toBe(true);

    for (const field of [
      "warn_at_remaining",
      "approval_at_remaining",
      "handoff_at_remaining",
      "finalization_at_remaining",
    ] as const) {
      const parsed = RuntimeBudgetLimitSchema.safeParse({
        dimension: "tasks",
        limit: 10,
        [field]: 11,
      });
      expect(parsed.success).toBe(false);
    }

    expect(RuntimeBudgetLimitSchema.safeParse({
      dimension: "tasks",
      limit: 10,
      mode_transition_at_remaining: { consolidation: 11 },
    }).success).toBe(false);
    expect(RuntimeBudgetLimitSchema.safeParse({
      dimension: "tasks",
      limit: 10,
      mode_transition_at_remaining: { finalization: 11 },
    }).success).toBe(false);

    await expect(store.create({
      budget_id: "budget-invalid-threshold",
      scope: { goal_id: "goal-a" },
      created_at: "2026-05-01T00:00:00.000Z",
      limits: [
        {
          dimension: "tasks",
          limit: 10,
          approval_at_remaining: 11,
        },
      ],
    })).rejects.toThrow("approval_at_remaining must be less than or equal to limit");
    await expect(store.load("budget-invalid-threshold")).resolves.toBeNull();
  });

  it("normalizes legacy persisted thresholds above their limit when reading existing budgets", async () => {
    await store.create({
      budget_id: "budget-legacy-threshold",
      scope: { goal_id: "goal-a" },
      created_at: "2026-05-01T00:00:00.000Z",
      limits: [
        {
          dimension: "tasks",
          limit: 10,
          approval_at_remaining: 1,
          mode_transition_at_remaining: { consolidation: 2, finalization: 1 },
        },
      ],
    });

    await mutatePersistedBudget("budget-legacy-threshold", (persisted: {
      limits: Array<{
        approval_at_remaining?: number;
        mode_transition_at_remaining?: {
          consolidation?: number;
          finalization?: number;
        };
      }>;
    }) => {
      persisted.limits[0]!.approval_at_remaining = 11;
      persisted.limits[0]!.mode_transition_at_remaining = {
        consolidation: 12,
        finalization: 13,
      };
    });

    const budget = await store.load("budget-legacy-threshold");

    expect(budget?.limits[0]).toMatchObject({
      dimension: "tasks",
      limit: 10,
      approval_at_remaining: 10,
      mode_transition_at_remaining: {
        consolidation: 10,
        finalization: 10,
      },
    });
    await expect(store.list()).resolves.toContainEqual(expect.objectContaining({ budget_id: "budget-legacy-threshold" }));
  });

  it("rejects unsafe budget usage additions without corrupting persisted counters", async () => {
    await store.create({
      budget_id: "budget-unsafe-usage",
      scope: { goal_id: "goal-a" },
      created_at: "2026-05-01T00:00:00.000Z",
      limits: [{ dimension: "llm_tokens", limit: Number.MAX_SAFE_INTEGER }],
    });

    await expect(store.updateUsage("budget-unsafe-usage", {
      dimension: "llm_tokens",
      amount: Number.MAX_SAFE_INTEGER + 1,
      source: "tool_usage",
      observed_at: "2026-05-01T00:01:00.000Z",
    })).rejects.toThrow("finite safe non-negative");

    expect((await store.load("budget-unsafe-usage"))?.usage[0]).toMatchObject({ used: 0, recent: [] });

    await store.updateUsage("budget-unsafe-usage", {
      dimension: "llm_tokens",
      amount: Number.MAX_SAFE_INTEGER,
      source: "tool_usage",
      observed_at: "2026-05-01T00:02:00.000Z",
    });

    await expect(store.updateUsage("budget-unsafe-usage", {
      dimension: "llm_tokens",
      amount: 0.1,
      source: "tool_usage",
      observed_at: "2026-05-01T00:03:00.000Z",
    })).rejects.toThrow("usage total");
    await expect(store.updateUsage("budget-unsafe-usage", {
      dimension: "llm_tokens",
      amount: 1,
      source: "tool_usage",
      observed_at: "2026-05-01T00:04:00.000Z",
    })).rejects.toThrow("usage total");

    const budget = await store.load("budget-unsafe-usage");
    expect(budget?.usage[0]).toMatchObject({
      used: Number.MAX_SAFE_INTEGER,
      recent: [expect.objectContaining({ amount: Number.MAX_SAFE_INTEGER })],
    });

    await store.create({
      budget_id: "budget-rounded-usage",
      scope: { goal_id: "goal-a" },
      created_at: "2026-05-01T00:00:00.000Z",
      limits: [{ dimension: "llm_tokens", limit: Number.MAX_SAFE_INTEGER }],
    });
    await store.updateUsage("budget-rounded-usage", {
      dimension: "llm_tokens",
      amount: Number.MAX_SAFE_INTEGER - 1,
      source: "tool_usage",
      observed_at: "2026-05-01T00:05:00.000Z",
    });
    await expect(store.updateUsage("budget-rounded-usage", {
      dimension: "llm_tokens",
      amount: 0.5,
      source: "tool_usage",
      observed_at: "2026-05-01T00:06:00.000Z",
    })).rejects.toThrow("usage total");

    const roundedBudget = await store.load("budget-rounded-usage");
    expect(roundedBudget?.usage[0]).toMatchObject({
      used: Number.MAX_SAFE_INTEGER - 1,
      recent: [expect.objectContaining({ amount: Number.MAX_SAFE_INTEGER - 1 })],
    });
  });

  it("marks exhaustion and applies the configured exhaustion policy", async () => {
    await store.create({
      budget_id: "budget-exhausted",
      scope: { goal_id: "goal-a" },
      created_at: "2026-05-01T00:00:00.000Z",
      limits: [
        {
          dimension: "tasks",
          limit: 2,
          exhaustion_policy: "handoff_required",
        },
      ],
    });

    await store.recordTaskExecution("budget-exhausted", { tasks: 2, observed_at: "2026-05-01T00:01:00.000Z" });
    const status = store.status((await store.load("budget-exhausted"))!);

    expect(status).toMatchObject({
      mode: "exhausted",
      exhausted: true,
      approval_required: false,
      handoff_required: true,
    });
    expect(status.dimensions[0]).toMatchObject({
      dimension: "tasks",
      remaining: 0,
      exhausted: true,
      exhaustion_policy: "handoff_required",
      threshold_actions: ["handoff_required"],
    });
  });

  it("does not convert stop exhaustion policy into approval-required continuation", async () => {
    await store.create({
      budget_id: "budget-stop",
      scope: { goal_id: "goal-a" },
      created_at: "2026-05-01T00:00:00.000Z",
      limits: [
        {
          dimension: "tasks",
          limit: 1,
          exhaustion_policy: "stop",
        },
      ],
    });

    await store.recordTaskExecution("budget-stop", { tasks: 1, observed_at: "2026-05-01T00:01:00.000Z" });
    const status = store.status((await store.load("budget-stop"))!);

    expect(status.exhausted).toBe(true);
    expect(status.approval_required).toBe(false);
    expect(status.dimensions[0]).toMatchObject({
      dimension: "tasks",
      exhaustion_policy: "stop",
      threshold_actions: [],
    });
  });

  it("triggers approval before a high-cost branch when remaining budget crosses threshold", async () => {
    await store.create({
      budget_id: "budget-approval",
      scope: { run_id: "run-a" },
      created_at: "2026-05-01T00:00:00.000Z",
      limits: [
        {
          dimension: "evaluator_attempts",
          limit: 3,
          approval_at_remaining: 1,
        },
      ],
    });

    await store.recordEvaluatorCall("budget-approval", { attempts: 2, observed_at: "2026-05-01T00:01:00.000Z" });
    const status = store.status((await store.load("budget-approval"))!);

    expect(status.approval_required).toBe(true);
    expect(status.dimensions[0]).toMatchObject({
      dimension: "evaluator_attempts",
      used: 2,
      remaining: 1,
      threshold_actions: ["approval_required"],
    });
  });

  it("switches task generation context from exploration to consolidation and finalization by remaining budget", async () => {
    await store.create({
      budget_id: "budget-mode",
      scope: { goal_id: "goal-a" },
      created_at: "2026-05-01T00:00:00.000Z",
      limits: [
        {
          dimension: "wall_clock_ms",
          limit: 1000,
          finalization_at_remaining: 150,
          mode_transition_at_remaining: {
            consolidation: 400,
            finalization: 150,
          },
        },
      ],
    });

    await store.updateUsage("budget-mode", {
      dimension: "wall_clock_ms",
      amount: 650,
      source: "manual",
      observed_at: "2026-05-01T00:01:00.000Z",
    });
    let budget = (await store.load("budget-mode"))!;
    expect(store.taskGenerationContext(budget)).toMatchObject({
      mode: "consolidation",
      finalization_required: false,
      remaining: { wall_clock_ms: 350 },
    });

    await store.updateUsage("budget-mode", {
      dimension: "wall_clock_ms",
      amount: 250,
      source: "manual",
      observed_at: "2026-05-01T00:02:00.000Z",
    });
    budget = (await store.load("budget-mode"))!;

    expect(store.taskGenerationContext(budget)).toMatchObject({
      mode: "finalization",
      finalization_required: true,
      remaining: { wall_clock_ms: 100 },
    });
  });

  async function mutatePersistedBudget<T extends Record<string, unknown>>(
    budgetId: string,
    mutate: (persisted: T) => void,
  ): Promise<void> {
    const db = await openRuntimeControlDatabase({ rootDir: path.join(tmpDir, "runtime") });
    try {
      const row = db.read((sqlite) => sqlite.prepare(`
        SELECT record_json
        FROM runtime_budgets
        WHERE budget_id = ?
      `).get(budgetId) as { record_json: string } | undefined);
      if (!row) throw new Error(`Missing persisted budget: ${budgetId}`);
      const persisted = JSON.parse(row.record_json) as T;
      mutate(persisted);
      db.transaction((sqlite: SqliteDatabase) => {
        sqlite.prepare(`
          UPDATE runtime_budgets
          SET record_json = json(?)
          WHERE budget_id = ?
        `).run(JSON.stringify(persisted), budgetId);
      });
    } finally {
      db.close();
    }
  }
});
