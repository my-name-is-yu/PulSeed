export const BUILTIN_GATEWAY_CHANNEL_NAMES = [
  "telegram-bot",
  "whatsapp-webhook",
  "signal-bridge",
  "discord-bot",
] as const;

export type BuiltinGatewayChannelName = typeof BUILTIN_GATEWAY_CHANNEL_NAMES[number];
