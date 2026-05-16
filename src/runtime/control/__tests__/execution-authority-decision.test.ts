import { describe, expect, it } from "vitest";
import type { PermissionGrantRecord } from "../../store/permission-grant-store.js";
import { evaluateAdmissionPolicy, type AdmissionOperationScopeInput } from "../admission-policy.js";
import {
  createExecutionAuthorityDecision,
  projectAdmissionAuthority,
  projectHostToolExecutionAuthority,
  projectOutboundConversationAuthority,
  projectPermissionGrantAuthority,
  projectResidentOperationBoundaryAuthority,
} from "../execution-authority-decision.js";
import { PermissionCheckResultSchema } from "../../../tools/types.js";
import { evaluateResidentOperationBoundary, type ResidentAttentionOperationProjection } from "../../capability-operation-planner.js";

const NOW = "2026-05-16T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function actor() {
  return {
    surface: "chat" as const,
    platform: "slack",
    conversation_id: "conversation:inbound",
    identity_key: "user:yu",
    user_id: "user:yu",
  };
}

function notificationOperation(overrides: Partial<AdmissionOperationScopeInput> = {}): AdmissionOperationScopeInput {
  return {
    operation_id: "notify.send",
    capability_id: "capability:notify",
    operation_kind: "send",
    provider_ref: "asset:notifier/slack",
    asset_ref: "asset:notifier/slack",
    tool_name: "notify.send",
    payload_class: "notification_payload",
    side_effect_profile: "send",
    external_action_authority: true,
    required_permission_capabilities: ["notify_user"],
    target_refs: ["conversation:outbound"],
    ...overrides,
  };
}

function grant(overrides: Partial<PermissionGrantRecord> = {}): PermissionGrantRecord {
  return {
    schema_version: "permission-grant-v1",
    grant_id: "grant:notify-once",
    subject: {
      kind: "user",
      id: "user:someone-else",
    },
    origin: {
      channel: "chat",
      platform: "slack",
      conversation_id: "conversation:inbound",
      user_id: "user:someone-else",
      session_id: "session:chat",
    },
    source: {
      kind: "source_ref",
      ref: "approval:grant:notify-once",
    },
    scope: {
      kind: "session",
      session_id: "session:chat",
    },
    duration: {
      kind: "once",
    },
    review: {
      kind: "none",
    },
    capabilities: ["notify_user"],
    excluded_capabilities: [],
    state: "active",
    state_version: 0,
    state_epoch: NOW_MS,
    staleness: {
      status: "fresh",
      checked_at: NOW_MS,
      binding: {},
    },
    created_at: NOW_MS,
    updated_at: NOW_MS,
    activated_at: NOW_MS,
    supersedes: [],
    usage_count: 0,
    audit_refs: [],
    ...overrides,
  };
}

function peerInitiativeAdmission(): ResidentAttentionOperationProjection {
  return {
    action: "peer_initiative",
    source_kind: "resident_proactive_maintenance",
    attention_input_id: "attention:peer:1",
    signal_context_id: "signal:peer:1",
    urge_id: "urge:peer:1",
    agenda_item_id: "agenda:peer:1",
    inhibition_decision_id: "inhibition:peer:1",
    initiative_gate_decision_id: "gate:peer:1",
    outcome_decision_id: "outcome:peer:1",
    requested_outcome: "request_approval",
    admission_status: "admitted",
    final_outcome: "request_approval",
    branch_admitted: true,
  };
}

