import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeBudgetLimitSchema, RuntimeBudgetStore, RuntimeBudgetUsageSchema } from "../store/budget-store.js";

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

    expect(status.dimensions).toContainEqual(expect.objectContaining({ dimension: "iterations", used: 2, remaining: 8 }));
    expect(status.dimensions).toContainEqual(expect.objectContaining({ dimension: "disk_bytes", used: 250, remaining: 750 }));
    expect(status.dimensions).toContainEqual(expect.objectContaining({ dimension: "llm_tokens", used: 1000, remaining: 4000 }));
    expect(status.dimensions).toContainEqual(expect.objectContaining({ dimension: "evaluator_attempts", used: 1, remaining: 2 }));
    expect(status.recent_consumption[0]).toMatchObject({ source: "evaluator_call", amount: 1 });
  });

  it("rejects non-finite budget values before persistence", async () => {
    expect(RuntimeBudgetLimitSchema.safeParse({
      dimension: "wall_clock_ms",
      limit: 1_000,
      warn_at_remaining: 100,
      mode_transition_at_remaining: { consolidation: 400, finalization: 100 },
    }).success).toBe(true);
    expect(RuntimeBudgetLimitSchema.safeParse({ dimension: "wall_clock_ms", limit: Number.POSITIVE_INFINITY }).success).toBe(false);
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
      limits: [{ dimension: "tasks", limit: 10 }],
    });
    await expect(store.updateUsage("budget-non-finite-usage", {
      dimension: "tasks",
      amount: Number.POSITIVE_INFINITY,
      source: "manual",
      observed_at: "2026-05-01T00:01:00.000Z",
    })).rejects.toThrow("finite non-negative");

    expect((await store.load("budget-non-finite-usage"))?.usage[0]?.used).toBe(0);
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
});
