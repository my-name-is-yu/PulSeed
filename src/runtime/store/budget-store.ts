import { z } from "zod";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "./runtime-paths.js";
import { RuntimeJournal } from "./runtime-journal.js";

export const RuntimeBudgetDimensionSchema = z.enum([
  "wall_clock_ms",
  "iterations",
  "tasks",
  "process_ms",
  "disk_bytes",
  "artifacts",
  "llm_tokens",
  "tool_calls",
  "evaluator_attempts",
]);
export type RuntimeBudgetDimension = z.infer<typeof RuntimeBudgetDimensionSchema>;

export const RuntimeBudgetModeSchema = z.enum([
  "exploration",
  "consolidation",
  "finalization",
  "exhausted",
]);
export type RuntimeBudgetMode = z.infer<typeof RuntimeBudgetModeSchema>;

export const RuntimeBudgetThresholdActionSchema = z.enum([
  "approval_required",
  "handoff_required",
  "finalization_required",
]);
export type RuntimeBudgetThresholdAction = z.infer<typeof RuntimeBudgetThresholdActionSchema>;

export const RuntimeBudgetScopeSchema = z.object({
  goal_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
}).strict().refine((scope) => Boolean(scope.goal_id || scope.run_id), {
  message: "budget scope requires goal_id or run_id",
});
export type RuntimeBudgetScope = z.infer<typeof RuntimeBudgetScopeSchema>;

const RuntimeBudgetNonNegativeSafeNumberSchema = z.number().finite().safe().nonnegative();

export const RuntimeBudgetLimitSchema = z.object({
  dimension: RuntimeBudgetDimensionSchema,
  limit: RuntimeBudgetNonNegativeSafeNumberSchema,
  warn_at_remaining: RuntimeBudgetNonNegativeSafeNumberSchema.optional(),
  approval_at_remaining: RuntimeBudgetNonNegativeSafeNumberSchema.optional(),
  handoff_at_remaining: RuntimeBudgetNonNegativeSafeNumberSchema.optional(),
  finalization_at_remaining: RuntimeBudgetNonNegativeSafeNumberSchema.optional(),
  mode_transition_at_remaining: z.object({
    consolidation: RuntimeBudgetNonNegativeSafeNumberSchema.optional(),
    finalization: RuntimeBudgetNonNegativeSafeNumberSchema.optional(),
  }).strict().optional(),
  exhaustion_policy: z.enum(["stop", "approval_required", "handoff_required", "finalize"]).default("approval_required"),
}).strict();
export type RuntimeBudgetLimit = z.infer<typeof RuntimeBudgetLimitSchema>;
export type RuntimeBudgetLimitInput = z.input<typeof RuntimeBudgetLimitSchema>;

export const RuntimeBudgetUsageSchema = z.object({
  dimension: RuntimeBudgetDimensionSchema,
  used: RuntimeBudgetNonNegativeSafeNumberSchema,
  updated_at: z.string().datetime(),
  recent: z.array(z.object({
    amount: RuntimeBudgetNonNegativeSafeNumberSchema,
    source: z.enum(["task_execution", "artifact_generation", "tool_usage", "evaluator_call", "manual"]),
    reason: z.string().min(1).optional(),
    observed_at: z.string().datetime(),
  }).strict()).default([]),
}).strict();
export type RuntimeBudgetUsage = z.infer<typeof RuntimeBudgetUsageSchema>;
export type RuntimeBudgetUsageInput = z.input<typeof RuntimeBudgetUsageSchema>;

export const RuntimeBudgetRecordSchema = z.object({
  schema_version: z.literal("runtime-budget-v1"),
  budget_id: z.string().min(1),
  scope: RuntimeBudgetScopeSchema,
  title: z.string().min(1).optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  limits: z.array(RuntimeBudgetLimitSchema).min(1),
  usage: z.array(RuntimeBudgetUsageSchema),
  notes: z.string().min(1).optional(),
}).strict().superRefine((budget, ctx) => {
  const seenLimits = new Set<string>();
  for (const limit of budget.limits) {
    if (seenLimits.has(limit.dimension)) {
      ctx.addIssue({
        code: "custom",
        path: ["limits", limit.dimension],
        message: `duplicate budget limit dimension: ${limit.dimension}`,
      });
    }
    seenLimits.add(limit.dimension);
  }
  const seenUsage = new Set<string>();
  for (const usage of budget.usage) {
    if (seenUsage.has(usage.dimension)) {
      ctx.addIssue({
        code: "custom",
        path: ["usage", usage.dimension],
        message: `duplicate budget usage dimension: ${usage.dimension}`,
      });
    }
    seenUsage.add(usage.dimension);
  }
});
export type RuntimeBudgetRecord = z.infer<typeof RuntimeBudgetRecordSchema>;
const RuntimeBudgetRecordRuntimeSchema = RuntimeBudgetRecordSchema as unknown as z.ZodType<RuntimeBudgetRecord>;

