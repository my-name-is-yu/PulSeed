import type { TierBudget } from "../../../base/types/memory-lifecycle.js";

const MAX_SAFE_BUDGET_COUNT = Number.MAX_SAFE_INTEGER;

function normalizeBudgetCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function addBudgetCounts(left: number, right: number): number {
  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : MAX_SAFE_BUDGET_COUNT;
}

// ─── Tier Budget Allocation ───

/**
 * Distributes a total token budget across memory tiers.
 * - core: 50% (always included items)
 * - recall: 35% (recent observations, strategy history)
 * - archival: remaining (completed-goal knowledge)
 */
export function allocateTierBudget(totalTokens: number): TierBudget {
  const normalizedTotal = normalizeBudgetCount(totalTokens);
  const core = Math.floor(normalizedTotal * 0.50);
  const recall = Math.floor(normalizedTotal * 0.35);
  const archival = normalizedTotal - core - recall;
  return { core, recall, archival };
}

// ─── Budget Allocation ───

export interface BudgetAllocation {
  goalDefinition: number;
  observations: number;
  knowledge: number;
  transferKnowledge: number;
  meta: number;
}

export function allocateBudget(totalBudget: number): BudgetAllocation {
  const normalizedBudget = normalizeBudgetCount(totalBudget);
  return {
    goalDefinition: Math.floor(normalizedBudget * 0.20),
    observations: Math.floor(normalizedBudget * 0.30),
    knowledge: Math.floor(normalizedBudget * 0.30),
    transferKnowledge: Math.floor(normalizedBudget * 0.15),
    meta: Math.floor(normalizedBudget * 0.05),
  };
}

// ─── Token Estimation ───

/** Estimate token count. Heuristic: 1 token ≈ 4 characters. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Progressive Disclosure Selection ───

/**
 * Select candidates greedily by similarity (descending) until the budget is exhausted.
 * Assumes `candidates` is already sorted by similarity descending.
 */
export function selectWithinBudget<T extends { text: string; similarity: number }>(
  candidates: T[],
  budgetTokens: number
): T[] {
  const selected: T[] = [];
  const normalizedBudget = normalizeBudgetCount(budgetTokens);
  let usedTokens = 0;
  for (const candidate of candidates) {
    const tokens = estimateTokens(candidate.text);
    if (addBudgetCounts(usedTokens, tokens) > normalizedBudget) break;
    selected.push(candidate);
    usedTokens = addBudgetCounts(usedTokens, tokens);
  }
  return selected;
}

// ─── Budget Trimming ───

/**
 * When total actual usage exceeds the budget, reduce allocations starting from
 * the lowest-priority categories.
 *
 * Priority order (highest first): observations, knowledge, goalDefinition,
 * transferKnowledge, meta.
 */
export function trimToBudget(
  allocation: BudgetAllocation,
  actualUsage: Record<keyof BudgetAllocation, number>,
  totalBudget: number
): BudgetAllocation {
  const trimOrder: (keyof BudgetAllocation)[] = [
    "meta",
    "transferKnowledge",
    "goalDefinition",
    "knowledge",
    "observations",
  ];
  const result = normalizeBudgetAllocation(allocation);
  const normalizedActualUsage = normalizeBudgetAllocation(actualUsage);
  const normalizedTotalBudget = normalizeBudgetCount(totalBudget);
  let totalUsed = Object.values(normalizedActualUsage).reduce(addBudgetCounts, 0);

  for (const category of trimOrder) {
    if (totalUsed <= normalizedTotalBudget) break;
    const excess = totalUsed - normalizedTotalBudget;
    const reduction = Math.min(result[category], excess);
    result[category] -= reduction;
    totalUsed -= reduction;
  }
  return result;
}

function normalizeBudgetAllocation(
  allocation: Record<keyof BudgetAllocation, number>
): BudgetAllocation {
  return {
    goalDefinition: normalizeBudgetCount(allocation.goalDefinition),
    observations: normalizeBudgetCount(allocation.observations),
    knowledge: normalizeBudgetCount(allocation.knowledge),
    transferKnowledge: normalizeBudgetCount(allocation.transferKnowledge),
    meta: normalizeBudgetCount(allocation.meta),
  };
}
