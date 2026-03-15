import { StateManager } from "./state-manager.js";
import { GoalDependencyGraph } from "./goal-dependency-graph.js";
import { VectorIndex } from "./vector-index.js";
import type { IEmbeddingClient } from "./embedding-client.js";
import { scoreDeadline } from "./drive-scorer.js";
import {
  CrossGoalPortfolioConfigSchema,
} from "./types/cross-portfolio.js";
import type {
  CrossGoalAllocation,
  CrossGoalPortfolioConfig,
  GoalPriorityFactors,
  StrategyTemplate,
  CrossGoalRebalanceResult,
  CrossGoalRebalanceTrigger,
} from "./types/cross-portfolio.js";
import type { Goal } from "./types/goal.js";

// ─── Helpers ───

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * CrossGoalPortfolio manages resource allocation and priority across multiple
 * active goals. It sits above individual PortfolioManager instances and answers
 * the question: "given N active goals, how should overall resources be split?"
 *
 * Responsibilities:
 *   - Calculate per-goal priority scores from 4 factors
 *   - Allocate resource shares proportionally
 *   - Rebalance on 4 trigger types
 *   - Recommend strategy templates using vector similarity
 *
 * CrossGoalPortfolio does NOT manage strategies within a single goal —
 * that remains the responsibility of PortfolioManager.
 */
export class CrossGoalPortfolio {
  private readonly stateManager: StateManager;
  private readonly goalDependencyGraph: GoalDependencyGraph;
  private readonly vectorIndex: VectorIndex;
  private readonly embeddingClient: IEmbeddingClient;
  private readonly config: CrossGoalPortfolioConfig;

  /** goalId → cached GoalPriorityFactors from the last calculation */
  private lastPriorities: Map<string, GoalPriorityFactors> = new Map();

  constructor(
    stateManager: StateManager,
    goalDependencyGraph: GoalDependencyGraph,
    vectorIndex: VectorIndex,
    embeddingClient: IEmbeddingClient,
    config?: Partial<CrossGoalPortfolioConfig>
  ) {
    this.stateManager = stateManager;
    this.goalDependencyGraph = goalDependencyGraph;
    this.vectorIndex = vectorIndex;
    this.embeddingClient = embeddingClient;
    this.config = CrossGoalPortfolioConfigSchema.parse(config ?? {});
  }

  // ─── Priority Calculation ───

