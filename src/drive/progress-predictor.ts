export interface PredictionResult {
  predictedGapScore: number;              // predicted next gap score (clamped 0-1)
  confidence: number;                     // R² of linear fit (0-1)
  trend: "improving" | "worsening" | "stable";
  predictedIterationsToGoal: number | null; // est. iterations to gap=0, null if not converging
  slopePerIteration: number;              // rate of change per iteration
}

const TREND_THRESHOLD = 0.005;

/**
 * ProgressPredictor uses linear regression on recent gap history to predict
 * future gap scores, enabling early stall detection before a stall is confirmed.
 */
export class ProgressPredictor {
  private readonly minDataPoints: number;

  constructor(minDataPoints = 3) {
    this.minDataPoints = minDataPoints;
  }

  /**
   * Predict the next gap score and trend from gap history.
   * Returns null if there are fewer than minDataPoints entries.
   *
   * @param gapHistory - Array of normalized gap scores (0-1)
   * @param windowSize - Number of recent entries to use for regression
   */
  predict(gapHistory: number[], windowSize = 5): PredictionResult | null {
    if (gapHistory.length < this.minDataPoints) {
      return null;
    }

    // Take last windowSize entries
    const window = gapHistory.slice(-windowSize);
    const n = window.length;

    // x values: 0, 1, 2, ..., n-1
    // y values: gap scores
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;

    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += window[i]!;
      sumXY += i * window[i]!;
      sumXX += i * i;
    }

    const denominator = n * sumXX - sumX * sumX;

    let slope: number;
    let intercept: number;

    if (denominator === 0) {
      // All x values are equal (n=1) — use flat line
      slope = 0;
      intercept = sumY / n;
    } else {
      slope = (n * sumXY - sumX * sumY) / denominator;
      intercept = (sumY - slope * sumX) / n;
    }

    // Predicted next gap score: x = n (next step after 0..n-1)
    const predictedRaw = slope * n + intercept;
    const predictedGapScore = Math.max(0, Math.min(1, predictedRaw));

    // R² (coefficient of determination)
    const meanY = sumY / n;
    let ssTot = 0;
    let ssRes = 0;
    for (let i = 0; i < n; i++) {
      const fitted = slope * i + intercept;
      ssTot += (window[i]! - meanY) ** 2;
      ssRes += (window[i]! - fitted) ** 2;
    }

    const confidence = ssTot === 0 ? 1.0 : Math.max(0, 1 - ssRes / ssTot);

    // Trend classification
    let trend: "improving" | "worsening" | "stable";
    if (slope < -TREND_THRESHOLD) {
      trend = "improving"; // gap decreasing → progress
    } else if (slope > TREND_THRESHOLD) {
      trend = "worsening"; // gap increasing → regression
    } else {
      trend = "stable";
    }

    // Predicted iterations to reach gap=0 (only when improving)
    let predictedIterationsToGoal: number | null = null;
    if (trend === "improving" && slope < 0) {
      // Solve: slope * x + intercept = 0 → x = -intercept / slope
      // x is relative to x=0 in the window, so subtract current last index (n-1)
      const xAtZero = -intercept / slope;
      const stepsFromNow = xAtZero - (n - 1);
      if (stepsFromNow > 0.5) {
        predictedIterationsToGoal = Math.ceil(stepsFromNow);
      }
    }

    return {
      predictedGapScore,
      confidence,
      trend,
      predictedIterationsToGoal,
      slopePerIteration: slope,
    };
  }
}
