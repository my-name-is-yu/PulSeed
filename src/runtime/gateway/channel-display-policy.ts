export type GatewayDisplaySurface = "progress" | "final";

export type GatewayProgressSurfaceMode = "editable" | "single_status" | "off";

export type GatewayFinalSurfaceMode = "edit_stream" | "send_once" | "chunked";

export type GatewayProgressCleanupPolicy = "delete" | "collapse" | "retain" | "none";

export type GatewayToolProgressMode = "off" | "new" | "all" | "verbose";

export interface GatewayDisplayCapabilities {
  readonly canEditMessages: boolean;
  readonly canDeleteMessages: boolean;
  readonly canStreamByEdit: boolean;
  readonly canThreadReplies: boolean;
  readonly canSendReactions: boolean;
  readonly canSendSilentMessages: boolean;
  readonly maxMessageLength?: number;
}

export interface GatewayDisplayPolicy {
  readonly progressSurface: GatewayProgressSurfaceMode;
  readonly finalSurface: GatewayFinalSurfaceMode;
  readonly cleanupPolicy: GatewayProgressCleanupPolicy;
  readonly toolProgress: GatewayToolProgressMode;
  readonly showReasoning: false;
  readonly progressMaxItems: number;
  readonly progressMaxChars: number;
}

export interface GatewayChannelDisplayContract {
  readonly capabilities: GatewayDisplayCapabilities;
  readonly policy?: Partial<GatewayDisplayPolicy>;
}

export interface ResolvedGatewayChannelDisplayContract {
  readonly capabilities: GatewayDisplayCapabilities;
  readonly policy: GatewayDisplayPolicy;
}

const DEFAULT_PROGRESS_MAX_ITEMS = 8;
const DEFAULT_PROGRESS_MAX_CHARS = 1_200;

export const EDITABLE_GATEWAY_DISPLAY_CAPABILITIES: GatewayDisplayCapabilities = {
  canEditMessages: true,
  canDeleteMessages: true,
  canStreamByEdit: true,
  canThreadReplies: false,
  canSendReactions: false,
  canSendSilentMessages: false,
};

export const LIMITED_GATEWAY_DISPLAY_CAPABILITIES: GatewayDisplayCapabilities = {
  canEditMessages: false,
  canDeleteMessages: false,
  canStreamByEdit: false,
  canThreadReplies: false,
  canSendReactions: false,
  canSendSilentMessages: false,
};

export const TELEGRAM_GATEWAY_DISPLAY_CONTRACT: GatewayChannelDisplayContract = {
  capabilities: {
    ...EDITABLE_GATEWAY_DISPLAY_CAPABILITIES,
    maxMessageLength: 4_096,
  },
};

export const DISCORD_GATEWAY_DISPLAY_CONTRACT: GatewayChannelDisplayContract = {
  capabilities: {
    ...EDITABLE_GATEWAY_DISPLAY_CAPABILITIES,
    canThreadReplies: true,
    canSendReactions: true,
    maxMessageLength: 2_000,
  },
};

export const SLACK_GATEWAY_DISPLAY_CONTRACT: GatewayChannelDisplayContract = {
  capabilities: {
    ...EDITABLE_GATEWAY_DISPLAY_CAPABILITIES,
    canThreadReplies: true,
    canSendReactions: true,
    maxMessageLength: 4_000,
  },
};

export const WHATSAPP_GATEWAY_DISPLAY_CONTRACT: GatewayChannelDisplayContract = {
  capabilities: {
    ...LIMITED_GATEWAY_DISPLAY_CAPABILITIES,
    maxMessageLength: 4_096,
  },
};

export const SIGNAL_GATEWAY_DISPLAY_CONTRACT: GatewayChannelDisplayContract = {
  capabilities: {
    ...LIMITED_GATEWAY_DISPLAY_CAPABILITIES,
    maxMessageLength: 2_000,
  },
};

export const WEBHOOK_GATEWAY_DISPLAY_CONTRACT: GatewayChannelDisplayContract = {
  capabilities: LIMITED_GATEWAY_DISPLAY_CAPABILITIES,
};

export function createGatewayDisplayPolicy(
  capabilities: GatewayDisplayCapabilities,
  overrides: Partial<GatewayDisplayPolicy> = {},
): GatewayDisplayPolicy {
  const supportsEditableProgress = capabilities.canEditMessages && capabilities.canStreamByEdit;
  const progressSurface: GatewayProgressSurfaceMode = supportsEditableProgress ? "editable" : "off";
  const finalSurface: GatewayFinalSurfaceMode = capabilities.canStreamByEdit
    ? "edit_stream"
    : capabilities.maxMessageLength
      ? "chunked"
      : "send_once";

  const policy: GatewayDisplayPolicy = {
    progressSurface,
    finalSurface,
    cleanupPolicy: supportsEditableProgress
      ? capabilities.canDeleteMessages ? "delete" : "none"
      : "none",
    toolProgress: supportsEditableProgress ? "all" : "off",
    showReasoning: false,
    progressMaxItems: DEFAULT_PROGRESS_MAX_ITEMS,
    progressMaxChars: DEFAULT_PROGRESS_MAX_CHARS,
    ...overrides,
  };
  return { ...policy, showReasoning: false };
}

export function resolveGatewayChannelDisplayContract(
  contract: GatewayChannelDisplayContract | undefined,
): ResolvedGatewayChannelDisplayContract {
  const capabilities = contract?.capabilities ?? LIMITED_GATEWAY_DISPLAY_CAPABILITIES;
  return {
    capabilities,
    policy: createGatewayDisplayPolicy(capabilities, contract?.policy),
  };
}
