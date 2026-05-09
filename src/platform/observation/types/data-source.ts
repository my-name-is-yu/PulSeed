import { z } from "zod";

// --- DataSourceType ---

export const DataSourceTypeEnum = z.enum(["file", "http_api", "database", "custom", "github_issue", "file_existence", "shell", "artifact_metric", "websocket", "sse", "mcp"]);
export type DataSourceType = z.infer<typeof DataSourceTypeEnum>;

// --- PollingConfig ---

const PositiveSafeIntegerSchema = z.number().finite().int().positive().safe();
const NonNegativeUnitIntervalSchema = z.number().finite().min(0).max(1);

export const ShellDataSourceCommandSchema = z.object({
  argv: z.array(z.string()).nonempty(),
  output_type: z.enum(["number", "boolean", "raw"]),
  cwd: z.string().optional(),
  timeout_ms: PositiveSafeIntegerSchema.optional(),
}).strict();
export type ShellDataSourceCommand = z.infer<typeof ShellDataSourceCommandSchema>;

export const PollingConfigSchema = z.object({
  interval_ms: PositiveSafeIntegerSchema.min(30000),
  change_threshold: NonNegativeUnitIntervalSchema.optional(),
});
export type PollingConfig = z.infer<typeof PollingConfigSchema>;

// --- DataSourceConfig ---

export const DataSourceConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: DataSourceTypeEnum,
  connection: z.object({
    path: z.string().optional(),
    repo: z.string().optional(),
    url: z.string().optional(),
    method: z.enum(["GET", "POST"]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body_template: z.string().optional(),
    commands: z.record(z.string(), ShellDataSourceCommandSchema).optional(),
    metric_file_names: z.array(z.string()).optional(),
    artifact_roots: z.array(z.string()).optional(),
    include_paths: z.array(z.string()).optional(),
    parser_hints: z.array(z.string()).optional(),
    exclude_dirs: z.array(z.string()).optional(),
    exclude_paths: z.array(z.string()).optional(),
    max_metric_files: PositiveSafeIntegerSchema.optional(),
    max_artifact_files: PositiveSafeIntegerSchema.optional(),
    max_candidates: PositiveSafeIntegerSchema.optional(),
    stale_after_ms: PositiveSafeIntegerSchema.optional(),
    fresh_after_time: z.string().datetime().optional(),
    freshness_scope: z.enum(["none", "goal", "task", "run"]).optional(),
    freshness_scope_id: z.string().optional(),
    current_progress_policy: z.enum(["legacy", "completed_fresh_only", "allow_live"]).optional(),
    dimension_metrics: z.record(z.string(), z.array(z.string())).optional(),
    dimension_aggregations: z.record(z.string(), z.enum(["max", "min", "count", "file_count"])).optional(),
    require_metric_match: z.boolean().optional(),
  }),
  polling: PollingConfigSchema.optional(),
  auth: z
    .object({
      type: z.enum(["none", "api_key", "basic", "bearer"]),
      secret_ref: z.string().optional(),
    })
    .optional(),
  enabled: z.boolean().default(true),
  created_at: z.string(),
  dimension_mapping: z.record(z.string(), z.string()).optional(),
  scope_goal_id: z.string().optional(),
  connection_string: z.string().optional(),
});
export type DataSourceConfig = z.infer<typeof DataSourceConfigSchema>;

// --- DataSourceQuery ---

export const DataSourceQuerySchema = z.object({
  dimension_name: z.string(),
  expression: z.string().optional(),
  timeout_ms: PositiveSafeIntegerSchema.default(10000),
});
export type DataSourceQuery = z.infer<typeof DataSourceQuerySchema>;

// --- DataSourceResult ---

export const DataSourceResultSchema = z.object({
  value: z.union([z.number().finite(), z.string(), z.boolean(), z.null()]),
  raw: z.unknown(),
  timestamp: z.string(),
  source_id: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type DataSourceResult = z.infer<typeof DataSourceResultSchema>;

// --- DataSourceRegistry ---

export const DataSourceRegistrySchema = z.object({
  sources: z.array(DataSourceConfigSchema),
});
export type DataSourceRegistry = z.infer<typeof DataSourceRegistrySchema>;
