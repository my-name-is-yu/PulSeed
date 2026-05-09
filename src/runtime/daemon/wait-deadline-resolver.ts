import {
  normalizeWaitMetadata,
  type WaitMetadata,
  type WaitStrategy,
  parseStrategy,
} from "../../base/types/strategy.js";
import { isWaitStrategy } from "../../orchestrator/strategy/portfolio-allocation.js";
import { parsePersistedScheduleEntries } from "../schedule/entry-normalization.js";
import type { ScheduleEntry } from "../types/schedule.js";

export interface WaitDeadlineResolution {
  next_observe_at: string | null;
  waiting_goals: Array<{
    goal_id: string;
    strategy_id: string;
    next_observe_at: string;
    wait_until: string;
    wait_reason: string;
    approval_pending?: boolean;
    activation_kind?: "wait_resume";
    internal_schedule?: boolean;
  }>;
}

export interface WaitDeadlineResolverState {
  readRaw(path: string): Promise<unknown | null>;
}

export class WaitDeadlineResolver {
  constructor(private readonly stateManager: WaitDeadlineResolverState) {}

  async resolve(goalIds: string[]): Promise<WaitDeadlineResolution> {
    const waitingGoals = await this.resolveFromInternalSchedules(goalIds);
    waitingGoals.sort((a, b) => Date.parse(a.next_observe_at) - Date.parse(b.next_observe_at));

    return {
      next_observe_at: waitingGoals[0]?.next_observe_at ?? null,
      waiting_goals: waitingGoals,
    };
  }

  clampInterval(intervalMs: number, resolution: WaitDeadlineResolution, nowMs = Date.now()): number {
    return clampIntervalToNextWaitDeadline(intervalMs, resolution.next_observe_at, nowMs);
  }

  private async resolveFromInternalSchedules(goalIds: string[]): Promise<WaitDeadlineResolution["waiting_goals"]> {
    const rawSchedules = await this.stateManager.readRaw("schedules.json");
    const parsedSchedules = parsePersistedScheduleEntries(rawSchedules);
    if (!parsedSchedules.validList) {
      return [];
    }

    const waitingGoals = await Promise.all(parsedSchedules.entries
      .filter((entry) =>
        entry.enabled
        && entry.metadata?.internal === true
        && entry.metadata.activation_kind === "wait_resume"
        && typeof entry.metadata.goal_id === "string"
        && typeof entry.metadata.wait_strategy_id === "string"
        && goalIds.includes(entry.metadata.goal_id)
      )
      .map(async (entry) => this.resolveWaitGoalFromEntry(entry)));

    return waitingGoals.filter((goal): goal is NonNullable<typeof goal> => goal !== null);
  }

  private async resolveWaitGoalFromEntry(
    entry: ScheduleEntry
  ): Promise<WaitDeadlineResolution["waiting_goals"][number] | null> {
    const goalId = entry.metadata?.goal_id;
    const strategyId = entry.metadata?.wait_strategy_id;
    if (!goalId || !strategyId) return null;

    const waitStrategy = await this.loadWaitStrategy(goalId, strategyId);
    const metadata = waitStrategy
      ? normalizeWaitMetadataFailSoft(
          waitStrategy,
          await this.stateManager.readRaw(`strategies/${goalId}/wait-meta/${strategyId}.json`)
        )
      : null;

    return {
      goal_id: goalId,
      strategy_id: strategyId,
      next_observe_at: entry.next_fire_at,
      wait_until: waitStrategy?.wait_until ?? entry.next_fire_at,
      wait_reason: waitStrategy?.wait_reason ?? entry.metadata?.note ?? "waiting",
      approval_pending: metadata ? isApprovalPending(metadata) : false,
      activation_kind: entry.metadata?.activation_kind,
      internal_schedule: entry.metadata?.internal === true,
    };
  }

  private async loadWaitStrategy(goalId: string, strategyId: string): Promise<WaitStrategy | null> {
    const rawPortfolio = await this.stateManager.readRaw(`strategies/${goalId}/portfolio.json`);
    if (!rawPortfolio || typeof rawPortfolio !== "object") return null;
    const strategies = (rawPortfolio as Record<string, unknown>)["strategies"];
    if (!Array.isArray(strategies)) return null;
    const match = strategies
      .map((candidate) => parseStrategy(candidate))
      .find((candidate) => candidate.id === strategyId);
    if (!match || !isWaitStrategy(match as Record<string, unknown>) || match.state !== "active") {
      return null;
    }
    return match as WaitStrategy;
  }
}

function isApprovalPending(metadata: WaitMetadata): boolean {
  const extra = metadata as WaitMetadata & {
    approval_pending?: unknown;
  };
  if (extra.approval_pending) return true;
  if (metadata.resume_plan.action === "request_approval") return true;
  const evidence = metadata.latest_observation?.evidence;
  return Boolean(evidence && typeof evidence === "object" && evidence["approval_pending"]);
}

function normalizeWaitMetadataFailSoft(
  waitStrategy: WaitStrategy,
  data: unknown
): WaitMetadata {
  try {
    return normalizeWaitMetadata(waitStrategy, data);
  } catch {
    return normalizeWaitMetadata(waitStrategy, null);
  }
}

export function getDueWaitGoalIds(
  resolution: WaitDeadlineResolution,
  nowMs = Date.now()
): string[] {
  const dueGoalIds = new Set<string>();
  for (const goal of resolution.waiting_goals) {
    const observeAtMs = Date.parse(goal.next_observe_at);
    if (!Number.isFinite(observeAtMs)) continue;
    if (observeAtMs <= nowMs) {
      dueGoalIds.add(goal.goal_id);
    }
  }
  return [...dueGoalIds];
}

export function clampIntervalToNextWaitDeadline(
  intervalMs: number,
  nextObserveAt: string | null | undefined,
  nowMs = Date.now()
): number {
  if (!nextObserveAt) return intervalMs;
  const nextObserveMs = Date.parse(nextObserveAt);
  if (!Number.isFinite(nextObserveMs)) return intervalMs;
  const waitMs = Math.max(0, nextObserveMs - nowMs);
  return Math.min(intervalMs, waitMs);
}
