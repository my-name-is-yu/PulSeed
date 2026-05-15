import { z } from "zod/v3";
import {
  CognitionEventRefSchema,
  CognitionRefSchema,
  MemoryWritebackProposalSchema,
  type CognitionEventRef,
  type CognitionRef,
} from "../runtime/cognition/contracts.js";
import {
  MEMORY_LIFECYCLE_OWNER_ROUTING_TABLE,
  MemoryLifecycleCanonicalOwnerSchema,
  MemoryLifecycleOwnerRoutingRuleSchema,
  MemoryLifecycleProposedTargetSchema,
  ownerRoutingRuleForProposal,
  type MemoryLifecycleCanonicalOwner,
  type MemoryLifecycleOwnerRoutingRule,
  type MemoryLifecycleProposedTarget,
} from "../runtime/cognition/memory-writeback-owner-routing.js";
import {
  CognitiveReplayIndexEntrySchema,
  type CognitiveReplayIndexEntry,
} from "../runtime/visibility/cognitive-replay-index.js";
import {
  FeedbackIngestionEffectSchema,
  type FeedbackIngestionEffect,
} from "../runtime/attention/feedback-ingestion.js";
import {
  ProceduralMemoryRecordSchema,
  type ProceduralMemoryRecord,
} from "../platform/dream/procedural-memory.js";
import {
  GovernedMemoryAllowedUseClassSchema,
  GovernedMemoryBlockedUseClassSchema,
  GovernedMemoryCorrectionStateSchema,
  GovernedMemoryLifecycleSchema,
  GovernedMemoryOwnerRefSchema,
  GovernedMemoryProjectionPolicySchema,
  GovernedMemoryRecordKindSchema,
  GovernedMemoryRoleSchema,
  GovernedMemorySchema,
  type GovernedMemory,
  type GovernedMemoryAllowedUseClass,
  type GovernedMemoryBlockedUseClass,
  type GovernedMemoryProjectionPolicy,
} from "../platform/profile/governed-memory.js";
import {
  CognitionWritebackQueueEntrySchema,
  CognitionWritebackQueueOwnerSchema,
  ownerForWritebackProposal,
  type CognitionWritebackQueueEntry,
  type CognitionWritebackQueueOwner,
} from "../reflection/cognition-writeback-queue.js";

export {
  MEMORY_LIFECYCLE_OWNER_ROUTING_TABLE,
  MemoryLifecycleCanonicalOwnerSchema,
  MemoryLifecycleOwnerRoutingRuleSchema,
  MemoryLifecycleProposedTargetSchema,
  ownerRoutingRuleForProposal,
};
export type {
  MemoryLifecycleCanonicalOwner,
  MemoryLifecycleOwnerRoutingRule,
  MemoryLifecycleProposedTarget,
};

export const MemoryLifecycleOwnerRefSchema = z.union([
  z.object({
    kind: z.literal("governed_memory"),
    owner_ref: GovernedMemoryOwnerRefSchema,
  }).strict(),
  z.object({
    kind: z.literal("writeback_queue"),
    owner: CognitionWritebackQueueOwnerSchema,
    queue_entry_ref: CognitionRefSchema,
  }).strict().superRefine((ref, ctx) => {
    if (ref.queue_entry_ref.kind !== "cognition_writeback_queue_entry") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["queue_entry_ref", "kind"],
        message: "writeback queue lifecycle refs must use cognition_writeback_queue_entry refs",
      });
    }
  }),
  z.object({
    kind: z.literal("cognition_replay"),
    replay_ref: CognitionEventRefSchema,
  }).strict().superRefine((ref, ctx) => {
    if (ref.replay_ref.source_store !== "cognition_audit") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replay_ref", "source_store"],
        message: "cognition replay lifecycle refs must point to cognition_audit refs",
      });
    }
  }),
  z.object({
    kind: z.literal("attention_feedback"),
    feedback_ref: CognitionRefSchema,
  }).strict().superRefine((ref, ctx) => {
    if (ref.feedback_ref.kind !== "feedback") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["feedback_ref", "kind"],
        message: "attention feedback lifecycle refs must use feedback refs",
      });
    }
  }),
  z.object({
    kind: z.literal("procedural_promotion"),
    promotion_ref: CognitionRefSchema,
  }).strict().superRefine((ref, ctx) => {
    if (ref.promotion_ref.kind !== "procedural_memory") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["promotion_ref", "kind"],
        message: "procedural promotion lifecycle refs must use procedural_memory refs",
      });
    }
  }),
]);
export type MemoryLifecycleOwnerRef = z.infer<typeof MemoryLifecycleOwnerRefSchema>;

