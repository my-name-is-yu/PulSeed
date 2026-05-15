import { z } from "zod/v3";

export const KaggleMetricDirectionSchema = z.enum(["maximize", "minimize"]);
export type KaggleMetricDirection = z.infer<typeof KaggleMetricDirectionSchema>;

export const KAGGLE_VALIDATION_CHECKLIST = [
  "competition_metric_from_rules",
  "cv_split_strategy_declared",
  "oof_predictions_present_and_leak_checked",
  "target_encoding_and_stacking_are_oof_only",
  "seed_or_fold_stability_recorded",
  "train_test_drift_checked",
  "submission_portfolio_slot_declared",
  "final_report_separates_local_cv_public_lb_private_uncertainty",
] as const;

const KaggleValidationCompetitionMetricSchema = z.object({
    name: z.string().min(1),
    direction: KaggleMetricDirectionSchema,
    source: z.enum(["competition_rules", "inferred", "manual"]).default("manual"),
  }).strict();
const KaggleValidationCvSchema = z.object({
    strategy: z.string().min(1),
    fold_count: z.number().int().positive().optional(),
    repeated_seed_count: z.number().int().positive().optional(),
    stratified: z.boolean().optional(),
    group_aware: z.boolean().optional(),
    time_aware: z.boolean().optional(),
  }).strict();
const KaggleValidationOofSchema = z.object({
    present: z.boolean(),
    path: z.string().min(1).optional(),
    rows: z.number().int().nonnegative().optional(),
    coverage: z.number().min(0).max(1).optional(),
    leak_checked: z.boolean().optional(),
  }).strict();
const KaggleValidationLeakChecksSchema = z.object({
    target_encoding_oof_only: z.boolean().optional(),
    stacking_oof_only: z.boolean().optional(),
    train_test_boundary_checked: z.boolean().optional(),
    duplicate_or_id_leak_checked: z.boolean().optional(),
    notes: z.array(z.string().min(1)).default([]),
  }).strict();
const KaggleValidationStabilitySchema = z.object({
    repeated_seed_count: z.number().int().positive().optional(),
    fold_score_min: z.number().finite().optional(),
    fold_score_max: z.number().finite().optional(),
    seed_score_std: z.number().finite().nonnegative().optional(),
  }).strict();
const KaggleValidationTrainTestDriftSchema = z.object({
    checked: z.boolean(),
    adversarial_validation_auc: z.number().min(0).max(1).optional(),
    summary: z.string().min(1).optional(),
  }).strict();
const KaggleValidationPublicLeaderboardSchema = z.object({
    score: z.number().finite().optional(),
    submission_id: z.string().min(1).optional(),
    observed_at: z.string().datetime().optional(),
    notes: z.string().min(1).optional(),
  }).strict();

export const KaggleValidationContractSchema = z.object({
  competition_metric: KaggleValidationCompetitionMetricSchema.optional(),
  cv: KaggleValidationCvSchema.optional(),
  oof: KaggleValidationOofSchema.optional(),
  leak_checks: KaggleValidationLeakChecksSchema.optional(),
  stability: KaggleValidationStabilitySchema.optional(),
  train_test_drift: KaggleValidationTrainTestDriftSchema.optional(),
  public_leaderboard: KaggleValidationPublicLeaderboardSchema.optional(),
}).strict();
export type KaggleValidationContract = z.infer<typeof KaggleValidationContractSchema>;

