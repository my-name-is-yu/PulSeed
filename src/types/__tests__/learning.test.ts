import { describe, it, expect } from "vitest";
import {
  LearningTriggerTypeEnum,
  LearningTriggerSchema,
  LearnedPatternTypeEnum,
  LearnedPatternSchema,
  FeedbackTargetStepEnum,
  FeedbackEffectEnum,
  FeedbackEntrySchema,
  LearningPipelineConfigSchema,
} from "../learning.js";

// ─── LearningTriggerTypeEnum ───

describe("LearningTriggerTypeEnum", () => {
  it("accepts all 4 trigger types", () => {
    const types = [
      "milestone_reached",
      "stall_detected",
      "periodic_review",
      "goal_completed",
    ] as const;
    for (const t of types) {
      expect(LearningTriggerTypeEnum.parse(t)).toBe(t);
    }
  });

  it("rejects invalid trigger type", () => {
    const result = LearningTriggerTypeEnum.safeParse("manual");
    expect(result.success).toBe(false);
  });
});

// ─── LearningTriggerSchema ───

describe("LearningTriggerSchema", () => {
  it("parses valid input", () => {
    const result = LearningTriggerSchema.parse({
      type: "milestone_reached",
      goal_id: "goal-1",
      context: "50% progress milestone",
      timestamp: "2024-06-01T12:00:00.000Z",
    });
    expect(result.type).toBe("milestone_reached");
    expect(result.goal_id).toBe("goal-1");
    expect(result.context).toBe("50% progress milestone");
  });

  it("rejects invalid datetime in timestamp", () => {
    const result = LearningTriggerSchema.safeParse({
      type: "stall_detected",
      goal_id: "goal-1",
      context: "stalled",
      timestamp: "not-a-datetime",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const result = LearningTriggerSchema.safeParse({
      type: "periodic_review",
    });
    expect(result.success).toBe(false);
  });
});

// ─── LearnedPatternTypeEnum ───

describe("LearnedPatternTypeEnum", () => {
  it("accepts all 4 pattern types", () => {
    const types = [
      "observation_accuracy",
      "strategy_selection",
      "scope_sizing",
      "task_generation",
    ] as const;
    for (const t of types) {
      expect(LearnedPatternTypeEnum.parse(t)).toBe(t);
    }
  });

  it("rejects invalid pattern type", () => {
    const result = LearnedPatternTypeEnum.safeParse("execution_speed");
    expect(result.success).toBe(false);
  });
});

// ─── LearnedPatternSchema ───

describe("LearnedPatternSchema", () => {
  it("parses valid input with all fields", () => {
    const result = LearnedPatternSchema.parse({
      pattern_id: "pat-1",
      type: "strategy_selection",
      description: "Use iterative approach for uncertain tasks",
      confidence: 0.85,
      evidence_count: 10,
      source_goal_ids: ["goal-1", "goal-2"],
      applicable_domains: ["coding", "design"],
      created_at: "2024-01-01T00:00:00.000Z",
    });
    expect(result.pattern_id).toBe("pat-1");
    expect(result.confidence).toBe(0.85);
    expect(result.evidence_count).toBe(10);
    expect(result.source_goal_ids).toEqual(["goal-1", "goal-2"]);
  });

  it("defaults embedding_id to null", () => {
    const result = LearnedPatternSchema.parse({
      pattern_id: "pat-1",
      type: "observation_accuracy",
      description: "desc",
      confidence: 0.6,
      evidence_count: 3,
      source_goal_ids: [],
      applicable_domains: [],
      created_at: "2024-01-01T00:00:00.000Z",
    });
    expect(result.embedding_id).toBeNull();
  });

  it("defaults last_applied_at to null", () => {
    const result = LearnedPatternSchema.parse({
      pattern_id: "pat-1",
      type: "scope_sizing",
      description: "desc",
      confidence: 0.5,
      evidence_count: 1,
      source_goal_ids: [],
      applicable_domains: [],
      created_at: "2024-01-01T00:00:00.000Z",
    });
    expect(result.last_applied_at).toBeNull();
  });

  it("accepts explicit embedding_id and last_applied_at", () => {
    const result = LearnedPatternSchema.parse({
      pattern_id: "pat-1",
      type: "task_generation",
      description: "desc",
      confidence: 0.7,
      evidence_count: 5,
      source_goal_ids: ["g1"],
      applicable_domains: ["writing"],
      embedding_id: "emb-99",
      last_applied_at: "2024-06-01T00:00:00.000Z",
      created_at: "2024-01-01T00:00:00.000Z",
    });
    expect(result.embedding_id).toBe("emb-99");
    expect(result.last_applied_at).toBe("2024-06-01T00:00:00.000Z");
  });

  it("rejects confidence below 0", () => {
    const result = LearnedPatternSchema.safeParse({
      pattern_id: "pat-1",
      type: "strategy_selection",
      description: "desc",
      confidence: -0.1,
      evidence_count: 1,
      source_goal_ids: [],
      applicable_domains: [],
      created_at: "2024-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence above 1", () => {
    const result = LearnedPatternSchema.safeParse({
      pattern_id: "pat-1",
      type: "scope_sizing",
      description: "desc",
      confidence: 1.01,
      evidence_count: 1,
      source_goal_ids: [],
      applicable_domains: [],
      created_at: "2024-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative evidence_count", () => {
    const result = LearnedPatternSchema.safeParse({
      pattern_id: "pat-1",
      type: "task_generation",
      description: "desc",
      confidence: 0.5,
      evidence_count: -1,
      source_goal_ids: [],
      applicable_domains: [],
      created_at: "2024-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

// ─── FeedbackTargetStepEnum ───

describe("FeedbackTargetStepEnum", () => {
  it("accepts all 4 target steps", () => {
    const steps = ["observation", "gap", "strategy", "task"] as const;
    for (const s of steps) {
      expect(FeedbackTargetStepEnum.parse(s)).toBe(s);
    }
  });

  it("rejects invalid target step", () => {
    const result = FeedbackTargetStepEnum.safeParse("planning");
    expect(result.success).toBe(false);
  });
});

// ─── FeedbackEffectEnum ───

describe("FeedbackEffectEnum", () => {
  it("accepts all 3 effect types", () => {
    const effects = ["positive", "negative", "neutral"] as const;
    for (const e of effects) {
      expect(FeedbackEffectEnum.parse(e)).toBe(e);
    }
  });

  it("rejects invalid effect", () => {
    const result = FeedbackEffectEnum.safeParse("inconclusive");
    expect(result.success).toBe(false);
  });
});

// ─── FeedbackEntrySchema ───

describe("FeedbackEntrySchema", () => {
  it("parses valid input with all fields", () => {
    const result = FeedbackEntrySchema.parse({
      feedback_id: "fb-1",
      pattern_id: "pat-1",
      target_step: "strategy",
      adjustment: "increase weight for deadline urgency",
      applied_at: "2024-06-01T00:00:00.000Z",
      effect_observed: "positive",
    });
    expect(result.feedback_id).toBe("fb-1");
    expect(result.target_step).toBe("strategy");
    expect(result.effect_observed).toBe("positive");
  });

  it("defaults effect_observed to null", () => {
    const result = FeedbackEntrySchema.parse({
      feedback_id: "fb-1",
      pattern_id: "pat-1",
      target_step: "observation",
      adjustment: "adjust confidence ceiling",
      applied_at: "2024-06-01T00:00:00.000Z",
    });
    expect(result.effect_observed).toBeNull();
  });

  it("accepts explicit null for effect_observed", () => {
    const result = FeedbackEntrySchema.parse({
      feedback_id: "fb-2",
      pattern_id: "pat-2",
      target_step: "gap",
      adjustment: "recalibrate",
      applied_at: "2024-06-01T00:00:00.000Z",
      effect_observed: null,
    });
    expect(result.effect_observed).toBeNull();
  });

  it("accepts all 4 target steps", () => {
    const steps = ["observation", "gap", "strategy", "task"] as const;
    for (const target_step of steps) {
      const r = FeedbackEntrySchema.parse({
        feedback_id: "fb",
        pattern_id: "pat",
        target_step,
        adjustment: "adj",
        applied_at: "2024-06-01T00:00:00.000Z",
      });
      expect(r.target_step).toBe(target_step);
    }
  });

  it("accepts all 3 effect types", () => {
    const effects = ["positive", "negative", "neutral"] as const;
    for (const effect_observed of effects) {
      const r = FeedbackEntrySchema.parse({
        feedback_id: "fb",
        pattern_id: "pat",
        target_step: "task",
        adjustment: "adj",
        applied_at: "2024-06-01T00:00:00.000Z",
        effect_observed,
      });
      expect(r.effect_observed).toBe(effect_observed);
    }
  });

  it("rejects invalid applied_at", () => {
    const result = FeedbackEntrySchema.safeParse({
      feedback_id: "fb-1",
      pattern_id: "pat-1",
      target_step: "task",
      adjustment: "adj",
      applied_at: "not-a-date",
    });
    expect(result.success).toBe(false);
  });
});

// ─── LearningPipelineConfigSchema ───

describe("LearningPipelineConfigSchema", () => {
  it("applies defaults when no input provided", () => {
    const result = LearningPipelineConfigSchema.parse({});
    expect(result.min_confidence_threshold).toBe(0.6);
    expect(result.periodic_review_interval_hours).toBe(72);
    expect(result.max_patterns_per_goal).toBe(50);
    expect(result.cross_goal_sharing_enabled).toBe(true);
  });

  it("parses valid explicit input", () => {
    const result = LearningPipelineConfigSchema.parse({
      min_confidence_threshold: 0.8,
      periodic_review_interval_hours: 24,
      max_patterns_per_goal: 100,
      cross_goal_sharing_enabled: false,
    });
    expect(result.min_confidence_threshold).toBe(0.8);
    expect(result.periodic_review_interval_hours).toBe(24);
    expect(result.max_patterns_per_goal).toBe(100);
    expect(result.cross_goal_sharing_enabled).toBe(false);
  });

  it("rejects min_confidence_threshold below 0", () => {
    const result = LearningPipelineConfigSchema.safeParse({ min_confidence_threshold: -0.1 });
    expect(result.success).toBe(false);
  });

  it("rejects min_confidence_threshold above 1", () => {
    const result = LearningPipelineConfigSchema.safeParse({ min_confidence_threshold: 1.1 });
    expect(result.success).toBe(false);
  });

  it("rejects periodic_review_interval_hours below 1", () => {
    const result = LearningPipelineConfigSchema.safeParse({ periodic_review_interval_hours: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects max_patterns_per_goal below 1", () => {
    const result = LearningPipelineConfigSchema.safeParse({ max_patterns_per_goal: 0 });
    expect(result.success).toBe(false);
  });
});
