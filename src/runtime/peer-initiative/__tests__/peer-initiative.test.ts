import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { createFeedbackIngestion } from "../../attention/index.js";
import {
  generatePeerInitiativeCandidates,
  mapPeerInitiativeBoundary,
  peerInitiativeActionButtons,
  peerInitiativeFeedbackToIngestionInput,
  projectPeerInitiativeFeedback,
  PeerInitiativeStore,
  selectPeerInitiativeCandidate,
} from "../index.js";
import { evaluateResidentOperationBoundary } from "../../capability-operation-planner.js";
import { openControlDatabase } from "../../store/control-db/index.js";
import type { ResidentAttentionAdmission } from "../../daemon/resident-attention-orchestrator.js";

function attentionAdmission(action: "peer_initiative" = "peer_initiative"): ResidentAttentionAdmission {
  return {
    action,
    source_kind: "resident_proactive_maintenance",
    attention_input_id: "attention:peer:1",
    signal_context_id: "signal:peer:1",
    urge_id: "urge:peer:1",
    agenda_item_id: "agenda:peer:1",
    inhibition_decision_id: "inhibition:peer:1",
    initiative_gate_decision_id: "gate:peer:1",
    outcome_decision_id: "outcome:peer:1",
    replay_disposition: "accepted",
    requested_outcome: "express_to_user",
    admission_status: "admitted",
    final_outcome: "express_to_user",
    branch_admitted: true,
    summary: "Resident peer initiative admitted.",
  };
}

