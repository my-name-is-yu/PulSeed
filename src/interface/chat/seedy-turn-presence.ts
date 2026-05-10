import { z } from "zod";

export const SEEDY_TURN_PRESENCE_SCHEMA_VERSION = "seedy-turn-presence-v1";
export const SEEDY_ACTIVE_TURN_STATUS_SCHEMA_VERSION = "seedy-active-turn-status-v1";

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

export interface SeedyActiveTurnStatus {
  readonly schema_version: typeof SEEDY_ACTIVE_TURN_STATUS_SCHEMA_VERSION;
  readonly active: boolean;
  readonly presence?: SeedyTurnPresence;
  readonly phase?: SeedyTurnPresencePhase;
  readonly importance?: SeedyPresenceImportance;
  readonly subject?: string;
  readonly reason?: string;
  readonly started_at?: string;
  readonly updated_at?: string;
  readonly last_activity_at?: string;
  readonly last_activity_label?: string;
  readonly expected_next?: SeedyPresenceExpectedNext;
  readonly elapsed_since_last_activity_ms?: number;
  readonly waiting: boolean;
  readonly blocked: boolean;
  readonly action_required: boolean;
}

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

export function createSeedyActiveTurnStatus(
  presence: SeedyTurnPresence | null | undefined,
  options: { readonly now?: Date | string | number } = {},
): SeedyActiveTurnStatus {
  if (!presence) {
    return {
      schema_version: SEEDY_ACTIVE_TURN_STATUS_SCHEMA_VERSION,
      active: false,
      waiting: false,
      blocked: false,
      action_required: false,
    };
  }

  const lastActivityAt = presence.last_activity_at ?? presence.updated_at;
  const elapsedMs = elapsedSince(lastActivityAt, options.now);
  const blocked = presence.phase === "blocked" || presence.importance === "blocked";
  const actionRequired = presence.importance === "action_required" || presence.expected_next === "approval";
  return {
    schema_version: SEEDY_ACTIVE_TURN_STATUS_SCHEMA_VERSION,
    active: true,
    presence,
    phase: presence.phase,
    importance: presence.importance,
    ...(presence.subject ? { subject: presence.subject } : {}),
    ...(presence.reason ? { reason: presence.reason } : {}),
    started_at: presence.started_at,
    updated_at: presence.updated_at,
    last_activity_at: lastActivityAt,
    ...(presence.last_activity_label ? { last_activity_label: presence.last_activity_label } : {}),
    ...(presence.expected_next ? { expected_next: presence.expected_next } : {}),
    ...(elapsedMs !== null ? { elapsed_since_last_activity_ms: elapsedMs } : {}),
    waiting: presence.phase === "waiting",
    blocked,
    action_required: actionRequired,
  };
}

export function formatSeedyActiveTurnStatus(status: SeedyActiveTurnStatus): string {
  if (!status.active) return "Seedy is not handling an active turn right now.";

  const subject = status.subject ? `: ${status.subject}` : "";
  const elapsed = formatElapsed(status.elapsed_since_last_activity_ms);
  const activity = status.last_activity_label
    ? ` Last visible activity: ${status.last_activity_label}${elapsed ? ` ${elapsed}` : ""}.`
    : elapsed
      ? ` Last visible activity was ${elapsed}.`
      : "";
  if (status.blocked) {
    return `Seedy is blocked${subject}.${activity}`.trim();
  }
  if (status.action_required) {
    return `Seedy needs input to continue${subject}.${activity}`.trim();
  }
  if (status.waiting) {
    return `Seedy is waiting${subject}.${activity}`.trim();
  }
  return `Seedy is ${status.phase ?? "working"}${subject}.${activity}`.trim();
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

function elapsedSince(value: string | undefined, nowInput: Date | string | number | undefined): number | null {
  if (!value) return null;
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return null;
  const now = nowInput instanceof Date
    ? nowInput.getTime()
    : typeof nowInput === "string"
      ? Date.parse(nowInput)
      : typeof nowInput === "number"
        ? nowInput
        : Date.now();
  if (!Number.isFinite(now)) return null;
  return Math.max(0, now - then);
}

function formatElapsed(elapsedMs: number | undefined): string {
  if (elapsedMs === undefined) return "";
  const seconds = Math.max(0, Math.round(elapsedMs / 1_000));
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hours ago`;
}
