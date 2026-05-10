export interface SeedyPresenceActivitySource {
  readonly last_activity_label?: string;
  readonly subject?: string;
}

export function safeSeedyPresenceActivity(source: SeedyPresenceActivitySource): string | null {
  return safeSeedyPresenceActivityFragment(source.last_activity_label)
    ?? safeSeedyPresenceActivityFragment(source.subject);
}

export function safeSeedyPresenceActivityFragment(value: string | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 90) return null;
  if (!isSafeSeedyPresenceFragment(normalized)) return null;
  return normalizeControlledActivityLabel(normalized);
}

function normalizeControlledActivityLabel(value: string): string | null {
  switch (value) {
    case "Taking action":
    case "tool activity":
    case "tool activity started":
    case "tool activity finished":
      return null;
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

function isSafeSeedyPresenceFragment(value: string): boolean {
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
  const lower = value.toLowerCase();
  if (/(^|\s)(command|shell|bash|zsh|terminal|exec|spawn|subprocess)(\s|:|$)/i.test(value)) return true;
  if (/(^|\s)(npm|pnpm|yarn|node|npx|git|gh|aws|gcloud|az|kubectl|docker|ssh|scp|curl|python|python3|pip|uv|make|cargo|go|ruby|bundle|psql|sqlite3)\s+\S/.test(lower)) {
    return true;
  }
  if (/(^|\s)-{1,2}[a-z0-9][a-z0-9-]*(=|\s|$)/i.test(value)) return true;
  if (/(^|[\s:])([.~]?\/|[A-Za-z]:\\)\S+/.test(value)) return true;
  if (/\b[A-Z0-9_]{3,}\b/.test(value) && /[_=]/.test(value)) return true;
  return false;
}
