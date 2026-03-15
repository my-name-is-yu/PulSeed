import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StateManager } from "./state-manager.js";
import type { ILLMClient } from "./llm-client.js";
import type { EthicsGate } from "./ethics-gate.js";
import type { GoalDependencyGraph } from "./goal-dependency-graph.js";
import type { GoalNegotiator } from "./goal-negotiator.js";
import { GoalSchema } from "./types/goal.js";
import type { Goal } from "./types/goal.js";
import type {
  GoalDecompositionConfig,
  DecompositionResult,
  GoalTreeState,
  PruneDecision,
  PruneReason,
} from "./types/goal-tree.js";

// ─── LLM Response Schemas ───

const SpecificityResponseSchema = z.object({
  specificity_score: z.number().min(0).max(1),
  reasoning: z.string(),
});

const SubgoalItemSchema = z.object({
  hypothesis: z.string(),
  dimensions: z
    .array(
      z.object({
        name: z.string(),
        label: z.string(),
        threshold_type: z.enum(["min", "max", "range", "present", "match"]),
        threshold_value: z.union([z.number(), z.string(), z.boolean(), z.null()]).nullable(),
        observation_method_hint: z.string().optional().default(""),
      })
    )
    .default([]),
  constraints: z.array(z.string()).default([]),
  expected_specificity: z.number().min(0).max(1).optional(),
});

const SubgoalsResponseSchema = z.array(SubgoalItemSchema);

const CoverageResponseSchema = z.object({
  covers_parent: z.boolean(),
  missing_dimensions: z.array(z.string()).default([]),
  reasoning: z.string(),
});

const RestructureSuggestionSchema = z.object({
  action: z.enum(["move", "merge", "split", "reorder"]),
  goal_ids: z.array(z.string()),
  reasoning: z.string(),
});
const RestructureResponseSchema = z.array(RestructureSuggestionSchema);

// ─── Prompt Builders ───

function buildSpecificityPrompt(goal: Goal): string {
  const dimNames = goal.dimensions.map((d) => d.name).join(", ");
  const constraintLines =
    goal.constraints.length > 0
      ? `\nConstraints: ${goal.constraints.join(", ")}`
      : "";
  return `Evaluate the specificity of this goal. A high specificity score (>= 0.7) means the goal is concrete enough to generate specific tasks directly. A low score means it is too abstract and needs further decomposition.

Goal title: ${goal.title}
Goal description: ${goal.description}
Dimensions: ${dimNames || "(none defined)"}${constraintLines}
Current decomposition depth: ${goal.decomposition_depth}

Output JSON:
{
  "specificity_score": <number 0.0 to 1.0>,
  "reasoning": "<brief explanation>"
}

Return ONLY the JSON object, no other text.`;
}

function buildSubgoalPrompt(
  goal: Goal,
  depth: number,
  maxDepth: number,
  maxChildren: number
): string {
  const constraintLines =
    goal.constraints.length > 0
      ? `Constraints:\n${goal.constraints.map((c) => `- ${c}`).join("\n")}`
      : "Constraints: none";

  const dimLines =
    goal.dimensions.length > 0
      ? `Existing dimensions:\n${goal.dimensions.map((d) => `- ${d.name}: ${d.label}`).join("\n")}`
      : "Existing dimensions: none";

  return `Decompose this goal into ${maxChildren} or fewer concrete subgoals. Each subgoal should address a distinct aspect of the parent goal and be more specific.

Parent goal: ${goal.title}
Description: ${goal.description}
${dimLines}
${constraintLines}
Current depth: ${depth} (max allowed depth: ${maxDepth})
Remaining decomposition levels: ${maxDepth - depth}

For each subgoal, provide:
- hypothesis: what this subgoal achieves (1-2 sentences)
- dimensions: array of measurable dimensions (name, label, threshold_type, threshold_value, observation_method_hint)
- constraints: array of constraints specific to this subgoal
- expected_specificity: estimated specificity score after decomposition (0.0-1.0)

Output JSON array of subgoal objects. Maximum ${maxChildren} items.
Return ONLY a JSON array, no other text.`;
}