describe("peer initiative contracts and gates", () => {
  it("selects a care-only candidate that is useful without requiring a reply", () => {
    const [candidate] = generatePeerInitiativeCandidates({
      details: {
        peer_initiative: {
          kind: "care_presence",
          message: "今日も頑張ってね。無理に全部きれいにしなくていいと思う。",
          action_plan: { mode: "care_only", permission_required: false },
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
      },
      attentionSignalRefs: ["attention:peer:1"],
      policyEpoch: "policy:1",
      now: "2026-05-15T00:00:00.000Z",
      surfaceTarget: "telegram",
    });

    const selection = selectPeerInitiativeCandidate([candidate]);

    expect(candidate.candidate_id).toMatch(/^peer-candidate:[a-f0-9]{24}$/);
    expect(selection.selected_candidate_id).toBe(candidate.candidate_id);
    expect(selection.selection_reason).toBe("care_presence_budget");
    expect(candidate.reply_required).toBe(false);
    expect(candidate.external_action_authority).toBe(false);
  });

  it("rejects playful curiosity when no shared ritual or preference enables it", () => {
    expect(() => generatePeerInitiativeCandidates({
      details: {
        peer_initiative: {
          kind: "playful_curiosity",
          message: "今のPulSeedに秘密道具を1つ足せるなら何がいい？",
          action_plan: { mode: "care_only", permission_required: false },
          worthiness: {
            can_be_valuable_without_reply: false,
            user_cognitive_load: "low",
            reply_pressure: "strong",
            care_value: "low",
            attention_fit: "weak",
            concrete_helpfulness: "none",
            self_serving_risk: "low",
            tutorial_risk: "none",
          },
        },
      },
      attentionSignalRefs: ["attention:peer:1"],
      policyEpoch: "policy:1",
      now: "2026-05-15T00:00:00.000Z",
      surfaceTarget: "telegram",
    })).toThrow("playful curiosity");
  });

  it("holds malformed peer initiative details instead of replacing them with default care", () => {
    const inputs = [
      undefined,
      { foo: "bar" },
      { peer_initiative: {} },
      { peer_initiative: { kind: "care_presence" } },
      {
        peer_initiative: {
          kind: "permissioned_attention_action",
          message: "この文面で送っていい？",
          action_plan: {
            mode: "permissioned_external_action",
            proposed_action_kind: "send_message",
            permission_required: false,
            confirmation_phrase: "この文面で送っていい？",
          },
        },
      },
    ];

    for (const details of inputs) {
      const candidates = generatePeerInitiativeCandidates({
        details,
        attentionSignalRefs: ["attention:peer:malformed"],
        policyEpoch: "policy:malformed",
        now: "2026-05-15T00:00:00.000Z",
        surfaceTarget: "telegram",
      });

      expect(candidates).toEqual([]);
      expect(selectPeerInitiativeCandidate(candidates)).toMatchObject({
        selection_reason: "no_candidate",
      });
    }
  });

  it("keeps valid nested peer initiative details selectable", () => {
    const candidates = generatePeerInitiativeCandidates({
      details: {
        peer_initiative: {
          kind: "care_presence",
          message: "今日も頑張ってね。",
          action_plan: { mode: "care_only", permission_required: false },
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
      },
      attentionSignalRefs: ["attention:peer:malformed"],
      policyEpoch: "policy:malformed",
      now: "2026-05-15T00:00:00.000Z",
      surfaceTarget: "telegram",
    });

    expect(candidates).toHaveLength(1);
    expect(selectPeerInitiativeCandidate(candidates)).toMatchObject({
      selected_candidate_id: candidates[0]!.candidate_id,
      selection_reason: "care_presence_budget",
    });
  });

  it("maps internal preparation through existing resident autonomy boundary to prepare_draft, not execute", () => {
    const admission = attentionAdmission();
    const details = {
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
      },
    };
    const [candidate] = generatePeerInitiativeCandidates({
      details,
      attentionSignalRefs: ["attention:peer:1"],
      policyEpoch: "policy:1",
      now: "2026-05-15T00:00:00.000Z",
      surfaceTarget: "telegram",
    });
    const boundary = evaluateResidentOperationBoundary({
      admission,
      assembledAt: "2026-05-15T00:00:00.000Z",
      details,
    });

    const mapping = mapPeerInitiativeBoundary({
      candidate,
      attentionAdmission: admission,
      operationBoundary: boundary,
      now: "2026-05-15T00:00:00.000Z",
    });

    expect(boundary.autonomy_decision?.level).toBe("prepare_only");
    expect(mapping.mapping.mapped_boundary).toBe("attention_prepare_draft");
    expect(mapping.companionActionProjectionId).toBeDefined();
    expect(mapping.shouldRender).toBe(true);
  });

  it("maps permissioned external actions to approval request without execution authority", () => {
    const admission = attentionAdmission();
    const details = {
      peer_initiative: {
        kind: "permissioned_attention_action",
        message: "この返信、短く済ませるならこの文面でいけそう。送っていい？",
        action_plan: {
          mode: "permissioned_external_action",
          proposed_action_kind: "send_message",
          prepared_artifact_ref: "peer-artifact:reply-draft",
          permission_required: true,
          confirmation_phrase: "この返信、短く済ませるならこの文面でいけそう。送っていい？",
        },
        worthiness: {
          can_be_valuable_without_reply: true,
          user_cognitive_load: "low",
          reply_pressure: "soft",
          care_value: "high",
          attention_fit: "strong",
          concrete_helpfulness: "high",
          self_serving_risk: "none",
          tutorial_risk: "none",
        },
      },
    };
    const [candidate] = generatePeerInitiativeCandidates({
      details,
      attentionSignalRefs: ["attention:peer:1"],
      policyEpoch: "policy:1",
      now: "2026-05-15T00:00:00.000Z",
      surfaceTarget: "telegram",
    });
    const boundary = evaluateResidentOperationBoundary({
      admission,
      assembledAt: "2026-05-15T00:00:00.000Z",
      details,
    });

    const mapping = mapPeerInitiativeBoundary({
      candidate,
      attentionAdmission: admission,
      operationBoundary: boundary,
      now: "2026-05-15T00:00:00.000Z",
    });

    expect(boundary.autonomy_decision?.level).toBe("approval_required");
    expect(boundary.execution_allowed).toBe(false);
    expect(mapping.mapping.mapped_boundary).toBe("permission_request");
    expect(mapping.shouldRender).toBe(true);
  });

  it("holds contextual capability disclosure when it is tutorial-like or lacks a current need fit", () => {
    const [candidate] = generatePeerInitiativeCandidates({
      details: {
        peer_initiative: {
          kind: "contextual_capability_disclosure",
          message: "PulSeedには便利な機能があります。",
          action_plan: {
            mode: "contextual_capability_disclosure",
            capability_ref: "capability:followup",
            current_need_ref: "need:followup",
            try_once_available: true,
            permission_required: false,
          },
          worthiness: {
            can_be_valuable_without_reply: true,
            user_cognitive_load: "low",
            reply_pressure: "soft",
            care_value: "medium",
            attention_fit: "medium",
            concrete_helpfulness: "medium",
            self_serving_risk: "low",
            tutorial_risk: "high",
          },
        },
      },
      attentionSignalRefs: ["attention:peer:1"],
      policyEpoch: "policy:1",
      now: "2026-05-15T00:00:00.000Z",
      surfaceTarget: "telegram",
    });

    const selection = selectPeerInitiativeCandidate([candidate]);

    expect(selection.selected_candidate_id).toBeUndefined();
    expect(selection.selection_reason).toBe("held_by_tutorial_risk");
  });

  it("projects structured peer feedback through canonical feedback ingestion before peer counters", async () => {
    const tmpDir = makeTempDir("peer-feedback-projection-");
    const [candidate] = generatePeerInitiativeCandidates({
      details: {
        peer_initiative: {
          kind: "care_presence",
          message: "今日も頑張ってね。",
          action_plan: { mode: "care_only", permission_required: false },
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
      },
      attentionSignalRefs: ["attention:peer:feedback"],
      policyEpoch: "policy:feedback",
      now: "2026-05-15T00:00:00.000Z",
      surfaceTarget: "telegram",
    });
    const feedbackAction = peerInitiativeActionButtons({
      candidate,
      outcomeDecisionId: "outcome:peer:feedback",
      feedbackEpoch: "2026-05-15T00:00:01.000Z",
    }).find((action) => action.action === "less_like_this");
    if (!feedbackAction || feedbackAction.action !== "less_like_this") {
      throw new Error("expected less_like_this feedback action");
    }
    const ingestion = createFeedbackIngestion(peerInitiativeFeedbackToIngestionInput(feedbackAction, {
      sourceSurface: "telegram",
      recordedAt: "2026-05-15T00:00:01.000Z",
      surfaceRef: "gateway:telegram:home_chat:12345",
    }), { now: "2026-05-15T00:00:01.000Z" });
    const projection = projectPeerInitiativeFeedback({
      action: feedbackAction,
      result: ingestion,
      sourceSurface: "telegram",
      projectedAt: "2026-05-15T00:00:02.000Z",
    });
    const store = new PeerInitiativeStore(path.join(tmpDir, "runtime"), { controlBaseDir: tmpDir });

    await store.upsertCandidate({ candidate, selectedState: "suggested" });
    await store.appendFeedbackProjection(projection);

    expect(ingestion.record.target).toMatchObject({
      kind: "outcome_decision",
      id: "outcome:peer:feedback",
    });
    expect(ingestion.effects.map((effect) => effect.effect_kind)).toContain("attention_cooldown");
    await expect(store.listFeedbackProjections({ candidateId: candidate.candidate_id })).resolves.toMatchObject([{
      candidate_id: candidate.candidate_id,
      structured_outcome: "less_like_this",
      source_surface: "telegram",
      feedback_id: ingestion.record.feedback_id,
    }]);
    await expect(store.getFeedbackProjectionForAction({
      candidateId: candidate.candidate_id,
      sourceSurface: "telegram",
      structuredOutcome: "less_like_this",
    })).resolves.toMatchObject({
      candidate_id: candidate.candidate_id,
      structured_outcome: "less_like_this",
      feedback_id: ingestion.record.feedback_id,
    });
  });

  it("fails closed when peer initiative JSON rows are schema-invalid", async () => {
    const tmpDir = makeTempDir("peer-invalid-json-row-");
    const store = new PeerInitiativeStore(path.join(tmpDir, "runtime"), { controlBaseDir: tmpDir });
    await store.ensureReady();

    const db = await openControlDatabase({ baseDir: tmpDir });
    try {
      db.transaction((sqlite) => {
        sqlite.prepare(`
          INSERT INTO peer_initiatives (
            candidate_id,
            idempotency_key,
            kind,
            selected_state,
            created_at,
            next_eligible_at,
            record_json
          )
          VALUES (?, ?, ?, ?, ?, ?, json(?))
        `).run(
          "peer-candidate:invalid-json",
          "peer-initiative:invalid-json",
          "care_presence",
          "suggested",
          "2026-05-15T00:00:00.000Z",
          null,
          JSON.stringify({ candidate_id: "peer-candidate:invalid-json" }),
        );
      });
    } finally {
      db.close();
    }

    await expect(store.listRecentCandidates()).resolves.toEqual([]);
  });

  it("claims peer delivery before send, blocks live duplicates, and reclaims expired pending leases", async () => {
    const tmpDir = makeTempDir("peer-delivery-claim-");
    const [candidate] = generatePeerInitiativeCandidates({
      details: {
        peer_initiative: {
          kind: "care_presence",
          message: "今日も頑張ってね。",
          action_plan: { mode: "care_only", permission_required: false },
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
      },
      attentionSignalRefs: ["attention:peer:claim"],
      policyEpoch: "policy:claim",
      now: "2026-05-15T00:00:00.000Z",
      surfaceTarget: "telegram",
    });
    const store = new PeerInitiativeStore(path.join(tmpDir, "runtime"), { controlBaseDir: tmpDir });

    await store.upsertCandidate({ candidate, selectedState: "suggested" });
    const deliveryInput = {
      delivery_id: `peer-delivery:${candidate.candidate_id}:telegram`,
      candidate_id: candidate.candidate_id,
      surface: "telegram",
      status: "pending_send",
      message_id: `peer-message:${candidate.candidate_id}`,
      target_binding_ref: "gateway:telegram:home_chat:12345",
      expression_decision_ref: "expression:peer:claim",
      visibility_policy_ref: "visibility:peer:claim",
    } as const;
    const first = await store.claimDelivery(deliveryInput, {
      now: "2026-05-15T00:00:00.000Z",
      leaseMs: 60_000,
    });
    const second = await store.claimDelivery(deliveryInput, {
      now: "2026-05-15T00:00:30.000Z",
      leaseMs: 60_000,
    });
    const afterLeaseExpiry = await store.claimDelivery(deliveryInput, {
      now: "2026-05-15T00:02:00.000Z",
      leaseMs: 60_000,
    });

    expect(first).toMatchObject({
      status: "claimed",
      record: {
        status: "pending_send",
        claimed_at: "2026-05-15T00:00:00.000Z",
        claim_expires_at: "2026-05-15T00:01:00.000Z",
        claim_attempt: 1,
      },
    });
    expect(second).toMatchObject({
      status: "existing",
      record: {
        status: "pending_send",
        claim_attempt: 1,
      },
    });
    expect(afterLeaseExpiry).toMatchObject({
      status: "claimed",
      record: {
        status: "pending_send",
        claimed_at: "2026-05-15T00:02:00.000Z",
        claim_expires_at: "2026-05-15T00:03:00.000Z",
        claim_attempt: 2,
      },
    });
  });

  it("allows held or failed peer deliveries to be reclaimed for a later send attempt", async () => {
    const tmpDir = makeTempDir("peer-delivery-reclaim-");
    const [candidate] = generatePeerInitiativeCandidates({
      details: {
        peer_initiative: {
          kind: "care_presence",
          message: "今日も頑張ってね。",
          action_plan: { mode: "care_only", permission_required: false },
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
      },
      attentionSignalRefs: ["attention:peer:reclaim"],
      policyEpoch: "policy:reclaim",
      now: "2026-05-15T00:00:00.000Z",
      surfaceTarget: "telegram",
    });
    const store = new PeerInitiativeStore(path.join(tmpDir, "runtime"), { controlBaseDir: tmpDir });
    const deliveryId = `peer-delivery:${candidate.candidate_id}:telegram`;

    await store.upsertCandidate({ candidate, selectedState: "suggested" });
    await store.recordDelivery({
      delivery_id: deliveryId,
      candidate_id: candidate.candidate_id,
      surface: "telegram",
      status: "held",
      failure_reason: "no live gateway outbound conversation port for telegram",
    });
    const afterHeld = await store.claimDelivery({
      delivery_id: deliveryId,
      candidate_id: candidate.candidate_id,
      surface: "telegram",
      status: "pending_send",
      message_id: `peer-message:${candidate.candidate_id}`,
      target_binding_ref: "gateway:telegram:home_chat:12345",
      expression_decision_ref: "expression:peer:reclaim",
      visibility_policy_ref: "visibility:peer:reclaim",
    });
    await store.recordDelivery({
      delivery_id: deliveryId,
      candidate_id: candidate.candidate_id,
      surface: "telegram",
      status: "failed",
      message_id: `peer-message:${candidate.candidate_id}`,
      target_binding_ref: "gateway:telegram:home_chat:12345",
      expression_decision_ref: "expression:peer:reclaim",
      visibility_policy_ref: "visibility:peer:reclaim",
      failure_reason: "temporary send failure",
    });
    const afterFailed = await store.claimDelivery({
      delivery_id: deliveryId,
      candidate_id: candidate.candidate_id,
      surface: "telegram",
      status: "pending_send",
      message_id: `peer-message:${candidate.candidate_id}`,
      target_binding_ref: "gateway:telegram:home_chat:12345",
      expression_decision_ref: "expression:peer:reclaim",
      visibility_policy_ref: "visibility:peer:reclaim",
    });

    expect(afterHeld).toMatchObject({
      status: "claimed",
      record: { status: "pending_send" },
    });
    expect(afterFailed).toMatchObject({
      status: "claimed",
      record: { status: "pending_send" },
    });
  });
});
