import { z } from "zod/v3";
import { LearningTrustEnvelopeSchema } from "./learning-trust.js";

export const ImmutableSnapshotReadRefBaseSchema = z.object({
  sourceKind: z.enum(["snapshot_event", "snapshot_evidence", "runtime_event_projection"]),
  ref: z.string().min(1),
  snapshotId: z.string().min(1),
  snapshotEventRef: z.string().min(1).optional(),
  snapshotEvidenceRef: z.string().min(1).optional(),
  runtimeEventProjectionRef: z.string().min(1).optional(),
  portSchemaVersion: z.string().min(1),
  versionOrSequence: z.string().min(1),
  highWatermark: z.string().min(1),
  inputHash: z.string().min(1),
  snapshotPayloadHash: z.string().min(1),
  redactionClass: z.enum(["refs_only", "diagnostic_metadata_only"]),
}).strict();

export const ImmutableSnapshotReadRefSchema = ImmutableSnapshotReadRefBaseSchema.superRefine((value, ctx) => {
  const present = [
    value.snapshotEventRef ? "snapshotEventRef" : null,
    value.snapshotEvidenceRef ? "snapshotEvidenceRef" : null,
    value.runtimeEventProjectionRef ? "runtimeEventProjectionRef" : null,
  ].filter(Boolean);
  if (present.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "immutable snapshot read ref must name exactly one replayable snapshot source",
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
export type ImmutableSnapshotReadRef = z.infer<typeof ImmutableSnapshotReadRefSchema>;

export const MicroProbeReadPortSchema = z.enum([
  "runtime_evidence_entry",
  "runtime_event_log_snapshot",
  "runtime_graph_snapshot",
  "goal_task_snapshot",
  "stall_state_snapshot",
  "attention_diagnostic_snapshot",
  "memory_truth_status_snapshot",
  "capability_readiness_snapshot",
  "learning_store_snapshot",
  "correction_status_snapshot",
]);
export type MicroProbeReadPort = z.infer<typeof MicroProbeReadPortSchema>;

export const MicroProbeReadSetEntrySchema = ImmutableSnapshotReadRefBaseSchema.extend({
  port: MicroProbeReadPortSchema,
}).strict().superRefine((value, ctx) => {
  if ((value.port as string) === "control_db") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["port"],
      message: "control_db is not a generic micro-probe read port",
    });
  }
});
export type MicroProbeReadSetEntry = z.infer<typeof MicroProbeReadSetEntrySchema>;

export const MicroProbeExpectedSignalSchema = z.object({
  polarity: z.enum(["if_true", "if_false"]),
  signalId: z.string().min(1),
  signalKind: z.string().min(1),
  diagnosticLabel: z.string().min(1),
}).strict();
export type MicroProbeExpectedSignal = z.infer<typeof MicroProbeExpectedSignalSchema>;

export const MicroProbePlanSchema = z.object({
  id: z.string().min(1),
  goalId: z.string().min(1),
  runId: z.string().min(1).optional(),
  loopIndex: z.number().int().nonnegative(),
  frameId: z.string().min(1),
  hypothesisIds: z.array(z.string().min(1)).min(1),
  plannedAt: z.string().datetime(),
  mode: z.enum([
    "runtime_event_replay",
    "runtime_graph_query",
    "typed_snapshot_query",
    "learning_store_query",
    "attention_snapshot_query",
    "memory_truth_status_query",
    "capability_snapshot_query",
    "correction_status_query",
  ]),
  sourceEvidenceRefs: z.array(z.string().min(1)).min(1),
  sourceEventRefs: z.array(z.string().min(1)).default([]),
  sourceRuntimeGraphRefs: z.array(z.string().min(1)).default([]),
  readSet: z.array(MicroProbeReadSetEntrySchema).min(1),
  probeSchemaVersion: z.literal("micro-probe/v1"),
  expectedSignals: z.array(MicroProbeExpectedSignalSchema).min(1),
  forbiddenCapabilities: z.array(z.enum([
    "tool_execution",
    "external_read",
    "model_call",
    "task_creation",
    "attention_wake",
    "surface_delivery",
    "memory_write",
  ])).default([
    "tool_execution",
    "external_read",
    "model_call",
    "task_creation",
    "attention_wake",
    "surface_delivery",
    "memory_write",
  ]),
}).strict();
export type MicroProbePlan = z.infer<typeof MicroProbePlanSchema>;

export const MicroProbeRecordSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  ranAt: z.string().datetime(),
  outcome: z.enum(["supported", "weakened", "falsified", "inconclusive", "deferred", "blocked"]),
  supportEvidenceRefs: z.array(z.string().min(1)).default([]),
  contradictionEvidenceRefs: z.array(z.string().min(1)).default([]),
  supportEventRefs: z.array(z.string().min(1)).default([]),
  supportRuntimeGraphRefs: z.array(z.string().min(1)).default([]),
  usedIndependentSupport: z.boolean(),
  replayFingerprint: z.string().min(1),
  correctionFilterDecision: z.enum(["current", "suppressed"]),
  readSetFingerprint: z.string().min(1),
  trust: LearningTrustEnvelopeSchema,
}).strict().superRefine((value, ctx) => {
  if (value.outcome === "supported" && !value.usedIndependentSupport) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["usedIndependentSupport"],
      message: "micro-probe support cannot be self-confirming",
    });
  }
});
export type MicroProbeRecord = z.infer<typeof MicroProbeRecordSchema>;
