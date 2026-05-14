import { describe, expect, it } from "vitest";
import {
  createProactivePolicyState,
  decideProactiveDelivery,
  decideProactiveThreshold,
  projectProactiveThresholdDecisionForSurface,
  ProactiveThresholdInputSchema,
  reduceProactivePolicyState,
  type ProactiveInterruptionBudget,
  type ProactiveThresholdInput,
} from "../index.js";

describe("proactive policy state", () => {
  const budget: ProactiveInterruptionBudget = {
    budget_id: "budget:gateway:2026-05-14T00",
    scope: "surface",
    surface: "gateway",
    window_started_at: "2026-05-14T00:00:00.000Z",
    window_ends_at: "2026-05-14T01:00:00.000Z",
    max_notify: 1,
    max_ask: 1,
    max_prepare: 1,
    current_debits: 0,
    quiet_mode_active: false,
  };

  function thresholdInput(input: Partial<ProactiveThresholdInput> = {}): ProactiveThresholdInput {
    return ProactiveThresholdInputSchema.parse({
      candidate_ref: { kind: "candidate", ref: "candidate:proactive:1" },
      expected_user_value: 0.56,
      interruption_cost: 0.4,
      urgency: "medium",
      confidence: 0.61,
      reversibility: "none",
      operation_boundary: "allowed",
      side_effect_profile: "read",
      privacy_profile: "workspace_private",
      recent_feedback_refs: [],
      channel_budget_ref: { kind: "interruption_budget", ref: budget.budget_id },
      quieting_active: false,
      stale_target_refs: [],
      downstream_authorization_refs: [],
      ...input,
    });
  }

  it("narrows future proactive delivery after overreach feedback", () => {
    const initial = createProactivePolicyState({
      policyId: "policy:resident",
      now: "2026-05-14T00:00:00.000Z",
      maxDeliveryKind: "suggest",
    });
    const narrowed = reduceProactivePolicyState(initial, {
      kind: "feedback",
      feedback_ref: { kind: "feedback", ref: "feedback:overreach" },
      feedback_kind: "overreach",
      recorded_at: "2026-05-14T00:01:00.000Z",
    });
    const decision = decideProactiveDelivery({
      state: narrowed,
      requestedDeliveryKind: "suggest",
      candidateCreatedAt: "2026-05-14T00:02:00.000Z",
    });

    expect(narrowed).toMatchObject({
      max_delivery_kind: "hold",
      cooldown_refs: [{ kind: "feedback", ref: "feedback:overreach" }],
      runtime_authority: false,
    });
    expect(decision).toMatchObject({
      requested_delivery_kind: "suggest",
      allowed_delivery_kind: "hold",
      reason: "cooldown",
      runtime_authority: false,
    });
  });

  it("does not flush old proactive backlog after quiet mode lifts", () => {
    const initial = createProactivePolicyState({
      policyId: "policy:resident",
      now: "2026-05-14T00:00:00.000Z",
      maxDeliveryKind: "suggest",
    });
    const quiet = reduceProactivePolicyState(initial, {
      kind: "quiet_entered",
      control_ref: { kind: "runtime_control", ref: "quiet:on" },
      recorded_at: "2026-05-14T00:01:00.000Z",
    });
    const active = reduceProactivePolicyState(quiet, {
      kind: "quiet_lifted",
      control_ref: { kind: "runtime_control", ref: "quiet:off" },
      recorded_at: "2026-05-14T00:10:00.000Z",
    });

    expect(decideProactiveDelivery({
      state: active,
      requestedDeliveryKind: "suggest",
      candidateCreatedAt: "2026-05-14T00:05:00.000Z",
    })).toMatchObject({
      allowed_delivery_kind: "hold",
      reason: "no_backlog_flush",
    });
    expect(decideProactiveDelivery({
      state: active,
      requestedDeliveryKind: "suggest",
      candidateCreatedAt: "2026-05-14T00:11:00.000Z",
    })).toMatchObject({
      allowed_delivery_kind: "digest",
      reason: "allowed",
    });
  });

  it("compares quiet-lift no-backlog cutoffs as instants", () => {
    const initial = createProactivePolicyState({
      policyId: "policy:resident",
      now: "2026-05-14T00:00:00.000Z",
      maxDeliveryKind: "suggest",
    });
    const active = reduceProactivePolicyState(initial, {
      kind: "quiet_lifted",
      control_ref: { kind: "runtime_control", ref: "quiet:off" },
      recorded_at: "2026-05-14T00:10:00Z",
    });

    expect(decideProactiveDelivery({
      state: active,
      requestedDeliveryKind: "suggest",
      candidateCreatedAt: "2026-05-14T00:10:00.500Z",
    })).toMatchObject({
      allowed_delivery_kind: "suggest",
      reason: "allowed",
    });
    expect(decideProactiveDelivery({
      state: active,
      requestedDeliveryKind: "suggest",
      candidateCreatedAt: "2026-05-14T00:09:59.999Z",
    })).toMatchObject({
      allowed_delivery_kind: "hold",
      reason: "no_backlog_flush",
    });
  });

  it("does not relax hold feedback when quiet mode lifts", () => {
    const initial = createProactivePolicyState({
      policyId: "policy:resident",
      now: "2026-05-14T00:00:00.000Z",
      maxDeliveryKind: "suggest",
    });
    const held = reduceProactivePolicyState(initial, {
      kind: "feedback",
      feedback_ref: { kind: "feedback", ref: "feedback:overreach" },
      feedback_kind: "overreach",
      recorded_at: "2026-05-14T00:01:00.000Z",
    });
    const quiet = reduceProactivePolicyState(held, {
      kind: "quiet_entered",
      control_ref: { kind: "runtime_control", ref: "quiet:on" },
      recorded_at: "2026-05-14T00:02:00.000Z",
    });
    const active = reduceProactivePolicyState(quiet, {
      kind: "quiet_lifted",
      control_ref: { kind: "runtime_control", ref: "quiet:off" },
      recorded_at: "2026-05-14T00:10:00.000Z",
    });

    expect(active.max_delivery_kind).toBe("hold");
    expect(decideProactiveDelivery({
      state: active,
      requestedDeliveryKind: "suggest",
      candidateCreatedAt: "2026-05-14T00:11:00.000Z",
    })).toMatchObject({
      allowed_delivery_kind: "hold",
      reason: "cooldown",
      reason_refs: [{ kind: "feedback", ref: "feedback:overreach" }],
    });
  });

  it("uses helpful_nudge as active default and allows normal suggestions without execution authority", () => {
    const state = createProactivePolicyState({
      policyId: "policy:resident",
      now: "2026-05-14T00:00:00.000Z",
      budget,
    });

    const decision = decideProactiveThreshold({
      state,
      thresholdInput: thresholdInput(),
      candidateCreatedAt: "2026-05-14T00:01:00.000Z",
    });

    expect(state.default_profile).toMatchObject({
      profile_id: "helpful_nudge",
      default_max_delivery_kind: "suggest",
    });
    expect(decision).toMatchObject({
      requested_delivery_kind: "suggest",
      allowed_delivery_kind: "suggest",
      display_delivery_kind: "suggest",
      budget_debit: 0,
      runtime_authority: false,
    });
  });

  it("covers threshold cutoffs below and at digest, suggest, notify, and product ask", () => {
    const state = createProactivePolicyState({
      policyId: "policy:resident",
      now: "2026-05-14T00:00:00.000Z",
      maxDeliveryKind: "speak",
      budget,
    });

    expect(decideProactiveThreshold({
      state,
      thresholdInput: thresholdInput({ expected_user_value: 0.34, confidence: 0.5, interruption_cost: 0.75 }),
      candidateCreatedAt: "2026-05-14T00:01:00.000Z",
    })).toMatchObject({
      allowed_delivery_kind: "hold",
      downgrade_reasons: ["below_digest_threshold"],
    });
    expect(decideProactiveThreshold({
      state,
      thresholdInput: thresholdInput({ expected_user_value: 0.35, confidence: 0.5, interruption_cost: 0.75 }),
      candidateCreatedAt: "2026-05-14T00:01:00.000Z",
    })).toMatchObject({ allowed_delivery_kind: "digest" });
    expect(decideProactiveThreshold({
      state,
      thresholdInput: thresholdInput({ expected_user_value: 0.55, confidence: 0.6, interruption_cost: 0.65 }),
      candidateCreatedAt: "2026-05-14T00:01:00.000Z",
    })).toMatchObject({ allowed_delivery_kind: "suggest" });
    expect(decideProactiveThreshold({
      state,
      thresholdInput: thresholdInput({ expected_user_value: 0.65, confidence: 0.7, interruption_cost: 0.8, urgency: "high" }),
      candidateCreatedAt: "2026-05-14T00:01:00.000Z",
    })).toMatchObject({ allowed_delivery_kind: "notify" });
    expect(decideProactiveThreshold({
      state,
      thresholdInput: thresholdInput({
        expected_user_value: 0.6,
        confidence: 0.65,
        interruption_cost: 0.75,
        requires_user_decision_ref: { kind: "decision", ref: "decision:missing-context" },
      }),
      candidateCreatedAt: "2026-05-14T00:01:00.000Z",
    })).toMatchObject({
      allowed_delivery_kind: "speak",
      display_delivery_kind: "ask",
      budget_debit: 1,
    });
  });

  it("keeps accepted feedback narrow and never raises delivery, budget, prepare, or execute authority", () => {
    const initial = createProactivePolicyState({
      policyId: "policy:resident",
      now: "2026-05-14T00:00:00.000Z",
      maxDeliveryKind: "digest",
      budget,
    });
    const accepted = reduceProactivePolicyState(initial, {
      kind: "feedback",
      feedback_ref: { kind: "feedback", ref: "feedback:accepted" },
      feedback_kind: "accepted",
      recorded_at: "2026-05-14T00:01:00.000Z",
    });

    const decision = decideProactiveThreshold({
      state: accepted,
      thresholdInput: thresholdInput({
        expected_user_value: 0.9,
        confidence: 0.95,
        interruption_cost: 0.2,
        urgency: "deadline",
        requested_delivery_kind: "execute",
        downstream_authorization_refs: [{ kind: "approval", ref: "approval:downstream" }],
      }),
      candidateCreatedAt: "2026-05-14T00:02:00.000Z",
    });

    expect(accepted.max_delivery_kind).toBe("digest");
    expect(decision).toMatchObject({
      requested_delivery_kind: "execute",
      allowed_delivery_kind: "hold",
      budget_debit: 0,
      feedback_policy_refs: [{ kind: "feedback", ref: "feedback:accepted" }],
      runtime_authority: false,
    });
    expect(decision.downgrade_reasons).toContain("resident_cognition_cannot_grant_execute");
  });

  it("requires local reversible current boundary before prepare", () => {
    const state = createProactivePolicyState({
      policyId: "policy:resident",
      now: "2026-05-14T00:00:00.000Z",
      maxDeliveryKind: "prepare",
      budget,
    });

    expect(decideProactiveThreshold({
      state,
      thresholdInput: thresholdInput({
        expected_user_value: 0.75,
        confidence: 0.75,
        interruption_cost: 0.5,
        reversibility: "hard",
        side_effect_profile: "external_write",
        prepared_artifact_ref: { kind: "artifact", ref: "prep:unsafe" },
      }),
      candidateCreatedAt: "2026-05-14T00:01:00.000Z",
    })).toMatchObject({
      allowed_delivery_kind: "suggest",
      downgrade_reasons: ["prepare_requires_local_reversible_current_boundary"],
    });

    expect(decideProactiveThreshold({
      state,
      thresholdInput: thresholdInput({
        expected_user_value: 0.75,
        confidence: 0.75,
        interruption_cost: 0.5,
        reversibility: "easy",
        side_effect_profile: "local_write",
        prepared_artifact_ref: { kind: "artifact", ref: "prep:local" },
      }),
      candidateCreatedAt: "2026-05-14T00:01:00.000Z",
    })).toMatchObject({
      allowed_delivery_kind: "prepare",
      budget_debit: 1,
    });
  });

  it("rejects stale two-turn approval targets before asking again", () => {
    const state = createProactivePolicyState({
      policyId: "policy:resident",
      now: "2026-05-14T00:00:00.000Z",
      maxDeliveryKind: "speak",
      budget,
    });
    const oldTarget = { kind: "goal", ref: "goal:old" };

    expect(decideProactiveThreshold({
      state,
      thresholdInput: thresholdInput({
        expected_user_value: 0.6,
        confidence: 0.65,
        interruption_cost: 0.75,
        target_ref: oldTarget,
        requires_approval_ref: { kind: "approval", ref: "approval:old-target" },
      }),
      candidateCreatedAt: "2026-05-14T00:01:00.000Z",
    })).toMatchObject({
      allowed_delivery_kind: "speak",
      display_delivery_kind: "ask",
    });

    expect(decideProactiveThreshold({
      state,
      thresholdInput: thresholdInput({
        expected_user_value: 0.6,
        confidence: 0.65,
        interruption_cost: 0.75,
        target_ref: oldTarget,
        stale_target_refs: [oldTarget],
        requires_approval_ref: { kind: "approval", ref: "approval:old-target" },
      }),
      candidateCreatedAt: "2026-05-14T00:02:00.000Z",
    })).toMatchObject({
      allowed_delivery_kind: "hold",
      downgrade_reasons: ["stale_target_rejected"],
    });
  });

  it("lets interruption budget only downgrade and projects normal/operator views without raw policy leakage", () => {
    const exhaustedBudget = {
      ...budget,
      current_debits: 1,
    };
    const state = createProactivePolicyState({
      policyId: "policy:resident",
      now: "2026-05-14T00:00:00.000Z",
      maxDeliveryKind: "notify",
      budget: exhaustedBudget,
    });

    const decision = decideProactiveThreshold({
      state,
      thresholdInput: thresholdInput({
        expected_user_value: 0.65,
        confidence: 0.7,
        interruption_cost: 0.8,
        urgency: "deadline",
        recent_feedback_refs: [{ kind: "feedback", ref: "feedback:recent-dismissal" }],
      }),
      candidateCreatedAt: "2026-05-14T00:01:00.000Z",
    });
    const normal = projectProactiveThresholdDecisionForSurface({
      decision,
      surfaceTarget: "normal_user",
      budget: exhaustedBudget,
    });
    const operator = projectProactiveThresholdDecisionForSurface({
      decision,
      surfaceTarget: "operator_debug",
      budget: exhaustedBudget,
    });

    expect(decision).toMatchObject({
      requested_delivery_kind: "notify",
      allowed_delivery_kind: "digest",
      downgrade_reasons: ["interruption_budget_exhausted"],
    });
    expect(normal.operator_refs).toBeUndefined();
    expect(operator.operator_refs?.feedback_policy_refs).toEqual([
      { kind: "feedback", ref: "feedback:recent-dismissal" },
    ]);
  });
});