export const KaggleLongRunValidationContractSchema = KaggleValidationContractSchema.superRefine((contract, ctx) => {
  if (!contract.competition_metric) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "competition_metric is required before starting a Kaggle long run", path: ["competition_metric"] });
  }
  if (!contract.cv) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cv split strategy is required before starting a Kaggle long run", path: ["cv"] });
  } else if ((contract.cv.fold_count ?? 0) < 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cv.fold_count must declare at least two folds before starting a Kaggle long run", path: ["cv", "fold_count"] });
  }
  if (!contract.oof) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "OOF generation contract is required before starting a Kaggle long run", path: ["oof"] });
  } else {
    if (contract.oof.present !== true) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "OOF predictions must be planned before starting a Kaggle long run", path: ["oof", "present"] });
    }
    if (contract.oof.leak_checked !== true) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "OOF leakage check must be required before starting a Kaggle long run", path: ["oof", "leak_checked"] });
    }
  }
  if (!contract.leak_checks) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "leak-check contract is required before starting a Kaggle long run", path: ["leak_checks"] });
  } else {
    const requiredChecks: Array<[keyof NonNullable<KaggleValidationContract["leak_checks"]>, string]> = [
      ["target_encoding_oof_only", "target encoding must be constrained to OOF-safe transforms"],
      ["stacking_oof_only", "stacking must be constrained to OOF-safe transforms"],
      ["train_test_boundary_checked", "train/test boundary check must be required"],
      ["duplicate_or_id_leak_checked", "duplicate/id leakage check must be required"],
    ];
    for (const [key, message] of requiredChecks) {
      if (contract.leak_checks[key] !== true) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ["leak_checks", key] });
      }
    }
  }
  if (!contract.train_test_drift) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "train/test drift contract is required before starting a Kaggle long run", path: ["train_test_drift"] });
  } else if (contract.train_test_drift.checked !== true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "train/test drift check must be required before starting a Kaggle long run", path: ["train_test_drift", "checked"] });
  }
});
export type KaggleLongRunValidationContract = z.infer<typeof KaggleLongRunValidationContractSchema>;

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
  validation: KaggleValidationContractSchema.optional(),
}).strict();

export type KaggleMetrics = z.infer<typeof KaggleMetricsSchema>;

export interface KaggleValidationDiscipline {
  oof_present: boolean;
  oof_leak_checked: boolean;
  cv_stability_available: boolean;
  cv_std: number | null;
  public_lb_score: number | null;
  public_lb_gap: number | null;
  drift_checked: boolean;
  drift_risk: "unknown" | "low" | "high";
  leak_risks: string[];
  warnings: string[];
  risk_level: "low" | "medium" | "high";
  robust_penalty: number;
}

export interface KaggleMetricsCompatibilityFallback {
  experiment_id?: string;
  competition?: string;
  created_at?: string;
  log_path?: string;
  submission_path?: string;
  model_path?: string;
}

export type KaggleMetricParseResult = {
  ok: true;
  metrics: KaggleMetrics;
  source_schema: "strict" | "loose";
  warnings: string[];
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
    return { ok: true, metrics: parsed.data, source_schema: "strict", warnings: [] };
  }
  return {
    ok: false,
    reason: "malformed",
    message: "metrics.json does not match the strict Kaggle metrics schema",
    issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
  };
}

export function parseKaggleMetricsCompatible(
  value: unknown,
  fallback: KaggleMetricsCompatibilityFallback = {},
): KaggleMetricParseResult {
  const strict = KaggleMetricsSchema.safeParse(value);
  if (strict.success) {
    return { ok: true, metrics: strict.data, source_schema: "strict", warnings: [] };
  }
  const loose = normalizeLooseKaggleMetrics(value, fallback);
  if (loose) {
    const parsed = KaggleMetricsSchema.safeParse(loose.metrics);
    if (parsed.success) {
      return {
        ok: true,
        metrics: parsed.data,
        source_schema: "loose",
        warnings: loose.warnings,
      };
    }
  }
  return {
    ok: false,
    reason: "malformed",
    message: "metrics.json does not match the strict Kaggle metrics schema or supported loose Kaggle metric schema",
    issues: strict.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
  };
}

export function normalizedMetricScore(metrics: KaggleMetrics): number {
  return metrics.direction === "maximize" ? metrics.cv_score : -metrics.cv_score;
}

