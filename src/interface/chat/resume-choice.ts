export function parseResumeChoiceNumber(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1) return null;
  return String(value) === trimmed ? value : null;
}
