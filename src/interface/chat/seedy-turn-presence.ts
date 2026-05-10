import { z } from "zod";

export const SEEDY_TURN_PRESENCE_SCHEMA_VERSION = "seedy-turn-presence-v1";

export const SeedyTurnPresencePhaseSchema = z.enum([
  "received",
  "orienting",
  "thinking",
  "acting",
  "waiting",
  "blocked",
  "finalizing",
  "complete",
]);
export type SeedyTurnPresencePhase = z.infer<typeof SeedyTurnPresencePhaseSchema>;

export const SeedyPresenceAudienceSchema = z.enum([
  "user",
  "diagnostic",
  "internal",
]);
export type SeedyPresenceAudience = z.infer<typeof SeedyPresenceAudienceSchema>;

export const SeedyPresenceImportanceSchema = z.enum([
  "ephemeral",
  "status",
  "action_required",
  "blocked",
]);
export type SeedyPresenceImportance = z.infer<typeof SeedyPresenceImportanceSchema>;

export const SeedyPresenceExpectedNextSchema = z.enum([
  "final",
  "progress",
  "approval",
  "user_input",
  "unknown",
]);
export type SeedyPresenceExpectedNext = z.infer<typeof SeedyPresenceExpectedNextSchema>;

export const SeedyTurnPresenceSchema = z.object({
  schema_version: z.literal(SEEDY_TURN_PRESENCE_SCHEMA_VERSION).default(SEEDY_TURN_PRESENCE_SCHEMA_VERSION),
  turn_id: z.string().min(1),
  ingress_id: z.string().min(1).optional(),
  audience: SeedyPresenceAudienceSchema,
  phase: SeedyTurnPresencePhaseSchema,
  importance: SeedyPresenceImportanceSchema,
  subject: z.string().min(1).max(160).optional(),
  reason: z.string().min(1).max(240).optional(),
  started_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  last_activity_at: z.string().datetime().optional(),
  last_activity_label: z.string().min(1).max(120).optional(),
  expected_next: SeedyPresenceExpectedNextSchema.optional(),
  diagnostic_ref: z.string().min(1).max(240).optional(),
}).strict();
export type SeedyTurnPresence = z.infer<typeof SeedyTurnPresenceSchema>;

type SeedyTurnPresenceInput = Omit<z.input<typeof SeedyTurnPresenceSchema>, "schema_version">;

export type CreateSeedyTurnPresenceInput = SeedyTurnPresenceInput & {
  readonly schema_version?: typeof SEEDY_TURN_PRESENCE_SCHEMA_VERSION;
};

export interface CreateUserVisibleSeedyTurnPresenceInput {
  readonly turn_id: string;
  readonly ingress_id?: string;
  readonly phase: SeedyTurnPresencePhase;
  readonly importance?: SeedyPresenceImportance;
  readonly subject?: string;
  readonly reason?: string;
  readonly started_at?: string;
  readonly updated_at?: string;
  readonly last_activity_at?: string;
  readonly last_activity_label?: string;
  readonly expected_next?: SeedyPresenceExpectedNext;
}

export function createSeedyTurnPresence(input: CreateSeedyTurnPresenceInput): SeedyTurnPresence {
  return SeedyTurnPresenceSchema.parse({
    schema_version: SEEDY_TURN_PRESENCE_SCHEMA_VERSION,
    ...input,
  });
}

export function createUserVisibleSeedyTurnPresence(
  input: CreateUserVisibleSeedyTurnPresenceInput,
): SeedyTurnPresence {
  const now = new Date().toISOString();
  const startedAt = input.started_at ?? now;
  return createSeedyTurnPresence({
    ...input,
    audience: "user",
    importance: input.importance ?? defaultSeedyPresenceImportance(input.phase),
    started_at: startedAt,
    updated_at: input.updated_at ?? startedAt,
  });
}

export function isUserVisibleSeedyTurnPresence(presence: SeedyTurnPresence): boolean {
  return presence.audience === "user";
}

export function defaultSeedyPresenceImportance(
  phase: SeedyTurnPresencePhase,
): SeedyPresenceImportance {
  switch (phase) {
    case "blocked":
      return "blocked";
    case "waiting":
      return "status";
    case "complete":
      return "status";
    case "received":
    case "orienting":
    case "thinking":
    case "acting":
    case "finalizing":
      return "ephemeral";
  }
}
