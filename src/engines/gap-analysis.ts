import { Goal, Gap } from '../state/models.js';

const INVERSE_DIMENSIONS = new Set(['open_issues']);

export class GapAnalysisEngine {
  computeGaps(goal: Goal): Gap[] {
    const gaps: Gap[] = [];

    for (const [dim, threshold] of Object.entries(goal.achievement_thresholds)) {
      const sv = goal.state_vector[dim];

      if (!sv) {
        // No observation — assume maximum gap with low confidence
        gaps.push({ dimension: dim, current: 0, target: threshold, magnitude: 1.0, confidence: 0.3 });
        continue;
      }

      let magnitude: number;
      if (INVERSE_DIMENSIONS.has(dim)) {
        magnitude = Math.max(0, (sv.value - threshold)) / Math.max(sv.value, 1);
      } else {
        magnitude = threshold === 0 ? 0 : Math.max(0, (threshold - sv.value)) / threshold;
      }
      magnitude = Math.min(1.0, magnitude);

      gaps.push({
        dimension: dim,
        current: sv.value,
        target: threshold,
        magnitude,
        confidence: sv.confidence,
      });
    }

    return gaps.sort((a, b) => (b.magnitude * b.confidence) - (a.magnitude * a.confidence));
  }

  maxGapScore(goal: Goal): number {
    const gaps = this.computeGaps(goal);
    if (gaps.length === 0) return 0;
    return Math.max(...gaps.map(g => g.magnitude * g.confidence));
  }

  isGoalSatisfied(goal: Goal, threshold = 0.05): boolean {
    const gaps = this.computeGaps(goal);
    return gaps.every(g => g.magnitude <= threshold);
  }
}
