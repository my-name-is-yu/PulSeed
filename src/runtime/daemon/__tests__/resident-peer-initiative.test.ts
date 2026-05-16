import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { DaemonConfigSchema, DaemonStateSchema } from "../../types/daemon.js";
import type {
  GatewayOutboundConversationPort,
  OutboundConversationMessage,
  OutboundConversationSurface,
  OutboundConversationTarget,
} from "../../gateway/index.js";
import { upsertRelationshipProfileItem } from "../../../platform/profile/relationship-profile.js";
import {
  PeerInitiativeStore,
  generatePeerInitiativeCandidates,
} from "../../peer-initiative/index.js";
import {
  DEFAULT_RESIDENT_ACTIVATION_POLICY_ID,
  ProactivePolicyStateStore,
  ResidentActivationStore,
} from "../../store/index.js";
import { ref } from "../../attention/attention-refs.js";
import { evaluateResidentOperationBoundary } from "../../capability-operation-planner.js";
import { OutcomeDecisionSchema } from "../../types/companion-autonomy.js";
import {
  proactiveTick,
  triggerResidentPeerInitiative,
} from "../runner-resident-proactive.js";

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

class FakeOutboundConversationPort implements GatewayOutboundConversationPort {
  readonly surface = "telegram" as const;
  readonly messages: OutboundConversationMessage[] = [];

  async resolveDefaultTarget(): Promise<OutboundConversationTarget> {
    return {
      surface: "telegram",
      target_binding_ref: "gateway:telegram:home_chat:12345",
      channel_policy_ref: "gateway:telegram:telegram-bot:outbound-conversation-policy",
    };
  }

  async sendOutboundConversationMessage(message: OutboundConversationMessage) {
    this.messages.push(message);
    return {
      message_id: message.message_id,
      surface: "telegram" as const,
      target_binding_ref: message.target_binding_ref,
      delivered_at: "2026-05-15T00:00:01.000Z",
      transport_message_ref: "telegram:77",
    };
  }
}

