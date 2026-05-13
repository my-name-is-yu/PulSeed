import {
  CognitionEventRefSchema,
  CognitionWritebackReflectionInputSchema,
  type CognitionEventRef,
  type CognitionWritebackReflectionInput,
} from "../runtime/cognition/index.js";
import {
  createCognitionWritebackQueueEntry,
  decideCognitionWritebackQueueEntry,
  type CognitionWritebackQueueEntry,
  type CognitionWritebackSourceState,
} from "./cognition-writeback-queue.js";

export type CognitionWritebackSourceStateMap = Record<string, CognitionWritebackSourceState>;

export function evaluateCognitionWritebackReflectionInput(input: {
  reflectionInput: CognitionWritebackReflectionInput;
  evaluatedAt: string;
  sourceStates?: CognitionWritebackSourceStateMap;
}): CognitionWritebackQueueEntry[] {
  const reflectionInput = CognitionWritebackReflectionInputSchema.parse(input.reflectionInput);
  return reflectionInput.writeback_proposals.map((proposal, index) => {
    const sourceState = strongestSourceState(
      proposal.source_event_refs.map((ref) => sourceStateForRef(ref, input.sourceStates))
    );
    const queued = createCognitionWritebackQueueEntry({
      queueEntryId: `${reflectionInput.input_id}:queue:${index + 1}`,
      proposal,
      createdAt: input.evaluatedAt,
      sourceState,
      invalidationRefs: proposal.source_event_refs.filter((ref) =>
        sourceStateForRef(ref, input.sourceStates) !== "current"
      ),
    });
    if (queued.state === "blocked_source_invalid") return queued;
    return decideCognitionWritebackQueueEntry({
      entry: queued,
      decidedAt: input.evaluatedAt,
      decision: {
        kind: "ready_for_owner_review",
        reason: "proposal source refs are current; owner-specific review is still required before any memory write",
      },
    });
  });
}

export function cognitionWritebackSourceStateKey(ref: CognitionEventRef): string {
  const parsed = CognitionEventRefSchema.parse(ref);
  return `${parsed.source_store}:${parsed.ref}`;
}

function sourceStateForRef(
  ref: CognitionEventRef,
  sourceStates: CognitionWritebackSourceStateMap | undefined
): CognitionWritebackSourceState {
  return sourceStates?.[cognitionWritebackSourceStateKey(ref)] ?? "current";
}

function strongestSourceState(states: CognitionWritebackSourceState[]): CognitionWritebackSourceState {
  if (states.includes("deleted_or_tombstoned")) return "deleted_or_tombstoned";
  if (states.includes("missing_source")) return "missing_source";
  return "current";
}
