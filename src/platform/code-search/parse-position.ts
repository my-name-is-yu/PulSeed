const SAFE_POSITION_TOKEN = /^\d+$/;

export function parseSafePosition(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!SAFE_POSITION_TOKEN.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