describe("resident peer initiative caller path", () => {
  it("runs resident proactive tick into a Telegram outbound conversation without a direct user prompt", async () => {
    const baseDir = makeTempDir("resident-peer-initiative-");
    const gatewayPort = new FakeOutboundConversationPort();
    await upsertRelationshipProfileItem(baseDir, {
      stableKey: "peer-initiative-test-context",
      kind: "preference",
      value: "Low-pressure peer initiative messages are allowed when they reduce current load.",
      source: "setup_user",
      allowedScopes: ["resident_behavior"],
      sensitivity: "private",
      now: "2026-05-15T00:00:00.000Z",
    });
    const state = DaemonStateSchema.parse({
      pid: 123,
      started_at: "2026-05-15T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 4,
      active_goals: [],
      status: "idle",
      runtime_root: path.join(baseDir, "runtime"),
      last_resident_at: null,
      resident_activity: null,
    });
    const llmClient = {
      sendMessage: vi.fn(async () => ({
        content: JSON.stringify({
          action: "peer_initiative",
          details: {
            peer_initiative: {
              kind: "attention_preparation",
              message: "今日も頑張ってね。最低限版だけ作っておくね。",
              action_plan: {
                mode: "internal_preparation",
                preparation_kind: "minimum_viable_plan",
                prepared_artifact_ref: "peer-artifact:min-plan",
                permission_required: false,
                user_visible_trigger: "show_me",
              },
              worthiness: {
                can_be_valuable_without_reply: true,
                user_cognitive_load: "low",
                reply_pressure: "none",
                care_value: "high",
                attention_fit: "strong",
                concrete_helpfulness: "high",
                self_serving_risk: "none",
                tutorial_risk: "none",
              },
              need_signals: [{
                signal_id: "need:min-plan",
                kind: "decision_load_high",
                created_at: "2026-05-15T00:00:00.000Z",
                attention_signal_refs: ["attention:external"],
                confidence: 0.85,
                summary: "Current attention suggests a smaller next shape would reduce load.",
              }],
            },
          },
        }),
      })),
      parseJSON: vi.fn((content: string) => JSON.parse(content) as unknown),
    };

    const context = {
      baseDir,
      config: DaemonConfigSchema.parse({
        proactive_mode: true,
        proactive_interval_ms: 1,
        goal_review_interval_ms: 7 * 24 * 60 * 60 * 1000,
        runtime_root: path.join(baseDir, "runtime"),
      }),
      llmClient: llmClient as never,
      state,
      logger: logger() as never,
      saveDaemonState: vi.fn(async () => {}),
      curiosityEngine: undefined,
      stateManager: {
        listGoalIds: vi.fn(async () => []),
        loadGoal: vi.fn(async () => null),
      } as never,
      goalNegotiator: undefined,
      currentGoalIds: [],
      supervisor: undefined,
      gateway: {
        getOutboundConversationPort: (surface: OutboundConversationSurface) => surface === "telegram" ? gatewayPort : undefined,
      },
      refreshOperationalState: vi.fn(),
      abortSleep: vi.fn(),
      scheduleEngine: undefined,
      knowledgeManager: undefined,
      memoryLifecycle: undefined,
      driveSystem: { writeEvent: vi.fn(async () => {}) } as never,
      attentionStateStore: {
        saveCycle: vi.fn(async () => null),
      },
      feedbackIngestionStore: {
        listEffects: vi.fn(async () => []),
      },
    };

    await proactiveTick(
      context,
      0,
      () => {},
      Date.now(),
      () => {},
    );

    expect(gatewayPort.messages).toHaveLength(1);
    expect(gatewayPort.messages[0]).toMatchObject({
      source: "peer_initiative",
      text: "今日も頑張ってね。最低限版だけ作っておくね。",
      reply_required: false,
      trigger_actions: [expect.objectContaining({ action: "show_prepared" })],
      feedback_actions: expect.arrayContaining([
        expect.objectContaining({ action: "less_like_this" }),
        expect.objectContaining({ action: "wrong_read" }),
      ]),
    });
    expect(JSON.stringify(gatewayPort.messages[0])).not.toContain("raw_content_allowed");
    expect(JSON.stringify(gatewayPort.messages[0])).not.toContain("visibility-policy-v1");
    expect(state.resident_activity).toMatchObject({
      kind: "observation",
      peer_initiative_delivery_status: "delivered",
      peer_initiative_threshold_delivery_kind: "notify",
      peer_prepared_artifact_ref: "peer-artifact:min-plan",
    });
    const records = await new PeerInitiativeStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir })
      .listRecentCandidates();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "attention_preparation",
      selected_state: "notified",
      delivered_at: expect.any(String),
    });

    await proactiveTick(
      context,
      0,
      () => {},
      Date.now(),
      () => {},
    );

    expect(gatewayPort.messages).toHaveLength(1);
  });

  it("keeps digest-only peer initiatives out of outbound chat delivery", async () => {
    const baseDir = makeTempDir("resident-peer-initiative-digest-");
    const gatewayPort = new FakeOutboundConversationPort();
    const state = DaemonStateSchema.parse({
      pid: 123,
      started_at: "2026-05-15T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 4,
      active_goals: [],
      status: "idle",
      runtime_root: path.join(baseDir, "runtime"),
      last_resident_at: null,
      resident_activity: null,
    });
    const details = {
      peer_initiative: {
        kind: "care_presence",
        message: "今日も頑張ってね。",
        max_delivery_kind: "digest",
        action_plan: {
          mode: "care_only",
          permission_required: false,
        },
        worthiness: {
          can_be_valuable_without_reply: true,
          user_cognitive_load: "low",
          reply_pressure: "none",
          care_value: "high",
          attention_fit: "medium",
          concrete_helpfulness: "medium",
          self_serving_risk: "none",
          tutorial_risk: "none",
        },
      },
    };
    const outcomeDecision = OutcomeDecisionSchema.parse({
      outcome_decision_id: "outcome:peer:digest",
      initiative_decision_ref: ref("initiative_gate_decision", "gate:peer:digest"),
      decided_at: "2026-05-15T00:00:00.000Z",
      requested_outcome: "express_to_user",
      admission_status: "admitted",
      final_outcome: "express_to_user",
      visibility_policy_ref: ref("visibility_policy", "visibility:peer:digest"),
    });
    const attentionAdmission = {
      action: "peer_initiative",
      source_kind: "resident_proactive_maintenance",
      attention_input_id: "attention:peer:digest",
      signal_context_id: "signal:peer:digest",
      urge_id: "urge:peer:digest",
      agenda_item_id: "agenda:peer:digest",
      inhibition_decision_id: "inhibition:peer:digest",
      initiative_gate_decision_id: "gate:peer:digest",
      outcome_decision_id: outcomeDecision.outcome_decision_id,
      outcome_decision: outcomeDecision,
      replay_disposition: "accepted",
      requested_outcome: "express_to_user",
      admission_status: "admitted",
      final_outcome: "express_to_user",
      branch_admitted: true,
      summary: "Resident peer initiative admitted for expression, then downgraded by threshold.",
    };
    const operationBoundary = evaluateResidentOperationBoundary({
      admission: attentionAdmission as never,
      assembledAt: "2026-05-15T00:00:00.000Z",
      details,
    });

    const context = {
      baseDir,
      config: DaemonConfigSchema.parse({
        proactive_mode: true,
        proactive_interval_ms: 1,
        goal_review_interval_ms: 7 * 24 * 60 * 60 * 1000,
        runtime_root: path.join(baseDir, "runtime"),
      }),
      state,
      logger: logger() as never,
      saveDaemonState: vi.fn(async () => {}),
      gateway: {
        getOutboundConversationPort: (surface: OutboundConversationSurface) => surface === "telegram" ? gatewayPort : undefined,
      },
    };

    await triggerResidentPeerInitiative(
      context,
      details,
      {
        attentionAdmission: attentionAdmission as never,
        operationBoundary,
        selectionSurfaceRef: "surface:relationship-profile:peer:digest",
        metadata: {},
      },
    );

    expect(gatewayPort.messages).toHaveLength(0);
    expect(state.resident_activity).toMatchObject({
      kind: "skipped",
      peer_initiative_delivery_status: "held",
      peer_initiative_threshold_delivery_kind: "digest",
    });
    const records = await new PeerInitiativeStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir })
      .listRecentCandidates();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "care_presence",
      selected_state: "digested",
    });
  });

  it("uses persisted proactive policy feedback in the resident peer initiative caller path", async () => {
    const baseDir = makeTempDir("resident-peer-initiative-policy-state-");
    const gatewayPort = new FakeOutboundConversationPort();
    const runtimeRoot = path.join(baseDir, "runtime");
    const activationStore = new ResidentActivationStore(runtimeRoot, { controlBaseDir: baseDir });
    const proposal = await activationStore.propose({
      requestedMaxDeliveryKind: "notify",
      dogfoodDurationHours: 168,
      now: "2026-05-15T00:00:00.000Z",
    });
    const binding = await activationStore.accept(proposal.proposal_id, "2026-05-15T00:00:01.000Z");
    const policyStore = new ProactivePolicyStateStore(runtimeRoot, { controlBaseDir: baseDir });
    await policyStore
      .applyEvents({
        policyId: DEFAULT_RESIDENT_ACTIVATION_POLICY_ID,
        now: "2026-05-15T00:00:00.000Z",
        maxDeliveryKind: "suggest",
        events: [{
          kind: "feedback",
          feedback_ref: { kind: "peer_feedback_projection", ref: "peer-feedback:not-now" },
          feedback_kind: "dismissed",
          recorded_at: "2026-05-15T00:00:01.000Z",
        }],
      });
    const state = DaemonStateSchema.parse({
      pid: 123,
      started_at: "2026-05-15T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 4,
      active_goals: [],
      status: "idle",
      runtime_root: runtimeRoot,
      last_resident_at: null,
      resident_activity: null,
    });
    const details = {
      peer_initiative: {
        kind: "care_presence",
        message: "今日も頑張ってね。",
        max_delivery_kind: "notify",
        action_plan: {
          mode: "care_only",
          permission_required: false,
        },
        worthiness: {
          can_be_valuable_without_reply: true,
          user_cognitive_load: "low",
          reply_pressure: "none",
          care_value: "high",
          attention_fit: "strong",
          concrete_helpfulness: "high",
          self_serving_risk: "none",
          tutorial_risk: "none",
        },
      },
    };
    const outcomeDecision = OutcomeDecisionSchema.parse({
      outcome_decision_id: "outcome:peer:policy-state",
      initiative_decision_ref: ref("initiative_gate_decision", "gate:peer:policy-state"),
      decided_at: "2026-05-15T00:00:00.000Z",
      requested_outcome: "express_to_user",
      admission_status: "admitted",
      final_outcome: "express_to_user",
      visibility_policy_ref: ref("visibility_policy", "visibility:peer:policy-state"),
    });
    const attentionAdmission = {
      action: "peer_initiative",
      source_kind: "resident_proactive_maintenance",
      attention_input_id: "attention:peer:policy-state",
      signal_context_id: "signal:peer:policy-state",
      urge_id: "urge:peer:policy-state",
      agenda_item_id: "agenda:peer:policy-state",
      inhibition_decision_id: "inhibition:peer:policy-state",
      initiative_gate_decision_id: "gate:peer:policy-state",
      outcome_decision_id: outcomeDecision.outcome_decision_id,
      outcome_decision: outcomeDecision,
      replay_disposition: "accepted",
      requested_outcome: "express_to_user",
      admission_status: "admitted",
      final_outcome: "express_to_user",
      branch_admitted: true,
      summary: "Resident peer initiative admitted for expression, then downgraded by stored feedback state.",
    };
    const operationBoundary = evaluateResidentOperationBoundary({
      admission: attentionAdmission as never,
      assembledAt: "2026-05-15T00:00:00.000Z",
      details,
    });

    await triggerResidentPeerInitiative(
      {
        baseDir,
        config: DaemonConfigSchema.parse({
          proactive_mode: true,
          proactive_interval_ms: 1,
          goal_review_interval_ms: 7 * 24 * 60 * 60 * 1000,
          runtime_root: path.join(baseDir, "runtime"),
        }),
        state,
        logger: logger() as never,
        saveDaemonState: vi.fn(async () => {}),
        gateway: {
          getOutboundConversationPort: (surface: OutboundConversationSurface) => surface === "telegram" ? gatewayPort : undefined,
        },
      },
      details,
      {
        attentionAdmission: attentionAdmission as never,
        operationBoundary,
        selectionSurfaceRef: "surface:relationship-profile:peer:policy-state",
        metadata: {},
      },
    );

    expect(gatewayPort.messages).toHaveLength(0);
    expect(state.resident_activity).toMatchObject({
      kind: "skipped",
      peer_initiative_delivery_status: "held",
      peer_initiative_threshold_delivery_kind: "digest",
    });
    const records = await new PeerInitiativeStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir })
      .listRecentCandidates();
    expect(records[0]).toMatchObject({
      kind: "care_presence",
      selected_state: "digested",
    });
    const storedPolicy = await policyStore.load(DEFAULT_RESIDENT_ACTIVATION_POLICY_ID);
    expect(storedPolicy).toMatchObject({
      max_delivery_kind: "digest",
      cooldown_refs: [{ kind: "peer_feedback_projection", ref: "peer-feedback:not-now" }],
      feedback_refs: [{ kind: "peer_feedback_projection", ref: "peer-feedback:not-now" }],
      interruption_budget: {
        budget_id: binding.interruption_budget.budget_id,
      },
    });
  });

  it("preserves resident activation budget debits in the resident peer initiative caller path", async () => {
    const baseDir = makeTempDir("resident-peer-initiative-budget-state-");
    const gatewayPort = new FakeOutboundConversationPort();
    const runtimeRoot = path.join(baseDir, "runtime");
    const activationStore = new ResidentActivationStore(runtimeRoot, { controlBaseDir: baseDir });
    const proposal = await activationStore.propose({
      requestedMaxDeliveryKind: "notify",
      dailyBudget: { max_notify: 1 },
      dogfoodDurationHours: 168,
      now: "2026-05-16T00:00:00.000Z",
    });
    const binding = await activationStore.accept(proposal.proposal_id, "2026-05-16T00:00:01.000Z");
    const policyStore = new ProactivePolicyStateStore(runtimeRoot, { controlBaseDir: baseDir });
    await policyStore.save({
      schema_version: "proactive-policy-state/v1",
      policy_id: DEFAULT_RESIDENT_ACTIVATION_POLICY_ID,
      mode: "active",
      max_delivery_kind: "notify",
      default_profile: {
        profile_id: "helpful_nudge",
        default_max_delivery_kind: "notify",
        digest_bias: "low_value_or_recently_dismissed",
        notify_requires: "high_urgency_or_deadline_risk",
        ask_requires: "missing_user_decision_or_exact_approval",
        prepare_requires: "local_reversible_current_boundary",
        execute_requires: "preauthorized_downstream_owner",
      },
      interruption_budget: {
        ...binding.interruption_budget,
        current_debits: 1,
      },
      cooldown_refs: [],
      feedback_refs: [],
      updated_at: "2026-05-15T00:00:02.000Z",
      runtime_authority: false,
    });
    const state = DaemonStateSchema.parse({
      pid: 123,
      started_at: "2026-05-15T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 4,
      active_goals: [],
      status: "idle",
      runtime_root: runtimeRoot,
      last_resident_at: null,
      resident_activity: null,
    });
    const details = {
      peer_initiative: {
        kind: "care_presence",
        message: "今日も頑張ってね。",
        max_delivery_kind: "notify",
        action_plan: {
          mode: "care_only",
          permission_required: false,
        },
        worthiness: {
          can_be_valuable_without_reply: true,
          user_cognitive_load: "low",
          reply_pressure: "none",
          care_value: "high",
          attention_fit: "strong",
          concrete_helpfulness: "high",
          self_serving_risk: "none",
          tutorial_risk: "none",
        },
      },
    };
    const outcomeDecision = OutcomeDecisionSchema.parse({
      outcome_decision_id: "outcome:peer:budget-state",
      initiative_decision_ref: ref("initiative_gate_decision", "gate:peer:budget-state"),
      decided_at: "2026-05-15T00:00:00.000Z",
      requested_outcome: "express_to_user",
      admission_status: "admitted",
      final_outcome: "express_to_user",
      visibility_policy_ref: ref("visibility_policy", "visibility:peer:budget-state"),
    });
    const attentionAdmission = {
      action: "peer_initiative",
      source_kind: "resident_proactive_maintenance",
      attention_input_id: "attention:peer:budget-state",
      signal_context_id: "signal:peer:budget-state",
      urge_id: "urge:peer:budget-state",
      agenda_item_id: "agenda:peer:budget-state",
      inhibition_decision_id: "inhibition:peer:budget-state",
      initiative_gate_decision_id: "gate:peer:budget-state",
      outcome_decision_id: outcomeDecision.outcome_decision_id,
      outcome_decision: outcomeDecision,
      replay_disposition: "accepted",
      requested_outcome: "express_to_user",
      admission_status: "admitted",
      final_outcome: "express_to_user",
      branch_admitted: true,
      summary: "Resident peer initiative admitted, then held by exhausted activation budget.",
    };
    const operationBoundary = evaluateResidentOperationBoundary({
      admission: attentionAdmission as never,
      assembledAt: "2026-05-15T00:00:00.000Z",
      details,
    });

    await triggerResidentPeerInitiative(
      {
        baseDir,
        config: DaemonConfigSchema.parse({
          proactive_mode: true,
          proactive_interval_ms: 1,
          goal_review_interval_ms: 7 * 24 * 60 * 60 * 1000,
          runtime_root: runtimeRoot,
        }),
        state,
        logger: logger() as never,
        saveDaemonState: vi.fn(async () => {}),
        gateway: {
          getOutboundConversationPort: (surface: OutboundConversationSurface) => surface === "telegram" ? gatewayPort : undefined,
        },
      },
      details,
      {
        attentionAdmission: attentionAdmission as never,
        operationBoundary,
        selectionSurfaceRef: "surface:relationship-profile:peer:budget-state",
        metadata: {},
      },
    );

    expect(gatewayPort.messages).toHaveLength(0);
    expect(state.resident_activity).toMatchObject({
      kind: "skipped",
      peer_initiative_delivery_status: "held",
      peer_initiative_threshold_delivery_kind: "digest",
    });
    const storedPolicy = await policyStore.load(DEFAULT_RESIDENT_ACTIVATION_POLICY_ID);
    expect(storedPolicy?.interruption_budget).toMatchObject({
      budget_id: binding.interruption_budget.budget_id,
      current_debits: 1,
      max_notify: 1,
    });
  });

  it("does not debit resident activation budget for an already pending peer delivery", async () => {
    const baseDir = makeTempDir("resident-peer-initiative-pending-budget-");
    const runtimeRoot = path.join(baseDir, "runtime");
    const now = "2026-05-16T00:10:00.000Z";
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(now));
      const gatewayPort = new FakeOutboundConversationPort();
      const activationStore = new ResidentActivationStore(runtimeRoot, { controlBaseDir: baseDir });
      const proposal = await activationStore.propose({
        requestedMaxDeliveryKind: "notify",
        dailyBudget: { max_notify: 2 },
        dogfoodDurationHours: 168,
        now: "2026-05-16T00:00:00.000Z",
      });
      const binding = await activationStore.accept(proposal.proposal_id, "2026-05-16T00:00:01.000Z");
      const state = DaemonStateSchema.parse({
        pid: 123,
        started_at: "2026-05-16T00:00:00.000Z",
        last_loop_at: null,
        loop_count: 4,
        active_goals: [],
        status: "idle",
        runtime_root: runtimeRoot,
        last_resident_at: null,
        resident_activity: null,
      });
      const details = {
        peer_initiative: {
          kind: "care_presence",
          message: "今日も頑張ってね。",
          max_delivery_kind: "notify",
          action_plan: {
            mode: "care_only",
            permission_required: false,
          },
          worthiness: {
            can_be_valuable_without_reply: true,
            user_cognitive_load: "low",
            reply_pressure: "none",
            care_value: "high",
            attention_fit: "strong",
            concrete_helpfulness: "high",
            self_serving_risk: "none",
            tutorial_risk: "none",
          },
          need_signals: [{
            signal_id: "need:peer:pending-budget",
            kind: "care_presence_appropriate",
            created_at: now,
            attention_signal_refs: ["attention:peer:pending-budget"],
            confidence: 0.85,
            summary: "Existing pending delivery should not consume a second budget debit.",
          }],
        },
      };
      const outcomeDecision = OutcomeDecisionSchema.parse({
        outcome_decision_id: "outcome:peer:pending-budget",
        initiative_decision_ref: ref("initiative_gate_decision", "gate:peer:pending-budget"),
        decided_at: now,
        requested_outcome: "express_to_user",
        admission_status: "admitted",
        final_outcome: "express_to_user",
        visibility_policy_ref: ref("visibility_policy", "visibility:peer:pending-budget"),
      });
      const attentionAdmission = {
        action: "peer_initiative",
        source_kind: "resident_proactive_maintenance",
        attention_input_id: "attention:peer:pending-budget",
        signal_context_id: "signal:peer:pending-budget",
        urge_id: "urge:peer:pending-budget",
        agenda_item_id: "agenda:peer:pending-budget",
        inhibition_decision_id: "inhibition:peer:pending-budget",
        initiative_gate_decision_id: "gate:peer:pending-budget",
        outcome_decision_id: outcomeDecision.outcome_decision_id,
        outcome_decision: outcomeDecision,
        replay_disposition: "accepted",
        requested_outcome: "express_to_user",
        admission_status: "admitted",
        final_outcome: "express_to_user",
        branch_admitted: true,
        summary: "Resident peer initiative admitted while a previous send is pending.",
      };
      const selectionSurfaceRef = "surface:relationship-profile:peer:pending-budget";
      const candidate = generatePeerInitiativeCandidates({
        details,
        attentionSignalRefs: [
          attentionAdmission.attention_input_id,
          attentionAdmission.signal_context_id,
          attentionAdmission.agenda_item_id,
        ],
        relationshipProjectionRef: selectionSurfaceRef,
        policyEpoch: attentionAdmission.initiative_gate_decision_id,
        now,
        surfaceTarget: "telegram",
      })[0]!;
      const store = new PeerInitiativeStore(runtimeRoot, { controlBaseDir: baseDir });
      await store.upsertCandidate({
        candidate,
        selectedState: "suggested",
      });
      await store.recordDelivery({
        delivery_id: `peer-delivery:${candidate.candidate_id}:telegram`,
        candidate_id: candidate.candidate_id,
        surface: "telegram",
        status: "pending_send",
        message_id: `peer-message:${candidate.candidate_id}`,
        target_binding_ref: "gateway:telegram:home_chat:12345",
        expression_decision_ref: "expression:peer:pending-budget",
        visibility_policy_ref: "visibility:peer:pending-budget",
        claimed_at: now,
        claim_expires_at: "2026-05-16T00:20:00.000Z",
        claim_attempt: 1,
      });
      const operationBoundary = evaluateResidentOperationBoundary({
        admission: attentionAdmission as never,
        assembledAt: now,
        details,
      });

      await triggerResidentPeerInitiative(
        {
          baseDir,
          config: DaemonConfigSchema.parse({
            proactive_mode: true,
            proactive_interval_ms: 1,
            goal_review_interval_ms: 7 * 24 * 60 * 60 * 1000,
            runtime_root: runtimeRoot,
          }),
          state,
          logger: logger() as never,
          saveDaemonState: vi.fn(async () => {}),
          gateway: {
            getOutboundConversationPort: (surface: OutboundConversationSurface) => surface === "telegram" ? gatewayPort : undefined,
          },
        },
        details,
        {
          attentionAdmission: attentionAdmission as never,
          operationBoundary,
          selectionSurfaceRef,
          metadata: {},
        },
      );

      expect(gatewayPort.messages).toHaveLength(0);
      expect(state.resident_activity).toMatchObject({
        kind: "skipped",
        peer_initiative_delivery_status: "pending_send",
      });
      const storedPolicy = await new ProactivePolicyStateStore(runtimeRoot, { controlBaseDir: baseDir })
        .load(DEFAULT_RESIDENT_ACTIVATION_POLICY_ID);
      expect(storedPolicy?.interruption_budget).toMatchObject({
        budget_id: binding.interruption_budget.budget_id,
        current_debits: 0,
      });
      await store.recordDelivery({
        delivery_id: `peer-delivery:${candidate.candidate_id}:telegram`,
        candidate_id: candidate.candidate_id,
        surface: "telegram",
        status: "delivered",
        delivered_at: "2026-05-16T00:09:00.000Z",
        message_id: `peer-message:${candidate.candidate_id}`,
        target_binding_ref: "gateway:telegram:home_chat:12345",
        expression_decision_ref: "expression:peer:pending-budget",
        visibility_policy_ref: "visibility:peer:pending-budget",
      });

      await triggerResidentPeerInitiative(
        {
          baseDir,
          config: DaemonConfigSchema.parse({
            proactive_mode: true,
            proactive_interval_ms: 1,
            goal_review_interval_ms: 7 * 24 * 60 * 60 * 1000,
            runtime_root: runtimeRoot,
          }),
          state,
          logger: logger() as never,
          saveDaemonState: vi.fn(async () => {}),
          gateway: {
            getOutboundConversationPort: (surface: OutboundConversationSurface) => surface === "telegram" ? gatewayPort : undefined,
          },
        },
        details,
        {
          attentionAdmission: attentionAdmission as never,
          operationBoundary,
          selectionSurfaceRef,
          metadata: {},
        },
      );

      expect(gatewayPort.messages).toHaveLength(0);
      const afterDeliveredReplayPolicy = await new ProactivePolicyStateStore(runtimeRoot, { controlBaseDir: baseDir })
        .load(DEFAULT_RESIDENT_ACTIVATION_POLICY_ID);
      expect(afterDeliveredReplayPolicy?.interruption_budget).toMatchObject({
        budget_id: binding.interruption_budget.budget_id,
        current_debits: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the candidate held when outbound peer initiative delivery is unavailable", async () => {
    const baseDir = makeTempDir("resident-peer-initiative-held-delivery-");
    const state = DaemonStateSchema.parse({
      pid: 123,
      started_at: "2026-05-15T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 4,
      active_goals: [],
      status: "idle",
      runtime_root: path.join(baseDir, "runtime"),
      last_resident_at: null,
      resident_activity: null,
    });
    const details = {
      peer_initiative: {
        kind: "care_presence",
        message: "今日も頑張ってね。",
        max_delivery_kind: "notify",
        action_plan: {
          mode: "care_only",
          permission_required: false,
        },
        worthiness: {
          can_be_valuable_without_reply: true,
          user_cognitive_load: "low",
          reply_pressure: "none",
          care_value: "high",
          attention_fit: "strong",
          concrete_helpfulness: "medium",
          self_serving_risk: "none",
          tutorial_risk: "none",
        },
      },
    };
    const outcomeDecision = OutcomeDecisionSchema.parse({
      outcome_decision_id: "outcome:peer:held-delivery",
      initiative_decision_ref: ref("initiative_gate_decision", "gate:peer:held-delivery"),
      decided_at: "2026-05-15T00:00:00.000Z",
      requested_outcome: "express_to_user",
      admission_status: "admitted",
      final_outcome: "express_to_user",
      visibility_policy_ref: ref("visibility_policy", "visibility:peer:held-delivery"),
    });
    const attentionAdmission = {
      action: "peer_initiative",
      source_kind: "resident_proactive_maintenance",
      attention_input_id: "attention:peer:held-delivery",
      signal_context_id: "signal:peer:held-delivery",
      urge_id: "urge:peer:held-delivery",
      agenda_item_id: "agenda:peer:held-delivery",
      inhibition_decision_id: "inhibition:peer:held-delivery",
      initiative_gate_decision_id: "gate:peer:held-delivery",
      outcome_decision_id: outcomeDecision.outcome_decision_id,
      outcome_decision: outcomeDecision,
      replay_disposition: "accepted",
      requested_outcome: "express_to_user",
      admission_status: "admitted",
      final_outcome: "express_to_user",
      branch_admitted: true,
      summary: "Resident peer initiative admitted for expression, but no outbound port is available.",
    };
    const operationBoundary = evaluateResidentOperationBoundary({
      admission: attentionAdmission as never,
      assembledAt: "2026-05-15T00:00:00.000Z",
      details,
    });

    await triggerResidentPeerInitiative(
      {
        baseDir,
        config: DaemonConfigSchema.parse({
          proactive_mode: true,
          proactive_interval_ms: 1,
          goal_review_interval_ms: 7 * 24 * 60 * 60 * 1000,
          runtime_root: path.join(baseDir, "runtime"),
        }),
        state,
        logger: logger() as never,
        saveDaemonState: vi.fn(async () => {}),
        gateway: {
          getOutboundConversationPort: () => undefined,
        },
      },
      details,
      {
        attentionAdmission: attentionAdmission as never,
        operationBoundary,
        selectionSurfaceRef: "surface:relationship-profile:peer:held-delivery",
        metadata: {},
      },
    );

    expect(state.resident_activity).toMatchObject({
      kind: "skipped",
      peer_initiative_delivery_status: "held",
    });
    const store = new PeerInitiativeStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
    const records = await store.listRecentCandidates();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "care_presence",
      selected_state: "held",
    });
    expect(records[0]?.delivered_at).toBeUndefined();
    const delivery = await store.getDelivery(`peer-delivery:${records[0]!.candidate_id}:telegram`);
    expect(delivery).toMatchObject({
      status: "held",
      failure_reason: "no live gateway outbound conversation port for telegram",
    });
  });
});
