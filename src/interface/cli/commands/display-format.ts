const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const MAX_VALID_DATE_MS = 8_640_000_000_000_000;

function isValidTimestampMs(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && Math.abs(value) <= MAX_VALID_DATE_MS;
}

function formatRelativeDelta(deltaMs: number): string {
  const suffix = deltaMs < 0 ? "from now" : "ago";
  const absMs = Math.abs(deltaMs);
  if (absMs < MS_PER_MINUTE) return `${Math.floor(absMs / 1000)}s ${suffix}`;
  if (absMs < MS_PER_HOUR) return `${Math.floor(absMs / MS_PER_MINUTE)}m ${suffix}`;
  if (absMs < MS_PER_DAY) return `${Math.floor(absMs / MS_PER_HOUR)}h ${suffix}`;
  return `${Math.floor(absMs / MS_PER_DAY)}d ${suffix}`;
}

export function formatUptime(startedAt: string): string {
  const startedAtMs = Date.parse(startedAt);
  if (!isValidTimestampMs(startedAtMs)) return "unknown";

  const ms = Math.max(0, Date.now() - startedAtMs);
  const days = Math.floor(ms / MS_PER_DAY);
  const hours = Math.floor((ms % MS_PER_DAY) / MS_PER_HOUR);
  const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

export function formatRelativeTime(isoDate: string): string {
  const timestamp = Date.parse(isoDate);
  return formatRelativeTimestamp(timestamp);
}

export function formatRelativeTimestamp(timestamp: number): string {
  if (!isValidTimestampMs(timestamp)) return "unknown";
  return formatRelativeDelta(Date.now() - timestamp);
}

export function formatAbsoluteRelativeTimestamp(timestamp: number | undefined): string {
  if (timestamp === undefined) return "n/a";
  if (!isValidTimestampMs(timestamp)) return "n/a";
  return `${new Date(timestamp).toISOString()} (${formatRelativeTimestamp(timestamp)})`;
}

export function formatDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "n/a";
  if (ms < 1000) return `${ms}ms`;
  if (ms < MS_PER_MINUTE) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / MS_PER_MINUTE).toFixed(1)}m`;
}

export function formatPercent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "n/a" : `${(value * 100).toFixed(1)}%`;
}
