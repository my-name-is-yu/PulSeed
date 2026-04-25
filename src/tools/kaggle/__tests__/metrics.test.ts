import { describe, expect, it } from "vitest";
import { KaggleMetricsSchema, metricThresholdHintForDirection } from "../metrics.js";

describe("Kaggle metrics helpers", () => {
  it("maps maximize metrics to gte threshold hints", () => {
    expect(metricThresholdHintForDirection("accuracy", "maximize")).toMatchObject({
      wait_condition_type: "metric_threshold",
      metric: "accuracy",
      operator: "gte",
      value_required: true,
      metric_source: "wait_metadata.metrics",
    });
  });

  it("maps minimize metrics to lte threshold hints", () => {
    expect(metricThresholdHintForDirection("rmse", "minimize")).toMatchObject({
      wait_condition_type: "metric_threshold",
      metric: "rmse",
      operator: "lte",
      value_required: true,
      metric_source: "wait_metadata.metrics",
    });
  });

  it("accepts only the strict metrics contract", () => {
    const valid = {
      experiment_id: "exp-20260425-001",
      competition: "titanic",
      metric_name: "rmse",
      direction: "minimize",
      cv_score: 0.123,
      cv_std: 0.004,
      holdout_score: null,
      train_rows: 1000,
      valid_rows: 200,
      seed: 42,
      created_at: "2026-04-25T00:00:00.000Z",
      status: "completed",
      artifacts: {
        model: "experiments/exp-20260425-001/model.pkl",
        submission: "experiments/exp-20260425-001/submission.csv",
        log: "experiments/exp-20260425-001/train.log",
      },
    };

    expect(KaggleMetricsSchema.safeParse(valid).success).toBe(true);
    expect(KaggleMetricsSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(KaggleMetricsSchema.safeParse({ ...valid, direction: "higher" }).success).toBe(false);
  });
});