  /**
   * Calculate priority factors for each goal in the provided list.
   *
   * The 4 factors and their weights:
   *   w1=0.35  deadline_urgency    — how soon the goal must be finished
   *   w2=0.25  gap_severity        — worst-case normalized gap across dimensions
   *   w3=0.25  dependency_weight   — how many goals depend on this one
   *   w4=0.15  user_priority       — user-specified priority (1-5 → 0-1)
   *
   * After the weighted sum is computed, synergy/conflict edges from
   * GoalDependencyGraph adjust the final score before clamping to [0,1].
   *
   * @param goalIds — IDs of goals to evaluate (missing goals are skipped)
   * @returns GoalPriorityFactors[] sorted by computed_priority descending
   */
  calculateGoalPriorities(goalIds: string[]): GoalPriorityFactors[] {
    if (goalIds.length === 0) return [];

    const totalGoals = goalIds.length;
    const now = new Date();

    // --- Step 1: collect raw factors for each goal ---
    type RawFactors = {
      goalId: string;
      goal: Goal;
      deadlineUrgency: number;
      gapSeverity: number;
      dependencyWeight: number;
      userPriority: number;
    };

    const rawList: RawFactors[] = [];

    for (const goalId of goalIds) {
      const goal = this.stateManager.loadGoal(goalId);
      if (!goal) continue;

      // deadline_urgency — use scoreDeadline with maxGap=1 as the
      // normalized_weighted_gap input, then read the urgency value.
      let deadlineUrgency = 0;
      if (goal.deadline) {
        const deadlineMs = new Date(goal.deadline).getTime();
        const timeRemainingHours = (deadlineMs - now.getTime()) / (1000 * 60 * 60);
        const result = scoreDeadline(1, timeRemainingHours);
        // Normalize urgency to [0,1]. scoreDeadline with gap=1 means score == urgency.
        // urgency >= 1 (at minimum). We normalise by capping at the urgency-at-zero cap.
        // Use urgency directly but clamp to [0,1] after dividing by a reasonable max.
        // default urgency_steepness=2, deadline_horizon=168h → urgencyAtZero = exp(2) ≈ 7.39
        const urgencyAtZero = Math.exp(2); // exp(urgency_steepness)
        deadlineUrgency = clamp(result.urgency / urgencyAtZero, 0, 1);
      }

      // gap_severity — max normalized_weighted_gap across all dimensions
      // We approximate by treating each dimension's gap as proportional
      // to how far it is from its threshold relative to a known scale.
      // For simplicity (no GapCalculator instance injected), we derive a
      // rough severity from the dimension values directly.
      let gapSeverity = 0;
      for (const dim of goal.dimensions) {
        const dimGap = this._estimateDimensionGap(dim);
        if (dimGap > gapSeverity) {
          gapSeverity = dimGap;
        }
      }
      gapSeverity = clamp(gapSeverity, 0, 1);

      // dependency_weight — how many goals in the provided list depend on this goal
      const graph = this.goalDependencyGraph.getGraph();
      const dependentCount = graph.edges.filter(
        (e) =>
          e.from_goal_id === goalId &&
          e.type === "prerequisite" &&
          e.status === "active" &&
          goalIds.includes(e.to_goal_id)
      ).length;
      const dependencyWeight = totalGoals > 1 ? dependentCount / (totalGoals - 1) : 0;

      // user_priority — extract from goal constraints or metadata
      // Assume format "priority:N" (N in 1-5) anywhere in constraints
      let userPriority = 0.5; // default
      for (const constraint of goal.constraints) {
        const match = constraint.match(/\bpriority[:\s=]+(\d+)\b/i);
        if (match) {
          const level = parseInt(match[1]!, 10);
          userPriority = clamp(level / 5, 0, 1);
          break;
        }
      }

      rawList.push({
        goalId,
        goal,
        deadlineUrgency,
        gapSeverity,
        dependencyWeight: clamp(dependencyWeight, 0, 1),
        userPriority,
      });
    }

    if (rawList.length === 0) return [];

    // --- Step 2: compute weighted priority ---
    const W1 = 0.35;
    const W2 = 0.25;
    const W3 = 0.25;
    const W4 = 0.15;

    const withBase = rawList.map((r) => {
      const basePriority =
        W1 * r.deadlineUrgency +
        W2 * r.gapSeverity +
        W3 * r.dependencyWeight +
        W4 * r.userPriority;
      return { ...r, basePriority };
    });

    // --- Step 3: apply synergy / conflict adjustments ---
    const synergyBonus = this.config.synergy_bonus / 2; // split the config bonus equally
    const CONFLICT_PENALTY = 0.15;

    const goalIdSet = new Set(rawList.map((r) => r.goalId));

    // Build a lookup: goalId → index in withBase
    const indexMap = new Map<string, number>();
    withBase.forEach((r, i) => indexMap.set(r.goalId, i));

    // Adjust scores based on dependency edges between goals in the set
    const adjustments = new Array<number>(withBase.length).fill(0);
    const graph = this.goalDependencyGraph.getGraph();
    const seenPairs = new Set<string>();

    for (const edge of graph.edges) {
      if (edge.status !== "active") continue;
      if (!goalIdSet.has(edge.from_goal_id) || !goalIdSet.has(edge.to_goal_id)) continue;

      const pairKey = [edge.from_goal_id, edge.to_goal_id].sort().join("||");

      if (edge.type === "synergy") {
        if (!seenPairs.has(pairKey)) {
          seenPairs.add(pairKey);
          const idxA = indexMap.get(edge.from_goal_id);
          const idxB = indexMap.get(edge.to_goal_id);
          if (idxA !== undefined) adjustments[idxA]! += synergyBonus;
          if (idxB !== undefined) adjustments[idxB]! += synergyBonus;
        }
      } else if (edge.type === "conflict") {
        if (!seenPairs.has(pairKey)) {
          seenPairs.add(pairKey);
          // Penalise the lower-priority goal
          const idxA = indexMap.get(edge.from_goal_id);
          const idxB = indexMap.get(edge.to_goal_id);
          if (idxA !== undefined && idxB !== undefined) {
            const scoreA = withBase[idxA]!.basePriority;
            const scoreB = withBase[idxB]!.basePriority;
            if (scoreA <= scoreB) {
              adjustments[idxA]! -= CONFLICT_PENALTY;
            } else {
              adjustments[idxB]! -= CONFLICT_PENALTY;
            }
          }
        }
      }
    }

    // --- Step 4: produce final factors ---
    const result: GoalPriorityFactors[] = withBase.map((r, i) => {
      const computedPriority = clamp(r.basePriority + (adjustments[i] ?? 0), 0, 1);
      return {
        goal_id: r.goalId,
        deadline_urgency: r.deadlineUrgency,
        gap_severity: r.gapSeverity,
        dependency_weight: r.dependencyWeight,
        user_priority: r.userPriority,
        computed_priority: computedPriority,
      };
    });

    // Sort descending by computed_priority
    result.sort((a, b) => b.computed_priority - a.computed_priority);

    // Cache for rebalance
    for (const f of result) {
      this.lastPriorities.set(f.goal_id, f);
    }

    return result;
  }