export const MemoryLifecycleStageSchema = z.enum([
  "observed",
  "proposed",
  "queued",
  "owner_review",
  "accepted",
  "projected",
  "used",
  "corrected",
  "superseded",
  "retracted",
  "tombstoned",
  "deleted",
  "invalidated",
]);
export type MemoryLifecycleStage = z.infer<typeof MemoryLifecycleStageSchema>;

export const MemoryLifecycleReviewStateSchema = z.enum([
  "none",
  "pending_user_review",
  "pending_owner_review",
  "accepted",
  "rejected",
  "blocked_source_invalid",
]);
export type MemoryLifecycleReviewState = z.infer<typeof MemoryLifecycleReviewStateSchema>;

export const MemoryLifecycleEnvelopeSchema = z.object({
  envelope_id: z.string().min(1),
  owner_ref: MemoryLifecycleOwnerRefSchema,
  logical_key: z.string().min(1),
  governed_shape: z.object({
    record_kind: GovernedMemoryRecordKindSchema,
    role: GovernedMemoryRoleSchema,
  }).strict().optional(),
  proposal_kind: MemoryWritebackProposalSchema.shape.proposal_kind.optional(),
  lifecycle_stage: MemoryLifecycleStageSchema,
  governed_lifecycle: GovernedMemoryLifecycleSchema.optional(),
  correction_state: GovernedMemoryCorrectionStateSchema.optional(),
  allowed_uses: z.array(GovernedMemoryAllowedUseClassSchema).min(1),
  not_allowed_uses: z.array(GovernedMemoryBlockedUseClassSchema).default([]),
  source_refs: z.array(CognitionEventRefSchema).min(1),
  projection_policy: GovernedMemoryProjectionPolicySchema,
  review_state: MemoryLifecycleReviewStateSchema,
  invalidation_refs: z.array(CognitionEventRefSchema).default([]),
  owner_decision_ref: CognitionRefSchema.optional(),
}).strict().superRefine((envelope, ctx) => {
  if (envelope.owner_ref.kind !== "governed_memory") {
    if (envelope.governed_lifecycle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["governed_lifecycle"],
        message: "non-governed lifecycle envelopes must not pretend to expose GovernedMemoryLifecycle",
      });
    }
    if (envelope.correction_state) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["correction_state"],
        message: "non-governed lifecycle envelopes must not pretend to expose GovernedMemoryCorrectionState",
      });
    }
  }

  const blockedUses = new Set<string>(envelope.not_allowed_uses);
  const conflictingUse = envelope.allowed_uses.find((use) => blockedUses.has(use));
  if (conflictingUse) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowed_uses"],
      message: `memory lifecycle use cannot be both allowed and blocked: ${conflictingUse}`,
    });
  }

  if (envelope.allowed_uses.includes("never_use_directly") && envelope.allowed_uses.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowed_uses"],
      message: "never_use_directly cannot be combined with direct allowed uses",
    });
  }

  if (
    (envelope.lifecycle_stage === "deleted" || envelope.lifecycle_stage === "tombstoned" || envelope.lifecycle_stage === "invalidated")
    && envelope.projection_policy.surface_eligible
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["projection_policy", "surface_eligible"],
      message: "deleted, tombstoned, and invalidated lifecycle envelopes cannot be Surface eligible",
    });
  }

  if (envelope.review_state === "accepted" && envelope.lifecycle_stage === "owner_review") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["review_state"],
      message: "owner-review lifecycle stage cannot already be accepted",
    });
  }
});
export type MemoryLifecycleEnvelope = z.infer<typeof MemoryLifecycleEnvelopeSchema>;

