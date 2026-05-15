import { z } from "zod/v3";

export const MemoryVerificationStatusSchema = z.enum([
  "unknown",
  "unverified",
  "verified",
  "contradicted",
  "suspicious",
]);
export type MemoryVerificationStatus = z.infer<typeof MemoryVerificationStatusSchema>;

export const MemoryProvenanceSourceTypeSchema = z.enum([
  "user",
  "runtime",
  "tool",
  "web",
  "external",
  "imported",
  "unknown",
]);
export type MemoryProvenanceSourceType = z.infer<typeof MemoryProvenanceSourceTypeSchema>;

export const MemoryRiskSignalSchema = z.enum([
  "hallucinated",
  "low_provenance",
  "contradiction",
  "prompt_injection_like",
  "unverified_external",
]);
export type MemoryRiskSignal = z.infer<typeof MemoryRiskSignalSchema>;

export const MemoryProvenanceSchema = z.object({
  source_type: MemoryProvenanceSourceTypeSchema.default("unknown"),
  source_ref: z.string().min(1).optional(),
  raw_refs: z.array(z.string().min(1)).default([]),
  reliability: z.number().min(0).max(1).optional(),
  verification_status: MemoryVerificationStatusSchema.default("unknown"),
  risk_signals: z.array(MemoryRiskSignalSchema).default([]),
}).strict();
export type MemoryProvenance = z.infer<typeof MemoryProvenanceSchema>;

export const MemoryQuarantineStateSchema = z.object({
  status: z.literal("quarantined"),
  active: z.literal(false).default(false),
  reason: z.string().min(1),
  source: z.enum(["memory_lint", "user", "runtime_verification", "system"]).default("memory_lint"),
  confidence: z.number().min(0).max(1),
  inspection_refs: z.array(z.string().min(1)).min(1),
  created_at: z.string().datetime(),
}).strict();
export type MemoryQuarantineState = z.infer<typeof MemoryQuarantineStateSchema>;
