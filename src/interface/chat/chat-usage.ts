import type { LLMResponse } from "../../base/llm/llm-client.js";
import type { ChatSessionUsage, ChatUsageCounter } from "./chat-history.js";
import {
  addUsageCounter as addSharedUsageCounter,
  addUsageTokenCounts,
  formatUsageCounter as formatSharedUsageCounter,
  hasUsage as hasSharedUsage,
  normalizeUsageCounter as normalizeSharedUsageCounter,
  parseUsageTokenCount,
  sumUsageCounters as sumSharedUsageCounters,
  zeroUsageCounter as zeroSharedUsageCounter,
} from "../usage-counter.js";

export function zeroUsageCounter(): ChatUsageCounter {
  return zeroSharedUsageCounter() as ChatUsageCounter;
}

export function addTokenCounts(left: number, right: number): number {
  return addUsageTokenCounts(left, right);
}

export function normalizeUsageCounter(usage: ChatUsageCounter): ChatUsageCounter {
  return normalizeSharedUsageCounter(usage) as ChatUsageCounter;
}

export function sumUsageCounters(base: ChatUsageCounter | undefined, delta: ChatUsageCounter): ChatUsageCounter {
  return sumSharedUsageCounters(base, delta) as ChatUsageCounter;
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
  addSharedUsageCounter(target, delta);
}

export function usageFromLLMResponse(response: LLMResponse): ChatUsageCounter {
  const inputTokens = parseUsageTokenCount(response.usage?.input_tokens) ?? 0;
  const outputTokens = parseUsageTokenCount(response.usage?.output_tokens) ?? 0;
  return { inputTokens, outputTokens, totalTokens: addTokenCounts(inputTokens, outputTokens) };
}

export function hasUsage(usage: ChatUsageCounter): boolean {
  return hasSharedUsage(usage);
}

export function formatUsageCounter(prefix: string, usage: ChatUsageCounter): string[] {
  return formatSharedUsageCounter(prefix, usage);
}
