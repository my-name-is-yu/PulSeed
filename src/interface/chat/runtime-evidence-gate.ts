import { z } from "zod";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { ChatTurnContext } from "./turn-context.js";

const RuntimeEvidenceGateDecisionSchema = z.object({
  verdict: z.enum(["allow", "requires_evidence", "uncertain"]),
  reason: z.string().min(1),
});

type RuntimeEvidenceGateDecision = z.infer<typeof RuntimeEvidenceGateDecisionSchema>;

export interface RuntimeEvidenceGateInput {
  turnContext: ChatTurnContext;
  assistantOutput: string;
  hasRuntimeEvidence: boolean;
  runtimeEvidenceRefs?: string[];
  llmClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">;
}

export interface RuntimeEvidenceGateResult {
  output: string;
  blocked: boolean;
  reason?: string;
}

function buildRuntimeEvidenceGatePrompt(): string {
  return `You are a strict boundary checker for PulSeed chat final answers.

Decide whether the assistant final answer contains a verified or current local/runtime status claim that requires direct evidence from this same turn.

Return only JSON:
{
  "verdict": "allow" | "requires_evidence" | "uncertain",
  "reason": "short reason"
}

Use "requires_evidence" when the answer claims or implies that PulSeed inspected current daemon, gateway, process, runtime, tool, command, session, or local machine state; that a command/status check succeeded; or that a specific current status is known, and the same-turn evidence refs do not support that exact kind of claim.

Use "allow" when the answer is general guidance, asks the user to run a check, reports that it cannot verify, or clearly avoids claiming current runtime/local state.

Use "allow" when same-turn evidence refs directly support the answer's runtime/local status claim.

Use "uncertain" only when the answer may be making a current runtime/local claim but the wording is ambiguous.

Do not classify based on keywords alone. Judge the semantic claim and whether it depends on fresh runtime/tool evidence.`;
}

function boundedUnverifiedRuntimeStatusAnswer(): string {
  return [
    "I can't verify the current PulSeed runtime status from this turn because no trusted runtime/tool evidence was produced.",
    "I should not claim that a daemon, gateway, command, or watchdog check succeeded without that evidence.",
    "Please run an explicit runtime/status check, or try again from a surface where runtime-control/status tools are available.",
  ].join("\n");
}

export async function gateRuntimeEvidenceBoundFinalAnswer(input: RuntimeEvidenceGateInput): Promise<RuntimeEvidenceGateResult> {
  if (!input.assistantOutput.trim()) {
    return { output: input.assistantOutput, blocked: false };
  }
  if (!input.llmClient) {
    return { output: input.assistantOutput, blocked: false };
  }

  let decision: RuntimeEvidenceGateDecision;
  try {
    const response = await input.llmClient.sendMessage([
      {
        role: "user",
        content: JSON.stringify({
          user_input: input.turnContext.modelVisible.input.text,
          selected_route: input.turnContext.modelVisible.tools.selectedRoute,
          runtime_evidence: input.turnContext.modelVisible.runtimeEvidence,
          same_turn_evidence_refs: input.runtimeEvidenceRefs ?? [],
          has_same_turn_evidence: input.hasRuntimeEvidence,
          assistant_final: input.assistantOutput,
        }),
      },
    ], {
      system: buildRuntimeEvidenceGatePrompt(),
      max_tokens: 256,
      temperature: 0,
      model_tier: "light",
    });
    decision = input.llmClient.parseJSON(response.content, RuntimeEvidenceGateDecisionSchema);
  } catch {
    return { output: input.assistantOutput, blocked: false };
  }

  if (decision.verdict === "allow") {
    return { output: input.assistantOutput, blocked: false, reason: decision.reason };
  }
  return {
    output: boundedUnverifiedRuntimeStatusAnswer(),
    blocked: true,
    reason: decision.reason,
  };
}
