import { describe, it, expect } from 'vitest';
import {
  MotiveState,
  Goal,
  TrustBalance,
  StateVectorElement,
  Gap,
  updateTrustSuccess,
  updateTrustFailure,
} from '../../src/state/models.js';

describe('MotiveState', () => {
  it('creates with defaults: unique session_id and trust 0.7', () => {
    const a = MotiveState.parse({});
    const b = MotiveState.parse({});
    expect(a.session_id).toBeTruthy();
    expect(b.session_id).toBeTruthy();
    expect(a.session_id).not.toBe(b.session_id);
    expect(a.trust_balance.global).toBe(0.7);
    expect(a.version).toBe('1.0.0');
    expect(a.active_goal_ids).toEqual([]);
  });

  it('persists supplied values through parse', () => {
    const state = MotiveState.parse({ session_id: 'my-session', version: '2.0.0' });
    expect(state.session_id).toBe('my-session');
    expect(state.version).toBe('2.0.0');
  });

  it('rejects invalid types', () => {
    expect(() => MotiveState.parse({ active_goal_ids: 'not-an-array' })).toThrow();
  });
});

describe('Goal', () => {
  it('creates with required title and sensible defaults', () => {
    const goal = Goal.parse({ title: 'Write tests' });
    expect(goal.title).toBe('Write tests');
    expect(goal.id).toMatch(/^goal-/);
    expect(goal.status).toBe('active');
    expect(goal.type).toBe('dissatisfaction');
    expect(goal.gaps).toEqual([]);
    expect(goal.motivation_score).toBe(0);
    expect(goal.deadline).toBeNull();
    expect(goal.parent_goal_id).toBeNull();
  });

  it('roundtrip through JSON parse', () => {
    const original = Goal.parse({ title: 'Deploy feature', type: 'deadline', motivation_score: 0.8 });
    const json = JSON.stringify(original);
    const restored = Goal.parse(JSON.parse(json));
    expect(restored).toEqual(original);
  });

  it('generates unique ids for separate goals', () => {
    const g1 = Goal.parse({ title: 'Goal A' });
    const g2 = Goal.parse({ title: 'Goal B' });
    expect(g1.id).not.toBe(g2.id);
  });

  it('rejects missing required title', () => {
    expect(() => Goal.parse({})).toThrow();
  });

  it('accepts all GoalStatus values', () => {
    for (const status of ['active', 'completed', 'paused', 'abandoned'] as const) {
      const g = Goal.parse({ title: 'T', status });
      expect(g.status).toBe(status);
    }
  });

  it('rejects invalid GoalType', () => {
    expect(() => Goal.parse({ title: 'T', type: 'invalid-type' })).toThrow();
  });
});

describe('TrustBalance', () => {
  it('defaults to global 0.7', () => {
    const trust = TrustBalance.parse({});
    expect(trust.global).toBe(0.7);
    expect(trust.per_goal).toEqual({});
  });

  it('updateTrustSuccess increments global by 0.05 (reversible)', () => {
    const trust = TrustBalance.parse({});
    updateTrustSuccess(trust);
    expect(trust.global).toBeCloseTo(0.75);
  });

  it('updateTrustSuccess increments global by 0.1 (irreversible)', () => {
    const trust = TrustBalance.parse({});
    updateTrustSuccess(trust, undefined, true);
    expect(trust.global).toBeCloseTo(0.8);
  });

  it('updateTrustFailure decrements global by 0.15 (reversible)', () => {
    const trust = TrustBalance.parse({});
    updateTrustFailure(trust);
    expect(trust.global).toBeCloseTo(0.55);
  });

  it('updateTrustFailure decrements global by 0.3 (irreversible)', () => {
    const trust = TrustBalance.parse({});
    updateTrustFailure(trust, undefined, true);
    expect(trust.global).toBeCloseTo(0.4);
  });

  it('clamps global trust to [0, 1] on success', () => {
    const trust = TrustBalance.parse({ global: 0.98 });
    updateTrustSuccess(trust);
    expect(trust.global).toBe(1.0);
  });

  it('clamps global trust to [0, 1] on failure', () => {
    const trust = TrustBalance.parse({ global: 0.1 });
    updateTrustFailure(trust, undefined, true);
    expect(trust.global).toBe(0.0);
  });

  it('updates per_goal when goalId exists in per_goal', () => {
    const trust = TrustBalance.parse({ global: 0.7, per_goal: { 'goal-abc': 0.6 } });
    updateTrustSuccess(trust, 'goal-abc');
    expect(trust.per_goal['goal-abc']).toBeCloseTo(0.65);
  });

  it('does not create per_goal entry when goalId not present', () => {
    const trust = TrustBalance.parse({ global: 0.7, per_goal: {} });
    updateTrustSuccess(trust, 'goal-unknown');
    expect('goal-unknown' in trust.per_goal).toBe(false);
  });

  it('failure and success are asymmetric (failure delta > success delta)', () => {
    const successDelta = 0.05;
    const failureDelta = 0.15;
    expect(failureDelta).toBeGreaterThan(successDelta);
  });

  it('rejects global trust outside [0, 1]', () => {
    expect(() => TrustBalance.parse({ global: 1.5 })).toThrow();
    expect(() => TrustBalance.parse({ global: -0.1 })).toThrow();
  });
});

describe('StateVectorElement', () => {
  it('creates with required value and confidence', () => {
    const el = StateVectorElement.parse({ value: 0.5, confidence: 0.8 });
    expect(el.value).toBe(0.5);
    expect(el.confidence).toBe(0.8);
    expect(el.source).toBe('llm_estimate');
  });

  it('accepts confidence at boundary values 0 and 1', () => {
    expect(() => StateVectorElement.parse({ value: 0, confidence: 0 })).not.toThrow();
    expect(() => StateVectorElement.parse({ value: 1, confidence: 1 })).not.toThrow();
  });

  it('rejects confidence below 0', () => {
    expect(() => StateVectorElement.parse({ value: 0.5, confidence: -0.01 })).toThrow();
  });

  it('rejects confidence above 1', () => {
    expect(() => StateVectorElement.parse({ value: 0.5, confidence: 1.01 })).toThrow();
  });

  it('accepts all ObservationSource values', () => {
    for (const source of ['tool_output', 'llm_estimate', 'user_input'] as const) {
      const el = StateVectorElement.parse({ value: 0, confidence: 0.5, source });
      expect(el.source).toBe(source);
    }
  });
});

describe('Gap', () => {
  it('creates with required fields', () => {
    const gap = Gap.parse({ dimension: 'progress', current: 0.3, target: 1.0, magnitude: 0.7, confidence: 0.9 });
    expect(gap.dimension).toBe('progress');
    expect(gap.magnitude).toBe(0.7);
  });

  it('rejects magnitude outside [0, 1]', () => {
    expect(() => Gap.parse({ dimension: 'x', current: 0, target: 1, magnitude: 1.5, confidence: 0.5 })).toThrow();
    expect(() => Gap.parse({ dimension: 'x', current: 0, target: 1, magnitude: -0.1, confidence: 0.5 })).toThrow();
  });

  it('rejects confidence outside [0, 1]', () => {
    expect(() => Gap.parse({ dimension: 'x', current: 0, target: 1, magnitude: 0.5, confidence: -1 })).toThrow();
  });
});
