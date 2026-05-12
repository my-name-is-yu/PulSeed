import { describe, expect, it } from "vitest";
import type { CapabilityReadinessSnapshot } from "../../../platform/observation/types/capability.js";
import { evaluateAdmissionPolicy } from "../../control/admission-policy.js";
import {
  evaluateAutonomyDecision,
  type AutonomyDecisionInput,
  type AutonomyOperationPlanInput,
} from "../../control/autonomy-governor.js";
import { deriveCompanionStateSnapshot, CompanionStateReducerInputSchema } from "../../control/index.js";
import {
  createFeedbackIngestion,
  feedbackEffectsToAttentionFeedbackEvents,
  feedbackEffectsToAutonomyFeedbackSignals,
  feedbackEffectsToCompanionStateFeedbackRefs,
  feedbackEffectsToInvalidationEvidence,
  feedbackIngestionToAttentionInput,
  ref,
} from "../index.js";

const NOW = "2026-05-12T06:00:00.000Z";

function notificationOperation(overrides: Partial<AutonomyOperationPlanInput> = {}): AutonomyOperationPlanInput {
  return {
    operation_id: "notify.send",
    capability_id: "capability:notify",
    operation_kind: "send",
    provider_ref: "asset:notifier/telegram",
    payload_class: "notification_payload",
    side_effect_profile: "send",
    risk_class: "medium",
    privacy_profile: "user_visible",
    reversibility: "unknown",
    external_action_authority: true,
    target_refs: ["conversation:telegram"],
    ...overrides,
  };
}

function readiness(operation: AutonomyOperationPlanInput): CapabilityReadinessSnapshot {
  return {
    schema_version: "capability-readiness-snapshot/v1",
    snapshot_id: `readiness:${operation.operation_id}`,
    capability_id: operation.capability_id ?? `capability:${operation.operation_id}`,
    provider_ref: operation.provider_ref,
    asset_ref: operation.provider_ref,
    operation_id: operation.operation_id,
    operation_kind: operation.operation_kind,
    tool_name: operation.operation_id,
    payload_class: operation.payload_class,
    risk_class: operation.risk_class ?? "medium",
    side_effect_profile: operation.side_effect_profile,
    evaluated_at: NOW,
    state: "executable_verified",
    passed_gates: ["stored", "discoverable", "loadable", "compatible", "configured", "authenticated", "executable_verified"],
    failed_gates: [],
    degraded_gates: [],
    missing_config_refs: [],
    missing_auth_refs: [],
    verification_refs: [`verify:${operation.operation_id}`],
    evidence_refs: [`audit:${operation.operation_id}`],
    stale_refs: [],
    safe_user_visible_label: "Execution substrate verified",
    metadata: {},
  };
}

function allowedAdmission(operation: AutonomyOperationPlanInput) {
  return evaluateAdmissionPolicy({
    operation: {
      operation_id: operation.operation_id,
      capability_id: operation.capability_id,
      operation_kind: operation.operation_kind,
      provider_ref: operation.provider_ref,
      payload_class: operation.payload_class,
      side_effect_profile: operation.side_effect_profile,
      external_action_authority: operation.external_action_authority,
      required_permission_capabilities: [],
      target_refs: operation.target_refs,
    },
    actor: {
      surface: "chat",
      platform: "telegram",
      conversation_id: "conversation:telegram",
      identity_key: "user:yu",
      user_id: "user:yu",
    },
    surface: {
      surface_ref: "surface:telegram",
      channel: "chat",
      platform: "telegram",
      session_ref: "session:telegram",
    },
    notificationPolicy: [{
      ref: "notification:allowed",
      result: "allowed",
      reason: "Notification policy allowed this operation after admission.",
    }],
    authState: {
      ref: "auth:current",
      status: "valid",
    },
    evaluatedAt: NOW,
  });
}

function baseInput(operation: AutonomyOperationPlanInput): AutonomyDecisionInput {
  return {
    operation_plan: operation,
    readiness_snapshots: [readiness(operation)],
    admission_evaluation: allowedAdmission(operation),
    auth_state: {
      ref: "auth:current",
      status: "valid",
    },
    active_surface_ref: "surface:telegram",
    blast_radius: "external",
    privacy_sensitivity: "medium",
    external_side_effect: true,
    evaluated_at: NOW,
  };
}

function companionReducerInput(feedbackRefs: string[]) {
  return CompanionStateReducerInputSchema.parse({
    schema_version: "companion-state-reducer-input-v1",
    runtime_items: [],
    recent_runtime_events: [],
    active_surface_ref: "surface:telegram",
    surface_invalidation_events: [],
    global_control_state_ref: "global-control:feedback-test",
    global_controls: [],
    active_goal_refs: [],
    active_watch_refs: [],
    active_wait_refs: [],
    active_quiet_work_refs: [],
    attention_history_refs: [],
    control_overlays: [],
    pre_suspend_mode: null,
    authority_blockers: [],
    staleness_blockers: [],
    safety_blockers: [],
    user_activity_refs: ["activity:recent"],
    feedback_refs: feedbackRefs,
    safety_context_refs: [],
    event_high_watermark: "event:feedback-test",
    current_time: NOW,
  });
}

