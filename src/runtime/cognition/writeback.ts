import {
  CognitionEventRefSchema,
  CognitionWritebackReflectionInputSchema,
  MemoryWritebackProposalSchema,
  ReflectionHintSchema,
  type CognitionEventRef,
  type CognitionReplayRecord,
  type CognitionWritebackReflectionInput,
  type MemoryWritebackProposal,
  type ReflectionHint,
} from "./contracts.js";

export function createTurnEpisodeWritebackProposal(input: {
  proposalId: string;
  sourceEventRef: CognitionEventRef;
  evidenceSummaryRef?: CognitionEventRef;
}): MemoryWritebackProposal {
  const sourceEventRef = CognitionEventRefSchema.parse(input.sourceEventRef);
  const evidenceSummaryRef = input.evidenceSummaryRef
    ? CognitionEventRefSchema.parse(input.evidenceSummaryRef)
    : undefined;
  return MemoryWritebackProposalSchema.parse({
    proposal_id: input.proposalId,
    proposal_kind: "episode",
    source_event_refs: [sourceEventRef],
    proposed_target: "dream",
    admission_state: "pending_review",
    user_visible_review_text: "Review whether this turn contains durable memory before admitting it.",
    ...(evidenceSummaryRef ? { evidence_summary_ref: evidenceSummaryRef } : {}),
    auto_apply: false,
    source_content_materialized: false,
  });
}

export function createReflectionHintForWriteback(input: {
  hintId: string;
  sourceEventRef: CognitionEventRef;
}): ReflectionHint {
  return ReflectionHintSchema.parse({
    hint_id: input.hintId,
    hint_kind: "episode",
    source_refs: [CognitionEventRefSchema.parse(input.sourceEventRef)],
    consumer: "dream_consolidation",
    runtime_authority: false,
  });
}

export function createReflectionInputFromCognitionReplay(input: {
  inputId: string;
  record: CognitionReplayRecord;
  toolTraceRefs?: CognitionEventRef[];
  feedbackRefs?: CognitionEventRef[];
}): CognitionWritebackReflectionInput {
  return CognitionWritebackReflectionInputSchema.parse({
    schema_version: "cognition-writeback-reflection-input/v1",
    input_id: input.inputId,
    episode_refs: input.record.event_refs,
    writeback_proposals: input.record.stable_output?.memory_writeback ?? [],
    tool_trace_refs: input.toolTraceRefs ?? [],
    feedback_refs: input.feedbackRefs ?? [],
    runtime_authority: false,
  });
}
