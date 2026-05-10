import { renderSeedyPresenceViewModel } from "../../interface/chat/seedy-presence-view-model.js";
import {
  safeSeedyPresenceActivity,
  safeSeedyPresenceActivityFragment,
} from "../../interface/chat/seedy-presence-text.js";
import type { SeedyTurnPresence } from "../../interface/chat/seedy-turn-presence.js";

export interface SeedyPresenceRenderingOptions {
  readonly maxChars?: number;
  readonly now?: Date | string | number;
}

export function renderSeedyPresenceStatusText(
  presence: SeedyTurnPresence,
  options: SeedyPresenceRenderingOptions = {},
): string | null {
  if (presence.audience !== "user") return null;

  const viewModel = renderSeedyPresenceViewModel(presence);
  const text = statusTextForPresence(presence, viewModel.compactStatus, options);
  return truncateStatus(text, options.maxChars);
}

export function renderSeedyPresenceFallbackAck(
  presence: SeedyTurnPresence,
  options: SeedyPresenceRenderingOptions = {},
): string | null {
  if (presence.audience !== "user") return null;
  if (presence.phase === "complete") return null;
  return truncateStatus("I'm checking this.", options.maxChars);
}

export function isTerminalSeedyPresence(presence: SeedyTurnPresence): boolean {
  return presence.phase === "complete";
}

function statusTextForPresence(
  presence: SeedyTurnPresence,
  compactStatus: string,
  options: SeedyPresenceRenderingOptions,
): string {
  if (presence.importance === "action_required" || presence.expected_next === "approval") {
    return withSafeSubject("I need your input to continue.", presence);
  }
  if (presence.importance === "blocked" || presence.phase === "blocked") {
    return withSafeSubject("I'm blocked and need attention.", presence);
  }

  switch (compactStatus) {
    case "present":
    case "orienting":
      return withSafeSubject("I'm checking this.", presence);
    case "thinking":
      return withSafeSubject("I'm thinking through the next step.", presence);
    case "acting":
      return renderActivityStatus("I'm working on it.", presence, options);
    case "waiting":
      return renderWaitingStatus(presence, options);
    case "needs_user":
      return "I need your input to continue.";
    case "speaking":
      return "I'm putting the reply together.";
    case "idle":
      return "Done.";
    default:
      return "I'm checking this.";
  }
}

function renderActivityStatus(
  fallback: string,
  presence: SeedyTurnPresence,
  options: SeedyPresenceRenderingOptions,
): string {
  const activity = safePresenceActivity(presence);
  if (!activity) return fallback;
  const elapsed = formatElapsedSince(presence.last_activity_at ?? presence.updated_at, options.now);
  return `I'm working on it. Last visible activity: ${activity}${elapsed}.`;
}

function renderWaitingStatus(
  presence: SeedyTurnPresence,
  options: SeedyPresenceRenderingOptions,
): string {
  const activity = safePresenceActivity(presence);
  if (!activity) {
    return "I'm still working on it. I don't have a new visible update yet.";
  }
  const elapsed = formatElapsedSince(presence.last_activity_at ?? presence.updated_at, options.now);
  return `I'm still working on it. Last visible activity: ${activity}${elapsed}.`;
}

function withSafeSubject(prefix: string, presence: SeedyTurnPresence): string {
  const subject = safeSeedyPresenceActivityFragment(presence.subject);
  if (!subject) return prefix;
  return `${prefix} ${subject}.`;
}

function safePresenceActivity(presence: SeedyTurnPresence): string | null {
  return safeSeedyPresenceActivity(presence);
}

function formatElapsedSince(value: string | undefined, nowInput: Date | string | number | undefined): string {
  if (!value) return "";
  const then = Date.parse(value);
  const now = nowInput instanceof Date
    ? nowInput.getTime()
    : typeof nowInput === "string"
      ? Date.parse(nowInput)
      : typeof nowInput === "number"
        ? nowInput
        : Date.now();
  if (!Number.isFinite(then) || !Number.isFinite(now)) return "";
  const elapsedMs = Math.max(0, now - then);
  const seconds = Math.round(elapsedMs / 1_000);
  if (seconds < 5) return "";
  if (seconds < 60) return ` about ${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return ` about ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return ` about ${hours} hour${hours === 1 ? "" : "s"} ago`;
}

function truncateStatus(text: string, maxChars: number | undefined): string {
  if (maxChars === undefined || text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, Math.max(maxChars, 0));
  return text.slice(0, maxChars - 1).trimEnd();
}
