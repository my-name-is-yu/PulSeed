import { z } from "zod";
import {
  CognitionEventRefSchema,
  MemoryWritebackProposalSchema,
  type CognitionEventRef,
  type MemoryWritebackProposal,
} from "../../runtime/cognition/index.js";
import {
  CompanionGadgetPlanningSourceRefSchema,
  type CompanionGadgetPlanningSourceRef,
} from "../../runtime/decision/index.js";

export const ProceduralMemoryKindSchema = z.enum([
  "playbook",
  "tool_policy",
  "repair_recipe",
]);
export type ProceduralMemoryKind = z.infer<typeof ProceduralMemoryKindSchema>;

export const ProceduralMemoryStatusSchema = z.enum([
  "candidate",
  "owner_review_required",
  "approved",
  "disabled",
]);
export type ProceduralMemoryStatus = z.infer<typeof ProceduralMemoryStatusSchema>;

export const ProceduralMemoryRecordSchema = z.object({
  schema_version: z.literal("procedural-memory-record/v1"),
  procedural_memory_id: z.string().min(1),
  kind: ProceduralMemoryKindSchema,
  status: ProceduralMemoryStatusSchema,
  title: z.string().min(1),
  source_trace_refs: z.array(CognitionEventRefSchema).min(1),
  repair_evidence_refs: z.array(CognitionEventRefSchema).default([]),
  confidence: z.number().min(0).max(1),
  scope_refs: z.array(z.string().min(1)).default([]),
  planning_evidence_only: z.literal(true).default(true),
  execution_authority: z.literal(false).default(false),
  admission_required_before_use: z.literal(true).default(true),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict().superRefine((record, ctx) => {
  if (record.kind === "repair_recipe" && record.repair_evidence_refs.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["repair_evidence_refs"],
      message: "repair recipes require explicit repair evidence before reuse",
    });
  }
});
export type ProceduralMemoryRecord = z.infer<typeof ProceduralMemoryRecordSchema>;

export function createProceduralMemoryCandidate(input: {
  proceduralMemoryId: string;
  kind: ProceduralMemoryKind;
  title: string;
  sourceTraceRefs: CognitionEventRef[];
  repairEvidenceRefs?: CognitionEventRef[];
  confidence: number;
  scopeRefs?: string[];
  createdAt: string;
}): ProceduralMemoryRecord {
  return ProceduralMemoryRecordSchema.parse({
    schema_version: "procedural-memory-record/v1",
    procedural_memory_id: input.proceduralMemoryId,
    kind: input.kind,
    status: input.confidence >= 0.75 ? "owner_review_required" : "candidate",
    title: input.title,
    source_trace_refs: input.sourceTraceRefs,
    repair_evidence_refs: input.repairEvidenceRefs ?? [],
    confidence: input.confidence,
    scope_refs: input.scopeRefs ?? [],
    planning_evidence_only: true,
    execution_authority: false,
    admission_required_before_use: true,
    created_at: input.createdAt,
    updated_at: input.createdAt,
  });
}

export function createProceduralMemoryWritebackProposal(input: {
  proposalId: string;
  proceduralMemory: ProceduralMemoryRecord;
}): MemoryWritebackProposal {
  const proceduralMemory = ProceduralMemoryRecordSchema.parse(input.proceduralMemory);
  return MemoryWritebackProposalSchema.parse({
    proposal_id: input.proposalId,
    proposal_kind: "procedural_skill_candidate",
    source_event_refs: proceduralMemory.source_trace_refs,
    proposed_target: "reflection",
    admission_state: "pending_review",
    user_visible_review_text: "Review this procedural candidate before any owner admits it as planning evidence.",
    auto_apply: false,
    source_content_materialized: false,
  });
}

export function proceduralMemoryToGadgetPlanningRef(
  record: ProceduralMemoryRecord
): CompanionGadgetPlanningSourceRef {
  const proceduralMemory = ProceduralMemoryRecordSchema.parse(record);
  return CompanionGadgetPlanningSourceRefSchema.parse({
    kind: "procedural_memory",
    ref: proceduralMemory.procedural_memory_id,
    role: "memory",
  });
}
