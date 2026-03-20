import type {
  ShortTermEntry,
  MemoryIndexEntry,
  MemoryTier,
  TierBudget,
} from "../types/memory-lifecycle.js";

// ─── Constants ───

/** How many hours ago counts as "recent" for MemoryIndexEntry (no loop_number). */
const RECENT_HOURS = 5;

/** How many loops ago counts as "recent" for ShortTermEntry core classification. */
const RECENT_LOOPS = 5;

/** Core-eligible data types for ShortTermEntry. */
const CORE_DATA_TYPES: ReadonlySet<string> = new Set(["observation", "strategy"]);

// ─── Type guard ───

function isShortTermEntry(
  entry: ShortTermEntry | MemoryIndexEntry
): entry is ShortTermEntry {
  return "loop_number" in entry && "data_type" in entry;
}

// ─── classifyTier ───

/**
 * Classify a memory entry into a tier based on its goal membership and recency.
 *
 * - core:     active goal + core data type + recent (last 5 loops / 5 hours)
 * - recall:   active goal (other data types, or older)
 * - archival: completed goal OR not in any tracked goal
 */
export function classifyTier(
  entry: ShortTermEntry | MemoryIndexEntry,
  activeGoalIds: string[],
  completedGoalIds: string[]
): MemoryTier {
  const activeSet = new Set(activeGoalIds);
  const completedSet = new Set(completedGoalIds);

  // Archival: goal is completed or unknown
  if (!activeSet.has(entry.goal_id)) {
    // Could be completed or simply unknown — both are archival
    return "archival";
  }

  // entry.goal_id is in activeGoalIds → at least recall
  if (isShortTermEntry(entry)) {
    return classifyShortTermTier(entry, completedSet);
  } else {
    return classifyIndexEntryTier(entry);
  }
}

function classifyShortTermTier(
  entry: ShortTermEntry,
  _completedSet: Set<string>
): MemoryTier {
  // Core requires: core data type + recent loop
  const isCoreType = CORE_DATA_TYPES.has(entry.data_type);
  if (!isCoreType) return "recall";

  // Check recency: loop_number (0-indexed, higher = more recent)
  // We don't know the current loop number, so we use a heuristic:
  // tags may include "recent"; otherwise we treat any loop_number > 0 check
  // by seeing if the entry has the "recent" tag, or we fall back to timestamp.
  // The spec says "from last 5 loops (compare loop_number if ShortTermEntry)".
  // Without knowing max loop, use timestamp as proxy: if within 5 * avg_loop_time.
  // Simpler: if tags include "recent" OR timestamp is within RECENT_HOURS hours.
  if (entry.tags.includes("recent")) return "core";

  const ageMs = Date.now() - new Date(entry.timestamp).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  if (ageHours <= RECENT_HOURS) return "core";

  return "recall";
}

function classifyIndexEntryTier(entry: MemoryIndexEntry): MemoryTier {
  // MemoryIndexEntry: no loop_number. Use last_accessed recency.
  // Core: has "recent" tag OR last_accessed within RECENT_HOURS
  if (entry.tags.includes("recent")) return "core";

  const ageMs = Date.now() - new Date(entry.last_accessed).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  if (ageHours <= RECENT_HOURS) return "core";

  return "recall";
}

// ─── sortByTier ───

const TIER_ORDER: Record<MemoryTier, number> = {
  core: 0,
  recall: 1,
  archival: 2,
};

/**
 * Sort entries: core first, then recall, then archival.
 * Within the same tier, preserve original order (stable).
 */
export function sortByTier(entries: MemoryIndexEntry[]): MemoryIndexEntry[] {
  // Stable sort: annotate with original index to preserve order within tier
  return entries
    .map((e, idx) => ({ e, idx }))
    .sort((a, b) => {
      const tierDiff = TIER_ORDER[a.e.memory_tier] - TIER_ORDER[b.e.memory_tier];
      if (tierDiff !== 0) return tierDiff;
      return a.idx - b.idx;
    })
    .map(({ e }) => e);
}

// ─── filterByTierBudget ───

/**
 * Apply per-tier count limits from a TierBudget.
 *
 * TierBudget values are fractions [0, 1] of the total entry count.
 * Converts fractions to absolute counts based on entries.length.
 * At minimum, each tier gets Math.ceil(fraction * total) slots.
 *
 * Core entries are guaranteed first (up to their count limit),
 * then recall, then archival.
 * Entries are expected to already be sorted (sortByTier).
 */
export function filterByTierBudget(
  entries: MemoryIndexEntry[],
  budget: TierBudget
): MemoryIndexEntry[] {
  const total = entries.length;
  if (total === 0) return [];

  // Convert fractions to counts
  const coreMax = Math.round(budget.core * total);
  const recallMax = Math.round(budget.recall * total);
  const archivalMax = Math.round(budget.archival * total);

  const result: MemoryIndexEntry[] = [];
  let coreCount = 0;
  let recallCount = 0;
  let archivalCount = 0;

  for (const entry of entries) {
    if (entry.memory_tier === "core" && coreCount < coreMax) {
      result.push(entry);
      coreCount++;
    } else if (entry.memory_tier === "recall" && recallCount < recallMax) {
      result.push(entry);
      recallCount++;
    } else if (entry.memory_tier === "archival" && archivalCount < archivalMax) {
      result.push(entry);
      archivalCount++;
    }
  }

  return result;
}
