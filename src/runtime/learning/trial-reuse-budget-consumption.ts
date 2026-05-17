import { z } from "zod/v3";

export const TrialReuseBudgetConsumptionRecordSchema = z.object({
  id: z.string().min(1),
  gateId: z.string().min(1),
  candidateId: z.string().min(1),
  planId: z.string().min(1).optional(),
  consumerAttemptId: z.string().min(1),
  loopIndex: z.number().int().nonnegative(),
  reservedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  decision: z.enum(["reserved", "applied", "rejected"]),
  reasonCodes: z.array(z.enum([
    "ready",
    "budget_exhausted",
    "scope_conflict",
    "risk_too_high",
    "not_yet_eligible",
    "duplicate_attempt",
  ])).min(1),
  idempotencyKey: z.string().min(1),
}).strict();
export type TrialReuseBudgetConsumptionRecord = z.infer<typeof TrialReuseBudgetConsumptionRecordSchema>;
