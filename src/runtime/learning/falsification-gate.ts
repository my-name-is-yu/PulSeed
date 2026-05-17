import { z } from "zod/v3";

export const FalsificationGateDecisionSchema = z.object({
  id: z.string().min(1),
  targetKind: z.enum(["hypothesis", "generalization_candidate", "learning_artifact", "learning_prior"]),
  targetId: z.string().min(1),
  decision: z.enum(["allow_support", "weaken", "falsify", "defer", "suppress"]),
  reasonCodes: z.array(z.enum([
    "independent_support",
    "self_confirmation",
    "contradiction",
    "correction",
    "quarantine",
    "scope_unknown",
    "insufficient_evidence",
  ])).min(1),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  counterexampleRefs: z.array(z.string().min(1)).default([]),
  decidedAt: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  if (value.decision === "allow_support" && value.reasonCodes.includes("self_confirmation")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reasonCodes"],
      message: "self-confirming support cannot pass the falsification gate",
    });
  }
});
export type FalsificationGateDecision = z.infer<typeof FalsificationGateDecisionSchema>;
