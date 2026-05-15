import { z } from "zod/v3";
import {
  MemoryCorrectionEntrySchema,
  MemoryCorrectionTargetStateSchema,
} from "../../corrections/memory-correction-ledger.js";
import {
  MemoryProvenanceSchema,
  MemoryQuarantineStateSchema,
  MemoryVerificationStatusSchema,
} from "../../corrections/memory-quarantine.js";
import { MemoryGovernanceSchema } from "../../corrections/memory-governance.js";

// --- AgentMemoryType ---

export const AgentMemoryTypeEnum = z.enum([
  "fact",
  "procedure",
  "preference",
  "observation",
]);
export type AgentMemoryType = z.infer<typeof AgentMemoryTypeEnum>;

// --- AgentMemoryStatus ---

export const AgentMemoryStatusEnum = z.enum(["raw", "compiled", "archived", "corrected", "superseded", "retracted", "forgotten", "quarantined"]);
export type AgentMemoryStatus = z.infer<typeof AgentMemoryStatusEnum>;

// --- AgentMemoryEntry ---

export const AgentMemoryEntrySchema = z.object({
  id: z.string(),
  key: z.string(),
  value: z.string(),
  summary: z.string().optional(),
  tags: z.array(z.string()).default([]),
  category: z.string().optional(),
  memory_type: AgentMemoryTypeEnum.default("fact"),
  status: AgentMemoryStatusEnum.default("raw"),
  correction_state: MemoryCorrectionTargetStateSchema.optional(),
  verification_status: MemoryVerificationStatusSchema.optional(),
  provenance: MemoryProvenanceSchema.optional(),
  quarantine_state: MemoryQuarantineStateSchema.optional(),
  governance: MemoryGovernanceSchema.default({}),
  supersedes_memory_id: z.string().min(1).optional(),
  compiled_from: z.array(z.string()).optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type AgentMemoryEntry = z.infer<typeof AgentMemoryEntrySchema>;

// --- AgentMemoryStore (file-level schema) ---

export const AgentMemoryStoreSchema = z.object({
  entries: z.array(AgentMemoryEntrySchema),
  corrections: z.array(MemoryCorrectionEntrySchema).default([]),
  last_consolidated_at: z.string().nullable().default(null),
});
export type AgentMemoryStore = z.infer<typeof AgentMemoryStoreSchema>;

// --- Active Linting schemas ---

export const LintIssueTypeEnum = z.enum(["contradiction", "staleness", "redundancy", "quarantine"]);
export type LintIssueType = z.infer<typeof LintIssueTypeEnum>;

export const LintFindingSchema = z.object({
  type: LintIssueTypeEnum,
  entry_ids: z.array(z.string()).min(1),
  description: z.string(),
  confidence: z.number().min(0).max(1),
  suggested_action: z.enum(["flag_review", "auto_resolve_newest", "mark_stale", "merge", "quarantine"]),
});
export type LintFinding = z.infer<typeof LintFindingSchema>;

export const LintResponseSchema = z.object({
  findings: z.array(LintFindingSchema),
});

export const LintResultSchema = z.object({
  findings: z.array(LintFindingSchema),
  repairs_applied: z.number(),
  entries_flagged: z.number(),
});
export type LintResult = z.infer<typeof LintResultSchema>;
