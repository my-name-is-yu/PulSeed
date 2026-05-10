export { IngressGateway } from "./ingress-gateway.js";
export { BUILTIN_GATEWAY_CHANNEL_NAMES, type BuiltinGatewayChannelName } from "./builtin-channel-names.js";
export {
  ensureBuiltinGatewayChannelLocation,
  ensureBuiltinGatewayChannelLocations,
  loadBuiltinGatewayIntegrations,
  type BuiltinGatewayIntegrations,
  type BuiltinGatewayChannelLocation,
} from "./builtin-channel-integrations.js";
export { HttpChannelAdapter } from "./http-channel-adapter.js";
export { SlackChannelAdapter } from "./slack-channel-adapter.js";
export type { ChannelAdapter, EnvelopeHandler, ReplyChannel } from "./channel-adapter.js";
export type {
  TypingIndicatorCapability,
  TypingIndicatorContext,
  TypingIndicatorSession,
  TypingIndicatorStatus,
} from "./channel-adapter.js";
export {
  createGatewayDisplayPolicy,
  resolveGatewayChannelDisplayContract,
  DISCORD_GATEWAY_DISPLAY_CONTRACT,
  EDITABLE_GATEWAY_DISPLAY_CAPABILITIES,
  LIMITED_GATEWAY_DISPLAY_CAPABILITIES,
  SIGNAL_GATEWAY_DISPLAY_CONTRACT,
  SLACK_GATEWAY_DISPLAY_CONTRACT,
  TELEGRAM_GATEWAY_DISPLAY_CONTRACT,
  WEBHOOK_GATEWAY_DISPLAY_CONTRACT,
  WHATSAPP_GATEWAY_DISPLAY_CONTRACT,
} from "./channel-display-policy.js";
export { NonTuiDisplayProjector, createNonTuiDisplayProjector } from "./non-tui-display-projector.js";
export {
  renderGatewayActivityEvent,
  renderGatewayAgentTimelineItem,
  renderGatewayExpressionDecision,
  renderGatewayOperationProgress,
  renderGatewayToolProgressEvent,
} from "./chat-event-rendering.js";
export {
  publicProgressFromActivityEvent,
  publicProgressFromAgentTimelineItem,
  publicProgressFromOperationProgress,
  publicProgressFromToolEvent,
  renderGatewayPublicProgress,
} from "./gateway-progress-narration.js";
export type {
  NonTuiDisplayMessageRef,
  NonTuiDisplayProjectorOptions,
  NonTuiDisplayTransport,
} from "./non-tui-display-projector.js";
export type {
  GatewayChannelDisplayContract,
  GatewayDisplayCapabilities,
  GatewayDisplayPolicy,
  GatewayDisplaySurface,
  GatewayFinalSurfaceMode,
  GatewayProgressCleanupPolicy,
  GatewayProgressSurfaceMode,
  GatewayToolProgressMode,
  ResolvedGatewayChannelDisplayContract,
} from "./channel-display-policy.js";
export {
  createRefreshingTypingIndicator,
  createUnsupportedTypingIndicator,
  withTypingIndicator,
} from "./typing-indicator.js";
export type { SlackChannelAdapterConfig, SlackResponse } from "./slack-channel-adapter.js";
export { WsChannelAdapter } from "./ws-channel-adapter.js";
export type { WsLike, WsSocketLike } from "./ws-channel-adapter.js";
