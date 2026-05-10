export function computeActualElapsedMs(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
): number | null {
  if (!startedAt || !completedAt) return null;

  const startedMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs)) return null;

  const elapsedMs = completedMs - startedMs;
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) return null;
  return elapsedMs;
}
