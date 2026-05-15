import { z } from "zod/v3";
import {
  ThresholdSchema,
  ObservationMethodSchema,
  AggregationTypeEnum,
  GapAggregationEnum,
  PaceStatusEnum,
  DurationSchema,
} from "../../../base/types/core.js";

// --- History Entry ---

export const HistoryEntrySchema = z.object({
  value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  timestamp: z.string(),
  confidence: z.number().min(0).max(1),
  source_observation_id: z.string(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

// --- Satisficing Aggregation Enum (distinct from gap calculation aggregation) ---

/**
 * SatisficingAggregation defines how multiple subgoal dimensions aggregate
 * into a parent goal dimension during completion propagation.
 *
 * Note: This is distinct from AggregationTypeEnum (gap calculation) which includes "weighted_avg".
 * Satisficing uses simple aggregation strategies: min, avg, max, all_required.
 */
export const SatisficingAggregationEnum = z.enum(["min", "avg", "max", "all_required"]);
export type SatisficingAggregation = z.infer<typeof SatisficingAggregationEnum>;

export const DimensionObservationMappingSchema = z.object({
  kind: z.literal("data_source"),
  data_source: z.string().min(1),
  dimension: z.string().min(1),
  confidence: z.enum(["high", "medium", "low"]),
  rationale: z.string().optional(),
}).strict();
export type DimensionObservationMapping = z.infer<typeof DimensionObservationMappingSchema>;

// --- Dimension ---

export const DimensionSchema = z.object({
  name: z.string(),
  label: z.string(),
  current_value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  threshold: ThresholdSchema,
  confidence: z.number().min(0).max(1),
  observation_method: ObservationMethodSchema,
  last_updated: z.string().nullable(),
  history: z.array(HistoryEntrySchema),
  /** Weight for gap aggregation (default 1.0) */
  weight: z.number().default(1.0),
  /** Per-dimension uncertainty_weight override (null = use global) */
  uncertainty_weight: z.number().nullable().default(null),
  /**
   * Integrity flag: set to "uncertain" when a revert fails so PulSeed stops
   * autonomous task selection for this dimension until a human resets it.
   * See task-lifecycle.md §6.
   */
  state_integrity: z.enum(["ok", "uncertain"]).default("ok"),
  /**
   * The observation layer that last updated this dimension's confidence.
   * Used to compare against incoming observation priority (replaces static
   * confidence_tier comparison which never changes after goal creation).
   */
  last_observed_layer: z
    .enum(["self_report", "independent_review", "mechanical"])
    .optional(),
  observation_mapping: DimensionObservationMappingSchema.nullable().optional(),
  /**
   * Maps this subgoal dimension to a parent goal dimension with an aggregation strategy.
   * When set, propagateSubgoalCompletion uses parent_dimension (not name matching)
   * and aggregates multiple subgoal dimensions mapped to the same parent dimension.
   * See satisficing.md §7 Phase 2.
   */
  dimension_mapping: z
    .object({
      parent_dimension: z.string(),
      aggregation: SatisficingAggregationEnum,
    })
    .nullable()
    .default(null),
});
export type Dimension = z.infer<typeof DimensionSchema>;

// --- Dimension Mapping (for sub-goal to parent propagation) ---

export const DimensionMappingSchema = z.object({
  parent_dimension: z.string(),
  aggregation: AggregationTypeEnum,
});
export type DimensionMapping = z.infer<typeof DimensionMappingSchema>;

// --- Milestone Pace Snapshot ---

export const PaceSnapshotSchema = z.object({
  elapsed_ratio: z.number(),
  achievement_ratio: z.number(),
  pace_ratio: z.number(),
  status: PaceStatusEnum,
  evaluated_at: z.string(),
});
export type PaceSnapshot = z.infer<typeof PaceSnapshotSchema>;

// --- Goal Node Type ---

export const GoalNodeTypeEnum = z.enum(["goal", "subgoal", "milestone", "leaf"]);
export type GoalNodeType = z.infer<typeof GoalNodeTypeEnum>;

// --- Goal Status ---

export const GoalStatusEnum = z.enum([
  "active",
  "completed",
  "cancelled",
  "waiting",
  "archived",
  "abandoned",
]);
export type GoalStatus = z.infer<typeof GoalStatusEnum>;

// --- Observation Optimization ---

export const ObservationOptimizationSchema = z.object({
  /** Minimum seconds between LLM observations for a dimension (default: 60) */
  min_observation_interval_sec: z.number().int().min(0).default(60),
  /** Skip LLM observation when pre-check detects no change (default: true) */
  skip_on_no_change: z.boolean().default(true),
  /** Pre-check strategies to use before LLM observation */
  pre_check_strategies: z
    .array(z.enum(["datasource_delta", "file_stat", "git_diff", "age"]))
    .default(["datasource_delta", "git_diff", "age"]),
});
export type ObservationOptimization = z.infer<typeof ObservationOptimizationSchema>;

// --- Deadline finalization policy ---

export const GoalFinalizationExternalActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  tool_name: z.string().min(1).optional(),
  payload_ref: z.string().min(1).optional(),
  approval_required: z.literal(true).default(true),
}).strict();
export type GoalFinalizationExternalAction = z.infer<typeof GoalFinalizationExternalActionSchema>;

export const GoalFinalizationPolicySchema = z.object({
  /** Minimum time that must be reserved before a deadline for final packaging/checks. */
  minimum_buffer_ms: z.number().int().nonnegative(),
  /** Earlier warning window for switching from open exploration to consolidation. */
  consolidation_buffer_ms: z.number().int().nonnegative().default(0),
  deliverable_contract: z.string().min(1).optional(),
  best_artifact_selection: z.enum(["best_evidence", "latest_artifact", "latest_verified"]).default("best_evidence"),
  require_reproducibility_manifest: z.boolean().default(false),
  verification_steps: z.array(z.string().min(1)).default([]),
  external_actions: z.array(GoalFinalizationExternalActionSchema).default([]),
}).strict();
export type GoalFinalizationPolicy = z.infer<typeof GoalFinalizationPolicySchema>;

// --- Goal (a node in the goal tree) ---

export const GoalSchema = z.object({
  id: z.string(),
  parent_id: z.string().nullable().default(null),
  node_type: GoalNodeTypeEnum.default("goal"),
  title: z.string(),
  description: z.string().default(""),
  status: GoalStatusEnum.default("active"),

  dimensions: z.array(DimensionSchema),
  /** Aggregation method for child goals (default: max = bottleneck) */
  gap_aggregation: GapAggregationEnum.default("max"),
  /** Dimension mapping for sub-goal to parent propagation */
  dimension_mapping: DimensionMappingSchema.nullable().default(null),

  constraints: z.array(z.string()).default([]),
  children_ids: z.array(z.string()).default([]),

  // Milestone-specific fields
  target_date: z.string().nullable().default(null),
  origin: z
    .enum(["negotiation", "decomposition", "manual", "curiosity"])
    .nullable()
    .default(null),
  pace_snapshot: PaceSnapshotSchema.nullable().default(null),

  // Deadline & scheduling
  deadline: z.string().datetime().nullable().default(null),
  finalization_policy: GoalFinalizationPolicySchema.nullable().optional(),

  // Negotiation metadata
  confidence_flag: z.enum(["high", "medium", "low"]).nullable().default(null),
  user_override: z.boolean().default(false),
  feasibility_note: z.string().nullable().default(null),

  // Global uncertainty_weight for gap calculation (default: 1.0)
  uncertainty_weight: z.number().default(1.0),

  // Stage 14: Goal tree decomposition fields
  decomposition_depth: z.number().int().min(0).default(0),
  specificity_score: z.number().min(0).max(1).nullable().default(null),
  loop_status: z.enum(["idle", "running", "paused"]).default("idle"),

  // Token optimization: staged observation config (optional)
  observation_optimization: ObservationOptimizationSchema.optional(),

  // Timing
  created_at: z.string(),
  updated_at: z.string(),
});
export type Goal = z.infer<typeof GoalSchema>;

// --- Goal Tree (collection of goals for a top-level goal) ---

export const GoalTreeSchema = z.object({
  root_id: z.string(),
  goals: z.record(z.string(), GoalSchema),
});
export type GoalTree = z.infer<typeof GoalTreeSchema>;