export interface RuntimeBudgetCreateInput {
  budget_id: string;
  scope: RuntimeBudgetScope;
  title?: string;
  created_at?: string;
  limits: RuntimeBudgetLimitInput[];
  notes?: string;
}

export interface RuntimeBudgetUsageUpdateInput {
  dimension: RuntimeBudgetDimension;
  amount: number;
  source: RuntimeBudgetUsage["recent"][number]["source"];
  reason?: string;
  observed_at?: string;
}

export interface RuntimeBudgetDimensionStatus {
  dimension: RuntimeBudgetDimension;
  limit: number;
  used: number;
  remaining: number;
  exhausted: boolean;
  exhaustion_policy: RuntimeBudgetLimit["exhaustion_policy"];
  threshold_actions: RuntimeBudgetThresholdAction[];
}

export interface RuntimeBudgetStatus {
  budget_id: string;
  scope: RuntimeBudgetScope;
  mode: RuntimeBudgetMode;
  dimensions: RuntimeBudgetDimensionStatus[];
  approval_required: boolean;
  handoff_required: boolean;
  finalization_required: boolean;
  exhausted: boolean;
  recent_consumption: RuntimeBudgetUsage["recent"];
}

export class RuntimeBudgetStore {
  private readonly paths: RuntimeStorePaths;
  private readonly journal: RuntimeJournal;
  private readonly now: () => Date;

  constructor(runtimeRootOrPaths?: string | RuntimeStorePaths, options: { now?: () => Date } = {}) {
    this.paths =
      typeof runtimeRootOrPaths === "string"
        ? createRuntimeStorePaths(runtimeRootOrPaths)
        : runtimeRootOrPaths ?? createRuntimeStorePaths();
    this.journal = new RuntimeJournal(this.paths);
    this.now = options.now ?? (() => new Date());
  }

  async load(budgetId: string): Promise<RuntimeBudgetRecord | null> {
    return this.journal.load(this.paths.budgetPath(budgetId), RuntimeBudgetRecordRuntimeSchema);
  }

  async list(): Promise<RuntimeBudgetRecord[]> {
    return this.journal.list(this.paths.budgetsDir, RuntimeBudgetRecordRuntimeSchema);
  }

  async create(input: RuntimeBudgetCreateInput): Promise<RuntimeBudgetRecord> {
    const existing = await this.load(input.budget_id);
    if (existing) throw new Error(`Runtime budget already exists: ${input.budget_id}`);
    const createdAt = input.created_at ?? this.nowIso();
    const usage = input.limits.map((limit) => ({
      dimension: limit.dimension,
      used: 0,
      updated_at: createdAt,
      recent: [],
    }));
    return this.save({
      schema_version: "runtime-budget-v1",
      budget_id: input.budget_id,
      scope: input.scope,
      ...(input.title ? { title: input.title } : {}),
      created_at: createdAt,
      updated_at: createdAt,
      limits: input.limits.map((limit) => RuntimeBudgetLimitSchema.parse(limit)),
      usage,
      ...(input.notes ? { notes: input.notes } : {}),
    });
  }

  async updateUsage(budgetId: string, input: RuntimeBudgetUsageUpdateInput): Promise<RuntimeBudgetRecord> {
    const amount = parseBudgetUsageAmount(input.amount);
    return this.update(budgetId, (budget) => {
      const observedAt = input.observed_at ?? this.nowIso();
      const hasLimit = budget.limits.some((limit) => limit.dimension === input.dimension);
      if (!hasLimit) throw new Error(`Budget ${budgetId} has no limit for ${input.dimension}`);
      const usageByDimension = new Map(budget.usage.map((usage) => [usage.dimension, usage]));
      const existing = usageByDimension.get(input.dimension) ?? {
        dimension: input.dimension,
        used: 0,
        updated_at: observedAt,
        recent: [],
      };
      const nextUsage: RuntimeBudgetUsage = {
        ...existing,
        used: addBudgetUsage(existing.used, amount),
        updated_at: observedAt,
        recent: [
          {
            amount,
            source: input.source,
            ...(input.reason ? { reason: input.reason } : {}),
            observed_at: observedAt,
          },
          ...existing.recent,
        ].slice(0, 20),
      };
      usageByDimension.set(input.dimension, nextUsage);
      return {
        ...budget,
        updated_at: observedAt,
        usage: budget.limits.map((limit) => usageByDimension.get(limit.dimension) ?? {
          dimension: limit.dimension,
          used: 0,
          updated_at: observedAt,
          recent: [],
        }),
      };
    });
  }

