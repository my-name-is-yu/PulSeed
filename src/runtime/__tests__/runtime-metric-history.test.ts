import { describe, expect, it } from "vitest";
import { selectMetricTrendForDimension, type MetricTrendContext } from "../store/metric-history.js";

function trend(metricKey: string): MetricTrendContext {
  return {
    metric_key: metricKey,
    direction: "maximize",
    trend: "improving",
    latest_value: 0.8,
    latest_observed_at: "2026-04-30T00:05:00.000Z",
    best_value: 0.8,
    best_observed_at: "2026-04-30T00:05:00.000Z",
    observation_count: 2,
    recent_slope_per_observation: 0.1,
    best_delta: 0.1,
    last_meaningful_improvement_delta: 0.1,
    last_breakthrough_delta: null,
    time_since_last_meaningful_improvement_ms: 0,
    improvement_threshold: 0.01,
    breakthrough_threshold: 0.05,
    noise_band: 0.005,
    confidence: 0.8,
    source_refs: [{ entry_id: `${metricKey}-entry`, kind: "metric" }],
    summary: `${metricKey} improving`,
  };
}

describe("runtime metric-history selection", () => {
  it("does not apply unrelated metric trends to a dimension", () => {
    expect(selectMetricTrendForDimension([trend("accuracy")], "latency")).toBeUndefined();
  });

  it("allows exact dimension matches", () => {
    expect(selectMetricTrendForDimension([trend("latency")], "latency")?.metric_key).toBe("latency");
  });

  it("requires explicit metric keys instead of substring matches", () => {
    expect(selectMetricTrendForDimension([trend("accuracy")], "model_accuracy")).toBeUndefined();
    expect(
      selectMetricTrendForDimension([trend("accuracy")], "model_accuracy", {
        metricKeys: ["accuracy"],
      })?.metric_key
    ).toBe("accuracy");
  });
});
