import { z } from "zod";

const ChatUsageTokenCountSchema = z.number().int().nonnegative().refine(Number.isSafeInteger).catch(0);

export const ChatUsageCounterSchema = z.object({
  inputTokens: ChatUsageTokenCountSchema,
  outputTokens: ChatUsageTokenCountSchema,
  totalTokens: ChatUsageTokenCountSchema,
}).passthrough();
export type ChatUsageCounter = z.infer<typeof ChatUsageCounterSchema>;

export const ChatSessionUsageSchema = z.object({
  totals: ChatUsageCounterSchema.default({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  }),
  byPhase: z.record(ChatUsageCounterSchema).default({}),
  updatedAt: z.string().optional(),
}).passthrough();
export type ChatSessionUsage = z.infer<typeof ChatSessionUsageSchema>;
