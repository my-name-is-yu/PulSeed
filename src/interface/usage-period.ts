const USAGE_PERIOD_RE = /^(\d+)([dhw])$/i;

export function parseUsagePeriodMs(period: string): number {
  const match = USAGE_PERIOD_RE.exec(period.trim());
  if (!match) {
    throw new Error("period must look like 7d, 24h, or 2w");
  }
  const value = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("period value must be a positive safe integer");
  }
  const multiplier =
    unit === "h"
      ? 60 * 60 * 1000
      : unit === "w"
        ? 7 * 24 * 60 * 60 * 1000
        : 24 * 60 * 60 * 1000;
  const periodMs = value * multiplier;
  if (!Number.isSafeInteger(periodMs)) {
    throw new Error("period value is too large");
  }
  return periodMs;
}