function buildCoveragePrompt(parent: Goal, children: Goal[]): string {
  const parentDims = parent.dimensions.map((d) => d.name).join(", ");
  const childSummaries = children
    .map((c, i) => `  ${i + 1}. "${c.title}": dimensions=[${c.dimensions.map((d) => d.name).join(", ")}]`)
    .join("\n");

  return `Do these subgoals collectively cover all dimensions of the parent goal?

Parent goal: ${parent.title}
Parent dimensions: ${parentDims || "(none)"}

Subgoals:
${childSummaries}

Output JSON:
{
  "covers_parent": <true|false>,
  "missing_dimensions": ["<dim1>", ...],
  "reasoning": "<brief explanation>"
}

Return ONLY the JSON object, no other text.`;
}

function buildRestructurePrompt(rootId: string, treeState: GoalTreeState, goals: Goal[]): string {
  const goalSummaries = goals
    .map((g) => `  - id="${g.id}" title="${g.title}" depth=${g.decomposition_depth} status=${g.status}`)
    .join("\n");

  return `Suggest restructuring actions for this goal tree to improve efficiency.

Root goal ID: ${rootId}
Total nodes: ${treeState.total_nodes}
Max depth reached: ${treeState.max_depth_reached}
Active loops: ${treeState.active_loops.length}
Pruned nodes: ${treeState.pruned_nodes.length}

Goals in tree:
${goalSummaries}

Suggest restructuring actions. Each action should specify:
- action: "move" | "merge" | "split" | "reorder"
- goal_ids: array of goal IDs involved
- reasoning: why this restructuring would help

Output JSON array. Return empty array [] if no restructuring needed.
Return ONLY a JSON array, no other text.`;
}

// ─── Helper: Build a Goal from subgoal spec ───

function buildGoalFromSubgoalSpec(
  spec: z.infer<typeof SubgoalItemSchema>,
  parentId: string,
  parentDepth: number,
  now: string
): Goal {
  const id = randomUUID();
  const dims = spec.dimensions.map((d) => ({
    name: d.name,
    label: d.label,
    current_value: null,
    threshold: {
      type: d.threshold_type,
      value: d.threshold_value ?? null,
    },
    confidence: 0.5,
    observation_method: {
      type: "manual" as const,
      source: "decomposition",
      schedule: null,
      endpoint: null,
      confidence_tier: "self_report" as const,
    },
    last_updated: now,
    history: [],
    weight: 1.0,
    uncertainty_weight: null,
    state_integrity: "ok" as const,
    dimension_mapping: null,
  }));

  return GoalSchema.parse({
    id,
    parent_id: parentId,
    node_type: "subgoal",
    title: spec.hypothesis.slice(0, 200),
    description: spec.hypothesis,
    status: "active",
    dimensions: dims,
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: spec.constraints,
    children_ids: [],
    target_date: null,
    origin: "decomposition",
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    decomposition_depth: parentDepth + 1,
    specificity_score: spec.expected_specificity ?? null,
    loop_status: "idle",
    created_at: now,
    updated_at: now,
  });
}

// ─── GoalTreeManager ───

/**
 * GoalTreeManager handles recursive goal decomposition, pruning,
 * dynamic subgoal addition, tree restructuring, and tree state queries.
 *
 * Responsibilities:
 *   - Specificity evaluation (LLM)
 *   - N-layer recursive decomposition
 *   - Decomposition validation (coverage + cycle check)
 *   - Pruning (cancel goal + all descendants)
 *   - Dynamic subgoal addition
 *   - Tree state queries
 */
export class GoalTreeManager {
  constructor(
    private readonly stateManager: StateManager,
    private readonly llmClient: ILLMClient,
    private readonly ethicsGate: EthicsGate,
    private readonly goalDependencyGraph: GoalDependencyGraph,
    private readonly goalNegotiator?: GoalNegotiator
  ) {}

