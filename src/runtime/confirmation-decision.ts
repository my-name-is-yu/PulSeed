import { z } from "zod";
import type { ILLMClient } from "../base/llm/llm-client.js";
import { getInternalIdentityPrefix } from "../base/config/identity-loader.js";
import {
  RunSpecConfidenceValueSchema,
  RunSpecSafeNonnegativeIntSchema,
} from "./run-spec/types.js";

const MIN_CONFIRMATION_CONFIDENCE = 0.7;

const ConfirmationRevisionSchema = z.object({
  workspace_path: z.string().min(1).nullable().optional(),
  deadline: z.object({
    raw: z.string().min(1),
    iso_at: z.string().nullable().optional(),
    timezone: z.string().nullable().optional(),
    finalization_buffer_minutes: RunSpecSafeNonnegativeIntSchema.nullable().optional(),
    confidence: z.enum(["high", "medium", "low"]).optional(),
  }).nullable().optional(),
  metric_direction: z.enum(["maximize", "minimize"]).nullable().optional(),
}).optional();

export const ConfirmationDecisionSchema = z.object({
  decision: z.enum(["approve", "cancel", "revise", "unknown"]),
  confidence: RunSpecConfidenceValueSchema,
  revision: ConfirmationRevisionSchema,
  clarification: z.string().optional(),
  rationale: z.string().optional(),
});

export type ConfirmationDecision = z.infer<typeof ConfirmationDecisionSchema>;
export type ConfirmationDecisionKind = ConfirmationDecision["decision"];

export interface ConfirmationDecisionContext {
  llmClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">;
  kind: "approval" | "run_spec_confirmation";
  subject: string;
  allowedDecisions?: ConfirmationDecisionKind[];
}

export async function classifyConfirmationDecision(
  input: string,
  context: ConfirmationDecisionContext,
): Promise<ConfirmationDecision> {
  const commandDecision = parseExactConfirmationCommand(input);
  if (commandDecision) return commandDecision;

  const trimmed = input.trim();
  const llmClient = context.llmClient;
  if (!trimmed || !llmClient) return unknownDecision("Confirmation classifier is unavailable.");

  try {
    const response = await llmClient.sendMessage(
      [{ role: "user", content: trimmed }],
      { system: getConfirmationDecisionPrompt(context), max_tokens: 600, temperature: 0 },
    );
    const parsed = llmClient.parseJSON(response.content, ConfirmationDecisionSchema);
    if (!isAllowedDecision(parsed.decision, context.allowedDecisions)) {
      return unknownDecision("The response did not map to an allowed confirmation decision.");
    }
    if (parsed.decision !== "unknown" && parsed.confidence < MIN_CONFIRMATION_CONFIDENCE) {
      return unknownDecision(parsed.clarification ?? "The confirmation response is ambiguous.");
    }
    if (parsed.decision === "revise" && !hasRevision(parsed)) {
      return unknownDecision(parsed.clarification ?? "Please include the revision details.");
    }
    return parsed;
  } catch {
    return unknownDecision("Confirmation could not be classified.");
  }
}

function parseExactConfirmationCommand(input: string): ConfirmationDecision | null {
  const command = input.trim();
  if (command === "/approve" || command === "/confirm") {
    return { decision: "approve", confidence: 1 };
  }
  if (command === "/cancel" || command === "/reject") {
    return { decision: "cancel", confidence: 1 };
  }
  return null;
}

function getConfirmationDecisionPrompt(context: ConfirmationDecisionContext): string {
  const allowed = context.allowedDecisions?.join(", ") ?? "approve, cancel, revise, unknown";
  return `${getInternalIdentityPrefix("assistant")} Classify the operator's reply inside an explicit pending confirmation context.

Use the pending context as the guard. Do not infer approval from vague enthusiasm, acknowledgement, side comments, or unrelated chat. If the reply is ambiguous, return unknown.

Allowed decisions: ${allowed}

Decision meanings:
- approve: explicitly approves or starts the pending approval/run.
- cancel: explicitly rejects, cancels, or stops the pending approval/run.
- revise: asks to change the pending RunSpec; include structured revision fields.
- unknown: asks for clarification, discusses the request, or is too ambiguous.

Context kind: ${context.kind}
Pending context:
${context.subject}

Respond only as JSON:
{
  "decision": "approve" | "cancel" | "revise" | "unknown",
  "confidence": 0.0-1.0,
  "revision": {
    "workspace_path": "/repo/path",
    "deadline": {
      "raw": "tomorrow morning",
      "iso_at": "2026-05-03T00:00:00.000Z",
      "timezone": "Asia/Tokyo",
      "finalization_buffer_minutes": 60,
      "confidence": "medium"
    },
    "metric_direction": "maximize" | "minimize"
  },
  "clarification": "short clarification request when unknown",
  "rationale": "short rationale"
}`;
}

function isAllowedDecision(
  decision: ConfirmationDecisionKind,
  allowed: ConfirmationDecisionKind[] | undefined,
): boolean {
  return !allowed || new Set(allowed).has(decision);
}

function hasRevision(decision: ConfirmationDecision): boolean {
  const revision = decision.revision;
  return Boolean(revision?.workspace_path || revision?.deadline || revision?.metric_direction);
}

export function unknownDecision(clarification: string): ConfirmationDecision {
  return {
    decision: "unknown",
    confidence: 0,
    clarification,
  };
}
