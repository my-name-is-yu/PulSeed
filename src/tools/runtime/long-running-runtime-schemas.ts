import { z } from "zod/v3";

export const LongRunningStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "blocked",
  "unknown",
]);
export type LongRunningStatus = z.infer<typeof LongRunningStatusSchema>;

export const LongRunningNextActionTypeSchema = z.enum([
  "continue",
  "retry",
  "investigate",
  "wait",
  "stop",
  "ask_user",
]);
export type LongRunningNextActionType = z.infer<typeof LongRunningNextActionTypeSchema>;

export const LongRunningNextActionSchema = z.object({
  type: LongRunningNextActionTypeSchema,
  summary: z.string().min(1),
  reason: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  due_at: z.string().datetime().optional(),
  owner: z.string().min(1).optional(),
}).strict();
export type LongRunningNextAction = z.infer<typeof LongRunningNextActionSchema>;

export const LongRunningArtifactRefSchema = z.object({
  label: z.string().min(1),
  path: z.string().min(1).optional(),
  state_relative_path: z.string().min(1).optional(),
  url: z.string().url().optional(),
  kind: z.enum(["log", "metrics", "report", "diff", "url", "other"]).default("other"),
}).strict();
export type LongRunningArtifactRef = z.infer<typeof LongRunningArtifactRefSchema>;

export const LongRunningEvidenceSchema = z.object({
  kind: z.enum(["metric", "log", "artifact", "observation", "error", "other"]),
  label: z.string().min(1),
  value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]).optional(),
  unit: z.string().min(1).optional(),
  direction: z.enum(["maximize", "minimize"]).optional(),
  path: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
}).strict();
export type LongRunningEvidence = z.infer<typeof LongRunningEvidenceSchema>;

export const LongRunningResultSchema = z.object({
  schema_version: z.literal("long-running-result-v1"),
  objective: z.string().min(1),
  status: LongRunningStatusSchema,
  evidence: z.array(LongRunningEvidenceSchema).default([]),
  artifacts: z.array(LongRunningArtifactRefSchema).default([]),
  failures: z.array(z.string().min(1)).default([]),
  next_action: LongRunningNextActionSchema,
  source: z.object({
    kind: z.string().min(1).default("manual"),
    path: z.string().min(1).optional(),
    process_session_id: z.string().min(1).optional(),
    background_run_id: z.string().min(1).optional(),
  }).strict().default({ kind: "manual" }),
  created_at: z.string().datetime(),
}).strict();
export type LongRunningResult = z.infer<typeof LongRunningResultSchema>;

export const RuntimeReportWriteInputSchema = z.object({
  objective: z.string().min(1).optional(),
  status: LongRunningStatusSchema.optional(),
  evidence: z.array(LongRunningEvidenceSchema).optional(),
  artifacts: z.array(LongRunningArtifactRefSchema).optional(),
  failures: z.array(z.string().min(1)).optional(),
  next_action: LongRunningNextActionSchema.optional(),
  result_json_path: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  process_session_id: z.string().min(1).optional(),
  background_run_id: z.string().min(1).optional(),
}).strict();
export type RuntimeReportWriteInput = z.infer<typeof RuntimeReportWriteInputSchema>;

export const RuntimeResultNormalizeInputSchema = z.object({
  objective: z.string().min(1),
  source_json_path: z.string().min(1).optional(),
  value: z.unknown().optional(),
  profile: z.enum(["generic", "kaggle_metrics"]).default("generic"),
  status: LongRunningStatusSchema.optional(),
  metric_name: z.string().min(1).optional(),
  metric_direction: z.enum(["maximize", "minimize"]).optional(),
  next_action: LongRunningNextActionSchema.optional(),
  run_id: z.string().min(1).optional(),
  process_session_id: z.string().min(1).optional(),
  background_run_id: z.string().min(1).optional(),
}).strict().refine((input) => input.source_json_path || input.value !== undefined, {
  message: "source_json_path or value is required",
});
export type RuntimeResultNormalizeInput = z.infer<typeof RuntimeResultNormalizeInputSchema>;

export const WorkspaceImportInputSchema = z.object({
  source_path: z.string().min(1),
  workspace_id: z.string().min(1).optional(),
  overwrite: z.boolean().default(false),
}).strict();
export type WorkspaceImportInput = z.infer<typeof WorkspaceImportInputSchema>;