  async recordTaskExecution(budgetId: string, input: { iterations?: number; tasks?: number; process_ms?: number; wall_clock_ms?: number; observed_at?: string; reason?: string }): Promise<RuntimeBudgetRecord> {
    let budget = await this.mustLoad(budgetId);
    const updates = this.planUsageUpdates(budget, [
      ["iterations", input.iterations],
      ["tasks", input.tasks],
      ["process_ms", input.process_ms],
      ["wall_clock_ms", input.wall_clock_ms],
    ]);
    for (const { dimension, amount } of updates) {
      budget = await this.updateUsage(budgetId, { dimension, amount, source: "task_execution", observed_at: input.observed_at, reason: input.reason });
    }
    return budget;
  }

  async recordArtifactGeneration(budgetId: string, input: { disk_bytes?: number; artifacts?: number; observed_at?: string; reason?: string }): Promise<RuntimeBudgetRecord> {
    let budget = await this.mustLoad(budgetId);
    const updates = this.planUsageUpdates(budget, [
      ["disk_bytes", input.disk_bytes],
      ["artifacts", input.artifacts],
    ]);
    for (const { dimension, amount } of updates) {
      budget = await this.updateUsage(budgetId, { dimension, amount, source: "artifact_generation", observed_at: input.observed_at, reason: input.reason });
    }
    return budget;
  }

  async recordToolUsage(budgetId: string, input: { llm_tokens?: number; tool_calls?: number; observed_at?: string; reason?: string }): Promise<RuntimeBudgetRecord> {
    let budget = await this.mustLoad(budgetId);
    const updates = this.planUsageUpdates(budget, [
      ["llm_tokens", input.llm_tokens],
      ["tool_calls", input.tool_calls],
    ]);
    for (const { dimension, amount } of updates) {
      budget = await this.updateUsage(budgetId, { dimension, amount, source: "tool_usage", observed_at: input.observed_at, reason: input.reason });
    }
    return budget;
  }

  async recordEvaluatorCall(budgetId: string, input: { attempts?: number; observed_at?: string; reason?: string }): Promise<RuntimeBudgetRecord> {
    const attempts = input.attempts ?? 1;
    return this.updateUsage(budgetId, {
      dimension: "evaluator_attempts",
      amount: attempts,
      source: "evaluator_call",
      observed_at: input.observed_at,
      reason: input.reason,
    });
  }

  status(budget: RuntimeBudgetRecord): RuntimeBudgetStatus {
    const usageByDimension = new Map(budget.usage.map((usage) => [usage.dimension, usage]));
    const dimensions = budget.limits.map((limit) => {
      const used = usageByDimension.get(limit.dimension)?.used ?? 0;
      const remaining = Math.max(0, limit.limit - used);
      const thresholdActions = thresholdActionsFor(limit, remaining, used);
      return {
        dimension: limit.dimension,
        limit: limit.limit,
        used,
        remaining,
        exhausted: used >= limit.limit,
        exhaustion_policy: limit.exhaustion_policy,
        threshold_actions: thresholdActions,
      };
    });
    const recent = budget.usage.flatMap((usage) => usage.recent).sort((a, b) => b.observed_at.localeCompare(a.observed_at)).slice(0, 10);
    const mode = budgetMode(budget.limits, dimensions);
    return {
      budget_id: budget.budget_id,
      scope: budget.scope,
      mode,
      dimensions,
      approval_required: dimensions.some((dimension) => dimension.threshold_actions.includes("approval_required")),
      handoff_required: dimensions.some((dimension) => dimension.threshold_actions.includes("handoff_required")),
      finalization_required: dimensions.some((dimension) => dimension.threshold_actions.includes("finalization_required")),
      exhausted: dimensions.some((dimension) => dimension.exhausted),
      recent_consumption: recent,
    };
  }

  taskGenerationContext(budget: RuntimeBudgetRecord): Record<string, unknown> {
    const status = this.status(budget);
    return {
      budget_id: status.budget_id,
      scope: status.scope,
      mode: status.mode,
      exhausted: status.exhausted,
      approval_required: status.approval_required,
      handoff_required: status.handoff_required,
      finalization_required: status.finalization_required,
      remaining: Object.fromEntries(status.dimensions.map((dimension) => [dimension.dimension, dimension.remaining])),
      recent_consumption: status.recent_consumption,
    };
  }

  private async mustLoad(budgetId: string): Promise<RuntimeBudgetRecord> {
    const budget = await this.load(budgetId);
    if (!budget) throw new Error(`Runtime budget not found: ${budgetId}`);
    return budget;
  }

