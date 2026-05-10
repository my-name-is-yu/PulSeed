import { renderSeedyPresenceViewModel } from "../../interface/chat/seedy-presence-view-model.js";
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
  const subject = safeActivityFragment(presence.subject);
  if (!subject) return prefix;
  return `${prefix} ${subject}.`;
}

function safePresenceActivity(presence: SeedyTurnPresence): string | null {
  return safeActivityFragment(presence.last_activity_label)
    ?? safeActivityFragment(presence.subject);
}

function safeActivityFragment(value: string | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 90) return null;
  if (!isSafePresenceFragment(normalized)) return null;
  return normalizeControlledActivityLabel(normalized);
}

function normalizeControlledActivityLabel(value: string): string {
  switch (value) {
    case "Taking action":
      return "the current action";
    case "tool activity":
    case "tool activity started":
    case "tool activity finished":
      return "the current action";
    case "drafting the response":
      return "drafting the reply";
    case "approval requested":
      return "waiting for your approval";
    default:
      return lowerInitial(value);
  }
}

function lowerInitial(value: string): string {
  const first = value[0];
  if (!first) return value;
  return `${first.toLowerCase()}${value.slice(1)}`;
}

function isSafePresenceFragment(value: string): boolean {
  if (/[\n\r`{}[\]<>]/.test(value)) return false;
  if (/https?:\/\//i.test(value)) return false;
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/.test(value)) return false;
  if (looksLikeCommandOrPath(value)) return false;
  const internalTerms = [
    "api key",
    "command output",
    "compaction",
    "gpt",
    "model",
    "model_request",
    "openai",
    "password",
    "provider",
    "raw ",
    "secret",
    "token",
    "tool catalog",
    "tool output",
    "trace",
  ];
  const lower = value.toLowerCase();
  return !internalTerms.some((term) => lower.includes(term));
}

function looksLikeCommandOrPath(value: string): boolean {
  const lower = value.toLocaleLowerCase();
  if (/(^|\s)(command|shell|bash|zsh|terminal|exec|spawn|subprocess)(\s|:|$)/i.test(value)) return true;
  if (/(^|\s)(npm|pnpm|yarn|node|npx|git|gh|aws|gcloud|az|kubectl|docker|ssh|scp|curl|python|python3|pip|uv|make|cargo|go|ruby|bundle|psql|sqlite3)\s+\S/.test(lower)) {
    return true;
  }
  if (/(^|\s)-{1,2}[a-z0-9][a-z0-9-]*(=|\s|$)/i.test(value)) return true;
  if (/(^|[\s:])([.~]?\/|[A-Za-z]:\\)\S+/.test(value)) return true;
  if (/\b[A-Z0-9_]{3,}\b/.test(value) && /[_=]/.test(value)) return true;
  return false;
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
