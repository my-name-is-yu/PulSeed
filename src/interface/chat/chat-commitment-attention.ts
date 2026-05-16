import {
  buildSignalContextFromAttentionInputs,
  createCommitmentAttentionInput,
  createCommitmentCandidate,
  type AttentionInputIntakeResult,
  type CommitmentCandidate,
  type CommitmentCandidateClassifier,
} from "../../runtime/attention/index.js";
import type { AttentionStateStore } from "../../runtime/store/attention-state-store.js";
import type { ChatTurnContext } from "./turn-context.js";

export interface ChatCommitmentAttentionResult {
  candidate: CommitmentCandidate | null;
  attentionInputIntake: AttentionInputIntakeResult | null;
  diagnostic: string | null;
}

export async function recordChatTurnCommitmentAttention(input: {
  turnContext: ChatTurnContext;
  classifier: CommitmentCandidateClassifier | null;
  store: Pick<AttentionStateStore, "saveCommitmentCandidates" | "saveCycle">;
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
  const extraction = await input.classifier.classify({
    text: input.turnContext.modelVisible.input.text,
    turnId: turn.turnId,
    sessionId: session.sessionId ?? "session:none",
    routeKind,
    startedAt: turn.startedAt,
    policyEpoch,
    locale: null,
  });

  const surfaceRef = runtime.replyTarget
    ? { kind: "surface" as const, id: runtime.replyTarget.surface ?? "chat" }
    : null;
  const candidate = createCommitmentCandidate({
    extraction,
    scope: {
      userId: runtime.replyTarget?.user_id ?? null,
      identityId: runtime.replyTarget?.identity_key ?? null,
      workspaceId: input.turnContext.hostOnly.execution.gitRoot,
      conversationId: runtime.replyTarget?.conversation_id ?? null,
      sessionId: session.sessionId ?? null,
      surfaceClass: surfaceClassForRoute(routeKind, runtime.replyTarget?.platform),
      surfaceRef: surfaceRef?.id ?? null,
      permissionScope: "local_only",
      sensitivity: "medium",
      memoryOwner: null,
      policyEpoch,
    },
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

function surfaceClassForRoute(
  routeKind: string,
  platform: string | null | undefined,
): "cli" | "tui" | "telegram" | "daemon" | "schedule" | "system" | "unknown" {
  if (platform === "telegram") return "telegram";
  if (routeKind === "gateway_model_loop") return "daemon";
  if (routeKind === "agent_loop") return "cli";
  return "unknown";
}
