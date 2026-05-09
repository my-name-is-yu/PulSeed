import { describe, expect, it } from "vitest";
import type { CapabilityReadinessSnapshot } from "../../../platform/observation/types/capability.js";
import type { PermissionGrantCapability, PermissionGrantRecord } from "../../store/permission-grant-store.js";
import { evaluateAdmissionPolicy, type AdmissionOperationScopeInput } from "../admission-policy.js";

const NOW = "2026-05-09T00:00:00.000Z";
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
    requires_runtime_control: false,
    required_permission_capabilities: ["notify_user"],
    target_refs: ["conversation:outbound"],
    ...overrides,
  };
}

function grant(
  overrides: Partial<PermissionGrantRecord> = {},
  capabilities: PermissionGrantCapability[] = ["notify_user"]
): PermissionGrantRecord {
  return {
    schema_version: "permission-grant-v1",
    grant_id: "grant:notify-once",
    subject: {
      kind: "user",
      id: "user:yu",
    },
    origin: {
      channel: "chat",
      platform: "slack",
      conversation_id: "conversation:inbound",
      user_id: "user:yu",
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
    capabilities,
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

function executableReadiness(): CapabilityReadinessSnapshot {
  return {
    schema_version: "capability-readiness-snapshot/v1",
    snapshot_id: "readiness:notify:slack:send",
    capability_id: "capability:notify",
    provider_ref: "asset:notifier/slack",
    asset_ref: "asset:notifier/slack",
    operation_id: "notify.send",
    operation_kind: "send",
    tool_name: "notify.send",
    payload_class: "notification_payload",
    risk_class: "medium",
    side_effect_profile: "send",
    evaluated_at: NOW,
    state: "executable_verified",
    passed_gates: ["stored", "discoverable", "loadable", "compatible", "configured", "authenticated", "executable_verified"],
    failed_gates: [],
    degraded_gates: [],
    missing_config_refs: [],
    missing_auth_refs: [],
    verification_refs: ["verify:notify-send-smoke"],
    evidence_refs: ["verify:notify-send-smoke"],
    stale_refs: [],
    safe_user_visible_label: "Execution substrate verified",
    metadata: {},
  };
}

describe("AdmissionPolicyEvaluation", () => {
  it("keeps executable readiness separate from autonomous notification admission", () => {
    const baseInput = {
      operation: notificationOperation({ required_permission_capabilities: [] }),
      actor: actor(),
      surface: {
        surface_ref: "surface:chat:slack",
        channel: "chat",
        platform: "slack",
      },
      readiness: executableReadiness(),
      evaluatedAt: NOW,
    };

    const approvalRequired = evaluateAdmissionPolicy({
      ...baseInput,
      notificationPolicy: [{
        ref: "notification:slack:autonomous-initiation",
        result: "approval_required",
        reason: "Autonomous outbound notification needs explicit approval.",
      }],
    });
    expect(approvalRequired).toMatchObject({
      readiness_ref: "readiness:notify:slack:send",
      result: "approval_required",
      notification_policy_refs: ["notification:slack:autonomous-initiation"],
    });

    const suppressed = evaluateAdmissionPolicy({
      ...baseInput,
      notificationPolicy: [{
        ref: "notification:quiet-hours",
        result: "suppressed",
        reason: "Quieting suppresses outbound notification.",
      }],
    });
    expect(suppressed.result).toBe("suppressed");
    expect(suppressed.readiness_ref).toBe("readiness:notify:slack:send");
  });

  it("does not treat inbound message permission as outbound notification permission", () => {
    const evaluation = evaluateAdmissionPolicy({
      operation: notificationOperation(),
      actor: actor(),
      surface: {
        surface_ref: "surface:chat:slack",
        channel: "chat",
        platform: "slack",
        inbound_permission_refs: ["grant:inbound-read"],
        session_ref: "session:chat",
      },
      authState: {
        ref: "auth:slack:user-yu",
        status: "valid",
      },
      permissionGrants: [{
        grant: grant({ grant_id: "grant:inbound-read" }, ["read_workspace"]),
        binding: {
          operation_id: "message.receive",
          provider_ref: "asset:notifier/slack",
          payload_class: "inbound_message",
          auth_state_ref: "auth:slack:user-yu",
          surface_ref: "surface:chat:slack",
          target_refs: ["conversation:inbound"],
          capabilities: ["read_workspace"],
        },
      }],
      notificationPolicy: [{
        ref: "notification:slack:user-directed",
        result: "allowed",
        reason: "User-directed notifications can be sent after permission admission.",
      }],
      evaluatedAt: NOW,
    });

    expect(evaluation.result).toBe("approval_required");
    expect(evaluation.permission_grant_refs).toEqual([]);
    expect(evaluation.rejected_permission_grant_refs).toEqual(["grant:inbound-read"]);
    expect(evaluation.metadata.considered_permission_grant_refs).toEqual(["grant:inbound-read"]);
    expect(evaluation.rationale.join("\n")).toContain("No active PermissionGrant covers notify_user");
  });

  it("does not treat reply target availability as session resume permission", () => {
    const evaluation = evaluateAdmissionPolicy({
      operation: {
        operation_id: "session.resume",
        capability_id: "capability:resume_session",
        operation_kind: "run",
        provider_ref: "runtime:session-registry",
        payload_class: "session_resume",
        side_effect_profile: "mutate",
        external_action_authority: false,
        requires_runtime_control: true,
        required_permission_capabilities: [],
        target_refs: ["session:agent-old"],
      },
      actor: actor(),
      surface: {
        surface_ref: "surface:chat:slack",
        channel: "chat",
        platform: "slack",
        reply_target: {
          surface: "chat",
          channel: "plugin_gateway",
          platform: "slack",
          conversation_id: "conversation:inbound",
          message_id: "message:latest",
          deliveryMode: "reply",
        },
      },
      evaluatedAt: NOW,
    });

    expect(evaluation.result).toBe("approval_required");
    expect(evaluation.runtime_control_refs).toEqual([]);
    expect(evaluation.rationale).toContain("Runtime control admission is required for this operation scope.");
  });

  it("does not reuse one-time approval as standing authority and records invalidation bindings", () => {
    const operation = notificationOperation({
      provider_epoch: "provider-v1",
      payload_epoch: "payload-v1",
      target_epoch_refs: {
        "conversation:outbound": "target-v1",
      },
    });
    const activeGrant = grant();
    const binding = {
      operation_id: "notify.send",
      provider_ref: "asset:notifier/slack",
      payload_class: "notification_payload",
      auth_state_ref: "auth:slack:user-yu",
      surface_ref: "surface:chat:slack",
      target_refs: ["conversation:outbound"],
      capabilities: ["notify_user" as const],
    };

    const allowed = evaluateAdmissionPolicy({
      operation,
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
        grant: activeGrant,
        binding,
      }],
      notificationPolicy: [{
        ref: "notification:slack:user-directed",
        result: "allowed",
        reason: "User-directed notification is allowed for this route.",
        epoch: "policy-v1",
      }],
      evaluatedAt: NOW,
    });

    expect(allowed).toMatchObject({
      result: "allowed",
      permission_grant_refs: ["grant:notify-once"],
      auth_state_ref: "auth:slack:user-yu",
    });
    expect(allowed.invalidation_bindings).toEqual(expect.arrayContaining([
      { kind: "target", ref: "conversation:outbound", epoch: "target-v1" },
      { kind: "provider", ref: "asset:notifier/slack", epoch: "provider-v1" },
      { kind: "auth", ref: "auth:slack:user-yu", epoch: "auth-v1" },
      { kind: "payload", ref: "notification_payload", epoch: "payload-v1" },
      { kind: "policy", ref: "notification:slack:user-directed", epoch: "policy-v1" },
      { kind: "surface", ref: "surface:chat:slack", epoch: "surface-v1" },
    ]));

    const reused = evaluateAdmissionPolicy({
      operation,
      actor: actor(),
      surface: {
        surface_ref: "surface:chat:slack",
        channel: "chat",
        platform: "slack",
        session_ref: "session:chat",
      },
      authState: {
        ref: "auth:slack:user-yu",
        status: "valid",
      },
      permissionGrants: [{
        grant: grant({ usage_count: 1 }),
        binding,
      }],
      notificationPolicy: [{
        ref: "notification:slack:user-directed",
        result: "allowed",
        reason: "User-directed notification is allowed for this route.",
      }],
      evaluatedAt: NOW,
    });

    expect(reused.result).toBe("approval_required");
    expect(reused.permission_grant_refs).toEqual([]);
    expect(reused.rejected_permission_grant_refs).toEqual(["grant:notify-once"]);
    expect(reused.rationale.join("\n")).toContain("No active PermissionGrant covers notify_user");
  });

  it("rejects grants from a different actor or scoped session", () => {
    const base = {
      operation: notificationOperation(),
      actor: actor(),
      notificationPolicy: [{
        ref: "notification:slack:user-directed",
        result: "allowed" as const,
        reason: "User-directed notification is allowed for this route.",
      }],
      evaluatedAt: NOW,
    };

    const otherActor = evaluateAdmissionPolicy({
      ...base,
      surface: {
        surface_ref: "surface:chat:slack",
        channel: "chat",
        platform: "slack",
        session_ref: "session:chat",
      },
      authState: {
        ref: "auth:slack:user-yu",
        status: "valid",
      },
      permissionGrants: [{
        grant: grant({
          grant_id: "grant:other-user",
          subject: {
            kind: "user",
            id: "user:someone-else",
          },
        }),
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
    });

    expect(otherActor.result).toBe("approval_required");
    expect(otherActor.permission_grant_refs).toEqual([]);
    expect(otherActor.rejected_permission_grant_refs).toEqual(["grant:other-user"]);
    expect(otherActor.rationale.join("\n")).toContain("subject does not match the requesting actor");

    const otherSession = evaluateAdmissionPolicy({
      ...base,
      surface: {
        surface_ref: "surface:chat:slack",
        channel: "chat",
        platform: "slack",
        session_ref: "session:other",
      },
      authState: {
        ref: "auth:slack:user-yu",
        status: "valid",
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
    });

    expect(otherSession.result).toBe("approval_required");
    expect(otherSession.permission_grant_refs).toEqual([]);
    expect(otherSession.rejected_permission_grant_refs).toEqual(["grant:notify-once"]);
    expect(otherSession.rationale.join("\n")).toContain("origin does not match the requesting actor or surface");
  });

  it("rejects grants from a different origin channel or platform", () => {
    const evaluation = evaluateAdmissionPolicy({
      operation: notificationOperation(),
      actor: actor(),
      surface: {
        surface_ref: "surface:chat:slack",
        channel: "chat",
        platform: "slack",
        session_ref: "session:chat",
      },
      authState: {
        ref: "auth:slack:user-yu",
        status: "valid",
      },
      permissionGrants: [{
        grant: grant({
          grant_id: "grant:web-origin",
          origin: {
            channel: "web",
            platform: "discord",
            conversation_id: "conversation:inbound",
            user_id: "user:yu",
            session_id: "session:chat",
          },
        }),
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
      }],
      evaluatedAt: NOW,
    });

    expect(evaluation.result).toBe("approval_required");
    expect(evaluation.permission_grant_refs).toEqual([]);
    expect(evaluation.rejected_permission_grant_refs).toEqual(["grant:web-origin"]);
    expect(evaluation.rationale.join("\n")).toContain("origin does not match the requesting actor or surface");
  });

  it("rejects auth-bound grants when current auth state is missing", () => {
    const evaluation = evaluateAdmissionPolicy({
      operation: notificationOperation(),
      actor: actor(),
      surface: {
        surface_ref: "surface:chat:slack",
        channel: "chat",
        platform: "slack",
        session_ref: "session:chat",
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
      }],
      evaluatedAt: NOW,
    });

    expect(evaluation.result).toBe("approval_required");
    expect(evaluation.permission_grant_refs).toEqual([]);
    expect(evaluation.rejected_permission_grant_refs).toEqual(["grant:notify-once"]);
    expect(evaluation.auth_state_ref).toBeUndefined();
    expect(evaluation.invalidation_bindings.some((binding) => binding.kind === "auth")).toBe(false);
    expect(evaluation.rationale.join("\n")).toContain("no current auth state was supplied");
  });

  it("rejects grant evidence that omits required operation surface or auth binding", () => {
    expect(() => evaluateAdmissionPolicy({
      operation: notificationOperation(),
      actor: actor(),
      surface: {
        surface_ref: "surface:chat:slack",
        channel: "chat",
        platform: "slack",
        session_ref: "session:chat",
      },
      permissionGrants: [{
        grant: grant(),
        binding: {
          provider_ref: "asset:notifier/slack",
          payload_class: "notification_payload",
          target_refs: ["conversation:outbound"],
          capabilities: ["notify_user"],
        } as never,
      }],
      notificationPolicy: [{
        ref: "notification:slack:user-directed",
        result: "allowed",
        reason: "User-directed notification is allowed for this route.",
      }],
      evaluatedAt: NOW,
    })).toThrow();
  });

  it("rejects auth-bound grants when current auth state is not valid", () => {
    const evaluation = evaluateAdmissionPolicy({
      operation: notificationOperation(),
      actor: actor(),
      surface: {
        surface_ref: "surface:chat:slack",
        channel: "chat",
        platform: "slack",
        session_ref: "session:chat",
      },
      authState: {
        ref: "auth:slack:user-yu",
        status: "missing",
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
      }],
      evaluatedAt: NOW,
    });

    expect(evaluation.result).toBe("approval_required");
    expect(evaluation.permission_grant_refs).toEqual([]);
    expect(evaluation.rejected_permission_grant_refs).toEqual(["grant:notify-once"]);
    expect(evaluation.auth_state_ref).toBe("auth:slack:user-yu");
    expect(evaluation.rationale.join("\n")).toContain("non-valid auth state");
    expect(evaluation.rationale.join("\n")).toContain("Auth state auth:slack:user-yu is missing");
  });
});