export function createMemoryLifecycleEnvelopeFromGovernedMemory(input: {
  memory: GovernedMemory | unknown;
  sourceEventRefs: readonly CognitionEventRef[];
  envelopeId?: string;
  lifecycleStage?: MemoryLifecycleStage;
  reviewState?: MemoryLifecycleReviewState;
  invalidationRefs?: readonly CognitionEventRef[];
}): MemoryLifecycleEnvelope {
  const memory = GovernedMemorySchema.parse(input.memory);
  const stage = input.lifecycleStage ?? lifecycleStageForGovernedMemory(memory);
  return MemoryLifecycleEnvelopeSchema.parse({
    envelope_id: input.envelopeId ?? `memory-lifecycle:governed:${memory.memory_id}`,
    owner_ref: {
      kind: "governed_memory",
      owner_ref: memory.owning_store_ref,
    },
    logical_key: memory.logical_key,
    governed_shape: {
      record_kind: memory.record_kind,
      role: memory.role,
    },
    lifecycle_stage: stage,
    governed_lifecycle: memory.lifecycle,
    correction_state: memory.correction_state,
    allowed_uses: memory.allowed_uses,
    not_allowed_uses: memory.not_allowed_uses,
    source_refs: input.sourceEventRefs,
    projection_policy: projectionPolicyForStage(memory.projection_policy, stage),
    review_state: input.reviewState ?? "accepted",
    invalidation_refs: input.invalidationRefs ?? [],
  });
}

export function createMemoryLifecycleEnvelopeFromWritebackQueueEntry(
  entry: CognitionWritebackQueueEntry | unknown
): MemoryLifecycleEnvelope {
  const parsed = CognitionWritebackQueueEntrySchema.parse(entry);
  const rule = ownerRoutingRuleForProposal(parsed.proposal);
  const expectedOwner = ownerForWritebackProposal(parsed.proposal);
  if (parsed.owner !== expectedOwner) {
    throw new Error(`writeback queue owner ${parsed.owner} does not match lifecycle routing owner ${expectedOwner}`);
  }
  return MemoryLifecycleEnvelopeSchema.parse({
    envelope_id: `memory-lifecycle:writeback:${parsed.queue_entry_id}`,
    owner_ref: {
      kind: "writeback_queue",
      owner: parsed.owner,
      queue_entry_ref: queueEntryRef(parsed.queue_entry_id),
    },
    logical_key: parsed.proposal.proposal_id,
    proposal_kind: parsed.proposal.proposal_kind,
    lifecycle_stage: lifecycleStageForWritebackQueue(parsed),
    allowed_uses: ["memory_write_candidate"],
    not_allowed_uses: [
      "runtime_grounding",
      "user_facing_reference",
      "surface_projection",
      "side_effect_authorization",
      "stale_session_authorization",
      "proactive_trigger",
    ],
    source_refs: parsed.source_refs,
    projection_policy: nonSurfaceProjectionPolicy(
      parsed.source_state === "current" ? "visible" : "redacted"
    ),
    review_state: reviewStateForWritebackQueue(parsed),
    invalidation_refs: parsed.invalidation_refs,
    ...(parsed.owner_decision_ref ? { owner_decision_ref: parsed.owner_decision_ref } : {}),
    governed_shape: governedShapeForRoutingRule(rule, parsed.owner),
  });
}

