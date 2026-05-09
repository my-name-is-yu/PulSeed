import {
  MAX_SCHEDULE_RETRY_ATTEMPTS,
  MAX_SCHEDULE_RETRY_DELAY_MS,
  MAX_SCHEDULE_RETRY_MULTIPLIER,
  MAX_SCHEDULE_RETRY_WINDOW_MS,
  ScheduleEntrySchema,
  type ScheduleEntry,
} from "../types/schedule.js";

export interface ParsedPersistedScheduleEntries {
  entries: ScheduleEntry[];
  invalidCount: number;
  validList: boolean;
}

export function parsePersistedScheduleEntries(rawEntries: unknown): ParsedPersistedScheduleEntries {
  if (!Array.isArray(rawEntries)) {
    return { entries: [], invalidCount: 0, validList: false };
  }

  const entries: ScheduleEntry[] = [];
  let invalidCount = 0;
  for (const candidate of normalizeLegacyScheduleRetryBounds(rawEntries)) {
    const result = ScheduleEntrySchema.safeParse(candidate);
    if (result.success) {
      entries.push(result.data);
    } else {
      invalidCount++;
    }
  }

  return { entries, invalidCount, validList: true };
}

export function normalizeLegacyScheduleRetryBounds(rawEntries: readonly unknown[]): unknown[] {
  return rawEntries.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return entry;
    }

    const input = entry as Record<string, unknown>;
    let output: Record<string, unknown> | null = null;
    const retryPolicy = normalizeRetryPolicyBounds(input.retry_policy);
    if (retryPolicy !== input.retry_policy) {
      output = { ...input, retry_policy: retryPolicy };
    }

    const retryState = normalizeRetryStateBounds(input.retry_state);
    if (retryState !== input.retry_state) {
      output = { ...(output ?? input), retry_state: retryState };
    }

    return output ?? entry;
  });
}

function normalizeRetryPolicyBounds(rawPolicy: unknown): unknown {
  if (rawPolicy === null || typeof rawPolicy !== "object" || Array.isArray(rawPolicy)) {
    return rawPolicy;
  }

  let policy = rawPolicy as Record<string, unknown>;
  policy = clampFiniteLegacyNumber(policy, "initial_delay_ms", 0, MAX_SCHEDULE_RETRY_DELAY_MS, true);
  policy = clampFiniteLegacyNumber(policy, "max_delay_ms", 1, MAX_SCHEDULE_RETRY_DELAY_MS, true);
  policy = clampFiniteLegacyNumber(policy, "multiplier", 1, MAX_SCHEDULE_RETRY_MULTIPLIER, false);
  policy = clampFiniteLegacyNumber(policy, "max_attempts", 1, MAX_SCHEDULE_RETRY_ATTEMPTS, true);
  policy = clampFiniteLegacyNumber(policy, "max_retry_window_ms", 1, MAX_SCHEDULE_RETRY_WINDOW_MS, true);
  return policy;
}

function normalizeRetryStateBounds(rawState: unknown): unknown {
  if (rawState === null || typeof rawState !== "object" || Array.isArray(rawState)) {
    return rawState;
  }
  return clampFiniteLegacyNumber(
    rawState as Record<string, unknown>,
    "attempts",
    0,
    MAX_SCHEDULE_RETRY_ATTEMPTS,
    true
  );
}

function clampFiniteLegacyNumber(
  record: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  integer: boolean
): Record<string, unknown> {
  const value = record[key];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    (integer && !Number.isInteger(value)) ||
    value <= max
  ) {
    return record;
  }
  return { ...record, [key]: max };
}
