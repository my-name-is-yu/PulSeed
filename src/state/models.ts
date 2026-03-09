import { z } from 'zod';
import { randomUUID } from 'node:crypto';

// Enums
export const ObservationSource = z.enum(['tool_output', 'llm_estimate', 'user_input']);
export type ObservationSource = z.infer<typeof ObservationSource>;

export const GoalType = z.enum(['deadline', 'dissatisfaction', 'opportunity']);
export type GoalType = z.infer<typeof GoalType>;

export const GoalStatus = z.enum(['active', 'completed', 'paused', 'abandoned']);
export type GoalStatus = z.infer<typeof GoalStatus>;

// State Vector Element
export const StateVectorElement = z.object({
  value: z.number(),
  confidence: z.number().min(0).max(1),
  observed_at: z.string().default(() => new Date().toISOString()),
  source: ObservationSource.default('llm_estimate'),
  observation_method: z.string().default(''),
});
export type StateVectorElement = z.infer<typeof StateVectorElement>;

// Gap
export const Gap = z.object({
  dimension: z.string(),
  current: z.number(),
  target: z.number(),
  magnitude: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
});
export type Gap = z.infer<typeof Gap>;

// Motivation Breakdown
export const MotivationBreakdown = z.object({
  deadline_pressure: z.number().default(0),
  dissatisfaction: z.number().default(0),
  opportunity: z.number().default(0),
});
export type MotivationBreakdown = z.infer<typeof MotivationBreakdown>;

// Goal Constraints
export const GoalConstraints = z.object({
  max_generation_depth: z.number().default(3),
  max_subtasks: z.number().default(10),
  distance_filter: z.number().default(0.7),
});
export type GoalConstraints = z.infer<typeof GoalConstraints>;

// Goal
export const Goal = z.object({
  id: z.string().default(() => `goal-${randomUUID().slice(0, 8)}`),
  title: z.string(),
  description: z.string().default(''),
  type: GoalType.default('dissatisfaction'),
  achievement_thresholds: z.record(z.string(), z.number()).default({ progress: 0.9 }),
  deadline: z.string().nullable().default(null),
  state_vector: z.record(z.string(), StateVectorElement).default({}),
  gaps: z.array(Gap).default([]),
  motivation_score: z.number().default(0),
  motivation_breakdown: MotivationBreakdown.default({}),
  constraints: GoalConstraints.default({}),
  status: GoalStatus.default('active'),
  created_at: z.string().default(() => new Date().toISOString()),
  parent_goal_id: z.string().nullable().default(null),
});
export type Goal = z.infer<typeof Goal>;

// Trust Balance
export const TrustBalance = z.object({
  global: z.number().min(0).max(1).default(0.7),
  per_goal: z.record(z.string(), z.number()).default({}),
});
export type TrustBalance = z.infer<typeof TrustBalance>;

export function updateTrustSuccess(trust: TrustBalance, goalId?: string, irreversible = false): void {
  const delta = irreversible ? 0.1 : 0.05;
  trust.global = Math.min(1.0, trust.global + delta);
  if (goalId && goalId in trust.per_goal) {
    trust.per_goal[goalId] = Math.min(1.0, trust.per_goal[goalId] + delta);
  }
}

export function updateTrustFailure(trust: TrustBalance, goalId?: string, irreversible = false): void {
  const delta = irreversible ? 0.3 : 0.15;
  trust.global = Math.max(0.0, trust.global - delta);
  if (goalId && goalId in trust.per_goal) {
    trust.per_goal[goalId] = Math.max(0.0, trust.per_goal[goalId] - delta);
  }
}

// Activation Conditions
export const ActivationConditions = z.object({
  idle_threshold_seconds: z.number().default(30),
  anomaly_threshold: z.number().default(0.7),
  retry_failed_after_hours: z.number().default(24),
});
export type ActivationConditions = z.infer<typeof ActivationConditions>;

// Meta Motivation
export const MetaMotivation = z.object({
  curiosity_targets: z.array(z.string()).default([]),
  exploration_budget: z.number().default(3),
  activation_conditions: ActivationConditions.default({}),
});
export type MetaMotivation = z.infer<typeof MetaMotivation>;

// Stall State
export const StallState = z.object({
  consecutive_failures: z.record(z.string(), z.number()).default({}),
  last_stall_at: z.string().nullable().default(null),
  stall_count: z.number().default(0),
});
export type StallState = z.infer<typeof StallState>;

// Top-level Motive State
export const MotiveState = z.object({
  version: z.string().default('1.0.0'),
  session_id: z.string().default(() => randomUUID()),
  last_updated: z.string().default(() => new Date().toISOString()),
  active_goal_ids: z.array(z.string()).default([]),
  global_constraints: z.record(z.string(), z.unknown()).default({}),
  trust_balance: TrustBalance.default({}),
  meta_motivation: MetaMotivation.default({}),
  stall_state: StallState.default({}),
});
export type MotiveState = z.infer<typeof MotiveState>;
