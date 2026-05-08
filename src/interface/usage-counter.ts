export interface UsageCounter {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

const MAX_TOKEN_COUNT = Number.MAX_SAFE_INTEGER;

export function parseUsageTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function zeroUsageCounter(): UsageCounter {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

export function addUsageTokenCounts(left: unknown, right: unknown): number {
  const normalizedLeft = parseUsageTokenCount(left) ?? 0;
  const normalizedRight = parseUsageTokenCount(right) ?? 0;
  const sum = normalizedLeft + normalizedRight;
  return Number.isSafeInteger(sum) ? sum : MAX_TOKEN_COUNT;
}

export function normalizeUsageCounter(raw: unknown): UsageCounter {
  if (!raw || typeof raw !== "object") return zeroUsageCounter();
  const usage = raw as Record<string, unknown>;
  const inputTokens = parseUsageTokenCount(usage.inputTokens) ?? 0;
  const outputTokens = parseUsageTokenCount(usage.outputTokens) ?? 0;
  const totalTokens = parseUsageTokenCount(usage.totalTokens) ?? addUsageTokenCounts(inputTokens, outputTokens);
  return { inputTokens, outputTokens, totalTokens };
}

export function sumUsageCounters(base: unknown, delta: unknown): UsageCounter {
  const normalizedBase = normalizeUsageCounter(base);
  const normalizedDelta = normalizeUsageCounter(delta);
  return {
    inputTokens: addUsageTokenCounts(normalizedBase.inputTokens, normalizedDelta.inputTokens),
    outputTokens: addUsageTokenCounts(normalizedBase.outputTokens, normalizedDelta.outputTokens),
    totalTokens: addUsageTokenCounts(normalizedBase.totalTokens, normalizedDelta.totalTokens),
  };
}

export function addUsageCounter(target: UsageCounter, delta: unknown): void {
  const next = sumUsageCounters(target, delta);
  target.inputTokens = next.inputTokens;
  target.outputTokens = next.outputTokens;
  target.totalTokens = next.totalTokens;
}

export function hasUsage(raw: unknown): boolean {
  const usage = normalizeUsageCounter(raw);
  return usage.totalTokens > 0 || usage.inputTokens > 0 || usage.outputTokens > 0;
}

export function formatUsageCounter(prefix: string, raw: unknown): string[] {
  const usage = normalizeUsageCounter(raw);
  return [
    `${prefix} input tokens:  ${usage.inputTokens}`,
    `${prefix} output tokens: ${usage.outputTokens}`,
    `${prefix} total tokens:  ${usage.totalTokens}`,
  ];
}
