import { z } from "zod/v3";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import { getInternalIdentityPrefix } from "../../base/config/identity-loader.js";
import type { RunSpec } from "./types.js";
import { formatRunSpecSetupProposal } from "./confirmation.js";

const MIN_DIALOGUE_CONFIDENCE = 0.7;

export const RunSpecPendingDialogueDecisionSchema = z.object({
  outcome: z.enum(["confirmation_reply", "new_intent", "ambiguous"]),
  confirmation_kind: z.enum(["approve", "cancel", "revise", "clarify", "unknown"]).optional(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().optional(),
});

export type RunSpecPendingDialogueDecision = z.infer<typeof RunSpecPendingDialogueDecisionSchema>;

export interface RunSpecPendingDialogueArbiterContext {
  llmClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">;
}

export async function arbitrateRunSpecPendingDialogue(
  spec: RunSpec,
  input: string,
  context: RunSpecPendingDialogueArbiterContext = {},
): Promise<RunSpecPendingDialogueDecision> {
  const command = parseExactRunSpecDialogueCommand(input);
  if (command) return command;

  const trimmed = input.trim();
  if (!trimmed || !context.llmClient) {
    return { outcome: "ambiguous", confirmation_kind: "unknown", confidence: 0 };
  }

  try {
    const response = await context.llmClient.sendMessage(
      [{ role: "user", content: trimmed }],
      {
        system: getRunSpecPendingDialoguePrompt(spec),
        max_tokens: 500,
        temperature: 0,
      },
    );
    const parsed = context.llmClient.parseJSON(response.content, RunSpecPendingDialogueDecisionSchema);
    if (parsed.confidence < MIN_DIALOGUE_CONFIDENCE) {
      return {
        outcome: "ambiguous",
        confirmation_kind: parsed.confirmation_kind ?? "unknown",
        confidence: parsed.confidence,
        rationale: parsed.rationale,
      };
    }
    if (parsed.outcome === "confirmation_reply" && !parsed.confirmation_kind) {
      return { outcome: "ambiguous", confirmation_kind: "unknown", confidence: 0 };
    }
    return parsed;
  } catch {
    return { outcome: "ambiguous", confirmation_kind: "unknown", confidence: 0 };
  }
}

function parseExactRunSpecDialogueCommand(input: string): RunSpecPendingDialogueDecision | null {
  const command = input.trim();
  if (command === "/approve" || command === "/confirm") {
    return { outcome: "confirmation_reply", confirmation_kind: "approve", confidence: 1 };
  }
  if (command === "/cancel" || command === "/reject") {
    return { outcome: "confirmation_reply", confirmation_kind: "cancel", confidence: 1 };
  }
  return null;
}

function getRunSpecPendingDialoguePrompt(spec: RunSpec): string {
  return `${getInternalIdentityPrefix("assistant")} Classify the operator's next message while a long-running RunSpec confirmation is pending.

Return a typed dialogue-routing decision. Use the pending RunSpec only as context; do not consume unrelated ordinary chat as a confirmation reply.

Outcomes:
- confirmation_reply: the message is explicitly about approving, cancelling, revising, or clarifying the pending RunSpec.
- new_intent: the message asks a separate ordinary chat question or starts an unrelated task. The pending RunSpec should remain pending.
- ambiguous: the message might be related to the pending RunSpec but is not enough to approve, cancel, or revise safely.

Confirmation kinds:
- approve: explicit permission to start the pending RunSpec.
- cancel: explicit instruction to discard the pending RunSpec.
- revise: asks to change workspace, deadline, metric, safety policy, or objective of the pending RunSpec.
- clarify: asks a question about the pending RunSpec before deciding.
- unknown: insufficiently clear.

Pending RunSpec:
${formatRunSpecSetupProposal(spec, { diagnostic: true })}

Respond only as JSON:
{
  "outcome": "confirmation_reply" | "new_intent" | "ambiguous",
  "confirmation_kind": "approve" | "cancel" | "revise" | "clarify" | "unknown",
  "confidence": 0.0-1.0,
  "rationale": "short reason"
}`;
}
