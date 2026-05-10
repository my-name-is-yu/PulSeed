import type { SeedyTurnPresence, SeedyTurnPresencePhase } from "./seedy-turn-presence.js";

export type SeedyPresenceBodyState =
  | "idle"
  | "attending"
  | "thinking"
  | "acting"
  | "waiting"
  | "needs_user"
  | "speaking";

export type SeedyPresenceSurfaceHint =
  | "none"
  | "progress"
  | "approval"
  | "tool"
  | "artifact"
  | "diagnostic";

export interface SeedyPresenceViewModel {
  readonly schema_version: "seedy-presence-view-model-v1";
  readonly turnId: string;
  readonly bodyState: SeedyPresenceBodyState;
  readonly compactStatus: string;
  readonly surfaceHint: SeedyPresenceSurfaceHint;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly userVisible: boolean;
}

export function renderSeedyPresenceViewModel(
  presence: SeedyTurnPresence,
): SeedyPresenceViewModel {
  return {
    schema_version: "seedy-presence-view-model-v1",
    turnId: presence.turn_id,
    bodyState: bodyStateFromPresence(presence),
    compactStatus: compactStatusFromPresence(presence),
    surfaceHint: surfaceHintFromPresence(presence),
    startedAt: presence.started_at,
    updatedAt: presence.updated_at,
    userVisible: presence.audience === "user",
  };
}

function bodyStateFromPresence(presence: SeedyTurnPresence): SeedyPresenceBodyState {
  if (presence.importance === "action_required" || presence.importance === "blocked") {
    return "needs_user";
  }
  switch (presence.phase) {
    case "received":
    case "orienting":
      return "attending";
    case "thinking":
      return "thinking";
    case "acting":
      return "acting";
    case "waiting":
      return "waiting";
    case "blocked":
      return "needs_user";
    case "finalizing":
      return "speaking";
    case "complete":
      return "idle";
  }
}

function compactStatusFromPresence(presence: SeedyTurnPresence): string {
  if (presence.importance === "action_required" || presence.importance === "blocked") {
    return "needs_user";
  }
  switch (presence.phase) {
    case "received":
      return "present";
    case "orienting":
      return "orienting";
    case "thinking":
      return "thinking";
    case "acting":
      return "acting";
    case "waiting":
      return "waiting";
    case "blocked":
      return "needs_user";
    case "finalizing":
      return "speaking";
    case "complete":
      return "idle";
  }
}

function surfaceHintFromPresence(presence: SeedyTurnPresence): SeedyPresenceSurfaceHint {
  if (presence.audience === "diagnostic") return "diagnostic";
  if (
    presence.importance === "action_required"
    || presence.importance === "blocked"
    || presence.expected_next === "approval"
  ) {
    return "approval";
  }
  if (presence.expected_next === "progress") return "progress";
  if (presence.phase === "acting") return "tool";
  if (presence.phase === "blocked") return "approval";
  return surfaceHintFromPhase(presence.phase);
}

function surfaceHintFromPhase(phase: SeedyTurnPresencePhase): SeedyPresenceSurfaceHint {
  switch (phase) {
    case "received":
    case "orienting":
    case "thinking":
    case "finalizing":
    case "complete":
      return "none";
    case "acting":
      return "tool";
    case "waiting":
      return "progress";
    case "blocked":
      return "approval";
  }
}
