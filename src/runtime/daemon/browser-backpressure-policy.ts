import type { GoalCycleScheduleSnapshotEntry } from "./maintenance.js";
import type { BackpressureSnapshot } from "../store/index.js";
import { GuardrailStore } from "../guardrails/index.js";
import {
  DEFAULT_BACKPRESSURE_LEASE_TTL_MS,
  DEFAULT_BACKPRESSURE_MAX_CONCURRENT_PER_PROVIDER,
  DEFAULT_BACKPRESSURE_MAX_CONCURRENT_PER_SERVICE,
  parseBackpressurePositiveSafeInt,
} from "../guardrails/backpressure-limits.js";

export interface BrowserBackpressurePolicyResult {
  activeGoalIds: string[];
  blocked: Array<{
    goal_id: string;
    provider_id: string;
    service_key: string;
    reason: string;
    since: string;
  }>;
}

export async function applyBrowserBackpressurePolicy(input: {
  runtimeRoot: string | null;
  goalIds: string[];
  snapshot: GoalCycleScheduleSnapshotEntry[];
  providerId?: string;
  maxConcurrentPerProvider?: number;
  maxConcurrentPerService?: number;
  leaseTtlMs?: number;
  now?: () => Date;
}): Promise<BrowserBackpressurePolicyResult> {
  if (!input.runtimeRoot || input.goalIds.length === 0) {
    return { activeGoalIds: input.goalIds, blocked: [] };
  }
  const store = new GuardrailStore(input.runtimeRoot);
  const backpressure = await store.loadBackpressureSnapshot();
  const now = input.now ?? (() => new Date());
  const leaseTtlMs = parseBackpressurePositiveSafeInt(
    input.leaseTtlMs ?? DEFAULT_BACKPRESSURE_LEASE_TTL_MS,
    "leaseTtlMs"
  );
  const maxConcurrentPerProvider = parseBackpressurePositiveSafeInt(
    input.maxConcurrentPerProvider ?? DEFAULT_BACKPRESSURE_MAX_CONCURRENT_PER_PROVIDER,
    "maxConcurrentPerProvider"
  );
  const maxConcurrentPerService = parseBackpressurePositiveSafeInt(
    input.maxConcurrentPerService ?? DEFAULT_BACKPRESSURE_MAX_CONCURRENT_PER_SERVICE,
    "maxConcurrentPerService"
  );
  const activeLeases = pruneExpiredLeases(backpressure?.active ?? [], leaseTtlMs, now);
  if (activeLeases.length === 0) return { activeGoalIds: input.goalIds, blocked: [] };

  const blocked: BrowserBackpressurePolicyResult["blocked"] = [];
  const activeGoalIds = input.goalIds.filter((goalId) => {
    const scope = browserScopeForGoal(goalId, input.snapshot, input.providerId);
    if (!scope) return true;
    const providerActive = activeLeases.filter((lease) => lease.provider_id === scope.providerId);
    const serviceActive = providerActive.filter((lease) => lease.service_key === scope.serviceKey);
    const providerPressure = providerActive.length >= maxConcurrentPerProvider;
    const servicePressure = serviceActive.length >= maxConcurrentPerService;
    if (!providerPressure && !servicePressure) return true;
    const reason = servicePressure
      ? `browser service backpressure active (${serviceActive.length}/${maxConcurrentPerService})`
      : `browser provider backpressure active (${providerActive.length}/${maxConcurrentPerProvider})`;
    blocked.push({
      goal_id: goalId,
      provider_id: scope.providerId,
      service_key: scope.serviceKey,
      reason,
      since: backpressure?.updated_at ?? new Date().toISOString(),
    });
    return false;
  });

  if (blocked.length > 0) {
    await store.updateBackpressureSnapshot((current) => {
      const currentActive = pruneExpiredLeases(current.active, leaseTtlMs, now);
      return {
        snapshot: {
          updated_at: now().toISOString(),
          active: currentActive,
          throttled: [
            ...(current.throttled ?? []),
            ...blocked.map((entry) => ({
              provider_id: entry.provider_id,
              service_key: entry.service_key,
              reason: `${entry.reason}: ${entry.goal_id}`,
              at: entry.since,
            })),
          ].slice(-20),
        },
        result: undefined,
      };
    });
  }

  return { activeGoalIds, blocked };
}

function browserScopeForGoal(
  goalId: string,
  snapshot: GoalCycleScheduleSnapshotEntry[],
  fallbackProviderId?: string,
): { providerId: string; serviceKey: string } | null {
  const entry = snapshot.find((candidate) => candidate.goalId === goalId);
  const metadata = entry?.schedule && typeof entry.schedule === "object"
    ? entry.schedule as Record<string, unknown>
    : {};
  const provider = metadata["browser_provider_id"];
  const providerId = typeof provider === "string" && provider.length > 0
    ? provider
    : fallbackProviderId;
  if (!providerId) return null;
  const direct = metadata["browser_service_key"];
  if (typeof direct === "string" && direct.length > 0) return { providerId, serviceKey: direct };
  const startUrl = metadata["browser_start_url"];
  if (typeof startUrl === "string") {
    try {
      return { providerId, serviceKey: new URL(startUrl).hostname.toLowerCase() };
    } catch {
      return null;
    }
  }
  return null;
}

function pruneExpiredLeases(
  active: BackpressureSnapshot["active"],
  leaseTtlMs: number,
  now: () => Date,
): BackpressureSnapshot["active"] {
  const nowMs = now().getTime();
  return active.filter((entry) => {
    const acquiredAt = Date.parse(entry.acquired_at);
    return Number.isFinite(acquiredAt) && nowMs - acquiredAt <= leaseTtlMs;
  });
}