describe("ExecutionAuthorityDecision", () => {
  it("keeps host sandbox boundaries terminal and non-grantable", () => {
    const decision = projectHostToolExecutionAuthority({
      status: "needs_sandbox",
      reason: "Network access is disabled for this session.",
      executionReason: "sandbox_required",
      requiredSandboxMode: "danger_full_access",
    }, {
      decidedAt: NOW,
    });

    expect(decision).toMatchObject({
      lifecycle: "terminal",
      outcome: "sandbox_required",
      can_execute: false,
      fail_closed: true,
    });
    expect(decision.evidence_refs).toContain("sandbox:danger_full_access");
  });

  it("types PermissionGrant evidence instead of accepting unknown shapes", () => {
    const permissionGrantDecision = {
      status: "expired_grant" as const,
      allowed: false,
      reason: "Grant grant-1 is expired.",
      requiredCapabilities: ["write_workspace" as const],
      excludedCapabilities: [],
      matchedGrantId: "grant-1",
      consideredGrantIds: ["grant-1", "grant-2"],
    };
    const parsed = PermissionCheckResultSchema.parse({
      status: "needs_approval",
      reason: "Fresh approval required.",
      permissionGrantDecision,
    });
    const decision = projectPermissionGrantAuthority(parsed.permissionGrantDecision!, {
      decidedAt: NOW,
    });

    expect(decision.outcome).toBe("approval_required");
    expect(decision.permission_grant_evaluation).toEqual(permissionGrantDecision);
    expect(decision.evidence_refs).toEqual(expect.arrayContaining([
      "permission-grant:grant-1",
      "permission-grant:grant-2",
      "permission-capability:write_workspace",
    ]));
    expect(() => PermissionCheckResultSchema.parse({
      status: "needs_approval",
      reason: "bad grant shape",
      permissionGrantDecision: { status: "matched", allowed: true },
    })).toThrow();
  });

  it("preserves Admission operation, auth, target, and rejected grant refs", () => {
    const admission = evaluateAdmissionPolicy({
      operation: notificationOperation({
        provider_epoch: "provider-v1",
        payload_epoch: "payload-v1",
        target_epoch_refs: {
          "conversation:outbound": "target-v1",
        },
      }),
      actor: actor(),
      surface: {
        surface_ref: "surface:chat:slack",
        channel: "chat",
        platform: "slack",
        session_ref: "session:chat",
        epoch: "surface-v1",
      },
      authState: {
        ref: "auth:slack:user-yu",
        status: "valid",
        epoch: "auth-v1",
      },
      permissionGrants: [{
        grant: grant(),
        binding: {
          operation_id: "notify.send",
          provider_ref: "asset:notifier/slack",
          payload_class: "notification_payload",
          auth_state_ref: "auth:slack:user-yu",
          surface_ref: "surface:chat:slack",
          target_refs: ["conversation:outbound"],
          capabilities: ["notify_user"],
        },
      }],
      notificationPolicy: [{
        ref: "notification:slack:user-directed",
        result: "allowed",
        reason: "User-directed notification is allowed for this route.",
        epoch: "policy-v1",
      }],
      evaluatedAt: NOW,
    });
    const decision = projectAdmissionAuthority(admission);

    expect(admission.result).toBe("approval_required");
    expect(decision.bindings).toMatchObject({
      operation_id: "notify.send",
      provider_ref: "asset:notifier/slack",
      payload_class: "notification_payload",
      auth_state_ref: "auth:slack:user-yu",
      surface_ref: "surface:chat:slack",
      target_refs: ["conversation:outbound"],
    });
    expect(decision.evidence_refs).toContain("permission-grant-rejected:grant:notify-once");
    expect(decision.invalidation_refs).toEqual(expect.arrayContaining([
      "target:conversation:outbound",
      "provider:asset:notifier/slack",
      "auth:auth:slack:user-yu",
      "payload:notification_payload",
      "surface:surface:chat:slack",
    ]));
  });

  it("keeps peer initiative preparation separate from external execution authority", () => {
    const details = {
      peer_initiative: {
        kind: "permissioned_attention_action",
        message: "This reply draft is ready. Send it?",
        action_plan: {
          mode: "permissioned_external_action",
          proposed_action_kind: "send_message",
          prepared_artifact_ref: "peer-artifact:reply-draft",
          permission_required: true,
          confirmation_phrase: "Send it?",
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
    const boundary = evaluateResidentOperationBoundary({
      admission: peerInitiativeAdmission(),
      assembledAt: NOW,
      details,
    });
    const decision = projectResidentOperationBoundaryAuthority(boundary);

    expect(boundary.preparation_allowed).toBe(true);
    expect(boundary.execution_allowed).toBe(false);
    expect(boundary.autonomy_decision?.level).toBe("approval_required");
    expect(decision).toMatchObject({
      outcome: "approval_required",
      can_prepare: true,
      can_execute: false,
    });
    expect(decision.bindings).toMatchObject({
      provider_ref: "resident:peer-initiative",
      payload_class: "resident.peer_initiative.permissioned_external_action",
    });
  });

  it("keeps RunSpec safety blocks distinct from generic approval required", () => {
    const decision = createExecutionAuthorityDecision({
      schema_version: "execution-authority-decision/v1",
      decision_id: "execution-authority:runspec:safety-block",
      decided_at: NOW,
      lifecycle: "terminal",
      outcome: "safety_blocked",
      reason: "RunSpec is confirmed but cannot start until required fields are resolved.",
      fail_closed: true,
      source: {
        kind: "runspec_safety",
        ref: "runspec:pending-1",
        stage: "execute",
      },
      evidence_refs: ["runspec:pending-1", "runspec-confirmation:turn-1"],
    });

    expect(decision.outcome).toBe("safety_blocked");
    expect(decision.outcome).not.toBe("approval_required");
  });

  it("preserves outbound conversation stale target rejection evidence", () => {
    const decision = projectOutboundConversationAuthority({
      decidedAt: NOW,
      currentTarget: {
        surface: "telegram",
        target_binding_ref: "gateway:telegram:home_chat:2",
        channel_policy_ref: "gateway:telegram:main:outbound-conversation-policy",
      },
      message: {
        message_id: "message:peer:1",
        surface: "telegram",
        target_binding_ref: "gateway:telegram:home_chat:1",
        channel_policy_ref: "gateway:telegram:main:outbound-conversation-policy",
        text: "Prepared note",
        reply_required: false,
        source: "peer_initiative",
        candidate_id: "candidate:peer:1",
        expression_decision_ref: "expression:peer:1",
        visibility_policy_ref: "visibility:peer:1",
        trigger_actions: [],
        feedback_actions: [],
      },
    });

    expect(decision).toMatchObject({
      outcome: "fail_closed",
      can_send: false,
      fail_closed: true,
      bindings: {
        target_binding_ref: "gateway:telegram:home_chat:1",
        channel_policy_ref: "gateway:telegram:main:outbound-conversation-policy",
      },
      outbound_conversation: {
        stale_target_rejected: true,
      },
    });
  });
});
