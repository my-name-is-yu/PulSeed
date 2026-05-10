import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_ONLY_SEEDY_PRESENCE_CONTRACT,
  DISCORD_SEEDY_PRESENCE_CONTRACT,
  FINAL_ONLY_SEEDY_PRESENCE_CONTRACT,
  GUI_BODY_SEEDY_PRESENCE_CONTRACT,
  SIGNAL_SEEDY_PRESENCE_CONTRACT,
  SLACK_SEEDY_PRESENCE_CONTRACT,
  TELEGRAM_SEEDY_PRESENCE_CONTRACT,
  WEBHOOK_SEEDY_PRESENCE_CONTRACT,
  WHATSAPP_SEEDY_PRESENCE_CONTRACT,
  createSeedyPresenceCapabilities,
  resolveGatewayChannelPresenceContract,
} from "../channel-presence-policy.js";
import type { ChannelAdapter, EnvelopeHandler } from "../channel-adapter.js";

describe("Seedy presence channel policy", () => {
  it("resolves Telegram and Discord to native ephemeral presence plus editable status capability", () => {
    const telegram = resolveGatewayChannelPresenceContract(TELEGRAM_SEEDY_PRESENCE_CONTRACT);
    const discord = resolveGatewayChannelPresenceContract(DISCORD_SEEDY_PRESENCE_CONTRACT);

    for (const resolved of [telegram, discord]) {
      expect(resolved.capabilities).toMatchObject({
        surfaceKind: "native_ephemeral",
        canShowNativeEphemeral: true,
        canEditStatus: true,
        canDeleteStatus: true,
        canSendFallbackAck: false,
        canRenderBodyMotion: false,
      });
    }
    expect(telegram.capabilities.heartbeatIntervalMs).toBe(4_000);
    expect(telegram.capabilities.maxStatusChars).toBe(4_096);
    expect(discord.capabilities.heartbeatIntervalMs).toBe(8_000);
    expect(discord.capabilities.canThreadStatus).toBe(true);
    expect(discord.capabilities.maxStatusChars).toBe(2_000);
  });

  it("resolves Slack to editable status without claiming native typing", () => {
    const slack = resolveGatewayChannelPresenceContract(SLACK_SEEDY_PRESENCE_CONTRACT);

    expect(slack.capabilities).toMatchObject({
      surfaceKind: "editable_status",
      canShowNativeEphemeral: false,
      canEditStatus: true,
      canDeleteStatus: true,
      canSendFallbackAck: false,
      canThreadStatus: true,
      heartbeatIntervalMs: 15_000,
      maxStatusChars: 4_000,
    });
  });

  it("resolves WhatsApp and Signal to delayed fallback acknowledgement without native or editable presence", () => {
    const whatsapp = resolveGatewayChannelPresenceContract(WHATSAPP_SEEDY_PRESENCE_CONTRACT);
    const signal = resolveGatewayChannelPresenceContract(SIGNAL_SEEDY_PRESENCE_CONTRACT);

    for (const resolved of [whatsapp, signal]) {
      expect(resolved.capabilities).toMatchObject({
        surfaceKind: "send_on_delay",
        canShowNativeEphemeral: false,
        canEditStatus: false,
        canDeleteStatus: false,
        canSendFallbackAck: true,
        fallbackAckDelayMs: 4_000,
        heartbeatIntervalMs: 30_000,
      });
    }
    expect(whatsapp.capabilities.maxStatusChars).toBe(4_096);
    expect(signal.capabilities.maxStatusChars).toBe(2_000);
  });

  it("keeps webhook and missing contracts diagnostic-only instead of inventing chat presence", () => {
    const webhook = resolveGatewayChannelPresenceContract(WEBHOOK_SEEDY_PRESENCE_CONTRACT);
    const defaulted = resolveGatewayChannelPresenceContract(undefined);

    for (const resolved of [webhook, defaulted]) {
      expect(resolved.capabilities).toMatchObject({
        surfaceKind: "diagnostic_only",
        canShowNativeEphemeral: false,
        canEditStatus: false,
        canSendFallbackAck: false,
        meaningfulStatusDelayMs: 0,
        heartbeatIntervalMs: 0,
      });
    }
    expect(defaulted.capabilities).toEqual(resolveGatewayChannelPresenceContract(DIAGNOSTIC_ONLY_SEEDY_PRESENCE_CONTRACT).capabilities);
  });

  it("keeps final-only distinct from diagnostic-only for send-once surfaces", () => {
    const finalOnly = resolveGatewayChannelPresenceContract(FINAL_ONLY_SEEDY_PRESENCE_CONTRACT);

    expect(finalOnly.capabilities.surfaceKind).toBe("final_only");
    expect(finalOnly.capabilities.canSendFallbackAck).toBe(false);
    expect(finalOnly.capabilities.meaningfulStatusDelayMs).toBe(0);
  });

  it("supports future GUI body presence without gateway channel internals", () => {
    const gui = resolveGatewayChannelPresenceContract(GUI_BODY_SEEDY_PRESENCE_CONTRACT);

    expect(gui.capabilities).toMatchObject({
      surfaceKind: "gui_body",
      canRenderBodyMotion: true,
      canRenderAmbientStatus: true,
      canEditStatus: true,
      canShowNativeEphemeral: false,
    });
  });

  it("derives timing from declared capabilities rather than platform names", () => {
    const nativeCustom = createSeedyPresenceCapabilities({
      surfaceKind: "native_ephemeral",
      canShowNativeEphemeral: true,
      canEditStatus: false,
      canDeleteStatus: false,
      canSendFallbackAck: false,
      canRenderBodyMotion: false,
      canRenderAmbientStatus: false,
      canThreadStatus: false,
    });
    const editableCustom = createSeedyPresenceCapabilities({
      surfaceKind: "editable_status",
      canShowNativeEphemeral: false,
      canEditStatus: true,
      canDeleteStatus: false,
      canSendFallbackAck: false,
      canRenderBodyMotion: false,
      canRenderAmbientStatus: false,
      canThreadStatus: false,
    });

    expect(nativeCustom.heartbeatIntervalMs).toBe(4_000);
    expect(editableCustom.heartbeatIntervalMs).toBe(15_000);
  });

  it("lets adapters declare presence contracts without semantic routing logic", () => {
    const adapter: ChannelAdapter = {
      name: "custom-editable",
      presenceContract: SLACK_SEEDY_PRESENCE_CONTRACT,
      async start() {},
      async stop() {},
      onEnvelope(_handler: EnvelopeHandler) {
        void _handler;
      },
    };

    const resolved = resolveGatewayChannelPresenceContract(adapter.presenceContract);

    expect(resolved.capabilities.surfaceKind).toBe("editable_status");
    expect(resolved.capabilities.canEditStatus).toBe(true);
  });
});
