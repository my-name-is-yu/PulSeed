import { z } from "zod/v3";

export const TrialReuseReadinessGateSchema = z.object({
  id: z.string().min(1),
  candidateId: z.string().min(1),
  sourceLoopIndex: z.number().int().nonnegative(),
  eligibleFromIteration: z.number().int().nonnegative(),
  sourceTransitionId: z.string().min(1),
  disjointSupportRefs: z.array(z.string().min(1)).min(1),
  actionShape: z.enum(["no_action", "reversible", "append_only", "manual_recovery", "irreversible"]),
  risk: z.enum(["low", "medium", "high"]),
  scopeDecision: z.enum(["exact", "adjacent", "blocked"]),
  transferScopeRef: z.string().min(1),
  trialReuseBudgetId: z.string().min(1),
  remainingTrialUses: z.number().int().nonnegative(),
  decision: z.enum(["ready", "blocked"]),
  reasonCodes: z.array(z.string().min(1)).min(1),
}).strict().superRefine((value, ctx) => {
  if (value.decision === "ready") {
    if (value.eligibleFromIteration <= value.sourceLoopIndex) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["eligibleFromIteration"],
        message: "trial reuse readiness must be N+1 gated",
      });
    }
    if (value.risk !== "low") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["risk"], message: "ready trial reuse requires low risk" });
    }
    if (value.scopeDecision === "blocked") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scopeDecision"], message: "blocked scope cannot be ready" });
    }
    if (value.remainingTrialUses < 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["remainingTrialUses"], message: "ready trial reuse requires remaining budget" });
    }
  }
});
export type TrialReuseReadinessGate = z.infer<typeof TrialReuseReadinessGateSchema>;
