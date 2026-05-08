const TELEGRAM_INTEGER_TOKEN = /^-?\d+$/;

export type TelegramIntegerListParseResult =
  | { ok: true; values: number[] }
  | { ok: false; invalidValue: string };

export function parseExactTelegramInteger(raw: string): number | undefined {
  const normalized = raw.trim();
  if (!TELEGRAM_INTEGER_TOKEN.test(normalized)) return undefined;
  const value = Number(normalized);
  if (!Number.isSafeInteger(value)) return undefined;
  return value;
}

export function parseTelegramIntegerList(raw: string): TelegramIntegerListParseResult {
  const normalized = raw.trim();
  if (!normalized) return { ok: true, values: [] };

  const values: number[] = [];
  for (const part of normalized.split(",")) {
    const trimmed = part.trim();
    const parsed = parseExactTelegramInteger(trimmed);
    if (parsed === undefined) {
      return { ok: false, invalidValue: trimmed };
    }
    values.push(parsed);
  }
  return { ok: true, values };
}
