import { z } from "zod";

export const DreamSourceSchema = z.enum([
  "observation",
  "task",
  "verification",
  "strategy",
  "stall",
]);

export type DreamSource = z.infer<typeof DreamSourceSchema>;
export type ImportanceSource = DreamSource;

export const DreamEventTypeSchema = z.enum([
  "PreObserve",
  "PostObserve",
  "PreTaskCreate",
  "PostTaskCreate",
  "PreExecute",
  "PostExecute",
  "GoalStateChange",
  "LoopCycleStart",
  "LoopCycleEnd",
  "ReflectionComplete",
  "StallDetected",
]);

export type DreamEventType = z.infer<typeof DreamEventTypeSchema>;

export const DriveScoreLogSchema = z.object({
  dimensionName: z.string(),
  score: z.number(),
  urgency: z.number().optional(),
  confidence: z.number().optional(),
});

export type DriveScoreLog = z.infer<typeof DriveScoreLogSchema>;

export const VerificationResultSummarySchema = z.object({
  verdict: z.string(),
  confidence: z.number().min(0).max(1),
  timestamp: z.string(),
});

export type VerificationResultSummary = z.infer<typeof VerificationResultSummarySchema>;

export const IterationGapDimensionSchema = z.object({
  dimension_name: z.string(),
  raw_gap: z.number(),
  normalized_gap: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  uncertainty_weight: z.number(),
});

export type IterationGapDimension = z.infer<typeof IterationGapDimensionSchema>;

export const IterationLogSchema = z.object({
  timestamp: z.string(),
  goalId: z.string(),
  iteration: z.number().int().nonnegative(),
  sessionId: z.string(),
  gapAggregate: z.number().min(0),
  gapDimensions: z.array(IterationGapDimensionSchema).optional(),
  driveScores: z.array(DriveScoreLogSchema).optional(),
  taskId: z.string().nullable().optional(),
  taskAction: z.string().nullable().optional(),
  strategyId: z.string().nullable().optional(),
  verificationResult: VerificationResultSummarySchema.nullable().optional(),
  stallDetected: z.boolean(),
  stallSeverity: z.number().min(0).max(3).nullable().optional(),
  tokensUsed: z.number().nonnegative().nullable().optional(),
  elapsedMs: z.number().nonnegative(),
  skipped: z.boolean().optional(),
  skipReason: z.string().nullable().optional(),
  completionJudgment: z.record(z.string(), z.unknown()),
  waitSuppressed: z.boolean().optional(),
});

export type IterationLog = z.infer<typeof IterationLogSchema>;

export const SessionLogSchema = z.object({
  timestamp: z.string(),
  goalId: z.string(),
  sessionId: z.string(),
  iterationCount: z.number().int().nonnegative(),
  finalGapAggregate: z.number().min(0),
  initialGapAggregate: z.number().min(0),
  totalTokensUsed: z.number().nonnegative(),
  totalElapsedMs: z.number().nonnegative(),
  stallCount: z.number().int().nonnegative(),
  outcome: z.string(),
  strategiesUsed: z.array(z.string()).default([]),
});

export type SessionLog = z.infer<typeof SessionLogSchema>;

export const ImportanceEntrySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  goalId: z.string(),
  source: DreamSourceSchema,
  importance: z.number().min(0).max(1),
  reason: z.string(),
  data_ref: z.string(),
  tags: z.array(z.string()).default([]),
  processed: z.boolean().default(false),
});

export type ImportanceEntry = z.infer<typeof ImportanceEntrySchema>;

export const EventLogSchema = z.object({
  timestamp: z.string(),
  eventType: DreamEventTypeSchema,
  goalId: z.string(),
  taskId: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});

export type EventLog = z.infer<typeof EventLogSchema>;

export const WatermarkStateSchema = z.object({
  goals: z.record(
    z.string(),
    z.object({
      lastProcessedLine: z.number().int().nonnegative().default(0),
      lastProcessedTimestamp: z.string().optional(),
    })
  ).default({}),
  importanceBuffer: z.object({
    lastProcessedLine: z.number().int().nonnegative().default(0),
    lastProcessedTimestamp: z.string().optional(),
  }).default({
    lastProcessedLine: 0,
  }),
});

export type WatermarkState = z.infer<typeof WatermarkStateSchema>;
export const DreamWatermarkSchema = WatermarkStateSchema;
export type DreamWatermark = WatermarkState;

export const DreamLogCollectionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  iterationLoggingEnabled: z.boolean().default(true),
  sessionSummariesEnabled: z.boolean().default(true),
  eventPersistenceEnabled: z.boolean().default(true),
  importanceThreshold: z.number().min(0).max(1).default(0.5),
  maxFileSizeBytes: z.number().int().positive().default(10 * 1024 * 1024),
  pruneTargetRatio: z.number().gt(0).lte(1).default(0.8),
  rotationMode: z.enum(["size", "date"]).default("size"),
  watermarkBehavior: z.enum(["readonly", "readwrite"]).default("readwrite"),
});

export type DreamLogCollectionConfig = z.infer<typeof DreamLogCollectionConfigSchema>;

export const DreamLogConfigSchema = z.object({
  logCollection: DreamLogCollectionConfigSchema.default({}),
});

export type DreamLogConfig = z.infer<typeof DreamLogConfigSchema>;
