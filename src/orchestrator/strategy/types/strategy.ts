import { z } from "zod/v3";
import { StrategyStateEnum, DurationSchema } from "../../../base/types/core.js";
import type { RebalanceTrigger } from "./portfolio.js";

export const StrategyUnitIntervalSchema = z.number().finite().min(0).max(1);
export const StrategySafeNonnegativeIntSchema = z.number().finite().int().nonnegative().safe();
const StrategyFiniteNumberSchema = z.number().finite();
const StrategyNonnegativeFiniteNumberSchema = z.number().finite().nonnegative();
const StrategySafeNonnegativeNumberSchema = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const StrategyDurationEstimateSchema = DurationSchema.extend({
  value: StrategyNonnegativeFiniteNumberSchema,
});

// --- Expected Effect ---

export const ExpectedEffectSchema = z.object({
  dimension: z.string(),
  direction: z.enum(["increase", "decrease"]),
  magnitude: z.enum(["small", "medium", "large"]),
});
export type ExpectedEffect = z.infer<typeof ExpectedEffectSchema>;

// --- Resource Estimate ---

export const ResourceEstimateSchema = z.object({
  sessions: StrategySafeNonnegativeIntSchema,
  duration: StrategyDurationEstimateSchema,
  llm_calls: StrategySafeNonnegativeIntSchema.nullable().default(null),
});
export type ResourceEstimate = z.infer<typeof ResourceEstimateSchema>;

// --- Exploration Metadata ---

export const StrategyExplorationRoleSchema = z.enum([
  "exploitation",
  "adjacent_exploration",
  "divergent_exploration",
]);
export type StrategyExplorationRole = z.infer<typeof StrategyExplorationRoleSchema>;

export const StrategyExplorationExpectedCostSchema = z.enum(["low", "medium", "high"]);
export type StrategyExplorationExpectedCost = z.infer<typeof StrategyExplorationExpectedCostSchema>;

export const StrategyLineageRelationshipSchema = z.enum([
  "current_best",
  "neighbor",
  "failed_lineage",
  "different_mechanism",
  "different_assumption",
  "unknown",
]);
export type StrategyLineageRelationship = z.infer<typeof StrategyLineageRelationshipSchema>;

export const StrategySmokeStatusSchema = z.enum([
  "not_run",
  "promote",
  "defer",
  "retire",
]);
export type StrategySmokeStatus = z.infer<typeof StrategySmokeStatusSchema>;

export const StrategySmokeMetadataSchema = z.object({
  status: StrategySmokeStatusSchema.default("not_run"),
  reason: z.string().min(1).optional(),
  evidence_ref: z.string().min(1).optional(),
}).strict();
export type StrategySmokeMetadata = z.infer<typeof StrategySmokeMetadataSchema>;

export const StrategyLineageAssessmentSchema = z.object({
  schema_version: z.literal("strategy-lineage-assessment-v1").default("strategy-lineage-assessment-v1"),
  confidence: StrategyUnitIntervalSchema,
  relationship_to_lineage: StrategyLineageRelationshipSchema,
  novelty_basis: z.enum([
    "typed_lineage_evidence",
    "strategy_metadata",
    "metric_trend_context",
    "smoke_evidence",
    "diagnostic_text_overlap",
    "unknown",
  ]),
  matched_failed_lineage_fingerprints: z.array(z.string().min(1)).default([]),
  matched_strategy_ids: z.array(z.string().min(1)).default([]),
  evidence_refs: z.array(z.string().min(1)).default([]),
  metric_trend: z.enum(["improving", "stalled", "noisy", "regressing", "breakthrough"]).optional(),
  lexical_similarity_diagnostic: StrategyUnitIntervalSchema.optional(),
  summary: z.string().min(1),
}).strict();
export type StrategyLineageAssessment = z.infer<typeof StrategyLineageAssessmentSchema>;

export const StrategyPlannerHintTraceSchema = z.object({
  source: z.enum(["dream_template_typed_applicability", "dream_template_embedding"]),
  source_id: z.string().min(1),
  confidence: StrategyUnitIntervalSchema,
  lexical_overlap_used: z.boolean(),
  matched_dimensions: z.array(z.string()).default([]),
  evidence_refs: z.array(z.string().min(1)).default([]),
}).strict();
export type StrategyPlannerHintTrace = z.infer<typeof StrategyPlannerHintTraceSchema>;

export const StrategyExplorationMetadataSchema = z.object({
  schema_version: z.literal("strategy-exploration-v1").default("strategy-exploration-v1"),
  phase: z.enum(["normal", "divergent_stall_recovery"]).default("normal"),
  role: StrategyExplorationRoleSchema,
  strategy_family: z.string().min(1),
  novelty_score: StrategyUnitIntervalSchema,
  similarity_to_recent_failures: StrategyUnitIntervalSchema.default(0),
  expected_cost: StrategyExplorationExpectedCostSchema,
  relationship_to_lineage: StrategyLineageRelationshipSchema,
  prior_evidence: z.string().min(1).optional(),
  downrank_reason: z.string().min(1).optional(),
  smoke: StrategySmokeMetadataSchema.default({ status: "not_run" }),
  speculative: z.literal(true).default(true),
  evidence_authority: z.literal("speculative_hypothesis").default("speculative_hypothesis"),
  lineage_assessment: StrategyLineageAssessmentSchema.optional(),
}).strict();
export type StrategyExplorationMetadata = z.infer<typeof StrategyExplorationMetadataSchema>;

