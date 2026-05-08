import type { LLMResponse } from "../../base/llm/llm-client.js";
import type { ChatSessionUsage, ChatUsageCounter } from "./chat-history.js";

const MAX_TOKEN_COUNT = Number.MAX_SAFE_INTEGER;

function parseTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function zeroUsageCounter(): ChatUsageCounter {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

export function addTokenCounts(left: number, right: number): number {
  const normalizedLeft = parseTokenCount(left) ?? 0;
  const normalizedRight = parseTokenCount(right) ?? 0;
  const sum = normalizedLeft + normalizedRight;
  return Number.isSafeInteger(sum) ? sum : MAX_TOKEN_COUNT;
}

export function normalizeUsageCounter(usage: ChatUsageCounter): ChatUsageCounter {
  const inputTokens = parseTokenCount(usage.inputTokens) ?? 0;
  const outputTokens = parseTokenCount(usage.outputTokens) ?? 0;
  const totalTokens = parseTokenCount(usage.totalTokens) ?? addTokenCounts(inputTokens, outputTokens);
  return { inputTokens, outputTokens, totalTokens };
}

export function sumUsageCounters(base: ChatUsageCounter | undefined, delta: ChatUsageCounter): ChatUsageCounter {
  const normalizedBase = normalizeUsageCounter(base ?? zeroUsageCounter());
  const normalizedDelta = normalizeUsageCounter(delta);
  return {
    inputTokens: addTokenCounts(normalizedBase.inputTokens, normalizedDelta.inputTokens),
    outputTokens: addTokenCounts(normalizedBase.outputTokens, normalizedDelta.outputTokens),
    totalTokens: addTokenCounts(normalizedBase.totalTokens, normalizedDelta.totalTokens),
  };
}

export function normalizeSessionUsage(usage: ChatSessionUsage): ChatSessionUsage {
  return {
    totals: normalizeUsageCounter((usage.totals ?? zeroUsageCounter()) as ChatUsageCounter),
    byPhase: Object.fromEntries(
      Object.entries(usage.byPhase ?? {}).map(([phase, counter]) => [
        phase,
        normalizeUsageCounter(counter as ChatUsageCounter),
      ])
    ),
    ...(usage.updatedAt ? { updatedAt: usage.updatedAt } : {}),
  };
}

export function addUsageCounter(target: ChatUsageCounter, delta: ChatUsageCounter): void {
  const next = sumUsageCounters(target, delta);
  target.inputTokens = next.inputTokens;
  target.outputTokens = next.outputTokens;
  target.totalTokens = next.totalTokens;
}

export function usageFromLLMResponse(response: LLMResponse): ChatUsageCounter {
  const inputTokens = parseTokenCount(response.usage?.input_tokens) ?? 0;
  const outputTokens = parseTokenCount(response.usage?.output_tokens) ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: addTokenCounts(inputTokens, outputTokens),
  };
}

export function hasUsage(usage: ChatUsageCounter): boolean {
  const normalized = normalizeUsageCounter(usage);
  return normalized.totalTokens > 0 || normalized.inputTokens > 0 || normalized.outputTokens > 0;
}

export function formatUsageCounter(prefix: string, usage: ChatUsageCounter): string[] {
  const normalized = normalizeUsageCounter(usage);
  return [
    `${prefix} input tokens:  ${normalized.inputTokens}`,
    `${prefix} output tokens: ${normalized.outputTokens}`,
    `${prefix} total tokens:  ${normalized.totalTokens}`,
  ];
}
