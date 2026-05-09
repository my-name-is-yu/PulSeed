import { describe, expect, it } from "vitest";
import {
  buildChannelPolicyMetadata,
  buildExternalSurfaceDecision,
  evaluateChannelAccess,
  resolveChannelRoute,
} from "../channel-policy.js";

describe("channel policy", () => {
  it("denies sender denylist before allow_all", () => {
    const decision = evaluateChannelAccess(
      { allowAll: true, deniedSenderIds: ["user-1"] },
      { platform: "discord", senderId: "user-1", conversationId: "chan-1" }
    );

    expect(decision).toMatchObject({ allowed: false, reason: "sender_denied" });
  });

  it("requires sender allowlist when allow_all is false", () => {
    const decision = evaluateChannelAccess(
      { allowedSenderIds: ["user-1"] },
      { platform: "signal", senderId: "user-2" }
    );

    expect(decision).toMatchObject({ allowed: false, reason: "sender_not_allowed" });
  });

  it("marks runtime control approval independently of routing", () => {
    const decision = evaluateChannelAccess(
      { allowAll: true, runtimeControlAllowedSenderIds: ["admin"] },
      { platform: "slack", senderId: "admin" }
    );

    expect(decision).toEqual({ allowed: true, runtimeControlApproved: true, runtimeControlConfigured: true });
  });

  it("marks runtime control as configured when sender is not approved for it", () => {
    const decision = evaluateChannelAccess(
      { allowAll: true, runtimeControlAllowedSenderIds: ["admin"] },
      { platform: "slack", senderId: "user-2" }
    );

    expect(decision).toEqual({ allowed: true, runtimeControlApproved: false, runtimeControlConfigured: true });
  });

  it("routes conversation before sender and default", () => {
    const route = resolveChannelRoute(
      {
        conversationGoalMap: { "thread-1": "goal-thread" },
        senderGoalMap: { "user-1": "goal-user" },
        defaultGoalId: "goal-default",
        identityKey: "shared",
      },
      { platform: "telegram", conversationId: "thread-1", senderId: "user-1" }
    );

    expect(route.goalId).toBe("goal-thread");
    expect(route.identityKey).toBe("shared");
    expect(route.metadata).toMatchObject({ routed_goal_id: "goal-thread" });
  });

  it("projects inbound access, notification routing, runtime control, and autonomy as separate surface fields", () => {
    const context = { platform: "telegram", senderId: "admin", conversationId: "chat-1", channelId: "chat-1" };
    const access = evaluateChannelAccess(
      { allowAll: true, runtimeControlAllowedSenderIds: ["admin"] },
      context
    );
    const route = resolveChannelRoute(
      { defaultGoalId: "goal-default", identityKey: "owner" },
      context
    );

    const surface = buildExternalSurfaceDecision(context, access, route);
    const metadata = buildChannelPolicyMetadata(context, access, route);

    expect(surface).toMatchObject({
      channel: "telegram",
      inbound_access: { allowed: true },
      reply_target_policy: {
        available: true,
        policy: "current_turn_only",
        delivery_mode: "reply",
      },
      notification_route_policy: {
        configured: true,
        may_notify: false,
        reason: "route_config_is_not_notification_permission",
        goal_id: "goal-default",
      },
      runtime_control_policy: {
        configured: true,
        allowed: true,
        approval_mode: "preapproved",
      },
      autonomy_authority: {
        may_initiate: false,
        reason: "external_surface_never_grants_autonomy",
      },
    });
    expect(surface.allowed_operation_kinds).toEqual(["turn_reply", "runtime_control_execute"]);
    expect(metadata.external_surface).toEqual(surface);
    expect(metadata.runtime_control_approved).toBe(true);
  });

  it("does not treat route configuration as notification or autonomous authority", () => {
    const context = { platform: "slack", senderId: "member", conversationId: "channel-1" };
    const access = evaluateChannelAccess({ allowAll: true }, context);
    const route = resolveChannelRoute({ defaultGoalId: "goal-default" }, context);

    const surface = buildExternalSurfaceDecision(context, access, route);

    expect(surface.notification_route_policy).toMatchObject({
      configured: true,
      may_notify: false,
    });
    expect(surface.runtime_control_policy).toMatchObject({
      configured: false,
      allowed: false,
      approval_mode: "disallowed",
    });
    expect(surface.autonomy_authority.may_initiate).toBe(false);
    expect(surface.allowed_operation_kinds).toEqual(["turn_reply"]);
  });
});