export function compareMetricScores(a: KaggleMetrics, b: KaggleMetrics): number {
  return normalizedMetricScore(b) - normalizedMetricScore(a);
}

export function summarizeKaggleValidation(metrics: KaggleMetrics): KaggleValidationDiscipline {
  const warnings: string[] = [];
  const leakRisks: string[] = [];
  const validation = metrics.validation;
  const oofPresent = validation?.oof?.present ?? false;
  const oofLeakChecked = validation?.oof?.leak_checked ?? false;
  const cvStd = metrics.cv_std ?? validation?.stability?.seed_score_std ?? null;
  const publicScore = validation?.public_leaderboard?.score ?? null;
  const publicGap = publicScore === null
    ? null
    : normalizedMetricScore(metrics) - (metrics.direction === "maximize" ? publicScore : -publicScore);
  const driftAuc = validation?.train_test_drift?.adversarial_validation_auc;
  const driftChecked = validation?.train_test_drift?.checked ?? false;
  const driftRisk = !driftChecked
    ? "unknown"
    : typeof driftAuc === "number" && driftAuc >= 0.65
      ? "high"
      : "low";

  if (!oofPresent) warnings.push("OOF predictions are missing");
  if (oofPresent && !oofLeakChecked) warnings.push("OOF leakage check is missing");
  if (cvStd === null) warnings.push("CV stability is missing");
  if (!driftChecked) warnings.push("train/test drift check is missing");
  if (publicGap !== null && publicGap > 0.03) warnings.push(`public leaderboard trails local CV by ${publicGap}`);
  if (validation?.leak_checks?.target_encoding_oof_only === false) leakRisks.push("target_encoding_not_oof_safe");
  if (validation?.leak_checks?.stacking_oof_only === false) leakRisks.push("stacking_not_oof_safe");
  if (validation?.leak_checks?.train_test_boundary_checked === false) leakRisks.push("train_test_boundary_not_checked");
  if (validation?.leak_checks?.duplicate_or_id_leak_checked === false) leakRisks.push("duplicate_or_id_leak_not_checked");

  const robustPenalty =
    (cvStd ?? 0.04) * 1.5
    + (!oofPresent ? 0.08 : 0)
    + (oofPresent && !oofLeakChecked ? 0.04 : 0)
    + (publicGap !== null && publicGap > 0 ? publicGap * 1.5 : 0)
    + (driftRisk === "high" ? 0.06 : driftRisk === "unknown" ? 0.02 : 0)
    + leakRisks.length * 0.08;
  const riskLevel = leakRisks.length > 0 || !oofPresent || (publicGap !== null && publicGap > 0.05) || driftRisk === "high"
    ? "high"
    : warnings.length > 0
      ? "medium"
      : "low";

  return {
    oof_present: oofPresent,
    oof_leak_checked: oofLeakChecked,
    cv_stability_available: cvStd !== null,
    cv_std: cvStd,
    public_lb_score: publicScore,
    public_lb_gap: publicGap,
    drift_checked: driftChecked,
    drift_risk: driftRisk,
    leak_risks: leakRisks,
    warnings,
    risk_level: riskLevel,
    robust_penalty: robustPenalty,
  };
}

