import { z } from "zod/v3";
import { LearningConsumerPhaseSchema } from "./generalization-candidate.js";
import { ImmutableSnapshotReadRefBaseSchema } from "./micro-probe.js";

export const LearningPriorConsumptionReadSetEntrySchema = ImmutableSnapshotReadRefBaseSchema.extend({
  port: z.enum([
    "learning_prior_snapshot",
    "correction_status_snapshot",
    "memory_truth_status_snapshot",
    "scope_compatibility_snapshot",
    "trust_status_snapshot",
    "governed_memory_decision_snapshot",
    "governed_memory_use_audit_snapshot",
  ]),
}).strict().superRefine((value, ctx) => {
  const present = [
    value.snapshotEventRef ? "snapshotEventRef" : null,
    value.snapshotEvidenceRef ? "snapshotEvidenceRef" : null,
    value.runtimeEventProjectionRef ? "runtimeEventProjectionRef" : null,
  ].filter(Boolean);
  if (present.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "learning-prior read set entry must name exactly one immutable replay source",
    });
  }
  if (value.sourceKind === "snapshot_event" && !value.snapshotEventRef) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["snapshotEventRef"], message: "snapshot_event requires snapshotEventRef" });
  }
  if (value.sourceKind === "snapshot_evidence" && !value.snapshotEvidenceRef) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["snapshotEvidenceRef"], message: "snapshot_evidence requires snapshotEvidenceRef" });
  }
  if (value.sourceKind === "runtime_event_projection" && !value.runtimeEventProjectionRef) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["runtimeEventProjectionRef"], message: "runtime_event_projection requires runtimeEventProjectionRef" });
  }
});
export type LearningPriorConsumptionReadSetEntry = z.infer<typeof LearningPriorConsumptionReadSetEntrySchema>;

export const LearningPriorConsumptionReasonCodeSchema = z.enum([
  "eligible",
  "not_yet_eligible",
  "scope_conflict",
  "scope_unknown",
  "trust_blocked",
  "correction_blocked",
  "quarantine_blocked",
  "governed_memory_revoked",
  "governed_memory_use_class_mismatch",
  "governed_memory_audit_stale",
  "stale_or_expired",
  "max_uses_exhausted",
  "consumer_execution_failed",
]);
export type LearningPriorConsumptionReasonCode = z.infer<typeof LearningPriorConsumptionReasonCodeSchema>;

export const LearningPriorConsumptionRecordSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1),
  consumerAttemptId: z.string().min(1),
  consumerDecisionRef: z.string().min(1),
  priorId: z.string().min(1),
  suggestionId: z.string().min(1),
  consumerPhase: LearningConsumerPhaseSchema,
  loopIndex: z.number().int().nonnegative(),
  reservedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  readSet: z.array(LearningPriorConsumptionReadSetEntrySchema).min(1),
  stage: z.enum(["reserved", "applied", "suppressed"]),
  reasonCodes: z.array(LearningPriorConsumptionReasonCodeSchema).min(1),
  generatedDecisionRefs: z.array(z.string().min(1)).default([]),
  runtimeGraphRefs: z.array(z.string().min(1)).default([]),
}).strict();
export type LearningPriorConsumptionRecord = z.infer<typeof LearningPriorConsumptionRecordSchema>;