  // ─── Resource Allocation ───

  /**
   * Allocate resource shares across goals based on their priority scores.
   *
   * Rules:
   *   1. If goals > max_concurrent_goals, lowest priority goals get allocation=0
   *      and are labelled "waiting".
   *   2. Active goals (up to max_concurrent_goals) share 1.0 proportionally to
   *      computed_priority, with a floor of min_goal_share.
   *   3. Sum of active allocations = 1.0.
   *
   * @param priorities — output from calculateGoalPriorities
   * @returns CrossGoalAllocation[] in the same order as priorities
   */
  allocateResources(priorities: GoalPriorityFactors[]): CrossGoalAllocation[] {
    if (priorities.length === 0) return [];

    const { max_concurrent_goals, min_goal_share } = this.config;

    // Split into active (top N) and waiting (rest), already sorted desc
    const activeCount = Math.min(priorities.length, max_concurrent_goals);
    const activePriorities = priorities.slice(0, activeCount);
    const waitingPriorities = priorities.slice(activeCount);

    // Build allocations for waiting goals (zero share)
    const waitingAllocations: CrossGoalAllocation[] = waitingPriorities.map((p) => ({
      goal_id: p.goal_id,
      priority: p.computed_priority,
      resource_share: 0,
      adjustment_reason: `waiting: exceeds max_concurrent_goals (${max_concurrent_goals})`,
    }));

    if (activePriorities.length === 0) return waitingAllocations;

    // Single goal gets everything
    if (activePriorities.length === 1) {
      return [
        {
          goal_id: activePriorities[0]!.goal_id,
          priority: activePriorities[0]!.computed_priority,
          resource_share: 1.0,
          adjustment_reason: "sole active goal",
        },
        ...waitingAllocations,
      ];
    }

    // Proportional allocation with guaranteed min_goal_share floor.
    //
    // Algorithm:
    //   1. Reserve min_goal_share for every active goal.
    //   2. Distribute the remaining budget (1 - n * min_goal_share) proportionally
    //      by computed_priority.
    //   3. This guarantees every active goal has at least min_goal_share.
    //
    // Edge case: if n * min_goal_share >= 1 (too many goals for the floor to
    // allow proportional distribution), fall back to equal distribution.
    const n = activePriorities.length;
    const reservedTotal = n * min_goal_share;

    let finalShares: number[];

    if (reservedTotal >= 1) {
      // No room for proportional top-up — give everyone an equal share
      finalShares = activePriorities.map(() => 1 / n);
    } else {
      const remainingBudget = 1 - reservedTotal;
      const totalPriority = activePriorities.reduce(
        (sum, p) => sum + p.computed_priority,
        0
      );

      if (totalPriority === 0) {
        // All zero — split remaining budget equally
        finalShares = activePriorities.map(() => min_goal_share + remainingBudget / n);
      } else {
        finalShares = activePriorities.map(
          (p) => min_goal_share + remainingBudget * (p.computed_priority / totalPriority)
        );
      }
    }

    // Track which goals received the floor for reason strings
    const totalPriorityForReason = activePriorities.reduce(
      (sum, p) => sum + p.computed_priority,
      0
    );
    const rawShares = totalPriorityForReason === 0
      ? activePriorities.map(() => 1 / n)
      : activePriorities.map((p) => p.computed_priority / totalPriorityForReason);

    const activeAllocations: CrossGoalAllocation[] = activePriorities.map((p, i) => {
      const share = finalShares[i]!;
      const raw = rawShares[i]!;
      let reason: string;
      if (raw < min_goal_share) {
        reason = `min_goal_share floor applied (raw=${raw.toFixed(3)})`;
      } else {
        reason = `proportional to priority ${p.computed_priority.toFixed(3)}`;
      }
      return {
        goal_id: p.goal_id,
        priority: p.computed_priority,
        resource_share: share,
        adjustment_reason: reason,
      };
    });

    return [...activeAllocations, ...waitingAllocations];
  }

