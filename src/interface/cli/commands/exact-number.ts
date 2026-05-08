const EXACT_FINITE_NUMBER_TOKEN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

export function parseExactFiniteNumber(value: string | undefined): number | null {
  const normalized = value?.trim() ?? "";
  if (!EXACT_FINITE_NUMBER_TOKEN.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
