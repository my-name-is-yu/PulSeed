import { z } from "zod";
import {
  CognitionRefSchema,
  MemoryWritebackProposalSchema,
  type MemoryWritebackProposal,
} from "../../runtime/cognition/index.js";
import {
  MemoryCorrectionTargetRefSchema,
  type MemoryCorrectionTargetRef,
} from "./memory-correction-ledger.js";
import {
  UserMemoryOperationSchema,
  type UserMemoryOperationInput,
} from "./user-memory-operations.js";

export const CognitionMemoryReviewActionSchema = z.enum([
  "review",
  "correct",
  "retract",
  "forget",
  "delete_request",
  "reject_proposal",
]);
export type CognitionMemoryReviewAction = z.infer<typeof CognitionMemoryReviewActionSchema>;

export const CognitionMemoryReviewProjectionSchema = z.object({
  schema_version: z.literal("cognition-memory-review-projection/v1"),
  projection_id: z.string().min(1),
  proposal_ref: CognitionRefSchema,
  proposed_target: z.enum(["dream", "profile", "soil", "knowledge", "attention_feedback", "reflection"]),
  safe_review_text: z.string().min(1),
  available_actions: z.array(CognitionMemoryReviewActionSchema).min(1),
  source_refs: z.array(CognitionRefSchema).default([]),
  normal_surface_raw_memory_visible: z.literal(false).default(false),
  raw_prompt_visible: z.literal(false).default(false),
  owner_write_performed: z.literal(false).default(false),
}).strict();
export type CognitionMemoryReviewProjection = z.infer<typeof CognitionMemoryReviewProjectionSchema>;

export const CognitionMemoryReviewCommandSchema = z.object({
  schema_version: z.literal("cognition-memory-review-command/v1"),
  command_id: z.string().min(1),
  action: CognitionMemoryReviewActionSchema,
  proposal_ref: CognitionRefSchema.optional(),
  target_ref: MemoryCorrectionTargetRefSchema.optional(),
  reason: z.string().min(1),
  replacement_value: z.string().min(1).optional(),
  replacement_key: z.string().min(1).optional(),
  goal_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
  destructive_delete_requires_owner_approval: z.literal(true).default(true),
  owner_write_performed: z.literal(false).default(false),
}).strict().superRefine((command, ctx) => {
  if ((command.action === "correct" || command.action === "forget" || command.action === "retract") && !command.target_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target_ref"],
      message: "memory correction, forget, and retract commands require an owner memory target ref",
    });
  }
  if ((command.action === "review" || command.action === "reject_proposal") && !command.proposal_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["proposal_ref"],
      message: "proposal review and rejection commands require a writeback proposal ref",
    });
  }
  if (command.action === "delete_request" && command.destructive_delete_requires_owner_approval !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["destructive_delete_requires_owner_approval"],
      message: "destructive memory delete requests require owner approval",
    });
  }
});
export type CognitionMemoryReviewCommand = z.infer<typeof CognitionMemoryReviewCommandSchema>;

export function projectCognitionMemoryWritebackForReview(input: {
  projectionId: string;
  proposal: MemoryWritebackProposal;
}): CognitionMemoryReviewProjection {
  const proposal = MemoryWritebackProposalSchema.parse(input.proposal);
  return CognitionMemoryReviewProjectionSchema.parse({
    schema_version: "cognition-memory-review-projection/v1",
    projection_id: input.projectionId,
    proposal_ref: { kind: "memory_writeback_proposal", ref: proposal.proposal_id },
    proposed_target: proposal.proposed_target,
    safe_review_text: proposal.user_visible_review_text ?? `Review ${proposal.proposal_kind} before any memory owner applies it.`,
    available_actions: ["review", "reject_proposal"],
    source_refs: proposal.source_event_refs.map((ref) => ({ kind: ref.source_store, ref: ref.ref })),
    normal_surface_raw_memory_visible: false,
    raw_prompt_visible: false,
    owner_write_performed: false,
  });
}

export function memoryOperationInputFromReviewCommand(command: CognitionMemoryReviewCommand): UserMemoryOperationInput {
  const parsed = CognitionMemoryReviewCommandSchema.parse(command);
  if (parsed.action !== "correct" && parsed.action !== "forget" && parsed.action !== "retract") {
    throw new Error(`review action ${parsed.action} is not a direct user memory operation`);
  }
  return {
    operation: UserMemoryOperationSchema.parse(parsed.action),
    targetRef: parsed.target_ref as MemoryCorrectionTargetRef,
    reason: parsed.reason,
    replacementValue: parsed.replacement_value,
    replacementKey: parsed.replacement_key,
    goalId: parsed.goal_id,
    runId: parsed.run_id,
    taskId: parsed.task_id,
  };
}