export function createMemoryLifecycleEnvelopeFromCognitionReplayIndexEntry(
  entry: CognitiveReplayIndexEntry | unknown
): MemoryLifecycleEnvelope {
  const parsed = CognitiveReplayIndexEntrySchema.parse(entry);
  return MemoryLifecycleEnvelopeSchema.parse({
    envelope_id: `memory-lifecycle:replay:${parsed.index_entry_id}`,
    owner_ref: {
      kind: "cognition_replay",
      replay_ref: parsed.cognition_replay_ref,
    },
    logical_key: parsed.index_entry_id,
    lifecycle_stage: parsed.invalidation_state === "valid" ? "observed" : "invalidated",
    allowed_uses: ["never_use_directly"],
    not_allowed_uses: [
      "runtime_grounding",
      "user_facing_reference",
      "surface_projection",
      "side_effect_authorization",
      "stale_session_authorization",
      "proactive_trigger",
    ],
    source_refs: parsed.source_refs,
    projection_policy: nonSurfaceProjectionPolicy(parsed.invalidation_state === "valid" ? "hidden" : "redacted"),
    review_state: "none",
    invalidation_refs: parsed.invalidation_refs,
  });
}

export function createMemoryLifecycleEnvelopeFromAttentionFeedbackEffect(input: {
  effect: FeedbackIngestionEffect | unknown;
  sourceEventRefs: readonly CognitionEventRef[];
  reviewState?: MemoryLifecycleReviewState;
}): MemoryLifecycleEnvelope {
  const effect = FeedbackIngestionEffectSchema.parse(input.effect);
  if (effect.effect_kind !== "attention_feedback") {
    throw new Error(`attention feedback lifecycle envelope requires attention_feedback effect, got ${effect.effect_kind}`);
  }
  const feedbackRef = CognitionRefSchema.parse({
    kind: "feedback",
    ref: effect.payload.feedback_ref.id,
  });
  return MemoryLifecycleEnvelopeSchema.parse({
    envelope_id: `memory-lifecycle:attention-feedback:${effect.feedback_id}`,
    owner_ref: {
      kind: "attention_feedback",
      feedback_ref: feedbackRef,
    },
    logical_key: effect.feedback_id,
    lifecycle_stage: "accepted",
    allowed_uses: ["attention_prioritization", "behavioral_inhibition"],
    not_allowed_uses: [
      "side_effect_authorization",
      "stale_session_authorization",
      "proactive_trigger",
      "surface_projection",
    ],
    source_refs: input.sourceEventRefs,
    projection_policy: nonSurfaceProjectionPolicy("visible"),
    review_state: input.reviewState ?? "accepted",
    invalidation_refs: [],
  });
}

export function createMemoryLifecycleEnvelopeFromProceduralMemory(
  record: ProceduralMemoryRecord | unknown
): MemoryLifecycleEnvelope {
  const parsed = ProceduralMemoryRecordSchema.parse(record);
  const accepted = parsed.status === "approved";
  return MemoryLifecycleEnvelopeSchema.parse({
    envelope_id: `memory-lifecycle:procedural:${parsed.procedural_memory_id}`,
    owner_ref: {
      kind: "procedural_promotion",
      promotion_ref: {
        kind: "procedural_memory",
        ref: parsed.procedural_memory_id,
      },
    },
    logical_key: parsed.procedural_memory_id,
    lifecycle_stage: lifecycleStageForProceduralMemory(parsed),
    allowed_uses: accepted ? ["goal_planning"] : ["never_use_directly"],
    not_allowed_uses: accepted
      ? ["side_effect_authorization", "stale_session_authorization", "proactive_trigger", "surface_projection"]
      : ["goal_planning", "side_effect_authorization", "stale_session_authorization", "proactive_trigger", "surface_projection"],
    source_refs: parsed.source_trace_refs,
    projection_policy: nonSurfaceProjectionPolicy(accepted ? "visible" : "hidden"),
    review_state: reviewStateForProceduralMemory(parsed),
    invalidation_refs: [],
  });
}

export const MemoryLifecycleReviewActionSchema = z.enum([
  "accept",
  "edit",
  "reject",
  "suppress",
  "forget_source",
  "accept_as_knowledge",
  "keep_private",
  "request_source_review",
  "promote_as_planning_hint",
  "retire_old_hint",
  "accept_downgrade",
  "reset_budget",
  "apply_correction",
  "revoke_use",
  "tombstone",
]);
export type MemoryLifecycleReviewAction = z.infer<typeof MemoryLifecycleReviewActionSchema>;

