import { randomUUID } from "node:crypto";
import {
  normalizeWaitMetadata,
  parseStrategy,
  resolveWaitNextObserveAt,
  type WaitStrategy,
} from "../../base/types/strategy.js";
import { isWaitStrategy } from "../../orchestrator/strategy/portfolio-allocation.js";
import { StrategyDreamStateStore } from "../store/strategy-dream-state-store.js";
import { ScheduleEntryStore } from "./entry-store.js";
import { ScheduleEntryListSchema, ScheduleEntrySchema, type ScheduleEntry } from "../types/schedule.js";

const WAIT_RESUME_TRIGGER_SECONDS = 365 * 24 * 60 * 60;

const noopLogger = {
  warn: (_message: string, _context?: Record<string, unknown>) => {},
};

function isWaitResumeEntry(entry: ScheduleEntry): boolean {
  return entry.metadata?.internal === true && entry.metadata.activation_kind === "wait_resume";
}

function waitResumeEntryName(goalId: string, strategyId: string): string {
  return `Wait resume ${goalId}/${strategyId}`;
}

function buildWaitResumeEntry(args: {
  entryId?: string;
  goalId: string;
  strategy: WaitStrategy;
  nextObserveAt: string;
  previous?: ScheduleEntry | null;
}): ScheduleEntry {
  const now = new Date().toISOString();
  const previous = args.previous ?? null;
  return ScheduleEntrySchema.parse({
    id: previous?.id ?? args.entryId ?? randomUUID(),
    name: previous?.name ?? waitResumeEntryName(args.goalId, args.strategy.id),
    layer: "goal_trigger",
    trigger: { type: "interval", seconds: WAIT_RESUME_TRIGGER_SECONDS, jitter_factor: 0 },
    enabled: true,
    metadata: {
      ...(previous?.metadata ?? {}),
      source: previous?.metadata?.source ?? "manual",
      internal: true,
      activation_kind: "wait_resume",
      goal_id: args.goalId,
      strategy_id: args.strategy.id,
      wait_strategy_id: args.strategy.id,
      note: args.strategy.wait_reason,
    },
    goal_trigger: {
      goal_id: args.goalId,
      max_iterations: previous?.goal_trigger?.max_iterations ?? 10,
      skip_if_active: false,
    },
    created_at: previous?.created_at ?? now,
    updated_at: now,
    last_fired_at: previous?.last_fired_at ?? null,
    next_fire_at: args.nextObserveAt,
    consecutive_failures: previous?.consecutive_failures ?? 0,
    last_escalation_at: previous?.last_escalation_at ?? null,
    escalation_timestamps: previous?.escalation_timestamps ?? [],
    total_executions: previous?.total_executions ?? 0,
    total_tokens_used: previous?.total_tokens_used ?? 0,
    max_tokens_per_day: previous?.max_tokens_per_day ?? 100000,
    tokens_used_today: previous?.tokens_used_today ?? 0,
    budget_reset_at: previous?.budget_reset_at ?? null,
    baseline_results: previous?.baseline_results ?? [],
  });
}

async function loadWaitProjectionInputs(baseDir: string, goalId: string, strategyId: string): Promise<{
  strategy: WaitStrategy | null;
  nextObserveAt: string | null;
}> {
  const stateStore = new StrategyDreamStateStore(baseDir);
  const portfolio = await stateStore.loadPortfolio(goalId);
  if (!portfolio) {
    return { strategy: null, nextObserveAt: null };
  }

  const strategy = portfolio.strategies
    .map((candidate) => parseStrategy(candidate))
    .find((candidate) => candidate.id === strategyId);
  if (!strategy || !isWaitStrategy(strategy as Record<string, unknown>) || strategy.state !== "active") {
    return { strategy: null, nextObserveAt: null };
  }

  const waitStrategy = strategy as WaitStrategy;
  const rawMetadata = await stateStore.loadWaitMetadata(goalId, strategyId);
  const metadata = normalizeWaitMetadata(waitStrategy, rawMetadata);
  return {
    strategy: waitStrategy,
    nextObserveAt: resolveWaitNextObserveAt(waitStrategy, metadata),
  };
}

export async function syncWaitStrategyScheduleProjection(params: {
  baseDir: string;
  goalId: string;
  strategyId: string;
}): Promise<void> {
  const { baseDir, goalId, strategyId } = params;
  const entryStore = new ScheduleEntryStore(baseDir, noopLogger);

  await entryStore.withLock(async () => {
    const entries = ScheduleEntryListSchema.parse(await entryStore.readEntries());
    const existing = entries.find((entry) => isWaitResumeEntry(entry) && entry.metadata?.wait_strategy_id === strategyId) ?? null;
    const { strategy, nextObserveAt } = await loadWaitProjectionInputs(baseDir, goalId, strategyId);

    let nextEntries = entries.filter((entry) => entry.id !== existing?.id);
    if (strategy && nextObserveAt) {
      nextEntries = [
        ...nextEntries,
        buildWaitResumeEntry({
          entryId: existing?.id,
          goalId,
          strategy,
          nextObserveAt,
          previous: existing,
        }),
      ];
    }

    await entryStore.saveEntries(nextEntries);
  });
}
