const EXACT_FINITE_NUMBER_TOKEN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

export function coerceDataSourceObservationValue(value: unknown): number | string | boolean | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!EXACT_FINITE_NUMBER_TOKEN.test(normalized)) return value;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (typeof value === "boolean" || value === null) {
    return value;
  }
  return 0;
}