  private hasLimit(budget: RuntimeBudgetRecord, dimension: RuntimeBudgetDimension): boolean {
    return budget.limits.some((limit) => limit.dimension === dimension);
  }

  private planUsageUpdates(
    budget: RuntimeBudgetRecord,
    inputs: ReadonlyArray<readonly [RuntimeBudgetDimension, number | undefined]>,
  ): Array<{ dimension: RuntimeBudgetDimension; amount: number }> {
    const plannedUsedByDimension = new Map(budget.usage.map((usage) => [usage.dimension, usage.used]));
    const updates: Array<{ dimension: RuntimeBudgetDimension; amount: number }> = [];
    for (const [dimension, rawAmount] of inputs) {
      const amount = parseOptionalBudgetUsageAmount(rawAmount);
      if (amount === null) continue;
      if (!this.hasLimit(budget, dimension)) continue;
      const current = plannedUsedByDimension.get(dimension) ?? 0;
      plannedUsedByDimension.set(dimension, addBudgetUsage(current, amount));
      updates.push({ dimension, amount });
    }
    return updates;
  }

  private async update(
    budgetId: string,
    updater: (budget: RuntimeBudgetRecord) => RuntimeBudgetRecord,
  ): Promise<RuntimeBudgetRecord> {
    const budget = await this.mustLoad(budgetId);
    return this.save(updater(budget));
  }

  private async save(budget: RuntimeBudgetRecord): Promise<RuntimeBudgetRecord> {
    return this.journal.save(this.paths.budgetPath(budget.budget_id), RuntimeBudgetRecordRuntimeSchema, budget);
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

function parseBudgetUsageAmount(amount: number): number {
  const parsed = RuntimeBudgetNonNegativeSafeNumberSchema.safeParse(amount);
  if (!parsed.success) {
    throw new Error("Budget usage amount must be a finite safe non-negative number");
  }
  return parsed.data;
}

function parseOptionalBudgetUsageAmount(amount: number | undefined): number | null {
  if (amount === undefined) return null;
  const parsed = parseBudgetUsageAmount(amount);
  return parsed > 0 ? parsed : null;
}

function addBudgetUsage(current: number, amount: number): number {
  const safeCurrent = parseBudgetUsageAmount(current);
  const safeAmount = parseBudgetUsageAmount(amount);
  const remainingSafeRange = Number.MAX_SAFE_INTEGER - safeCurrent;
  if (safeAmount > 0 && safeAmount > remainingSafeRange) {
    throw new Error("Budget usage total must be a finite safe non-negative number");
  }
  const next = safeCurrent + safeAmount;
  if (safeAmount > 0 && next <= safeCurrent) {
    throw new Error("Budget usage total must be a finite safe non-negative number");
  }
  const parsed = RuntimeBudgetNonNegativeSafeNumberSchema.safeParse(next);
  if (!parsed.success) {
    throw new Error("Budget usage total must be a finite safe non-negative number");
  }
  return parsed.data;
}

function thresholdActionsFor(limit: RuntimeBudgetLimit, remaining: number, used: number): RuntimeBudgetThresholdAction[] {
  const actions = new Set<RuntimeBudgetThresholdAction>();
  if (limit.approval_at_remaining !== undefined && remaining <= limit.approval_at_remaining) actions.add("approval_required");
  if (limit.handoff_at_remaining !== undefined && remaining <= limit.handoff_at_remaining) actions.add("handoff_required");
  if (limit.finalization_at_remaining !== undefined && remaining <= limit.finalization_at_remaining) actions.add("finalization_required");
  if (used >= limit.limit) {
    if (limit.exhaustion_policy === "handoff_required") actions.add("handoff_required");
    if (limit.exhaustion_policy === "finalize") actions.add("finalization_required");
    if (limit.exhaustion_policy === "approval_required") actions.add("approval_required");
  }
  return [...actions];
}

function budgetMode(limits: RuntimeBudgetLimit[], dimensions: RuntimeBudgetDimensionStatus[]): RuntimeBudgetMode {
  if (dimensions.some((dimension) => dimension.exhausted)) return "exhausted";
  let mode: RuntimeBudgetMode = "exploration";
  for (const status of dimensions) {
    const limit = limits.find((candidate) => candidate.dimension === status.dimension);
    const transitions = limit?.mode_transition_at_remaining;
    if (transitions?.finalization !== undefined && status.remaining <= transitions.finalization) return "finalization";
    if (transitions?.consolidation !== undefined && status.remaining <= transitions.consolidation) mode = "consolidation";
  }
  return mode;
}