describe("FeedbackIngestion", () => {
  it("turns dismissals into feedback attention inputs and future cooling-down state", () => {
    const result = createFeedbackIngestion({
      source: "gateway",
      feedback_kind: "surface_dismissal",
      outcome: "dismissed",
      target: {
        kind: "surface",
        id: "telegram-thread",
      },
      recorded_at: NOW,
      reason: "User dismissed the proactive surface.",
      route: "express_to_user",
    });

    const attention = feedbackIngestionToAttentionInput(result);
    expect(attention.source.source_kind).toBe("feedback");
    expect(attention.effect_policy).toEqual({
      wake: true,
      notify: false,
      speak: false,
      act: false,
    });
    expect(result.effects.map((effect) => effect.effect_kind)).toEqual(expect.arrayContaining([
      "attention_feedback",
      "attention_cooldown",
      "surface_invalidation",
    ]));

    const feedbackRefs = feedbackEffectsToCompanionStateFeedbackRefs(result.effects);
    const before = deriveCompanionStateSnapshot(companionReducerInput([]));
    const after = deriveCompanionStateSnapshot(companionReducerInput(feedbackRefs));
    expect(before.derivation_trace.threshold_changes).not.toContain("recent_feedback_raised_expression_threshold");
    expect(after.derivation_trace.threshold_changes).toContain("recent_feedback_raised_expression_threshold");
    expect(after.expression_thresholds.user_facing_expression).toBeGreaterThan(before.expression_thresholds.user_facing_expression);
  });

  it("turns corrections into attention feedback plus surface invalidation evidence", () => {
    const result = createFeedbackIngestion({
      source: "chat",
      feedback_kind: "surface_correction",
      outcome: "corrected",
      target: {
        kind: "surface",
        id: "tui-session",
      },
      recorded_at: NOW,
      reason: "That summary was for the wrong repo.",
      route: "express_to_user",
      urge_origin: "runtime_event",
    });

    expect(feedbackEffectsToAttentionFeedbackEvents(result.effects)).toEqual([
      expect.objectContaining({
        kind: "correction",
        route: "express_to_user",
      }),
    ]);
    expect(feedbackEffectsToAutonomyFeedbackSignals(result.effects)).toEqual([
      expect.objectContaining({
        outcome: "corrected",
        policy_adjustment: "require_confirmation",
      }),
    ]);
    expect(feedbackEffectsToInvalidationEvidence(result.effects)).toEqual([
      expect.objectContaining({
        kind: "correction",
        ref: "surface:tui-session:",
        reason: "That summary was for the wrong repo.",
      }),
    ]);
  });

  it("turns permission revocation into revocation evidence and future approval-required autonomy", () => {
    const result = createFeedbackIngestion({
      source: "telegram",
      feedback_kind: "permission_revoked",
      outcome: "permission_revoked",
      target: {
        kind: "permission_grant",
        id: "notify-standing",
      },
      permission_ref: ref("permission_grant", "notify-standing"),
      recorded_at: NOW,
      reason: "Do not use this standing notification permission anymore.",
      route: "request_approval",
    });

    expect(result.effects.map((effect) => effect.effect_kind)).toEqual(expect.arrayContaining([
      "permission_narrowing",
      "surface_invalidation",
    ]));
    expect(feedbackEffectsToInvalidationEvidence(result.effects)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "revocation",
        ref: "permission_grant:notify-standing:",
      }),
    ]));

    const operation = notificationOperation();
    const decision = evaluateAutonomyDecision({
      ...baseInput(operation),
      recent_feedback: feedbackEffectsToAutonomyFeedbackSignals(result.effects),
      invalidation_evidence: feedbackEffectsToInvalidationEvidence(result.effects),
    });

    expect(decision.level).toBe("prohibited");
    expect(decision.required_user_approval).toBe(false);
    expect(decision.blocked_steps).toEqual(expect.arrayContaining([
      "reuse_cached_decision",
    ]));
  });

  it("keeps positive feedback as reinforcement without granting external authority", () => {
    const result = createFeedbackIngestion({
      source: "runtime",
      feedback_kind: "runtime_outcome",
      outcome: "runtime_success",
      target: {
        kind: "runtime_operation",
        id: "notify.send",
      },
      runtime_ref: "runtime-item:notify-success",
      recorded_at: NOW,
      follow_through_success: true,
      reason: "The prepared summary was useful.",
      profile_proposal_refs: ["profile-proposal:success-pattern"],
    });

    expect(result.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        effect_kind: "positive_reinforcement",
        payload: expect.objectContaining({
          authority_delta: "none",
        }),
      }),
      expect.objectContaining({
        effect_kind: "profile_proposal_recommendation",
        payload: expect.objectContaining({
          requires_approval: true,
          authority_delta: "none",
        }),
      }),
    ]));
    expect(feedbackEffectsToCompanionStateFeedbackRefs(result.effects)).toEqual([]);

    const operation = notificationOperation();
    const decision = evaluateAutonomyDecision({
      ...baseInput(operation),
      trust_profile: {
        ref: "trust:telegram-high",
        provider_ref: "asset:notifier/telegram",
        trust_level: "high",
        positive_feedback_refs: ["feedback:runtime-success"],
      },
      recent_feedback: feedbackEffectsToAutonomyFeedbackSignals(result.effects),
    });

    expect(decision.level).toBe("approval_required");
    expect(decision.required_user_approval).toBe(true);
    expect(decision.blocked_steps).toEqual(expect.arrayContaining([
      "autonomous_initiate",
      "execute_without_approval",
    ]));
  });
});
