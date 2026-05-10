import {
  DISCORD_GATEWAY_DISPLAY_CONTRACT,
  SIGNAL_GATEWAY_DISPLAY_CONTRACT,
  SLACK_GATEWAY_DISPLAY_CONTRACT,
  TELEGRAM_GATEWAY_DISPLAY_CONTRACT,
  WEBHOOK_GATEWAY_DISPLAY_CONTRACT,
  WHATSAPP_GATEWAY_DISPLAY_CONTRACT,
  type GatewayDisplayCapabilities,
} from "./channel-display-policy.js";

export type SeedyPresenceSurfaceKind =
  | "gui_body"
  | "native_ephemeral"
  | "editable_status"
  | "send_on_delay"
  | "final_only"
  | "diagnostic_only";

export interface SeedyPresenceCapabilities {
  readonly surfaceKind: SeedyPresenceSurfaceKind;
  readonly canShowNativeEphemeral: boolean;
  readonly canEditStatus: boolean;
  readonly canDeleteStatus: boolean;
  readonly canSendFallbackAck: boolean;
  readonly canRenderBodyMotion: boolean;
  readonly canRenderAmbientStatus: boolean;
  readonly canThreadStatus: boolean;
  readonly fallbackAckDelayMs: number;
  readonly meaningfulStatusDelayMs: number;
  readonly heartbeatIntervalMs: number;
  readonly maxStatusChars?: number;
}

export type SeedyPresenceCapabilityInput = Omit<
  SeedyPresenceCapabilities,
  "fallbackAckDelayMs" | "meaningfulStatusDelayMs" | "heartbeatIntervalMs"
> & Partial<Pick<
  SeedyPresenceCapabilities,
  "fallbackAckDelayMs" | "meaningfulStatusDelayMs" | "heartbeatIntervalMs"
>>;

export interface GatewayChannelPresenceContract {
  readonly capabilities: SeedyPresenceCapabilityInput;
}

export interface ResolvedGatewayChannelPresenceContract {
  readonly capabilities: SeedyPresenceCapabilities;
}

const DEFAULT_FALLBACK_ACK_DELAY_MS = 4_000;
const DEFAULT_MEANINGFUL_STATUS_DELAY_MS = 2_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const NATIVE_EPHEMERAL_HEARTBEAT_INTERVAL_MS = 4_000;
const EDITABLE_STATUS_HEARTBEAT_INTERVAL_MS = 15_000;

export function createSeedyPresenceCapabilities(
  input: SeedyPresenceCapabilityInput,
): SeedyPresenceCapabilities {
  const hasVisiblePresence =
    input.canShowNativeEphemeral
    || input.canEditStatus
    || input.canRenderBodyMotion
    || input.canSendFallbackAck;

  return {
    ...input,
    fallbackAckDelayMs: input.fallbackAckDelayMs ?? (
      input.canSendFallbackAck ? DEFAULT_FALLBACK_ACK_DELAY_MS : 0
    ),
    meaningfulStatusDelayMs: input.meaningfulStatusDelayMs ?? (
      hasVisiblePresence ? DEFAULT_MEANINGFUL_STATUS_DELAY_MS : 0
    ),
    heartbeatIntervalMs: input.heartbeatIntervalMs ?? defaultHeartbeatIntervalMs(input),
  };
}

export function resolveGatewayChannelPresenceContract(
  contract: GatewayChannelPresenceContract | undefined,
): ResolvedGatewayChannelPresenceContract {
  return {
    capabilities: createSeedyPresenceCapabilities(
      contract?.capabilities ?? DIAGNOSTIC_ONLY_SEEDY_PRESENCE_CONTRACT.capabilities,
    ),
  };
}

export const GUI_BODY_SEEDY_PRESENCE_CONTRACT: GatewayChannelPresenceContract = {
  capabilities: createSeedyPresenceCapabilities({
    surfaceKind: "gui_body",
    canShowNativeEphemeral: false,
    canEditStatus: true,
    canDeleteStatus: true,
    canSendFallbackAck: false,
    canRenderBodyMotion: true,
    canRenderAmbientStatus: true,
    canThreadStatus: true,
  }),
};

export const TELEGRAM_SEEDY_PRESENCE_CONTRACT: GatewayChannelPresenceContract = {
  capabilities: createGatewayPresenceCapabilities({
    display: TELEGRAM_GATEWAY_DISPLAY_CONTRACT.capabilities,
    surfaceKind: "native_ephemeral",
    canShowNativeEphemeral: true,
    canSendFallbackAck: false,
  }),
};