export const MemoryLifecycleReviewItemKindSchema = z.enum([
  "profile_candidate",
  "soil_knowledge_candidate",
  "dream_procedural_candidate",
  "attention_feedback",
  "correction_invalidation",
  "cognition_replay_ref",
]);
export type MemoryLifecycleReviewItemKind = z.infer<typeof MemoryLifecycleReviewItemKindSchema>;

export const MemoryLifecycleReviewItemSchema = z.object({
  item_id: z.string().min(1),
  envelope_id: z.string().min(1),
  owner_ref: MemoryLifecycleOwnerRefSchema,
  item_kind: MemoryLifecycleReviewItemKindSchema,
  review_state: MemoryLifecycleReviewStateSchema,
  source_summary_refs: z.array(CognitionEventRefSchema).default([]),
  invalidation_refs: z.array(CognitionEventRefSchema).default([]),
  owner_decision_ref: CognitionRefSchema.optional(),
  allowed_actions: z.array(MemoryLifecycleReviewActionSchema).default([]),
  raw_content_visible: z.literal(false).default(false),
  hidden_prompt_visible: z.literal(false).default(false),
  sensitive_content_visible: z.literal(false).default(false),
  redaction_refs: z.array(CognitionRefSchema).default([]),
  repair_paths: z.array(z.enum(["correct", "suppress", "revoke", "forget"])).default([]),
}).strict();
export type MemoryLifecycleReviewItem = z.infer<typeof MemoryLifecycleReviewItemSchema>;

export const MemoryLifecycleReviewInboxSchema = z.object({
  schema_version: z.literal("memory-lifecycle-review-inbox/v1"),
  inbox_id: z.string().min(1),
  generated_at: z.string().datetime(),
  read_only: z.literal(true).default(true),
  mutation_performed: z.literal(false).default(false),
  items: z.array(MemoryLifecycleReviewItemSchema).default([]),
}).strict();
export type MemoryLifecycleReviewInbox = z.infer<typeof MemoryLifecycleReviewInboxSchema>;

export function createMemoryLifecycleReviewInbox(input: {
  inboxId: string;
  generatedAt: string;
  envelopes: readonly (MemoryLifecycleEnvelope | unknown)[];
  sourceRefsVisible?: boolean;
}): MemoryLifecycleReviewInbox {
  const envelopes = input.envelopes.map((envelope) => MemoryLifecycleEnvelopeSchema.parse(envelope));
  return MemoryLifecycleReviewInboxSchema.parse({
    schema_version: "memory-lifecycle-review-inbox/v1",
    inbox_id: input.inboxId,
    generated_at: input.generatedAt,
    read_only: true,
    mutation_performed: false,
    items: envelopes.map((envelope) =>
      reviewItemFromLifecycleEnvelope(envelope, {
        sourceRefsVisible: input.sourceRefsVisible ?? true,
      })
    ),
  });
}

export function reviewItemFromLifecycleEnvelope(
  envelopeInput: MemoryLifecycleEnvelope | unknown,
  options: { sourceRefsVisible?: boolean } = {},
): MemoryLifecycleReviewItem {
  const envelope = MemoryLifecycleEnvelopeSchema.parse(envelopeInput);
  const refsVisible = options.sourceRefsVisible ?? true;
  const itemKind = reviewItemKindForEnvelope(envelope);
  const redactionRefs = refsVisible
    ? envelope.invalidation_refs.map((ref): CognitionRef => ({
      kind: "redaction",
      ref: `${ref.source_store}:${ref.ref}`,
    }))
    : [];
  return MemoryLifecycleReviewItemSchema.parse({
    item_id: `memory-lifecycle-review:${envelope.envelope_id}`,
    envelope_id: envelope.envelope_id,
    owner_ref: envelope.owner_ref,
    item_kind: itemKind,
    review_state: envelope.review_state,
    source_summary_refs: refsVisible ? envelope.source_refs : [],
    invalidation_refs: refsVisible ? envelope.invalidation_refs : [],
    ...(envelope.owner_decision_ref ? { owner_decision_ref: envelope.owner_decision_ref } : {}),
    allowed_actions: reviewActionsForItem(itemKind, envelope),
    raw_content_visible: false,
    hidden_prompt_visible: false,
    sensitive_content_visible: false,
    redaction_refs: redactionRefs,
    repair_paths: repairPathsForEnvelope(envelope),
  });
}