// --- Strategy ---

export const StrategySchema = z.object({
  id: z.string(),
  goal_id: z.string(),
  target_dimensions: z.array(z.string()),
  primary_dimension: z.string(),

  hypothesis: z.string(),
  expected_effect: z.array(ExpectedEffectSchema),
  resource_estimate: ResourceEstimateSchema,

  state: StrategyStateEnum.default("candidate"),
  allocation: StrategyUnitIntervalSchema.default(0),

  created_at: z.string(),
  started_at: z.string().nullable().default(null),
  completed_at: z.string().nullable().default(null),

  gap_snapshot_at_start: StrategyNonnegativeFiniteNumberSchema.nullable().default(null),
  tasks_generated: z.array(z.string()).default([]),
  effectiveness_score: StrategyFiniteNumberSchema.nullable().default(null),
  consecutive_stall_count: StrategySafeNonnegativeIntSchema.default(0),

  // Stage 14: Cross-goal strategy fields
  source_template_id: z.string().nullable().default(null),
  cross_goal_context: z.string().nullable().default(null),

  // M14-S2: Structured PIVOT/REFINE/ESCALATE fields
  rollback_target_id: z.string().nullable().default(null),
  max_pivot_count: StrategySafeNonnegativeIntSchema.default(2),
  pivot_count: StrategySafeNonnegativeIntSchema.default(0),

  // Toolset immutability: snapshot tools at strategy activation
  toolset_locked: z.boolean().default(false),
  allowed_tools: z.array(z.string()).default([]),

  // Tool availability scoring: tools required by this strategy candidate
  required_tools: z.array(z.string()).default([]),

  // Curiosity-driven stall recovery metadata. Speculative unless promoted by smoke evidence.
  exploration: StrategyExplorationMetadataSchema.nullable().optional(),

  // Provenance for advisory/materialized planner hints that shaped this candidate.
  planner_hint_trace: StrategyPlannerHintTraceSchema.optional(),
});
export type Strategy = z.infer<typeof StrategySchema>;

// --- WaitStrategy ---

export const WaitStrategySchema = StrategySchema.extend({
  wait_reason: z.string(),
  wait_until: z.string(),
  measurement_plan: z.string(),
  fallback_strategy_id: z.string().nullable(),
});
export type WaitStrategy = z.infer<typeof WaitStrategySchema>;

export const TimeUntilWaitConditionSchema = z.object({
  type: z.literal("time_until"),
  until: z.string(),
});

export const FileExistsWaitConditionSchema = z.object({
  type: z.literal("file_exists"),
  path: z.string(),
});

export const FileMtimeChangedWaitConditionSchema = z.object({
  type: z.literal("file_mtime_changed"),
  path: z.string(),
  previous_mtime_ms: StrategySafeNonnegativeNumberSchema,
});

export const ProcessSessionExitedWaitConditionSchema = z.object({
  type: z.literal("process_session_exited"),
  session_id: z.string(),
});

export const ArtifactJsonValueWaitConditionSchema = z.object({
  type: z.literal("artifact_json_value"),
  path: z.string(),
  json_pointer: z.string(),
  expected: z.unknown(),
});

export const MetricThresholdWaitConditionSchema = z.object({
  type: z.literal("metric_threshold"),
  metric: z.string(),
  operator: z.enum(["lt", "lte", "eq", "gte", "gt"]),
  value: StrategyFiniteNumberSchema,
});

export const WaitConditionSchema = z.discriminatedUnion("type", [
  TimeUntilWaitConditionSchema,
  FileExistsWaitConditionSchema,
  FileMtimeChangedWaitConditionSchema,
  ProcessSessionExitedWaitConditionSchema,
  ArtifactJsonValueWaitConditionSchema,
  MetricThresholdWaitConditionSchema,
]);
export type WaitCondition = z.infer<typeof WaitConditionSchema>;

export const WaitObservationResultSchema = z.object({
  status: z.enum(["pending", "satisfied", "stale", "failed", "expired"]),
  evidence: z.record(z.string(), z.unknown()).default({}),
  next_observe_at: z.string().nullable().default(null),
  confidence: StrategyUnitIntervalSchema.default(0),
  resume_hint: z.string().nullable().default(null),
});
export type WaitObservationResult = z.infer<typeof WaitObservationResultSchema>;

