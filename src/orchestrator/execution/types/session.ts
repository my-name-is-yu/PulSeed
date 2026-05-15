import { z } from "zod/v3";

// --- Session Type ---

export const SessionTypeEnum = z.enum([
  "task_execution",
  "observation",
  "task_review",
  "goal_review",
  "chat_execution",
]);
export type SessionType = z.infer<typeof SessionTypeEnum>;

// --- Context Slot (a piece of context passed to a session) ---

export const MAX_SESSION_CONTEXT_BUDGET = 1_000_000;
export const MAX_CONTEXT_SLOT_TOKEN_ESTIMATE = 1_000_000;

const ContextBudgetValueSchema = z.number().int().min(0).max(MAX_SESSION_CONTEXT_BUDGET);
const ContextSlotTokenEstimateSchema = z.number().finite().min(0).max(MAX_CONTEXT_SLOT_TOKEN_ESTIMATE);

export const ContextSlotSchema = z.object({
  priority: z.number().finite().min(1).max(6),
  label: z.string(),
  content: z.string(),
  token_estimate: ContextSlotTokenEstimateSchema.default(0),
});
export type ContextSlot = z.infer<typeof ContextSlotSchema>;

// --- Session ---

// --- Context Budget Config ---

export const ContextBudgetConfigSchema = z.object({
  task_execution: ContextBudgetValueSchema.default(50_000),
  observation: ContextBudgetValueSchema.default(50_000),
  task_review: ContextBudgetValueSchema.default(30_000),
  goal_review: ContextBudgetValueSchema.default(40_000),
});
export type ContextBudgetConfig = z.infer<typeof ContextBudgetConfigSchema>;

// --- Session ---

export const SessionSchema = z.object({
  id: z.string(),
  session_type: SessionTypeEnum,
  goal_id: z.string(),
  task_id: z.string().nullable().default(null),
  context_slots: z.array(ContextSlotSchema),
  context_budget: ContextBudgetValueSchema,
  started_at: z.string(),
  ended_at: z.string().nullable().default(null),
  result_summary: z.string().nullable().default(null),
});
export type Session = z.infer<typeof SessionSchema>;
