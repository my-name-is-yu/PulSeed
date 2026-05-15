import { z } from "zod/v3";
import type { ILLMClient } from "../base/llm/llm-client.js";
import { getInternalIdentityPrefix } from "../base/config/identity-loader.js";
import type { ApprovalOrigin, ApprovalRecord } from "./store/runtime-schemas.js";

const MIN_CONVERSATIONAL_APPROVAL_CONFIDENCE = 0.7;

export const ConversationalApprovalDecisionSchema = z.object({
  decision: z.enum(["approve", "reject", "clarify", "side_question", "new_intent", "unknown"]),
  confidence: z.number().min(0).max(1),
  clarification: z.string().optional(),
  rationale: z.string().optional(),
});

export type ConversationalApprovalDecision = z.infer<typeof ConversationalApprovalDecisionSchema>;

export interface ConversationalApprovalDecisionContext {
  llmClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">;
  approval: ApprovalRecord;
  replyOrigin: ApprovalOrigin;
  priorTurnState?: string;
}

export async function classifyConversationalApprovalDecision(
  input: string,
  context: ConversationalApprovalDecisionContext
): Promise<ConversationalApprovalDecision> {
  const commandDecision = parseExactApprovalCommand(input);
  if (commandDecision) return commandDecision;

  const trimmed = input.trim();
  const llmClient = context.llmClient;
  if (!trimmed || !llmClient) {
    return unknownDecision("Approval reply classification is unavailable.");
  }

  try {
    const response = await llmClient.sendMessage(
      [{ role: "user", content: trimmed }],
      { system: getConversationalApprovalDecisionPrompt(context), max_tokens: 600, temperature: 0 }
    );
    const parsed = llmClient.parseJSON(response.content, ConversationalApprovalDecisionSchema);
    if (parsed.decision !== "unknown" && parsed.confidence < MIN_CONVERSATIONAL_APPROVAL_CONFIDENCE) {
      return unknownDecision(parsed.clarification ?? "The approval reply was ambiguous.");
    }
    return parsed;
  } catch {
    return unknownDecision("Approval reply could not be classified.");
  }
}

function parseExactApprovalCommand(input: string): ConversationalApprovalDecision | null {
  const command = input.trim();
  if (command === "/approve") {
    return { decision: "approve", confidence: 1 };
  }
  if (command === "/reject") {
    return { decision: "reject", confidence: 1 };
  }
  if (command === "/clarify") {
    return { decision: "clarify", confidence: 1 };
  }
  return null;
}

function getConversationalApprovalDecisionPrompt(context: ConversationalApprovalDecisionContext): string {
  return `${getInternalIdentityPrefix("assistant")} Classify the operator's reply inside one active conversational approval context.

This is a safety decision. Use only the active approval context below as the guard. Do not approve from vague enthusiasm, acknowledgement, side comments, unrelated chat, stale approval IDs, or mismatched target context. Low-confidence replies must be unknown.

Decision meanings:
- approve: explicitly approves the active approval request.
- reject: explicitly denies, rejects, cancels, or stops the active approval request.
- clarify: asks a question or requests explanation while keeping the approval pending.
- side_question: asks about the active approval or nearby runtime/setup status without approving or rejecting it.
- new_intent: asks PulSeed to handle an unrelated task or conversation turn while the approval remains pending.
- unknown: ambiguous approval/rejection, stale, wrong-context, or too low-confidence.

Active approval context:
${describeApprovalContext(context.approval)}

Reply origin:
${JSON.stringify(context.replyOrigin, null, 2)}

Prior turn state:
${context.priorTurnState ?? "none"}

Respond only as JSON:
{
  "decision": "approve" | "reject" | "clarify" | "side_question" | "new_intent" | "unknown",
  "confidence": 0.0-1.0,
  "clarification": "short clarification prompt when clarify or unknown",
  "rationale": "short rationale"
}`;
}

function describeApprovalContext(approval: ApprovalRecord): string {
  return JSON.stringify({
    approval_id: approval.approval_id,
    goal_id: approval.goal_id,
    state: approval.state,
    created_at: approval.created_at,
    expires_at: approval.expires_at,
    origin: approval.origin,
    payload: approval.payload,
  }, null, 2);
}

export function unknownDecision(clarification: string): ConversationalApprovalDecision {
  return {
    decision: "unknown",
    confidence: 0,
    clarification,
  };
}
