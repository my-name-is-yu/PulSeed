const OUTBOX_SEQ_TOKEN = /^[0-9]+$/;

export function parseOutboxSeq(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!OUTBOX_SEQ_TOKEN.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
