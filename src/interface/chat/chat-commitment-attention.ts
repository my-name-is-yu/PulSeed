import {
  buildSignalContextFromAttentionInputs,
  createCommitmentAttentionInput,
  createCommitmentCandidate,
  type AttentionInputIntakeResult,
  type CommitmentCandidate,
  type CommitmentCandidateClassifier,
  type CommitmentCandidateExtraction,
  type CommitmentLifecycleControl,
} from "../../runtime/attention/index.js";
import type { AttentionStateStore } from "../../runtime/store/attention-state-store.js";
import type { AttentionScope } from "../../runtime/types/companion-autonomy.js";
import type { ChatTurnContext } from "./turn-context.js";

export interface ChatCommitmentAttentionResult {
  candidate: CommitmentCandidate | null;
  attentionInputIntake: AttentionInputIntakeResult | null;
  diagnostic: string | null;
}

export async function recordChatTurnCommitmentAttention(input: {
  turnContext: ChatTurnContext;
  classifier: CommitmentCandidateClassifier | null;
  store: Pick<
    AttentionStateStore,
    "saveCommitmentCandidates" | "saveCycle" | "listCommitmentCandidates" | "applyCommitmentControl"
  >;
}): Promise<ChatCommitmentAttentionResult> {
  if (!input.classifier) {
    return {
      candidate: null,
      attentionInputIntake: null,
      diagnostic: "commitment attention classifier unavailable; shadow write skipped",
    };
  }

  const turn = input.turnContext.modelVisible.turn;
  const session = input.turnContext.modelVisible.session;
  const runtime = input.turnContext.modelVisible.runtime;
  const routeKind = session.route?.kind ?? "unknown";
  const policyEpoch = `chat-route:${routeKind}`;
  const surfaceRef = runtime.replyTarget
    ? { kind: "surface" as const, id: runtime.replyTarget.surface ?? "chat" }
    : null;
  const scope = commitmentScopeForTurn({
    context: input.turnContext,
    routeKind,
    policyEpoch,
    surfaceRef,
  });
  const openCommitments = await input.store.listCommitmentCandidates({
    scope,
    states: ["candidate", "shadow_held", "ask_confirmation", "watching", "active_care", "quieted", "snoozed", "stale"],
    includeTerminal: false,
  });
  const extraction = await input.classifier.classify({
    text: input.turnContext.modelVisible.input.text,
    turnId: turn.turnId,
    sessionId: session.sessionId ?? "session:none",
    routeKind,
    startedAt: turn.startedAt,
    policyEpoch,
    openCommitments: openCommitments.map((candidate) => ({
      commitmentId: candidate.commitment_id,
      summary: candidate.summary,
      materializationState: candidate.materialization_state,
      dueWindowStart: candidate.due.window_start,
      dueWindowEnd: candidate.due.window_end,
      updatedAt: candidate.updated_at,
    })),
    locale: null,
  });

  if (isCommitmentControlOutcome(extraction)) {
    const target = openCommitments.find((candidate) => candidate.commitment_id === extraction.target_commitment_id);
    if (!target) {
      return {
        candidate: null,
        attentionInputIntake: null,
        diagnostic: `commitment classifier outcome ${extraction.outcome} had no current target; no lifecycle control applied`,
      };
    }
    const updated = await input.store.applyCommitmentControl({
      commitmentId: target.commitment_id,
      control: controlForExtraction(extraction),
      now: turn.startedAt,
      feedbackRef: `feedback:chat-commitment:${turn.turnId}:${extraction.outcome}`,
      reason: extraction.reason,
    });
    return {
      candidate: updated,
      attentionInputIntake: null,
      diagnostic: updated
        ? `commitment candidate ${updated.materialization_state} after ${extraction.outcome}`
        : `commitment classifier target ${target.commitment_id} was not found during lifecycle control`,
    };
  }

  const candidate = createCommitmentCandidate({
    extraction,
    scope,
    turnId: turn.turnId,
    sessionId: session.sessionId ?? "session:none",
    sourceId: `chat:${session.sessionId ?? "session:none"}:${turn.turnId}:user`,
    emittedAt: turn.startedAt,
    policyEpoch,
    activeSurfaceRef: surfaceRef,
  });

  if (!candidate) {
    return {
      candidate: null,
      attentionInputIntake: null,
      diagnostic: extraction.outcome === "candidate"
        ? "commitment classifier produced a low-confidence candidate; shadow write held out"
        : `commitment classifier outcome ${extraction.outcome}; no candidate written`,
    };
  }

  const attentionInput = createCommitmentAttentionInput({ candidate });
  const attentionInputIntake = await input.store.saveCycle({
    attentionInputs: [attentionInput],
    signalContext: buildSignalContextFromAttentionInputs({
      inputs: [attentionInput],
      assembled_at: turn.startedAt,
      signal_context_id: `signal:chat-commitment:${turn.turnId}`,
    }),
    recordedAt: turn.startedAt,
  });
  await input.store.saveCommitmentCandidates([candidate]);

  return {
    candidate,
    attentionInputIntake,
    diagnostic: attentionInputIntake && attentionInputIntake.accepted.length > 0
      ? "commitment attention candidate recorded in shadow mode"
      : "commitment attention candidate replay key was already recorded",
  };
}

function isCommitmentControlOutcome(
  extraction: CommitmentCandidateExtraction,
): extraction is CommitmentCandidateExtraction & {
  outcome: "completion" | "correction" | "not_relevant";
} {
  return extraction.outcome === "completion"
    || extraction.outcome === "correction"
    || extraction.outcome === "not_relevant";
}

function controlForExtraction(
  extraction: CommitmentCandidateExtraction & { outcome: "completion" | "correction" | "not_relevant" },
): CommitmentLifecycleControl {
  switch (extraction.outcome) {
    case "completion":
      return "already_done";
    case "correction":
      return "correct_memory_source";
    case "not_relevant":
      return "not_relevant";
  }
}

function commitmentScopeForTurn(input: {
  context: ChatTurnContext;
  routeKind: string;
  policyEpoch: string;
  surfaceRef: { kind: "surface"; id: string } | null;
}): AttentionScope {
  const runtime = input.context.modelVisible.runtime;
  const session = input.context.modelVisible.session;
  return {
    userId: runtime.replyTarget?.user_id ?? null,
    identityId: runtime.replyTarget?.identity_key ?? null,
    workspaceId: input.context.hostOnly.execution.gitRoot,
    conversationId: runtime.replyTarget?.conversation_id ?? null,
    sessionId: session.sessionId ?? null,
    surfaceClass: surfaceClassForRoute(input.routeKind, runtime.replyTarget?.platform),
    surfaceRef: input.surfaceRef?.id ?? null,
    permissionScope: "local_only",
    sensitivity: "medium",
    memoryOwner: null,
    policyEpoch: input.policyEpoch,
  };
}

function surfaceClassForRoute(
  routeKind: string,
  platform: string | null | undefined,
): "cli" | "tui" | "telegram" | "daemon" | "schedule" | "system" | "unknown" {
  if (platform === "telegram") return "telegram";
  if (routeKind === "gateway_model_loop") return "daemon";
  if (routeKind === "agent_loop") return "cli";
  return "unknown";
}
