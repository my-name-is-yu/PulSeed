import { z } from "zod";

const MAX_NOTIFICATION_BATCHING_WINDOW_MINUTES = 24 * 60;
const MAX_NOTIFICATION_COOLDOWN_MINUTES = 30 * 24 * 60;
const NotificationCooldownMinutesSchema = z.number()
  .finite()
  .safe()
  .nonnegative()
  .max(MAX_NOTIFICATION_COOLDOWN_MINUTES);

// Channel configurations
export const SlackChannelSchema = z.object({
  type: z.literal("slack"),
  webhook_url: z.string().url(),
  report_types: z.array(z.string()).default([]),
  format: z.enum(["compact", "full"]).default("compact"),
});
export type SlackChannel = z.infer<typeof SlackChannelSchema>;

export const EmailChannelSchema = z.object({
  type: z.literal("email"),
  address: z.string().email(),
  smtp: z.object({
    host: z.string(),
    port: z.number().int().positive().default(587),
    secure: z.boolean().default(true),
    auth: z.object({
      user: z.string(),
      pass: z.string(),
    }),
  }),
  report_types: z.array(z.string()).default([]),
  format: z.enum(["compact", "full"]).default("full"),
});
export type EmailChannel = z.infer<typeof EmailChannelSchema>;

export const WebhookChannelSchema = z.object({
  type: z.literal("webhook"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  report_types: z.array(z.string()).default([]),
  format: z.string().default("json"),
});
export type WebhookChannel = z.infer<typeof WebhookChannelSchema>;

export const NotificationChannelSchema = z.discriminatedUnion("type", [
  SlackChannelSchema,
  EmailChannelSchema,
  WebhookChannelSchema,
]);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const PluginNotifierRouteSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  report_types: z.array(z.string()).default([]),
});
export type PluginNotifierRoute = z.infer<typeof PluginNotifierRouteSchema>;

export const PluginNotifierRoutingSchema = z.object({
  mode: z.enum(["all", "only", "none"]).default("all"),
  routes: z.array(PluginNotifierRouteSchema).default([]),
}).default({});
export type PluginNotifierRouting = z.infer<typeof PluginNotifierRoutingSchema>;

// Do Not Disturb
export const DoNotDisturbSchema = z.object({
  enabled: z.boolean().default(false),
  start_hour: z.number().int().min(0).max(23).default(22),
  end_hour: z.number().int().min(0).max(23).default(7),
  exceptions: z.array(z.string()).default(["urgent_alert", "approval_request"]),
});
export type DoNotDisturb = z.infer<typeof DoNotDisturbSchema>;

// Cooldown config (minutes)
export const NotificationCooldownSchema = z.object({
  urgent_alert: NotificationCooldownMinutesSchema.default(0),
  approval_request: NotificationCooldownMinutesSchema.default(0),
  stall_escalation: NotificationCooldownMinutesSchema.default(60),
  strategy_change: NotificationCooldownMinutesSchema.default(30),
  goal_completion: NotificationCooldownMinutesSchema.default(0),
  capability_escalation: NotificationCooldownMinutesSchema.default(60),
}).catchall(NotificationCooldownMinutesSchema);
export type NotificationCooldown = z.infer<typeof NotificationCooldownSchema>;

// Per-goal reporting override
export const GoalReportingOverrideSchema = z.object({
  goal_id: z.string(),
  verbosity: z.enum(["minimal", "standard", "detailed"]).optional(),
  notification_cooldown: z.record(z.string(), NotificationCooldownMinutesSchema).optional(),
  channels: z.array(NotificationChannelSchema).optional(),
});
export type GoalReportingOverride = z.infer<typeof GoalReportingOverrideSchema>;

// Batching config
export const NotificationBatchingSchema = z.object({
  enabled: z.boolean().default(false),
  window_minutes: z.number().finite().int().positive().max(MAX_NOTIFICATION_BATCHING_WINDOW_MINUTES).default(30),
  digest_format: z.enum(["compact", "detailed"]).default("compact"),
});
export type NotificationBatching = z.infer<typeof NotificationBatchingSchema>;

// Full notification config
export const NotificationConfigSchema = z.object({
  channels: z.array(NotificationChannelSchema).default([]),
  plugin_notifiers: PluginNotifierRoutingSchema,
  do_not_disturb: DoNotDisturbSchema.default({}),
  cooldown: NotificationCooldownSchema.default({}),
  goal_overrides: z.array(GoalReportingOverrideSchema).default([]),
  batching: NotificationBatchingSchema.default({}),
});
export type NotificationConfig = z.infer<typeof NotificationConfigSchema>;

// Notification result
export const NotificationResultSchema = z.object({
  channel_type: z.string(),
  success: z.boolean(),
  delivered_at: z.string().datetime().optional(),
  error: z.string().optional(),
  suppressed: z.boolean().default(false),
  suppression_reason: z.enum(["dnd", "cooldown", "filtered"]).optional(),
});
export type NotificationResult = z.infer<typeof NotificationResultSchema>;
