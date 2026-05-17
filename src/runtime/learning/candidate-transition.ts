import { z } from "zod/v3";

export const CandidateTransitionReasonCodeSchema = z.enum([
  "unsupported",
  "contradicted",
  "independent_support",
  "self_confirmation_rejected",
  "correction_suppressed",
  "quarantine_suppressed",
  "scope_conflict",
  "trial_reuse_ready",
  "negative_transfer_observed",
  "transfer_scope_narrowed",
  "deferred_requires_durableloop_experiment",
]);
export type CandidateTransitionReasonCode = z.infer<typeof CandidateTransitionReasonCodeSchema>;

export const CandidateTransitionSchema = z.object({
  id: z.string().min(1),
  goalId: z.string().min(1),
  runId: z.string().min(1).optional(),
  loopIndex: z.number().int().nonnegative(),
  targetKind: z.enum(["frame", "hypothesis", "generalization_candidate", "artifact", "prior"]),
  targetId: z.string().min(1),
  fromStatus: z.string().min(1),
  toStatus: z.string().min(1),
  reasonCode: CandidateTransitionReasonCodeSchema,
  diagnosticLabel: z.string().min(1).optional(),
  microProbeRecordIds: z.array(z.string().min(1)).default([]),
  evidenceRefs: z.array(z.string().min(1)).min(1),
  eventRefs: z.array(z.string().min(1)).default([]),
  runtimeGraphRefs: z.array(z.string().min(1)).default([]),
  readinessGateId: z.string().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.reasonCode === "trial_reuse_ready" && !value.readinessGateId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["readinessGateId"],
      message: "trial_reuse_ready transition requires readinessGateId",
    });
  }
});
export type CandidateTransition = z.infer<typeof CandidateTransitionSchema>;
