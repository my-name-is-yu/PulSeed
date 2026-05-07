import { z } from "zod";
import type { ILLMClient } from "../base/llm/llm-client.js";
import { getInternalIdentityPrefix } from "../base/config/identity-loader.js";
import type { ApprovalOrigin, ApprovalRecord } from "./store/runtime-schemas.js";
import { PermissionGrantCapabilitySchema } from "./store/permission-grant-store.js";
import type { PendingPermissionGrantProposal } from "./permission-dialogue.js";

const MIN_PERMISSION_GRANT_REPLY_CONFIDENCE = 0.7;

export const PermissionGrantReplyDecisionSchema = z.object({
  decision: z.enum([
    "approve_once",
    "approve_current_run",
    "approve_current_goal",
    "reject",
    "clarify",
    "narrow_scope",
    "extend_scope",
    "revoke",
    "side_question",
    "new_intent",
    "unknown",
  ]),
  confidence: z.number().min(0).max(1),
  capabilities: z.array(PermissionGrantCapabilitySchema).min(1).optional(),
  requested_scope: z.enum([
    "once",
    "current_run",
    "current_goal",
    "session",
    "workspace",
    "project",
    "global",
    "standing",
  ]).optional(),
  clarification: z.string().optional(),
  rationale: z.string().optional(),
});

export type PermissionGrantReplyDecision = z.infer<typeof PermissionGrantReplyDecisionSchema>;

export interface PermissionGrantReplyDecisionContext {
  llmClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">;
  approval: ApprovalRecord;
  proposal: PendingPermissionGrantProposal;
  replyOrigin: ApprovalOrigin;
  priorTurnState?: string;
}

export async function classifyConversationalPermissionGrantDecision(
  input: string,
  context: PermissionGrantReplyDecisionContext,
): Promise<PermissionGrantReplyDecision> {
  const commandDecision = parseExactPermissionGrantCommand(input);
  if (commandDecision) return commandDecision;

  const trimmed = input.trim();
  const llmClient = context.llmClient;
  if (!trimmed || !llmClient) {
    return unknownGrantDecision("Permission reply classification is unavailable.");
  }

  try {
    const response = await llmClient.sendMessage(
      [{ role: "user", content: trimmed }],
      { system: getPermissionGrantReplyDecisionPrompt(context), max_tokens: 700, temperature: 0 },
    );
    const parsed = llmClient.parseJSON(response.content, PermissionGrantReplyDecisionSchema);
    if (parsed.decision !== "unknown" && parsed.confidence < MIN_PERMISSION_GRANT_REPLY_CONFIDENCE) {
      return unknownGrantDecision(parsed.clarification ?? "The permission reply was ambiguous.");
    }
    return parsed;
  } catch {
    return unknownGrantDecision("Permission reply could not be classified.");
  }
}

function parseExactPermissionGrantCommand(input: string): PermissionGrantReplyDecision | null {
  const command = input.trim();
  if (command === "/approve" || command === "/approve-once") {
    return { decision: "approve_once", confidence: 1 };
  }
  if (command === "/approve-run") {
    return { decision: "approve_current_run", confidence: 1 };
  }
  if (command === "/approve-goal") {
    return { decision: "approve_current_goal", confidence: 1 };
  }
  if (command === "/reject") {
    return { decision: "reject", confidence: 1 };
  }
  if (command === "/clarify") {
    return { decision: "clarify", confidence: 1 };
  }
  return null;
}

function getPermissionGrantReplyDecisionPrompt(context: PermissionGrantReplyDecisionContext): string {
  return `${getInternalIdentityPrefix("assistant")} Classify the operator's reply inside one active PermissionGrant proposal.

This is a safety decision. Use only the active proposal below as the guard. Do not create or broaden permission from vague enthusiasm, acknowledgements, side comments, stale approval IDs, old targets, or unrelated chat. Low-confidence replies must be unknown.

Decision meanings:
- approve_once: approves only the currently pending tool/action once, without creating a reusable grant.
- approve_current_run: approves a reusable grant for the current run only.
- approve_current_goal: approves a reusable grant for the current goal only.
- reject: denies the active proposal.
- clarify: asks a question or requests explanation while keeping the proposal pending.
- narrow_scope: approves fewer capabilities than proposed. Include the approved capabilities.
- extend_scope: asks for a broader scope than proposed. Include requested_scope.
- revoke: asks to revoke or cancel the proposed permission boundary.
- side_question: asks about the proposal or nearby runtime/setup status without approving or rejecting it.
- new_intent: asks PulSeed to handle an unrelated task while the proposal remains pending.
- unknown: ambiguous, stale, wrong-context, or too low-confidence.

Standing or global permission must not be granted from one reply. If the reply requests standing/global permission, classify it as extend_scope with requested_scope "standing" or "global"; the caller must require a second explicit confirmation.

Active approval context:
${describeApprovalContext(context.approval)}

Active grant proposal:
${JSON.stringify(context.proposal, null, 2)}

Reply origin:
${JSON.stringify(context.replyOrigin, null, 2)}

Prior turn state:
${context.priorTurnState ?? "none"}

Respond only as JSON:
{
  "decision": "approve_once" | "approve_current_run" | "approve_current_goal" | "reject" | "clarify" | "narrow_scope" | "extend_scope" | "revoke" | "side_question" | "new_intent" | "unknown",
  "confidence": 0.0-1.0,
  "capabilities": ["write_workspace"],
  "requested_scope": "once" | "current_run" | "current_goal" | "session" | "workspace" | "project" | "global" | "standing",
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

export function unknownGrantDecision(clarification: string): PermissionGrantReplyDecision {
  return {
    decision: "unknown",
    confidence: 0,
    clarification,
  };
}