export const WaitResumePlanSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("continue_strategy") }),
  z.object({ action: z.literal("activate_fallback"), strategy_id: z.string() }),
  z.object({ action: z.literal("request_approval"), reason: z.string().nullable().default(null) }),
  z.object({ action: z.literal("complete_wait") }),
  z.object({ action: z.literal("generate_task"), prompt: z.string().nullable().default(null) }),
]);
export type WaitResumePlan = z.infer<typeof WaitResumePlanSchema>;

export const WaitMetadataSchema = z.object({
  schema_version: z.literal(1).default(1),
  wait_until: z.string(),
  conditions: z.array(WaitConditionSchema).default([]),
  resume_plan: WaitResumePlanSchema.default({ action: "complete_wait" }),
  process_refs: z.array(z.record(z.string(), z.unknown())).default([]),
  artifact_refs: z.array(z.record(z.string(), z.unknown())).default([]),
  approval_policy: z.record(z.string(), z.unknown()).nullable().default(null),
  next_observe_at: z.string().nullable().default(null),
  latest_observation: WaitObservationResultSchema.nullable().default(null),
}).passthrough();
export type WaitMetadata = z.infer<typeof WaitMetadataSchema>;

export const WaitExpiryOutcomeStatusSchema = z.enum([
  "not_due",
  "improved",
  "unchanged",
  "worsened",
  "unknown",
  "fallback_activated",
  "approval_required",
]);
export type WaitExpiryOutcomeStatus = z.infer<typeof WaitExpiryOutcomeStatusSchema>;

export interface WaitExpiryOutcome {
  status: WaitExpiryOutcomeStatus;
  goal_id: string;
  strategy_id: string;
  details?: string;
  rebalance_trigger?: RebalanceTrigger;
}

export function waitConditionFromWaitUntil(waitUntil: string): WaitCondition {
  return { type: "time_until", until: waitUntil };
}

export function buildDefaultWaitMetadata(waitStrategy: WaitStrategy): WaitMetadata {
  return WaitMetadataSchema.parse({
    schema_version: 1,
    wait_until: waitStrategy.wait_until,
    conditions: [waitConditionFromWaitUntil(waitStrategy.wait_until)],
    resume_plan: waitStrategy.fallback_strategy_id
      ? { action: "activate_fallback", strategy_id: waitStrategy.fallback_strategy_id }
      : { action: "complete_wait" },
  });
}

export function normalizeWaitMetadata(waitStrategy: WaitStrategy, data: unknown): WaitMetadata {
  const fallback = buildDefaultWaitMetadata(waitStrategy);
  const raw = data && typeof data === "object" ? data as Record<string, unknown> : {};
  return WaitMetadataSchema.parse({
    ...raw,
    schema_version: 1,
    wait_until: typeof raw["wait_until"] === "string" ? raw["wait_until"] : fallback.wait_until,
    conditions: Array.isArray(raw["conditions"]) && raw["conditions"].length > 0
      ? raw["conditions"]
      : fallback.conditions,
    resume_plan: raw["resume_plan"] ?? fallback.resume_plan,
  });
}

export function resolveWaitNextObserveAt(
  waitStrategy: WaitStrategy,
  metadata: WaitMetadata
): string | null {
  const explicitNextObserveAt = validWaitDateString(metadata.next_observe_at)
    ?? validWaitDateString(metadata.latest_observation?.next_observe_at);
  if (explicitNextObserveAt) return explicitNextObserveAt;

  const candidates = [
    ...metadata.conditions.map((condition) => waitConditionDeadline(condition)),
    waitStrategy.wait_until,
  ].filter((value): value is string => validWaitDateString(value) !== null);

  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
}

function waitConditionDeadline(condition: WaitCondition): string | null {
  if (condition.type === "time_until") return condition.until;
  return null;
}

function validWaitDateString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  if (!Number.isFinite(Date.parse(value))) return null;
  return value;
}

// --- Parse Helpers ---

/**
 * Parse a strategy object, preserving WaitStrategy extension fields.
 * Uses duck-typing: if the object has wait_reason or wait_until fields,
 * it is parsed as a WaitStrategy; otherwise as a plain Strategy.
 * Use this instead of StrategySchema.parse() to avoid stripping WaitStrategy fields.
 */
export function parseStrategy(data: unknown): Strategy | WaitStrategy {
  const obj = data as Record<string, unknown>;
  if (obj && (obj['wait_reason'] !== undefined || obj['wait_until'] !== undefined)) {
    return WaitStrategySchema.parse(data);
  }
  return StrategySchema.parse(data);
}

export function parseStrategies(data: unknown[]): (Strategy | WaitStrategy)[] {
  return data.map(d => parseStrategy(d));
}


// --- Portfolio ---

export const PortfolioSchema = z.object({
  goal_id: z.string(),
  strategies: z.array(z.unknown()).transform(items => items.map(item => parseStrategy(item))),
  rebalance_interval: DurationSchema,
  last_rebalanced_at: z.string(),
});
export type Portfolio = z.infer<typeof PortfolioSchema>;