function normalizeLooseValidationContract(value: unknown, warnings: string[]): KaggleValidationContract | undefined {
  if (!isRecord(value)) return undefined;
  const normalized: KaggleValidationContract = {};
  const competitionMetric = KaggleValidationCompetitionMetricSchema.strip().safeParse(value["competition_metric"]);
  if (competitionMetric.success) {
    normalized.competition_metric = competitionMetric.data;
  } else if ("competition_metric" in value) {
    warnings.push("validation.competition_metric malformed; ignored");
  }
  const cv = KaggleValidationCvSchema.strip().safeParse(value["cv"]);
  if (cv.success) {
    normalized.cv = cv.data;
  } else if ("cv" in value) {
    warnings.push("validation.cv malformed; ignored");
  }
  const oof = KaggleValidationOofSchema.strip().safeParse(value["oof"]);
  if (oof.success) {
    normalized.oof = oof.data;
  } else if ("oof" in value) {
    warnings.push("validation.oof malformed; ignored");
  }
  const leakChecks = KaggleValidationLeakChecksSchema.strip().safeParse(value["leak_checks"]);
  if (leakChecks.success) {
    normalized.leak_checks = leakChecks.data;
  } else if ("leak_checks" in value) {
    warnings.push("validation.leak_checks malformed; ignored");
  }
  const stability = KaggleValidationStabilitySchema.strip().safeParse(value["stability"]);
  if (stability.success) {
    normalized.stability = stability.data;
  } else if ("stability" in value) {
    warnings.push("validation.stability malformed; ignored");
  }
  const drift = KaggleValidationTrainTestDriftSchema.strip().safeParse(value["train_test_drift"]);
  if (drift.success) {
    normalized.train_test_drift = drift.data;
  } else if ("train_test_drift" in value) {
    warnings.push("validation.train_test_drift malformed; ignored");
  }
  const publicLeaderboard = normalizeLoosePublicLeaderboard(value["public_leaderboard"], warnings);
  if (publicLeaderboard) {
    normalized.public_leaderboard = publicLeaderboard;
  } else if ("public_leaderboard" in value) {
    warnings.push("validation.public_leaderboard malformed; ignored");
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeLoosePublicLeaderboard(
  value: unknown,
  warnings: string[],
): KaggleValidationContract["public_leaderboard"] | undefined {
  if (!isRecord(value)) return undefined;
  const score = numberField(value, "score");
  const submissionId = stringField(value, "submission_id");
  const observedAtRaw = stringField(value, "observed_at");
  const observedAt = normalizeDateTime(observedAtRaw ?? undefined);
  const notes = stringField(value, "notes");
  const normalized: KaggleValidationContract["public_leaderboard"] = {};
  if (score !== null) normalized.score = score;
  if (submissionId) normalized.submission_id = submissionId;
  if (observedAt) normalized.observed_at = observedAt;
  if (observedAtRaw && !observedAt) warnings.push("validation.public_leaderboard.observed_at malformed; ignored");
  if (notes) normalized.notes = notes;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeLooseKaggleMetrics(
  value: unknown,
  fallback: KaggleMetricsCompatibilityFallback,
): { metrics: KaggleMetrics; warnings: string[] } | null {
  if (!isRecord(value)) return null;
  const allMetrics = isRecord(value["all_metrics"]) ? value["all_metrics"] : null;
  const metricName = stringField(value, "metric_name")
    ?? firstNumericMetricName(allMetrics)
    ?? (numberField(value, "roc_auc") !== null ? "roc_auc" : null)
    ?? (numberField(value, "auc") !== null ? "auc" : null)
    ?? (numberField(value, "balanced_accuracy") !== null ? "balanced_accuracy" : null)
    ?? (numberField(value, "accuracy") !== null ? "accuracy" : null);
  if (!metricName) return null;

  const score = numberField(value, "cv_score")
    ?? numberField(value, "metric_value")
    ?? numberField(value, "score")
    ?? numberField(value, metricName)
    ?? numberField(allMetrics, metricName);
  if (score === null) return null;

  const experimentId = stringField(value, "experiment_id") ?? fallback.experiment_id;
  const competition = stringField(value, "competition") ?? fallback.competition;
  if (!experimentId || !competition) return null;

  const direction = normalizeMetricDirection(
    stringField(value, "direction") ?? stringField(value, "metric_direction"),
    metricName,
  );
  const createdAt = normalizeDateTime(
    stringField(value, "created_at")
      ?? stringField(value, "finished_at_utc")
      ?? stringField(value, "started_at_utc")
      ?? fallback.created_at,
  ) ?? new Date().toISOString();
  const logPath = stringFieldFromArtifacts(value, "log")
    ?? stringField(value, "train_log")
    ?? fallback.log_path
    ?? `experiments/${experimentId}/train.log`;

  const artifacts: KaggleMetrics["artifacts"] = { log: logPath };
  const submission = stringFieldFromArtifacts(value, "submission")
    ?? stringField(value, "submission_file")
    ?? fallback.submission_path;
  if (submission) artifacts.submission = submission;
  const model = stringFieldFromArtifacts(value, "model")
    ?? stringField(value, "model_file")
    ?? fallback.model_path;
  if (model) artifacts.model = model;

  const warnings: string[] = [];
  if (!stringField(value, "competition")) warnings.push("competition was supplied by the caller");
  if (!stringField(value, "direction") && !stringField(value, "metric_direction")) {
    warnings.push(`direction inferred as ${direction} for metric ${metricName}`);
  }
  if (numberField(value, "train_rows") === null) warnings.push("train_rows missing; normalized to 0");
  if (numberField(value, "valid_rows") === null) warnings.push("valid_rows missing; normalized to 0");

  const normalized: KaggleMetrics = {
    experiment_id: experimentId,
    competition,
    metric_name: metricName,
    direction,
    cv_score: score,
    cv_std: numberField(value, "cv_std") ?? stdFromFoldScores(value["fold_scores"]),
    holdout_score: numberField(value, "holdout_score"),
    train_rows: intField(value, "train_rows") ?? 0,
    valid_rows: intField(value, "valid_rows") ?? 0,
    seed: intField(value, "seed") ?? 0,
    created_at: createdAt,
    status: normalizeStatus(stringField(value, "status")),
    artifacts,
  };
  const validation = normalizeLooseValidationContract(value["validation"], warnings);
  if (validation) {
    normalized.validation = validation;
  }

  return {
    metrics: normalized,
    warnings,
  };
}

function normalizeMetricDirection(value: string | null, metricName: string): KaggleMetrics["direction"] {
  if (value === "maximize" || value === "higher" || value === "higher_is_better" || value === "greater_is_better") return "maximize";
  if (value === "minimize" || value === "lower" || value === "lower_is_better" || value === "less_is_better") return "minimize";
  return metricName === "rmse" || metricName === "log_loss" ? "minimize" : "maximize";
}

function normalizeStatus(value: string | null): KaggleMetrics["status"] {
  if (value === "running" || value === "completed" || value === "failed") return value;
  if (value === "succeeded" || value === "success" || value === "complete") return "completed";
  if (value === "error") return "failed";
  return "completed";
}

function normalizeDateTime(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function firstNumericMetricName(value: Record<string, unknown> | null): string | null {
  if (!value) return null;
  for (const preferred of ["roc_auc", "auc", "balanced_accuracy", "accuracy", "macro_f1", "weighted_f1", "log_loss", "rmse"]) {
    if (numberField(value, preferred) !== null) return preferred;
  }
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "number" && Number.isFinite(field)) return key;
  }
  return null;
}

function stdFromFoldScores(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  const scores = value.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  if (scores.length < 2) return null;
  const mean = scores.reduce((total, item) => total + item, 0) / scores.length;
  const variance = scores.reduce((total, item) => total + (item - mean) ** 2, 0) / (scores.length - 1);
  return Math.sqrt(variance);
}

function stringFieldFromArtifacts(value: Record<string, unknown>, key: string): string | null {
  const artifacts = value["artifacts"];
  return isRecord(artifacts) ? stringField(artifacts, key) : null;
}

function stringField(value: Record<string, unknown> | null, key: string): string | null {
  const field = value?.[key];
  return typeof field === "string" && field.trim().length > 0 ? field : null;
}

function numberField(value: Record<string, unknown> | null, key: string): number | null {
  const field = value?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

function intField(value: Record<string, unknown>, key: string): number | null {
  const field = numberField(value, key);
  return field !== null && Number.isInteger(field) ? field : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
