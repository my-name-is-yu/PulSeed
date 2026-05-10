import { renderSeedyPresenceViewModel } from "../../interface/chat/seedy-presence-view-model.js";
import type { SeedyTurnPresence } from "../../interface/chat/seedy-turn-presence.js";

export interface SeedyPresenceRenderingOptions {
  readonly maxChars?: number;
}

export function renderSeedyPresenceStatusText(
  presence: SeedyTurnPresence,
  options: SeedyPresenceRenderingOptions = {},
): string | null {
  if (presence.audience !== "user") return null;

  const viewModel = renderSeedyPresenceViewModel(presence);
  const text = statusTextForCompactStatus(viewModel.compactStatus);
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

function statusTextForCompactStatus(compactStatus: string): string {
  switch (compactStatus) {
    case "present":
    case "orienting":
      return "Checking this.";
    case "thinking":
      return "Thinking through the next step.";
    case "acting":
      return "Working on it.";
    case "waiting":
      return "Waiting on the current step.";
    case "needs_user":
      return "I need your input to continue.";
    case "speaking":
      return "Preparing the reply.";
    case "idle":
      return "Done.";
    default:
      return "Checking this.";
  }
}

function truncateStatus(text: string, maxChars: number | undefined): string {
  if (maxChars === undefined || text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, Math.max(maxChars, 0));
  return text.slice(0, maxChars - 1).trimEnd();
}