  // ─── Specificity Evaluation ───

  /**
   * Evaluates the specificity of a goal using an LLM.
   * Returns a score between 0 (very abstract) and 1 (very concrete).
   * Falls back to 0.5 on parse failures.
   */
  private async evaluateSpecificity(
    goal: Goal
  ): Promise<{ score: number; reasoning: string }> {
    const prompt = buildSpecificityPrompt(goal);
    try {
      const response = await this.llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        { temperature: 0 }
      );
      const parsed = this.llmClient.parseJSON(
        response.content,
        SpecificityResponseSchema
      );
      return { score: parsed.specificity_score, reasoning: parsed.reasoning };
    } catch {
      // Conservative fallback: treat as needing decomposition
      return { score: 0.5, reasoning: "LLM evaluation failed, defaulting to 0.5" };
    }
  }

  // ─── Core Decomposition ───

  /**
   * Recursively decomposes a goal into subgoals until each subgoal either:
   *   (a) has specificity_score >= config.min_specificity → leaf node
   *   (b) has decomposition_depth >= config.max_depth → forced leaf
   *
   * Returns a DecompositionResult for the top-level call.
   */
  async decomposeGoal(
    goalId: string,
    config: GoalDecompositionConfig
  ): Promise<DecompositionResult> {
    const goal = this.stateManager.loadGoal(goalId);
    if (!goal) {
      throw new Error(`GoalTreeManager.decomposeGoal: goal "${goalId}" not found`);
    }

    return this._decomposeGoalInternal(goal, config, 0);
  }

  private async _decomposeGoalInternal(
    goal: Goal,
    config: GoalDecompositionConfig,
    retryCount: number
  ): Promise<DecompositionResult> {
    const now = new Date().toISOString();

    // Step 1: Evaluate specificity
    const { score: specificityScore, reasoning } = await this.evaluateSpecificity(goal);

    // Update goal with specificity score
    const updatedGoal: Goal = {
      ...goal,
      specificity_score: specificityScore,
      updated_at: now,
    };

    // Step 2: Determine if this is a leaf node
    const isLeaf =
      specificityScore >= config.min_specificity ||
      goal.decomposition_depth >= config.max_depth;

    if (isLeaf) {
      // Mark as leaf node
      const leafGoal: Goal = {
        ...updatedGoal,
        node_type: "leaf",
        updated_at: now,
      };
      this.stateManager.saveGoal(leafGoal);

      return {
        parent_id: goal.id,
        children: [],
        depth: goal.decomposition_depth,
        specificity_scores: { [goal.id]: specificityScore },
        reasoning:
          specificityScore >= config.min_specificity
            ? `Goal is specific enough (score=${specificityScore.toFixed(2)}): ${reasoning}`
            : `Max depth ${config.max_depth} reached, forced leaf`,
      };
    }

    // Step 3: Generate subgoals via LLM
    const maxChildren = 5;
    const subgoalPrompt = buildSubgoalPrompt(
      updatedGoal,
      goal.decomposition_depth,
      config.max_depth,
      maxChildren
    );

    let subgoalSpecs: z.infer<typeof SubgoalsResponseSchema> = [];
    try {
      const subgoalResponse = await this.llmClient.sendMessage(
        [{ role: "user", content: subgoalPrompt }],
        { temperature: 0 }
      );
      const parsed = this.llmClient.parseJSON(
        subgoalResponse.content,
        SubgoalsResponseSchema
      );
      subgoalSpecs = parsed.map((sg: (typeof parsed)[number]) => ({
        ...sg,
        dimensions: (sg.dimensions ?? []).map((d) => ({
          ...d,
          observation_method_hint: d.observation_method_hint ?? "",
        })),
        constraints: sg.constraints ?? [],
      }));
      // Clamp to max_children_per_node
      subgoalSpecs = subgoalSpecs.slice(0, maxChildren);
    } catch {
      // If subgoal generation fails, treat as leaf
      const leafGoal: Goal = {
        ...updatedGoal,
        node_type: "leaf",
        updated_at: now,
      };
      this.stateManager.saveGoal(leafGoal);
      return {
        parent_id: goal.id,
        children: [],
        depth: goal.decomposition_depth,
        specificity_scores: { [goal.id]: specificityScore },
        reasoning: "Subgoal generation failed, treating as leaf",
      };
    }

    // Handle empty decomposition
    if (subgoalSpecs.length === 0) {
      const leafGoal: Goal = {
        ...updatedGoal,
        node_type: "leaf",
        updated_at: now,
      };
      this.stateManager.saveGoal(leafGoal);
      return {
        parent_id: goal.id,
        children: [],
        depth: goal.decomposition_depth,
        specificity_scores: { [goal.id]: specificityScore },
        reasoning: "LLM returned empty subgoal list, treating as leaf",
      };
    }

    // Step 4: Build child Goal objects
    const childGoals: Goal[] = subgoalSpecs.map((spec) =>
      buildGoalFromSubgoalSpec(spec, goal.id, goal.decomposition_depth, now)
    );

    // Step 5: Build the provisional decomposition result for validation
    const provisionalResult: DecompositionResult = {
      parent_id: goal.id,
      children: childGoals,
      depth: goal.decomposition_depth,
      specificity_scores: { [goal.id]: specificityScore },
      reasoning,
    };

    // Step 6: Validate decomposition (retry up to 2 times)
    const isValid = await this.validateDecomposition(provisionalResult);
    if (!isValid && retryCount < 2) {
      // Retry decomposition
      return this._decomposeGoalInternal(goal, config, retryCount + 1);
    }

    // Step 7: Save parent goal (updated specificity_score, node_type stays as-is for non-leaf)
    this.stateManager.saveGoal(updatedGoal);

    // Step 8: Save each child goal and update parent's children_ids
    const childIds: string[] = [];
    for (const child of childGoals) {
      this.stateManager.saveGoal(child);
      childIds.push(child.id);

      // Register parent->child dependency in GoalDependencyGraph
      try {
        this.goalDependencyGraph.addEdge({
          from_goal_id: goal.id,
          to_goal_id: child.id,
          type: "parent_child" as never, // type extended in 14A
          status: "active",
          condition: null,
          affected_dimensions: child.dimensions.map((d) => d.name),
          mitigation: null,
          detection_confidence: 1.0,
          reasoning: `Parent-child relationship from goal decomposition`,
        });
      } catch {
        // Dependency graph may not support parent_child type — skip silently
      }
    }

    // Update parent goal's children_ids
    const parentWithChildren: Goal = {
      ...updatedGoal,
      children_ids: [...updatedGoal.children_ids, ...childIds],
      updated_at: now,
    };
    this.stateManager.saveGoal(parentWithChildren);

    // Step 9: Collect specificity scores for result
    const specificityScores: Record<string, number> = {
      [goal.id]: specificityScore,
    };

    // Step 10: Recursively decompose each child
    for (const child of childGoals) {
      const childResult = await this._decomposeGoalInternal(child, config, 0);
      // Merge child specificity scores
      Object.assign(specificityScores, childResult.specificity_scores);
      // Merge children into child's record
      if (childResult.children.length > 0) {
        const reloadedChild = this.stateManager.loadGoal(child.id);
        if (reloadedChild) {
          // child was saved with updated children_ids from recursive call
          void reloadedChild; // already persisted by recursive call
        }
      }
    }

    return {
      parent_id: goal.id,
      children: childGoals,
      depth: goal.decomposition_depth,
      specificity_scores: specificityScores,
      reasoning,
    };
  }

  // ─── Validation ───

  /**
   * Validates a decomposition result by checking:
   *   1. Coverage: subgoals cover all parent dimensions (LLM)
   *   2. Cycle detection: no circular dependencies introduced
   *
   * Returns true only if both checks pass.
   */
  async validateDecomposition(result: DecompositionResult): Promise<boolean> {
    const parent = this.stateManager.loadGoal(result.parent_id);
    if (!parent) return false;

    const children = result.children as Goal[];

    // Check 1: Coverage validation via LLM
    if (children.length > 0) {
      const coveragePrompt = buildCoveragePrompt(parent, children);
      try {
        const coverageResponse = await this.llmClient.sendMessage(
          [{ role: "user", content: coveragePrompt }],
          { temperature: 0 }
        );
        const coverage = this.llmClient.parseJSON(
          coverageResponse.content,
          CoverageResponseSchema
        );
        if (!coverage.covers_parent) {
          return false;
        }
      } catch {
        // On parse failure, allow decomposition to proceed
      }
    }

    // Check 2: Cycle detection
    for (const child of children as Goal[]) {
      const wouldCycle = this.goalDependencyGraph.detectCycle(
        result.parent_id,
        child.id
      );
      if (wouldCycle) {
        return false;
      }
    }

    return true;
  }

  // ─── Pruning ───

  /**
   * Prunes a goal and all its descendants by setting status = "cancelled".
   * Removes the goal from its parent's children_ids.
   * Returns a PruneDecision.
   */
  pruneGoal(goalId: string, reason: PruneReason): PruneDecision {
    const goal = this.stateManager.loadGoal(goalId);
    if (!goal) {
      throw new Error(`GoalTreeManager.pruneGoal: goal "${goalId}" not found`);
    }

    const now = new Date().toISOString();

    // Cancel the goal and all descendants
    this._cancelGoalAndDescendants(goal, now);

    // Remove from parent's children_ids
    if (goal.parent_id) {
      const parent = this.stateManager.loadGoal(goal.parent_id);
      if (parent) {
        const updatedParent: Goal = {
          ...parent,
          children_ids: parent.children_ids.filter((id) => id !== goalId),
          updated_at: now,
        };
        this.stateManager.saveGoal(updatedParent);
      }
    }

    return {
      goal_id: goalId,
      reason,
      replacement_id: null,
    };
  }

  private _cancelGoalAndDescendants(goal: Goal, now: string): void {
    // Recursively cancel all children first
    for (const childId of goal.children_ids) {
      const child = this.stateManager.loadGoal(childId);
      if (child) {
        this._cancelGoalAndDescendants(child, now);
      }
    }

    // Cancel this goal
    const cancelled: Goal = {
      ...goal,
      status: "cancelled",
      updated_at: now,
    };
    this.stateManager.saveGoal(cancelled);
  }

  // ─── Dynamic Subgoal Addition ───

  /**
   * Adds a new subgoal to a parent goal.
   * - Validates the parent exists
   * - Saves the new goal with parent_id set
   * - Adds child ID to parent's children_ids
   * - Registers the dependency in GoalDependencyGraph
   * Returns the saved goal.
   */
  addSubgoal(parentId: string, goal: Goal): Goal {
    const parent = this.stateManager.loadGoal(parentId);
    if (!parent) {
      throw new Error(`GoalTreeManager.addSubgoal: parent goal "${parentId}" not found`);
    }

    const now = new Date().toISOString();

    // Ensure parent_id is set on the new goal
    const goalWithParent: Goal = GoalSchema.parse({
      ...goal,
      parent_id: parentId,
      updated_at: now,
    });

    // Save the new goal
    this.stateManager.saveGoal(goalWithParent);

    // Update parent's children_ids
    const updatedParent: Goal = {
      ...parent,
      children_ids: [...parent.children_ids, goalWithParent.id],
      updated_at: now,
    };
    this.stateManager.saveGoal(updatedParent);

    // Register dependency
    try {
      this.goalDependencyGraph.addEdge({
        from_goal_id: parentId,
        to_goal_id: goalWithParent.id,
        type: "parent_child" as never,
        status: "active",
        condition: null,
        affected_dimensions: goalWithParent.dimensions.map((d) => d.name),
        mitigation: null,
        detection_confidence: 1.0,
        reasoning: `Parent-child relationship (dynamic subgoal addition)`,
      });
    } catch {
      // Dependency graph may not support parent_child type — skip silently
    }

    return goalWithParent;
  }

  // ─── Tree Restructure ───

  /**
   * Asks an LLM for restructuring suggestions on the current tree rooted at goalId,
   * then applies them. Currently supports identifying merge/move candidates.
   */
  async restructureTree(goalId: string): Promise<void> {
    const treeState = this.getTreeState(goalId);
    const allGoalIds = this._collectAllDescendantIds(goalId);
    allGoalIds.unshift(goalId);

    const goals: Goal[] = [];
    for (const id of allGoalIds) {
      const g = this.stateManager.loadGoal(id);
      if (g) goals.push(g);
    }

    const prompt = buildRestructurePrompt(goalId, treeState, goals);
    try {
      const response = await this.llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        { temperature: 0 }
      );
      const suggestions = this.llmClient.parseJSON(
        response.content,
        RestructureResponseSchema
      );

      const now = new Date().toISOString();

      for (const suggestion of suggestions) {
        if (suggestion.action === "merge" && suggestion.goal_ids.length >= 2) {
          // Merge: cancel all but first goal in the list
          const [keepId, ...mergeIds] = suggestion.goal_ids;
          if (keepId) {
            for (const mergeId of mergeIds) {
              const mergeGoal = this.stateManager.loadGoal(mergeId);
              if (mergeGoal && mergeGoal.status !== "cancelled") {
                this._cancelGoalAndDescendants(mergeGoal, now);
                // Remove from parent
                if (mergeGoal.parent_id) {
                  const parent = this.stateManager.loadGoal(mergeGoal.parent_id);
                  if (parent) {
                    const updatedParent: Goal = {
                      ...parent,
                      children_ids: parent.children_ids.filter((id) => id !== mergeId),
                      updated_at: now,
                    };
                    this.stateManager.saveGoal(updatedParent);
                  }
                }
              }
            }
          }
        }
        // Other actions (move, split, reorder) are logged but not fully automated in MVP
      }
    } catch {
      // Restructure is best-effort; silently ignore errors
    }
  }

  // ─── Tree State ───

  /**
   * Computes the current GoalTreeState for the tree rooted at rootId.
   * Traverses all descendants recursively.
   */
  getTreeState(rootId: string): GoalTreeState {
    const root = this.stateManager.loadGoal(rootId);
    if (!root) {
      return {
        root_id: rootId,
        total_nodes: 0,
        max_depth_reached: 0,
        active_loops: [],
        pruned_nodes: [],
      };
    }

    let totalNodes = 0;
    let maxDepthReached = 0;
    const activeLoops: string[] = [];
    const prunedNodes: string[] = [];

    const visit = (goal: Goal): void => {
      totalNodes++;

      if (goal.decomposition_depth > maxDepthReached) {
        maxDepthReached = goal.decomposition_depth;
      }

      if (goal.loop_status === "running") {
        activeLoops.push(goal.id);
      }

      if (goal.status === "cancelled") {
        prunedNodes.push(goal.id);
      }

      for (const childId of goal.children_ids) {
        const child = this.stateManager.loadGoal(childId);
        if (child) {
          visit(child);
        }
      }
    };

    visit(root);

    return {
      root_id: rootId,
      total_nodes: totalNodes,
      max_depth_reached: maxDepthReached,
      active_loops: activeLoops,
      pruned_nodes: prunedNodes,
    };
  }

  // ─── Private Helpers ───

  private _collectAllDescendantIds(goalId: string): string[] {
    const goal = this.stateManager.loadGoal(goalId);
    if (!goal) return [];
    const result: string[] = [];
    for (const childId of goal.children_ids) {
      result.push(childId);
      result.push(...this._collectAllDescendantIds(childId));
    }
    return result;
  }
}
