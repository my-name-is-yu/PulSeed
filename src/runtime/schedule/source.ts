import { z } from "zod/v3";

const ExternalSchedulePositiveSafeIntegerSchema = z.number()
  .finite()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);

const ExternalScheduleTriggerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cron"),
    expression: z.string().min(1),
  }),
  z.object({
    type: z.literal("interval"),
    seconds: ExternalSchedulePositiveSafeIntegerSchema,
  }),
]);

// External schedule entry from a plugin source (e.g., Google Calendar, Jira)
export const ExternalScheduleEntrySchema = z.object({
  external_id: z.string(),           // ID in the external system
  source_id: z.string(),             // which IScheduleSource provided this
  name: z.string(),
  layer: z.enum(['heartbeat', 'probe', 'cron', 'goal_trigger']),
  trigger: ExternalScheduleTriggerSchema,
  enabled: z.boolean().default(true),
  heartbeat: z.unknown().optional(),
  probe: z.unknown().optional(),
  cron: z.unknown().optional(),
  goal_trigger: z.unknown().optional(),
  metadata: z.record(z.unknown()).default({}), // source-specific data
  synced_at: z.string().datetime(),
});
export type ExternalScheduleEntry = z.infer<typeof ExternalScheduleEntrySchema>;

// Interface that schedule source plugins must implement
export interface IScheduleSource {
  readonly id: string;
  readonly name: string;

  // Fetch all schedule entries from the external source
  fetchEntries(): Promise<ExternalScheduleEntry[]>;

  // Check if the source is healthy/reachable
  healthCheck(): Promise<{ healthy: boolean; error?: string }>;
}