  // ─── Rebalancing ───

  /**
   * Recalculate priorities for all currently active goals and produce a new
   * allocation plan.
   *
   * @param trigger — what caused this rebalance
   * @param goalIds — explicit list of goal IDs to consider; if omitted, the
   *                  IDs from the last calculateGoalPriorities call are used
   */
  rebalanceGoals(
    trigger: CrossGoalRebalanceTrigger,
    goalIds?: string[]
  ): CrossGoalRebalanceResult {
    const ids = goalIds ?? Array.from(this.lastPriorities.keys());
    const priorities = this.calculateGoalPriorities(ids);
    const allocations = this.allocateResources(priorities);

    return {
      timestamp: new Date().toISOString(),
      allocations,
      triggered_by: trigger,
    };
  }

  // ─── Template Recommendation ───

  /**
   * Search the VectorIndex for strategy templates that match the given goal.
   *
   * Matching is based on:
   *   1. Semantic similarity between the goal text and template hypothesis_pattern
   *   2. domain_tags overlap (at least 1 tag in common with the goal's domain tags)
   *   3. Final ranking: similarity × effectiveness_score (descending)
   *
   * The caller is responsible for having added StrategyTemplate objects to the
   * VectorIndex with their `template_id` as the entry id and metadata shaped
   * as StrategyTemplate fields.
   *
   * @param goalId — goal for which templates are requested
   * @param vectorIndex — the index to search (typically the instance-level one,
   *                      but callers may pass a different one for testing)
   * @param limit — number of results to return (default 3)
   */
  async getRecommendedTemplates(
    goalId: string,
    vectorIndex: VectorIndex,
    limit: number = 3
  ): Promise<StrategyTemplate[]> {
    const goal = this.stateManager.loadGoal(goalId);
    if (!goal) return [];

    // Build a query string from the goal
    const queryText = [goal.title, goal.description, ...goal.constraints]
      .filter(Boolean)
      .join(" ");

    if (!queryText.trim()) return [];

    // Search index — retrieve more than `limit` so we can filter by domain_tags
    const searchResults = await vectorIndex.search(queryText, limit * 5);

    if (searchResults.length === 0) return [];

    // Derive goal domain tags from constraints (format "domain:tag") or title words
    const goalDomainTags = this._extractDomainTags(goal);

    // Filter and score
    const scored: Array<{ template: StrategyTemplate; finalScore: number }> = [];

    for (const result of searchResults) {
      const meta = result.metadata as Record<string, unknown>;

      // Must have the required StrategyTemplate fields in metadata
      if (
        typeof meta["template_id"] !== "string" ||
        typeof meta["hypothesis_pattern"] !== "string" ||
        !Array.isArray(meta["domain_tags"]) ||
        typeof meta["effectiveness_score"] !== "number"
      ) {
        continue;
      }

      const domainTags = meta["domain_tags"] as string[];
      const effectivenessScore = meta["effectiveness_score"] as number;

      // Require at least 1 domain tag overlap — unless goal has no tags (then include all)
      if (goalDomainTags.length > 0) {
        const overlap = domainTags.filter((t) => goalDomainTags.includes(t)).length;
        if (overlap < 1) continue;
      }

      const template: StrategyTemplate = {
        template_id: meta["template_id"] as string,
        source_goal_id: typeof meta["source_goal_id"] === "string"
          ? (meta["source_goal_id"] as string)
          : "",
        source_strategy_id: typeof meta["source_strategy_id"] === "string"
          ? (meta["source_strategy_id"] as string)
          : "",
        hypothesis_pattern: meta["hypothesis_pattern"] as string,
        domain_tags: domainTags,
        effectiveness_score: effectivenessScore,
        applicable_dimensions: Array.isArray(meta["applicable_dimensions"])
          ? (meta["applicable_dimensions"] as string[])
          : [],
        embedding_id: typeof meta["embedding_id"] === "string"
          ? (meta["embedding_id"] as string)
          : null,
        created_at: typeof meta["created_at"] === "string"
          ? (meta["created_at"] as string)
          : new Date().toISOString(),
      };

      const finalScore = result.similarity * effectivenessScore;
      scored.push({ template, finalScore });
    }

    // Sort by finalScore descending and return top `limit`
    scored.sort((a, b) => b.finalScore - a.finalScore);
    return scored.slice(0, limit).map((s) => s.template);
  }

