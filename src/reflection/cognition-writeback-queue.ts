import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  CognitionEventRefSchema,
  CognitionRefSchema,
  MemoryWritebackProposalSchema,
  type CognitionEventRef,
  type CognitionRef,
  type MemoryWritebackProposal,
} from "../runtime/cognition/index.js";

export const CognitionWritebackQueueOwnerSchema = z.enum([
  "dream",
  "profile",
  "soil",
  "knowledge",
  "procedural",
  "attention_feedback",
  "reflection",
]);
export type CognitionWritebackQueueOwner = z.infer<typeof CognitionWritebackQueueOwnerSchema>;

export const CognitionWritebackSourceStateSchema = z.enum([
  "current",
  "missing_source",
  "deleted_or_tombstoned",
]);
export type CognitionWritebackSourceState = z.infer<typeof CognitionWritebackSourceStateSchema>;

export const CognitionWritebackQueueStateSchema = z.enum([
  "queued",
  "ready_for_owner_review",
  "blocked_source_invalid",
  "rejected",
  "superseded",
  "accepted_by_owner",
]);
export type CognitionWritebackQueueState = z.infer<typeof CognitionWritebackQueueStateSchema>;

export const CognitionWritebackQueueAuditEventSchema = z.object({
  event_id: z.string().min(1),
  kind: z.enum(["queued", "revalidated", "blocked", "rejected", "superseded", "accepted_by_owner"]),
  created_at: z.string().datetime(),
  source_refs: z.array(CognitionEventRefSchema).default([]),
  reason: z.string().min(1),
}).strict();
export type CognitionWritebackQueueAuditEvent = z.infer<typeof CognitionWritebackQueueAuditEventSchema>;

export const CognitionWritebackQueueEntrySchema = z.object({
  schema_version: z.literal("cognition-writeback-queue-entry/v1"),
  queue_entry_id: z.string().min(1),
  proposal: MemoryWritebackProposalSchema,
  owner: CognitionWritebackQueueOwnerSchema,
  state: CognitionWritebackQueueStateSchema,
  source_state: CognitionWritebackSourceStateSchema,
  source_refs: z.array(CognitionEventRefSchema).min(1),
  invalidation_refs: z.array(CognitionEventRefSchema).default([]),
  owner_decision_ref: CognitionRefSchema.optional(),
  supersedes_queue_entry_ref: CognitionRefSchema.optional(),
  review_required: z.literal(true).default(true),
  owner_write_performed: z.literal(false).default(false),
  runtime_authority: z.literal(false).default(false),
  audit_events: z.array(CognitionWritebackQueueAuditEventSchema).min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict().superRefine((entry, ctx) => {
  if (entry.proposal.auto_apply !== false) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["proposal", "auto_apply"],
      message: "cognition writeback queue entries cannot auto-apply proposals",
    });
  }
  if (entry.proposal.source_content_materialized !== false) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["proposal", "source_content_materialized"],
      message: "cognition writeback queue entries must remain refs-only",
    });
  }
  if (entry.source_state !== "current" && entry.state !== "blocked_source_invalid") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["state"],
      message: "missing, deleted, or tombstoned proposal sources must block owner acceptance",
    });
  }
  if (entry.state === "accepted_by_owner" && !entry.owner_decision_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["owner_decision_ref"],
      message: "owner acceptance must carry an owner decision ref",
    });
  }
  if (entry.owner_write_performed !== false) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["owner_write_performed"],
      message: "the reflection writeback queue must not write owner memory directly",
    });
  }
});
export type CognitionWritebackQueueEntry = z.infer<typeof CognitionWritebackQueueEntrySchema>;

export type CognitionWritebackQueueDecision =
  | { kind: "ready_for_owner_review"; reason: string }
  | { kind: "rejected"; reason: string }
  | { kind: "superseded"; reason: string; supersedesQueueEntryRef: CognitionRef }
  | { kind: "accepted_by_owner"; reason: string; ownerDecisionRef: CognitionRef };

export interface CognitionWritebackQueueStore {
  enqueue(entry: CognitionWritebackQueueEntry): Promise<CognitionWritebackQueueEntry>;
  update(entry: CognitionWritebackQueueEntry): Promise<CognitionWritebackQueueEntry>;
  list(): Promise<CognitionWritebackQueueEntry[]>;
}

