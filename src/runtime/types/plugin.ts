import { z } from "zod";

// ─── Config field schema ───

export const ConfigFieldSchema = z.object({
  type: z.enum(["string", "number", "boolean", "array"]),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
});

export type ConfigField = z.infer<typeof ConfigFieldSchema>;

// ─── Plugin manifest schema ───

export const PluginManifestSchema = z.object({
  name: z.string().regex(
    /^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/,
    "Plugin name must use lowercase letters, digits, hyphens, or @scope/name format",
  ),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  type: z.enum(["adapter", "data_source", "notifier", "schedule_source"]),

  // Capability declarations referenced by CapabilityDetector.
  capabilities: z.array(z.string()).min(1),

  // data_source only: observable dimension names.
  dimensions: z.array(z.string()).optional(),

  // notifier only: supported event types.
  supported_events: z.array(z.string()).optional(),

  description: z.string(),
  config_schema: z.record(ConfigFieldSchema).default({}),

  // npm package dependencies.
  dependencies: z.array(z.string()).default([]),

  // Plugin entry point relative to the plugin directory.
  entry_point: z.string().default("dist/index.js"),

  // Required PulSeed version bounds as semver ranges.
  min_pulseed_version: z.string().optional(),
  max_pulseed_version: z.string().optional(),

  // Declared resource access for security review.
  permissions: z
    .object({
      network: z.boolean().default(false),
      file_read: z.boolean().default(false),
      file_write: z.boolean().default(false),
      shell: z.boolean().default(false),
    })
    .default({}),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export type PluginType = PluginManifest["type"];

// ─── Plugin state schema ───

const PluginStateSafeNonnegativeIntSchema = z.number()
  .finite()
  .int()
  .nonnegative()
  .safe();

export const PluginStateSchema = z.object({
  name: z.string(),
  manifest: PluginManifestSchema,
  status: z.enum(["loaded", "error", "disabled", "incompatible"]),
  error_message: z.string().optional(),
  loaded_at: z.string(), // ISO 8601
  // Trust score using the asymmetric design from trust-and-safety.md §2.
  trust_score: z.number().int().min(-100).max(100).default(0),
  usage_count: PluginStateSafeNonnegativeIntSchema.default(0),
  success_count: PluginStateSafeNonnegativeIntSchema.default(0),
  failure_count: PluginStateSafeNonnegativeIntSchema.default(0),
});

export type PluginState = z.infer<typeof PluginStateSchema>;

// ─── Plugin match result ───

export const PluginMatchResultSchema = z.object({
  pluginName: z.string(),
  matchScore: z.number().min(0).max(1),
  matchedDimensions: z.array(z.string()),
  trustScore: z.number().int(),
  autoSelectable: z.boolean(), // trust_score >= 20
});

export type PluginMatchResult = z.infer<typeof PluginMatchResultSchema>;

// ─── Notification types ───

export type NotificationEventType =
  | "goal_progress" // Goal progress update.
  | "goal_complete" // Goal completed.
  | "task_blocked" // Task blocked.
  | "approval_needed" // Human approval required.
  | "stall_detected" // Stall detected.
  | "trust_change" // Trust score changed significantly.
  | "schedule_change_detected" // Schedule change detected.
  | "schedule_heartbeat_failure" // Schedule heartbeat failed.
  | "schedule_escalation" // Schedule escalation.
  | "schedule_report_ready"; // Schedule report is ready.

export interface NotificationEvent {
  type: NotificationEventType;
  goal_id: string;
  timestamp: string; // ISO 8601
  summary: string; // Human-readable one-line summary.
  details: Record<string, unknown>; // Event-type-specific data.
  severity: "info" | "warning" | "critical";
}

// ─── INotifier interface ───

export interface INotifier {
  name: string;
  notify(event: NotificationEvent): Promise<void>;
  supports(eventType: NotificationEventType): boolean;
}
