import { z } from "zod/v3";

export const MemoryCorrectionTargetKindSchema = z.enum([
  "agent_memory",
  "soil_record",
  "runtime_evidence",
  "dream_checkpoint",
]);
export type MemoryCorrectionTargetKind = z.infer<typeof MemoryCorrectionTargetKindSchema>;

export const MemoryCorrectionKindSchema = z.enum([
  "corrected",
  "superseded",
  "retracted",
  "forgotten",
  "quarantined",
]);
export type MemoryCorrectionKind = z.infer<typeof MemoryCorrectionKindSchema>;

export const MemoryCorrectionActorSchema = z.enum([
  "user",
  "dream_lint",
  "runtime_verification",
  "manual_tool",
]);
export type MemoryCorrectionActor = z.infer<typeof MemoryCorrectionActorSchema>;

export const MemoryCorrectionAuditStatusSchema = z.enum([
  "active",
  "superseded",
  "disputed",
  "destructive_delete_requested",
]);
export type MemoryCorrectionAuditStatus = z.infer<typeof MemoryCorrectionAuditStatusSchema>;

export const MemoryCorrectionTargetRefSchema = z.object({
  kind: MemoryCorrectionTargetKindSchema,
  id: z.string().min(1),
  scope: z.object({
    goal_id: z.string().min(1).optional(),
    run_id: z.string().min(1).optional(),
    task_id: z.string().min(1).optional(),
  }).strict().optional(),
}).strict();
export type MemoryCorrectionTargetRef = z.infer<typeof MemoryCorrectionTargetRefSchema>;

export const MemoryCorrectionProvenanceSchema = z.object({
  source: MemoryCorrectionActorSchema,
  source_ref: z.string().min(1).optional(),
  evidence_ref: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).nullable().default(null),
  note: z.string().min(1).optional(),
}).strict();
export type MemoryCorrectionProvenance = z.infer<typeof MemoryCorrectionProvenanceSchema>;

export const MemoryCorrectionAuditSchema = z.object({
  status: MemoryCorrectionAuditStatusSchema.default("active"),
  retained_for_audit: z.boolean().default(true),
  destructive_delete_approved_at: z.string().datetime().nullable().default(null),
}).strict();
export type MemoryCorrectionAudit = z.infer<typeof MemoryCorrectionAuditSchema>;

export const MemoryCorrectionEntrySchema = z.object({
  schema_version: z.literal("memory-correction-entry-v1").default("memory-correction-entry-v1"),
  correction_id: z.string().min(1),
  target_ref: MemoryCorrectionTargetRefSchema,
  correction_kind: MemoryCorrectionKindSchema,
  replacement_ref: MemoryCorrectionTargetRefSchema.nullable().default(null),
  actor: MemoryCorrectionActorSchema,
  reason: z.string().min(1),
  created_at: z.string().datetime(),
  provenance: MemoryCorrectionProvenanceSchema,
  audit: MemoryCorrectionAuditSchema.default({}),
}).strict();
export type MemoryCorrectionEntry = z.infer<typeof MemoryCorrectionEntrySchema>;
export type MemoryCorrectionEntryInput = z.input<typeof MemoryCorrectionEntrySchema>;

export const MemoryCorrectionLedgerFileSchema = z.object({
  schema_version: z.literal("memory-correction-ledger-v1").default("memory-correction-ledger-v1"),
  generated_at: z.string().datetime(),
  entries: z.array(MemoryCorrectionEntrySchema).default([]),
}).strict();
export type MemoryCorrectionLedgerFile = z.infer<typeof MemoryCorrectionLedgerFileSchema>;

export const MemoryCorrectionTargetStateSchema = z.object({
  target_ref: MemoryCorrectionTargetRefSchema,
  status: z.enum(["active", "corrected", "superseded", "retracted", "forgotten", "quarantined"]),
  active: z.boolean(),
  latest_correction_id: z.string().min(1).nullable().default(null),
  replacement_ref: MemoryCorrectionTargetRefSchema.nullable().default(null),
  retained_for_audit: z.boolean().default(true),
  reason: z.string().min(1).nullable().default(null),
  updated_at: z.string().datetime().nullable().default(null),
}).strict();
export type MemoryCorrectionTargetState = z.infer<typeof MemoryCorrectionTargetStateSchema>;

const inactiveCorrectionKinds = new Set<MemoryCorrectionKind>([
  "corrected",
  "superseded",
  "retracted",
  "forgotten",
  "quarantined",
]);

export function memoryCorrectionTargetKey(ref: MemoryCorrectionTargetRef): string {
  return JSON.stringify([
    ref.kind,
    ref.id,
    ref.scope?.goal_id ?? null,
    ref.scope?.run_id ?? null,
    ref.scope?.task_id ?? null,
  ]);
}

export function isMemoryCorrectionInactive(kind: MemoryCorrectionKind): boolean {
  return inactiveCorrectionKinds.has(kind);
}

export function summarizeMemoryCorrectionState(
  entries: MemoryCorrectionEntry[]
): Record<string, MemoryCorrectionTargetState> {
  const states: Record<string, MemoryCorrectionTargetState> = {};
  for (const entry of [...entries].sort((left, right) => left.created_at.localeCompare(right.created_at))) {
    if (entry.audit.status !== "active") continue;
    const key = memoryCorrectionTargetKey(entry.target_ref);
    states[key] = MemoryCorrectionTargetStateSchema.parse({
      target_ref: entry.target_ref,
      status: entry.correction_kind,
      active: !isMemoryCorrectionInactive(entry.correction_kind),
      latest_correction_id: entry.correction_id,
      replacement_ref: entry.replacement_ref,
      retained_for_audit: entry.audit.retained_for_audit,
      reason: entry.reason,
      updated_at: entry.created_at,
    });
  }
  return states;
}

export function correctionStateForTarget(
  states: Record<string, MemoryCorrectionTargetState>,
  ref: MemoryCorrectionTargetRef
): MemoryCorrectionTargetState {
  return states[memoryCorrectionTargetKey(ref)] ?? MemoryCorrectionTargetStateSchema.parse({
    target_ref: ref,
    status: "active",
    active: true,
  });
}