function lifecycleStageForGovernedMemory(memory: GovernedMemory): MemoryLifecycleStage {
  if (memory.correction_state === "deleted" || memory.lifecycle === "deleted") return "deleted";
  if (memory.lifecycle === "tombstoned") return "tombstoned";
  if (memory.lifecycle === "retracted" || memory.correction_state === "retracted") return "retracted";
  if (memory.lifecycle === "superseded" || memory.correction_state === "superseded" || memory.superseded_by_memory_id !== null) {
    return "superseded";
  }
  if (memory.correction_state === "corrected") return "corrected";
  if (memory.projection_policy.surface_eligible && memory.allowed_uses.includes("surface_projection")) return "projected";
  return "accepted";
}

function lifecycleStageForWritebackQueue(entry: CognitionWritebackQueueEntry): MemoryLifecycleStage {
  if (entry.state === "queued") return "queued";
  if (entry.state === "ready_for_owner_review") return "owner_review";
  if (entry.state === "accepted_by_owner") return "accepted";
  if (entry.state === "superseded") return "superseded";
  if (entry.state === "blocked_source_invalid") return "invalidated";
  return "retracted";
}

function lifecycleStageForProceduralMemory(record: ProceduralMemoryRecord): MemoryLifecycleStage {
  if (record.status === "candidate") return "proposed";
  if (record.status === "owner_review_required") return "owner_review";
  if (record.status === "approved") return "accepted";
  return "retracted";
}

function reviewStateForWritebackQueue(entry: CognitionWritebackQueueEntry): MemoryLifecycleReviewState {
  if (entry.state === "queued") return "pending_user_review";
  if (entry.state === "ready_for_owner_review") return "pending_owner_review";
  if (entry.state === "accepted_by_owner") return "accepted";
  if (entry.state === "blocked_source_invalid") return "blocked_source_invalid";
  if (entry.state === "rejected") return "rejected";
  return "none";
}

function reviewStateForProceduralMemory(record: ProceduralMemoryRecord): MemoryLifecycleReviewState {
  if (record.status === "candidate") return "pending_user_review";
  if (record.status === "owner_review_required") return "pending_owner_review";
  if (record.status === "approved") return "accepted";
  return "rejected";
}

function projectionPolicyForStage(
  policy: GovernedMemoryProjectionPolicy,
  stage: MemoryLifecycleStage
): GovernedMemoryProjectionPolicy {
  if (stage === "deleted" || stage === "tombstoned" || stage === "invalidated" || stage === "retracted" || stage === "superseded") {
    return GovernedMemoryProjectionPolicySchema.parse({
      ...policy,
      surface_eligible: false,
      inspection_visibility: stage === "deleted" || stage === "tombstoned" ? "redacted" : policy.inspection_visibility,
      stale_behavior: "exclude",
    });
  }
  return GovernedMemoryProjectionPolicySchema.parse(policy);
}

function nonSurfaceProjectionPolicy(
  inspectionVisibility: GovernedMemoryProjectionPolicy["inspection_visibility"],
): GovernedMemoryProjectionPolicy {
  return GovernedMemoryProjectionPolicySchema.parse({
    surface_eligible: false,
    requires_permission_gate: true,
    inspection_visibility: inspectionVisibility,
    stale_behavior: "exclude",
  });
}

function queueEntryRef(queueEntryId: string): CognitionRef {
  return {
    kind: "cognition_writeback_queue_entry",
    ref: queueEntryId,
  };
}

