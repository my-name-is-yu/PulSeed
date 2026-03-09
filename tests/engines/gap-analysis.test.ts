import { describe, it, expect, beforeEach } from 'vitest';
import { GapAnalysisEngine } from '../../src/engines/gap-analysis.js';
import { Goal } from '../../src/state/models.js';

describe('GapAnalysisEngine', () => {
  let engine: GapAnalysisEngine;

  beforeEach(() => {
    engine = new GapAnalysisEngine();
  });

  describe('computeGaps', () => {
    it('computes basic gaps correctly', () => {
      const goal = Goal.parse({
        title: 'Test goal',
        achievement_thresholds: { progress: 0.9, quality_score: 0.8 },
        state_vector: {
          progress: { value: 0.3, confidence: 0.85, source: 'tool_output' },
          quality_score: { value: 0.5, confidence: 0.6, source: 'llm_estimate' },
        },
      });
      const gaps = engine.computeGaps(goal);
      expect(gaps).toHaveLength(2);
      const progressGap = gaps.find(g => g.dimension === 'progress')!;
      expect(progressGap.magnitude).toBeCloseTo(0.667, 2);
      expect(progressGap.confidence).toBe(0.85);
    });

    it('sorts by magnitude * confidence descending', () => {
      const goal = Goal.parse({
        title: 'Test',
        achievement_thresholds: { progress: 0.9, quality_score: 0.8 },
        state_vector: {
          progress: { value: 0.3, confidence: 0.85 },
          quality_score: { value: 0.5, confidence: 0.6 },
        },
      });
      const gaps = engine.computeGaps(goal);
      const scores = gaps.map(g => g.magnitude * g.confidence);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
      }
    });

    it('handles inverse dimension (open_issues)', () => {
      const goal = Goal.parse({
        title: 'Test',
        achievement_thresholds: { open_issues: 2 },
        state_vector: {
          open_issues: { value: 5, confidence: 0.9, source: 'tool_output' },
        },
      });
      const gaps = engine.computeGaps(goal);
      expect(gaps).toHaveLength(1);
      expect(gaps[0].magnitude).toBeCloseTo(0.6, 2);
    });

    it('returns max gap with low confidence when no observation', () => {
      const goal = Goal.parse({
        title: 'Test',
        achievement_thresholds: { progress: 0.9 },
        state_vector: {},
      });
      const gaps = engine.computeGaps(goal);
      expect(gaps[0].magnitude).toBe(1.0);
      expect(gaps[0].confidence).toBe(0.3);
    });

    it('returns zero magnitude for completed dimensions', () => {
      const goal = Goal.parse({
        title: 'Done',
        achievement_thresholds: { progress: 0.9 },
        state_vector: { progress: { value: 0.95, confidence: 0.9 } },
      });
      const gaps = engine.computeGaps(goal);
      expect(gaps[0].magnitude).toBe(0);
    });

    it('returns zero magnitude when open_issues at or below target', () => {
      const goal = Goal.parse({
        title: 'Test',
        achievement_thresholds: { open_issues: 2 },
        state_vector: { open_issues: { value: 1, confidence: 0.9 } },
      });
      const gaps = engine.computeGaps(goal);
      expect(gaps[0].magnitude).toBe(0);
    });
  });

  describe('maxGapScore', () => {
    it('returns highest magnitude * confidence', () => {
      const goal = Goal.parse({
        title: 'Test',
        achievement_thresholds: { progress: 0.9, quality: 0.8 },
        state_vector: {
          progress: { value: 0.3, confidence: 0.85 },
          quality: { value: 0.5, confidence: 0.6 },
        },
      });
      expect(engine.maxGapScore(goal)).toBeGreaterThan(0.5);
    });

    it('returns 0 for empty thresholds', () => {
      const goal = Goal.parse({ title: 'Empty', achievement_thresholds: {} });
      expect(engine.maxGapScore(goal)).toBe(0);
    });
  });

  describe('isGoalSatisfied', () => {
    it('returns false when gaps remain', () => {
      const goal = Goal.parse({
        title: 'WIP',
        achievement_thresholds: { progress: 0.9 },
        state_vector: { progress: { value: 0.3, confidence: 0.85 } },
      });
      expect(engine.isGoalSatisfied(goal)).toBe(false);
    });

    it('returns true when all gaps below threshold', () => {
      const goal = Goal.parse({
        title: 'Done',
        achievement_thresholds: { progress: 0.9 },
        state_vector: { progress: { value: 0.92, confidence: 0.9 } },
      });
      expect(engine.isGoalSatisfied(goal)).toBe(true);
    });
  });
});