export function ownerForWritebackProposal(proposal: MemoryWritebackProposal): CognitionWritebackQueueOwner {
  switch (proposal.proposed_target) {
    case "dream":
      return "dream";
    case "profile":
      return "profile";
    case "soil":
      return "soil";
    case "knowledge":
      return "knowledge";
    case "attention_feedback":
      return "attention_feedback";
    case "reflection":
      return proposal.proposal_kind === "procedural_skill_candidate" ? "procedural" : "reflection";
  }
}

export function createCognitionWritebackQueueEntry(input: {
  queueEntryId: string;
  proposal: MemoryWritebackProposal;
  createdAt: string;
  sourceState?: CognitionWritebackSourceState;
  invalidationRefs?: CognitionEventRef[];
}): CognitionWritebackQueueEntry {
  const proposal = MemoryWritebackProposalSchema.parse(input.proposal);
  const sourceState = input.sourceState ?? "current";
  const blocked = sourceState !== "current";
  return CognitionWritebackQueueEntrySchema.parse({
    schema_version: "cognition-writeback-queue-entry/v1",
    queue_entry_id: input.queueEntryId,
    proposal,
    owner: ownerForWritebackProposal(proposal),
    state: blocked ? "blocked_source_invalid" : "queued",
    source_state: sourceState,
    source_refs: proposal.source_event_refs,
    invalidation_refs: input.invalidationRefs ?? [],
    review_required: true,
    owner_write_performed: false,
    runtime_authority: false,
    audit_events: [{
      event_id: `${input.queueEntryId}:queued`,
      kind: blocked ? "blocked" : "queued",
      created_at: input.createdAt,
      source_refs: proposal.source_event_refs,
      reason: blocked
        ? "proposal source refs were missing, deleted, or tombstoned before queueing"
        : "proposal queued for reflection-owned owner routing",
    }],
    created_at: input.createdAt,
    updated_at: input.createdAt,
  });
}

export function decideCognitionWritebackQueueEntry(input: {
  entry: CognitionWritebackQueueEntry;
  decision: CognitionWritebackQueueDecision;
  decidedAt: string;
}): CognitionWritebackQueueEntry {
  const entry = CognitionWritebackQueueEntrySchema.parse(input.entry);
  const auditEvent = CognitionWritebackQueueAuditEventSchema.parse({
    event_id: `${entry.queue_entry_id}:${input.decision.kind}:${input.decidedAt}`,
    kind: input.decision.kind === "ready_for_owner_review" ? "revalidated" : input.decision.kind,
    created_at: input.decidedAt,
    source_refs: entry.source_refs,
    reason: input.decision.reason,
  });
  return CognitionWritebackQueueEntrySchema.parse({
    ...entry,
    state: entry.source_state === "current" ? input.decision.kind : "blocked_source_invalid",
    ...(input.decision.kind === "accepted_by_owner" ? { owner_decision_ref: input.decision.ownerDecisionRef } : {}),
    ...(input.decision.kind === "superseded" ? { supersedes_queue_entry_ref: input.decision.supersedesQueueEntryRef } : {}),
    audit_events: [...entry.audit_events, auditEvent],
    updated_at: input.decidedAt,
  });
}

export class FileCognitionWritebackQueueStore implements CognitionWritebackQueueStore {
  constructor(private readonly baseDir: string, private readonly relativePath = "reflection/cognition-writeback-queue.json") {}

  async enqueue(entry: CognitionWritebackQueueEntry): Promise<CognitionWritebackQueueEntry> {
    const parsed = CognitionWritebackQueueEntrySchema.parse(entry);
    const entries = await this.list();
    const next = [...entries.filter((existing) => existing.queue_entry_id !== parsed.queue_entry_id), parsed];
    await this.write(next);
    return parsed;
  }

  async update(entry: CognitionWritebackQueueEntry): Promise<CognitionWritebackQueueEntry> {
    return this.enqueue(entry);
  }

  async list(): Promise<CognitionWritebackQueueEntry[]> {
    try {
      const text = await readFile(this.path(), "utf8");
      const parsed = JSON.parse(text) as unknown;
      return z.array(CognitionWritebackQueueEntrySchema).parse(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async write(entries: CognitionWritebackQueueEntry[]): Promise<void> {
    await mkdir(dirname(this.path()), { recursive: true });
    await writeFile(this.path(), `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  }

  private path(): string {
    return join(this.baseDir, this.relativePath);
  }
}