function governedShapeForRoutingRule(
  rule: MemoryLifecycleOwnerRoutingRule,
  queueOwner: CognitionWritebackQueueOwner
): MemoryLifecycleEnvelope["governed_shape"] | undefined {
  if (queueOwner === "profile") {
    return {
      record_kind: "seed_candidate",
      role: "seed",
    };
  }
  if (rule.canonical_owner === "knowledge") {
    return {
      record_kind: "knowledge_fact",
      role: "knowledge",
    };
  }
  if (rule.canonical_owner === "soil") {
    return {
      record_kind: "project_fact",
      role: "work_memory",
    };
  }
  return undefined;
}

function reviewItemKindForEnvelope(envelope: MemoryLifecycleEnvelope): MemoryLifecycleReviewItemKind {
  if (envelope.invalidation_refs.length > 0 || isInvalidationStage(envelope.lifecycle_stage)) {
    return "correction_invalidation";
  }
  if (envelope.owner_ref.kind === "cognition_replay") return "cognition_replay_ref";
  if (envelope.owner_ref.kind === "attention_feedback") return "attention_feedback";
  if (envelope.owner_ref.kind === "procedural_promotion") return "dream_procedural_candidate";
  if (envelope.owner_ref.kind === "writeback_queue") {
    if (envelope.owner_ref.owner === "profile") return "profile_candidate";
    if (envelope.owner_ref.owner === "soil" || envelope.owner_ref.owner === "knowledge") return "soil_knowledge_candidate";
    if (envelope.owner_ref.owner === "attention_feedback") return "attention_feedback";
    return "dream_procedural_candidate";
  }
  if (envelope.governed_shape?.role === "knowledge" || envelope.governed_shape?.role === "work_memory") {
    return "soil_knowledge_candidate";
  }
  return "profile_candidate";
}

function reviewActionsForItem(
  itemKind: MemoryLifecycleReviewItemKind,
  envelope: MemoryLifecycleEnvelope
): MemoryLifecycleReviewAction[] {
  if (envelope.review_state === "accepted" || envelope.review_state === "rejected" || envelope.review_state === "none") {
    return [];
  }
  if (envelope.review_state === "blocked_source_invalid") {
    return ["request_source_review", "reject"];
  }
  switch (itemKind) {
    case "profile_candidate":
      return ["accept", "edit", "reject", "suppress", "forget_source"];
    case "soil_knowledge_candidate":
      return ["accept_as_knowledge", "keep_private", "reject", "request_source_review"];
    case "dream_procedural_candidate":
      return ["promote_as_planning_hint", "reject", "retire_old_hint"];
    case "attention_feedback":
      return ["accept_downgrade", "reject", "reset_budget"];
    case "correction_invalidation":
      return ["apply_correction", "revoke_use", "suppress", "tombstone"];
    case "cognition_replay_ref":
      return [];
  }
}

function repairPathsForEnvelope(envelope: MemoryLifecycleEnvelope): Array<"correct" | "suppress" | "revoke" | "forget"> {
  if (envelope.lifecycle_stage === "deleted" || envelope.lifecycle_stage === "tombstoned") return ["forget"];
  if (envelope.lifecycle_stage === "corrected" || envelope.lifecycle_stage === "superseded") return ["correct", "suppress"];
  if (envelope.review_state === "blocked_source_invalid") return ["revoke", "forget"];
  return [];
}

function isInvalidationStage(stage: MemoryLifecycleStage): boolean {
  return stage === "corrected"
    || stage === "superseded"
    || stage === "retracted"
    || stage === "tombstoned"
    || stage === "deleted"
    || stage === "invalidated";
}

export function uniqueLifecycleBlockedUses(
  values: readonly GovernedMemoryBlockedUseClass[]
): GovernedMemoryBlockedUseClass[] {
  return Array.from(new Set(values));
}

export function uniqueLifecycleAllowedUses(
  values: readonly GovernedMemoryAllowedUseClass[]
): GovernedMemoryAllowedUseClass[] {
  return Array.from(new Set(values));
}
