import { z } from "zod";

export const KaggleMetricDirectionSchema = z.enum(["maximize", "minimize"]);
export type KaggleMetricDirection = z.infer<typeof KaggleMetricDirectionSchema>;

export const KaggleMetricsSchema = z.object({
  experiment_id: z.string().min(1),
  competition: z.string().min(1),
  metric_name: z.string().min(1),
  direction: KaggleMetricDirectionSchema,
  cv_score: z.number().finite(),
  cv_std: z.number().finite().nullable(),
  holdout_score: z.number().finite().nullable(),
  train_rows: z.number().int().nonnegative(),
  valid_rows: z.number().int().nonnegative(),
  seed: z.number().int(),
  created_at: z.string().datetime(),
  status: z.enum(["running", "completed", "failed"]),
  artifacts: z.object({
    model: z.string().min(1).optional(),
    submission: z.string().min(1).optional(),
    log: z.string().min(1),
  }).strict(),
}).strict();

export type KaggleMetrics = z.infer<typeof KaggleMetricsSchema>;

export type KaggleMetricParseResult = {
  ok: true;
  metrics: KaggleMetrics;
} | {
  ok: false;
  reason: "missing" | "malformed";
  message: string;
  issues?: string[];
};

export interface MetricThresholdHint {
  wait_condition_type: "metric_threshold";
  metric: string;
  operator: "gte" | "lte";
  value_required: true;
  metric_source: "wait_metadata.metrics";
  hint: string;
}

export function metricThresholdHintForDirection(
  metricName: string,
  direction: KaggleMetricDirection,
): MetricThresholdHint {
  const operator = direction === "maximize" ? "gte" : "lte";
  return {
    wait_condition_type: "metric_threshold",
    metric: metricName,
    operator,
    value_required: true,
    metric_source: "wait_metadata.metrics",
    hint: `${direction} ${metricName}: use metric_threshold operator ${operator} with a caller-supplied numeric threshold.`,
  };
}

export function parseKaggleMetrics(value: unknown): KaggleMetricParseResult {
  const parsed = KaggleMetricsSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, metrics: parsed.data };
  }
  return {
    ok: false,
    reason: "malformed",
    message: "metrics.json does not match the strict Kaggle metrics schema",
    issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
  };
}

export function normalizedMetricScore(metrics: KaggleMetrics): number {
  return metrics.direction === "maximize" ? metrics.cv_score : -metrics.cv_score;
}

export function compareMetricScores(a: KaggleMetrics, b: KaggleMetrics): number {
  return normalizedMetricScore(b) - normalizedMetricScore(a);
}