  // ─── Private helpers ───

  /**
   * Produce a rough [0,1] severity for a single goal dimension.
   *
   * For numeric thresholds we compute gap / scale.
   * For binary thresholds (present/match) we return 0 or 1.
   * Returns 0 when the dimension is already satisfied.
   */
  private _estimateDimensionGap(
    dim: Goal["dimensions"][number]
  ): number {
    const { current_value, threshold } = dim;

    if (current_value === null) return 1;

    switch (threshold.type) {
      case "min": {
        if (typeof current_value !== "number") return 0;
        const gap = threshold.value - current_value;
        if (gap <= 0) return 0;
        return threshold.value !== 0 ? clamp(gap / threshold.value, 0, 1) : 1;
      }
      case "max": {
        if (typeof current_value !== "number") return 0;
        const gap = current_value - threshold.value;
        if (gap <= 0) return 0;
        return threshold.value !== 0 ? clamp(gap / threshold.value, 0, 1) : 1;
      }
      case "range": {
        if (typeof current_value !== "number") return 0;
        const span = threshold.high - threshold.low;
        if (current_value < threshold.low) {
          const gap = threshold.low - current_value;
          return span > 0 ? clamp(gap / span, 0, 1) : 1;
        }
        if (current_value > threshold.high) {
          const gap = current_value - threshold.high;
          return span > 0 ? clamp(gap / span, 0, 1) : 1;
        }
        return 0;
      }
      case "present": {
        return current_value ? 0 : 1;
      }
      case "match": {
        return current_value === threshold.value ? 0 : 1;
      }
      default:
        return 0;
    }
  }

  /**
   * Extract domain tags from a goal's constraints and title.
   * Recognises constraints with format "domain:tagname" or "tag:tagname".
   */
  private _extractDomainTags(goal: Goal): string[] {
    const tags: string[] = [];
    for (const constraint of goal.constraints) {
      const match = constraint.match(/^(?:domain|tag)[:\s]+(.+)$/i);
      if (match) {
        tags.push(match[1]!.trim().toLowerCase());
      }
    }
    return tags;
  }

  // ─── Allocation Map ───

  /**
   * Get a goal_id → resource_share map for the given goal IDs.
   *
   * Recomputes allocations based on current goal states.
   * Returns a Map suitable for use by PortfolioManager.selectNextStrategyAcrossGoals().
   */
  getAllocationMap(goalIds: string[]): Map<string, number> {
    const priorities = this.calculateGoalPriorities(goalIds);
    const allocations = this.allocateResources(priorities);

    const map = new Map<string, number>();
    for (const alloc of allocations) {
      map.set(alloc.goal_id, alloc.resource_share);
    }

    // Fill in any goal IDs that were not computed (e.g. loadGoal returned null)
    const equalShare = goalIds.length > 0 ? 1.0 / goalIds.length : 0;
    for (const goalId of goalIds) {
      if (!map.has(goalId)) {
        map.set(goalId, equalShare);
      }
    }

    return map;
  }
}