export const DISCORD_SEEDY_PRESENCE_CONTRACT: GatewayChannelPresenceContract = {
  capabilities: createGatewayPresenceCapabilities({
    display: DISCORD_GATEWAY_DISPLAY_CONTRACT.capabilities,
    surfaceKind: "native_ephemeral",
    canShowNativeEphemeral: true,
    canSendFallbackAck: false,
    heartbeatIntervalMs: 8_000,
  }),
};

export const SLACK_SEEDY_PRESENCE_CONTRACT: GatewayChannelPresenceContract = {
  capabilities: createGatewayPresenceCapabilities({
    display: SLACK_GATEWAY_DISPLAY_CONTRACT.capabilities,
    surfaceKind: "editable_status",
    canShowNativeEphemeral: false,
    canSendFallbackAck: false,
  }),
};

export const WHATSAPP_SEEDY_PRESENCE_CONTRACT: GatewayChannelPresenceContract = {
  capabilities: createGatewayPresenceCapabilities({
    display: WHATSAPP_GATEWAY_DISPLAY_CONTRACT.capabilities,
    surfaceKind: "send_on_delay",
    canShowNativeEphemeral: false,
    canSendFallbackAck: true,
  }),
};

export const SIGNAL_SEEDY_PRESENCE_CONTRACT: GatewayChannelPresenceContract = {
  capabilities: createGatewayPresenceCapabilities({
    display: SIGNAL_GATEWAY_DISPLAY_CONTRACT.capabilities,
    surfaceKind: "send_on_delay",
    canShowNativeEphemeral: false,
    canSendFallbackAck: true,
  }),
};

export const FINAL_ONLY_SEEDY_PRESENCE_CONTRACT: GatewayChannelPresenceContract = {
  capabilities: createGatewayPresenceCapabilities({
    display: WEBHOOK_GATEWAY_DISPLAY_CONTRACT.capabilities,
    surfaceKind: "final_only",
    canShowNativeEphemeral: false,
    canSendFallbackAck: false,
  }),
};

export const WEBHOOK_SEEDY_PRESENCE_CONTRACT: GatewayChannelPresenceContract = {
  capabilities: createGatewayPresenceCapabilities({
    display: WEBHOOK_GATEWAY_DISPLAY_CONTRACT.capabilities,
    surfaceKind: "diagnostic_only",
    canShowNativeEphemeral: false,
    canSendFallbackAck: false,
  }),
};

export const DIAGNOSTIC_ONLY_SEEDY_PRESENCE_CONTRACT: GatewayChannelPresenceContract = WEBHOOK_SEEDY_PRESENCE_CONTRACT;

function createGatewayPresenceCapabilities(input: {
  readonly display: GatewayDisplayCapabilities;
  readonly surfaceKind: SeedyPresenceSurfaceKind;
  readonly canShowNativeEphemeral: boolean;
  readonly canSendFallbackAck: boolean;
  readonly heartbeatIntervalMs?: number;
}): SeedyPresenceCapabilities {
  const canEditStatus = input.display.canEditMessages && input.display.canStreamByEdit;
  return createSeedyPresenceCapabilities({
    surfaceKind: input.surfaceKind,
    canShowNativeEphemeral: input.canShowNativeEphemeral,
    canEditStatus,
    canDeleteStatus: canEditStatus && input.display.canDeleteMessages,
    canSendFallbackAck: input.canSendFallbackAck,
    canRenderBodyMotion: false,
    canRenderAmbientStatus: false,
    canThreadStatus: input.display.canThreadReplies,
    ...(input.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: input.heartbeatIntervalMs } : {}),
    ...(input.display.maxMessageLength ? { maxStatusChars: input.display.maxMessageLength } : {}),
  });
}

function defaultHeartbeatIntervalMs(input: SeedyPresenceCapabilityInput): number {
  if (input.canShowNativeEphemeral) return NATIVE_EPHEMERAL_HEARTBEAT_INTERVAL_MS;
  if (input.canEditStatus) return EDITABLE_STATUS_HEARTBEAT_INTERVAL_MS;
  if (input.canSendFallbackAck) return DEFAULT_HEARTBEAT_INTERVAL_MS;
  return 0;
}
