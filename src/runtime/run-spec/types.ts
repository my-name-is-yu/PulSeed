import { z } from "zod/v3";
import type { ILLMClient } from "../../base/llm/llm-client.js";

export const RunSpecProfileSchema = z.enum(["generic", "kaggle"]);
export type RunSpecProfile = z.infer<typeof RunSpecProfileSchema>;

export const RunSpecIdSchema = z.string().regex(
  /^runspec-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
);
export type RunSpecId = z.infer<typeof RunSpecIdSchema>;

export const RunSpecMetricDirectionSchema = z.enum(["maximize", "minimize", "unknown"]);
export type RunSpecMetricDirection = z.infer<typeof RunSpecMetricDirectionSchema>;

export const RunSpecConfidenceSchema = z.enum(["high", "medium", "low"]);
export type RunSpecConfidence = z.infer<typeof RunSpecConfidenceSchema>;

export const RunSpecFiniteScalarSchema = z.number().finite().refine(
  (value) => !Number.isInteger(value) || Number.isSafeInteger(value),
  { message: "Integer scalar must be within Number safe integer range" },
);
export const RunSpecRankPercentSchema = z.number().finite().min(0).max(100);
export const RunSpecConfidenceValueSchema = z.number().finite().min(0).max(1);
export const RunSpecSafeNonnegativeIntSchema = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const RunSpecSafePositiveIntSchema = z.number().finite().int().positive().max(Number.MAX_SAFE_INTEGER);

export const RunSpecMissingFieldSchema = z.object({
  field: z.string(),
  question: z.string(),
  severity: z.enum(["required", "confirmation"]),
});
export type RunSpecMissingField = z.infer<typeof RunSpecMissingFieldSchema>;

export const RunSpecWorkspaceSchema = z.object({
  path: z.string(),
  source: z.enum(["user", "context"]),
  confidence: RunSpecConfidenceSchema,
});
export type RunSpecWorkspace = z.infer<typeof RunSpecWorkspaceSchema>;

export const RunSpecExecutionTargetSchema = z.object({
  kind: z.enum(["local", "daemon", "remote"]),
  remote_host: z.string().nullable(),
  confidence: RunSpecConfidenceSchema,
});
export type RunSpecExecutionTarget = z.infer<typeof RunSpecExecutionTargetSchema>;

export const RunSpecMetricSchema = z.object({
  name: z.string(),
  direction: RunSpecMetricDirectionSchema,
  target: RunSpecFiniteScalarSchema.nullable(),
  target_rank_percent: RunSpecRankPercentSchema.nullable(),
  datasource: z.string().nullable(),
  confidence: RunSpecConfidenceSchema,
});
export type RunSpecMetric = z.infer<typeof RunSpecMetricSchema>;

export const RunSpecProgressContractSchema = z.object({
  kind: z.enum(["metric_target", "rank_percentile", "deadline_only", "open_ended", "unknown"]),
  dimension: z.string().nullable(),
  threshold: RunSpecFiniteScalarSchema.nullable(),
  semantics: z.string(),
  confidence: RunSpecConfidenceSchema,
});
export type RunSpecProgressContract = z.infer<typeof RunSpecProgressContractSchema>;

export const RunSpecDeadlineSchema = z.object({
  raw: z.string(),
  iso_at: z.string().nullable(),
  timezone: z.string().nullable(),
  finalization_buffer_minutes: RunSpecSafeNonnegativeIntSchema.nullable(),
  confidence: RunSpecConfidenceSchema,
});
export type RunSpecDeadline = z.infer<typeof RunSpecDeadlineSchema>;

export const RunSpecBudgetSchema = z.object({
  max_trials: RunSpecSafePositiveIntSchema.nullable(),
  max_wall_clock_minutes: RunSpecSafeNonnegativeIntSchema.nullable(),
  resident_policy: z.enum(["until_deadline", "best_effort", "unknown"]),
});
export type RunSpecBudget = z.infer<typeof RunSpecBudgetSchema>;

export const RunSpecApprovalPolicySchema = z.object({
  submit: z.enum(["approval_required", "allowed", "disallowed", "unspecified"]),
  publish: z.enum(["approval_required", "allowed", "disallowed", "unspecified"]),
  secret: z.enum(["approval_required", "disallowed", "unspecified"]),
  external_action: z.enum(["approval_required", "allowed", "disallowed", "unspecified"]),
  irreversible_action: z.enum(["approval_required", "disallowed", "unspecified"]),
});
export type RunSpecApprovalPolicy = z.infer<typeof RunSpecApprovalPolicySchema>;

export const RunSpecArtifactContractSchema = z.object({
  expected_artifacts: z.array(z.string()),
  discovery_globs: z.array(z.string()),
  primary_outputs: z.array(z.string()),
});
export type RunSpecArtifactContract = z.infer<typeof RunSpecArtifactContractSchema>;

export const RunSpecLinksSchema = z.object({
  goal_id: z.string().nullable(),
  runtime_session_id: z.string().nullable(),
  conversation_id: z.string().nullable(),
});
export type RunSpecLinks = z.infer<typeof RunSpecLinksSchema>;

export const RunSpecOriginSchema = z.object({
  channel: z.string().nullable(),
  session_id: z.string().nullable(),
  reply_target: z.record(z.string(), z.unknown()).nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
export type RunSpecOrigin = z.infer<typeof RunSpecOriginSchema>;

export const RunSpecSchema = z.object({
  schema_version: z.literal("run-spec-v1"),
  id: RunSpecIdSchema,
  status: z.enum(["draft", "confirmed", "cancelled", "attached"]),
  profile: RunSpecProfileSchema,
  source_text: z.string(),
  objective: z.string(),
  workspace: RunSpecWorkspaceSchema.nullable(),
  execution_target: RunSpecExecutionTargetSchema,
  metric: RunSpecMetricSchema.nullable(),
  progress_contract: RunSpecProgressContractSchema,
  deadline: RunSpecDeadlineSchema.nullable(),
  budget: RunSpecBudgetSchema,
  approval_policy: RunSpecApprovalPolicySchema,
  artifact_contract: RunSpecArtifactContractSchema,
  risk_flags: z.array(z.string()),
  missing_fields: z.array(RunSpecMissingFieldSchema),
  confidence: RunSpecConfidenceSchema,
  links: RunSpecLinksSchema,
  origin: RunSpecOriginSchema,
  created_at: z.string(),
  updated_at: z.string(),
});
export type RunSpec = z.infer<typeof RunSpecSchema>;

export interface RunSpecDerivationContext {
  cwd?: string;
  conversationId?: string | null;
  channel?: string | null;
  sessionId?: string | null;
  replyTarget?: Record<string, unknown> | null;
  originMetadata?: Record<string, unknown>;
  now?: Date;
  timezone?: string;
  llmClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">;
}
