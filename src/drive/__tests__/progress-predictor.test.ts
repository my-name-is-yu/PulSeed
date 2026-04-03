import { describe, it, expect } from "vitest";
import { ProgressPredictor } from "../progress-predictor.js";

describe("ProgressPredictor", () => {
  const predictor = new ProgressPredictor();

  // ─── Null cases ───

  it("returns null with fewer than minDataPoints (default=3)", () => {
    expect(predictor.predict([])).toBeNull();
    expect(predictor.predict([0.5])).toBeNull();
    expect(predictor.predict([0.5, 0.4])).toBeNull();
  });

  it("returns non-null with exactly minDataPoints entries", () => {
    const result = predictor.predict([0.5, 0.4, 0.3]);
    expect(result).not.toBeNull();
  });

  it("respects custom minDataPoints", () => {
    const strict = new ProgressPredictor(5);
    expect(strict.predict([0.5, 0.4, 0.3, 0.2])).toBeNull();
    expect(strict.predict([0.5, 0.4, 0.3, 0.2, 0.1])).not.toBeNull();
  });

  // ─── Trend detection ───

  it("identifies improving trend when gap scores decrease", () => {
    // Gap decreasing from 0.8 → 0.3 (slope ~ -0.1/iter)
    const result = predictor.predict([0.8, 0.7, 0.6, 0.5, 0.4, 0.3]);
    expect(result).not.toBeNull();
    expect(result!.trend).toBe("improving");
    expect(result!.slopePerIteration).toBeLessThan(0);
  });

  it("identifies worsening trend when gap scores increase", () => {
    // Gap increasing from 0.2 → 0.7 (slope ~ +0.1/iter)
    const result = predictor.predict([0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
    expect(result).not.toBeNull();
    expect(result!.trend).toBe("worsening");
    expect(result!.slopePerIteration).toBeGreaterThan(0);
  });

  it("identifies stable/plateau trend when gap scores are flat", () => {
    // Gap completely flat at 0.5
    const result = predictor.predict([0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(result).not.toBeNull();
    expect(result!.trend).toBe("stable");
  });

  it("identifies stable trend when slope magnitude is below threshold (0.005)", () => {
    // Very slight movement — within stable threshold
    const result = predictor.predict([0.5, 0.501, 0.502, 0.501, 0.5]);
    expect(result).not.toBeNull();
    expect(result!.trend).toBe("stable");
  });

  // ─── Predicted gap score ───

  it("predicts a reasonable next gap score for an improving series", () => {
    // Linear decrease: 0.8, 0.7, 0.6, 0.5, 0.4 → next should be ~0.3
    const result = predictor.predict([0.8, 0.7, 0.6, 0.5, 0.4]);
    expect(result).not.toBeNull();
    expect(result!.predictedGapScore).toBeCloseTo(0.3, 1);
  });

  it("predicts a reasonable next gap score for a worsening series", () => {
    // Linear increase: 0.2, 0.3, 0.4, 0.5, 0.6 → next should be ~0.7
    const result = predictor.predict([0.2, 0.3, 0.4, 0.5, 0.6]);
    expect(result).not.toBeNull();
    expect(result!.predictedGapScore).toBeCloseTo(0.7, 1);
  });

  // ─── Clamping ───

  it("clamps predicted gap score to [0, 1] (lower bound)", () => {
    // Steeply decreasing — predicted would go below 0
    const result = predictor.predict([0.5, 0.3, 0.1]);
    expect(result).not.toBeNull();
    expect(result!.predictedGapScore).toBeGreaterThanOrEqual(0);
    expect(result!.predictedGapScore).toBeLessThanOrEqual(1);
  });

  it("clamps predicted gap score to [0, 1] (upper bound)", () => {
    // Steeply increasing — predicted would go above 1
    const result = predictor.predict([0.5, 0.7, 0.9]);
    expect(result).not.toBeNull();
    expect(result!.predictedGapScore).toBeGreaterThanOrEqual(0);
    expect(result!.predictedGapScore).toBeLessThanOrEqual(1);
  });

  // ─── R² confidence ───

  it("returns confidence = 1.0 for a perfect linear series", () => {
    // Perfectly linear: 0.8, 0.6, 0.4, 0.2 (slope=-0.2, R²=1)
    const result = predictor.predict([0.8, 0.6, 0.4, 0.2]);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeCloseTo(1.0, 5);
  });

  it("returns confidence between 0 and 1 for noisy data", () => {
    // Random-ish values — R² will be low
    const result = predictor.predict([0.5, 0.2, 0.8, 0.1, 0.9]);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeGreaterThanOrEqual(0);
    expect(result!.confidence).toBeLessThanOrEqual(1);
  });

  it("returns confidence = 1.0 for a flat series (all same value)", () => {
    // All values equal — SS_tot=0, treated as R²=1
    const result = predictor.predict([0.5, 0.5, 0.5, 0.5]);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(1.0);
  });

  // ─── windowSize ───

  it("respects windowSize parameter — only uses last N entries", () => {
    // Long history with early noise; last 3 entries are cleanly decreasing
    const longHistory = [0.9, 0.1, 0.7, 0.2, 0.6, 0.5, 0.4, 0.3];
    const result = predictor.predict(longHistory, 3);
    expect(result).not.toBeNull();
    // With only last 3: [0.5, 0.4, 0.3] → trend should be improving
    expect(result!.trend).toBe("improving");
  });

  it("uses full array when history is shorter than windowSize", () => {
    // History shorter than window — should still work
    const result = predictor.predict([0.5, 0.4, 0.3], 10);
    expect(result).not.toBeNull();
    expect(result!.trend).toBe("improving");
  });

  // ─── predictedIterationsToGoal ───

  it("predicts iterations to goal when trend is improving", () => {
    // Linear from 0.8 to 0.4 over 5 points — slope = -0.1, should converge
    const result = predictor.predict([0.8, 0.7, 0.6, 0.5, 0.4]);
    expect(result).not.toBeNull();
    expect(result!.predictedIterationsToGoal).not.toBeNull();
    expect(result!.predictedIterationsToGoal).toBeGreaterThan(0);
  });

  it("returns null for predictedIterationsToGoal when trend is worsening", () => {
    const result = predictor.predict([0.2, 0.3, 0.4, 0.5, 0.6]);
    expect(result).not.toBeNull();
    expect(result!.predictedIterationsToGoal).toBeNull();
  });

  it("returns null for predictedIterationsToGoal when trend is stable", () => {
    const result = predictor.predict([0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(result).not.toBeNull();
    expect(result!.predictedIterationsToGoal).toBeNull();
  });

  it("estimates reasonable iterations to goal for a known linear series", () => {
    // Perfect line: 1.0, 0.8, 0.6, 0.4, 0.2 → slope=-0.2, current=0.2
    // Next predicted: 0.0. So predictedIterationsToGoal should be 1.
    const result = predictor.predict([1.0, 0.8, 0.6, 0.4, 0.2]);
    expect(result).not.toBeNull();
    expect(result!.predictedIterationsToGoal).toBe(1);
  });

  it('should return null iterations when gap is already near zero', () => {
    const predictor = new ProgressPredictor();
    const result = predictor.predict([0.1, 0.05, 0.0]);
    expect(result).not.toBeNull();
    expect(result!.predictedIterationsToGoal).toBeNull();
  });
});
