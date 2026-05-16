import { describe, expect, it } from "vitest";
import { EXTERNAL_SURFACE_METADATA_KEY, buildExternalSurfaceDecision } from "../../../runtime/gateway/channel-policy.js";
import {
  buildSessionKeyFromParts,
  buildSessionMetadata,
  cloneReplyTarget,
  normalizeActor,
  normalizeReplyTarget,
  resolveChannel,
  resolveRuntimeControl,
} from "../cross-platform-session-normalization.js";

describe("cross-platform session normalization", () => {
  it("builds stable session keys before falling back to ephemeral keys", () => {
    expect(buildSessionKeyFromParts({ identity_key: "  shared-id " })).toBe("identity:shared-id");
    expect(buildSessionKeyFromParts({ platform: "Telegram", conversation_id: " chat-1 " })).toBe("platform:telegram:conversation:chat-1");
    expect(buildSessionKeyFromParts({ platform: "Slack", user_id: " user-1 " })).toBe("platform:slack:user:user-1");
    expect(buildSessionKeyFromParts({}).startsWith("ephemeral:")).toBe(true);
  });

  it("normalizes reply targets and strips notification route metadata for external surfaces", () => {
    const externalSurface = buildExternalSurfaceDecision(
      { platform: "telegram", senderId: "user-1", conversationId: "chat-1" },
      { allowed: true, runtimeControlApproved: true, runtimeControlConfigured: true },
      { metadata: {}, identityKey: "telegram:user-1" }
    );

    const replyTarget = normalizeReplyTarget("plugin_gateway", {
      platform: "Telegram",
      conversation_id: " chat-1 ",
      identity_key: " telegram:user-1 ",
      user_id: " user-1 ",
      message_id: " msg-1 ",
      metadata: { notification_route_id: "route-1", retained: true },
      externalSurface,
    });

    expect(replyTarget).toMatchObject({
      surface: "gateway",
      platform: "telegram",
      conversation_id: "chat-1",
      identity_key: "telegram:user-1",
      user_id: "user-1",
      message_id: "msg-1",
      deliveryMode: "reply",
    });
    const metadata = replyTarget.metadata ?? {};
    expect(metadata).toMatchObject({ retained: true });
    expect(metadata).not.toHaveProperty("notification_route_id");
    expect(metadata[EXTERNAL_SURFACE_METADATA_KEY]).toEqual(externalSurface);
  });

  it("normalizes actors and runtime-control policy from structured ingress metadata", () => {
    expect(resolveChannel({ platform: "telegram" })).toBe("plugin_gateway");
    expect(resolveChannel({ channel: "tui", platform: "telegram" })).toBe("tui");

    const actor = normalizeActor("plugin_gateway", {
      platform: "Telegram",
      conversation_id: " chat-1 ",
      identity_key: " identity-1 ",
      user_id: " user-1 ",
    });
    expect(actor).toEqual({
      surface: "gateway",
      platform: "telegram",
      conversation_id: "chat-1",
      identity_key: "identity-1",
      user_id: "user-1",
    });

    expect(resolveRuntimeControl("cli", undefined, undefined, undefined)).toEqual({
      allowed: true,
      approvalMode: "interactive",
    });
    expect(resolveRuntimeControl("plugin_gateway", undefined, { runtime_control_approved: true }, undefined)).toEqual({
      allowed: true,
      approvalMode: "preapproved",
    });
  });

  it("lets typed surface denial override stale runtime-control fields and metadata", () => {
    const externalSurface = buildExternalSurfaceDecision(
      { platform: "discord", senderId: "user-1", conversationId: "channel-1" },
      { allowed: false, runtimeControlApproved: false, runtimeControlConfigured: true },
      { metadata: {}, identityKey: "discord:user-1" }
    );

    expect(resolveRuntimeControl(
      "plugin_gateway",
      {
        allowed: true,
        approvalMode: "preapproved",
        approval_mode: "preapproved",
      },
      { runtime_control_approved: true },
      externalSurface
    )).toEqual({
      allowed: false,
      approvalMode: "disallowed",
    });
  });

  it("clones metadata so loaded session snapshots cannot mutate stored references", () => {
    const original = { surface: "gateway" as const, metadata: { nested: { value: 1 } } };
    const cloned = cloneReplyTarget(original);

    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    expect(cloned.metadata).not.toBe(original.metadata);
  });

  it("preserves structured session metadata precedence", () => {
    expect(buildSessionMetadata({
      metadata: { platform: "custom", extra: true },
      platform: "telegram",
      conversation_id: "chat-1",
      user_id: "user-1",
      channel: "plugin_gateway",
    })).toEqual({
      platform: "telegram",
      extra: true,
      conversation_id: "chat-1",
      user_id: "user-1",
      channel: "plugin_gateway",
    });
  });
});
