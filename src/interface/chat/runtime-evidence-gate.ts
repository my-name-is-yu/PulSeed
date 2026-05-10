import { z } from "zod";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { ChatTurnContext } from "./turn-context.js";

const RUNTIME_EVIDENCE_CLAIM_DOMAINS = [
  "runtime_status",
  "workspace_state",
  "local_machine",
  "command_or_tool",
  "unknown",
] as const;

type RuntimeEvidenceClaimDomain = typeof RUNTIME_EVIDENCE_CLAIM_DOMAINS[number];

const RuntimeEvidenceGateDecisionSchema = z.object({
  verdict: z.enum(["allow", "requires_evidence", "uncertain"]),
  reason: z.string().min(1),
  claim_domain: z.unknown().optional(),
});

type RuntimeEvidenceGateDecision = Omit<z.infer<typeof RuntimeEvidenceGateDecisionSchema>, "claim_domain"> & {
  claim_domain?: RuntimeEvidenceClaimDomain;
};

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
  "reason": "short reason",
  "claim_domain": "runtime_status" | "workspace_state" | "local_machine" | "command_or_tool" | "unknown"
}

Use "requires_evidence" when the answer claims or implies that PulSeed inspected current daemon, gateway, process, runtime, tool, command, session, or local machine state; that a command/status check succeeded; or that a specific current status is known, and the same-turn evidence refs do not support that exact kind of claim.

Use "allow" when the answer is general guidance, asks the user to run a check, reports that it cannot verify, or clearly avoids claiming current runtime/local state.

Use "allow" when same-turn evidence refs directly support the answer's runtime/local status claim.

Use "uncertain" only when the answer may be making a current runtime/local claim but the wording is ambiguous.

Set claim_domain to "workspace_state" when the blocked or uncertain claim depends on current repository, workspace, file, directory, path, or source-tree state.

Set claim_domain to "runtime_status" when it depends on current PulSeed daemon, gateway, watchdog, resident runtime, or runtime health state.

Set claim_domain to "command_or_tool" when it depends on whether a command or tool actually ran or succeeded in this turn.

Set claim_domain to "local_machine" for other current local machine or process facts, and "unknown" only when the domain cannot be identified.

Do not classify based on keywords alone. Judge the semantic claim and whether it depends on fresh runtime/tool evidence.`;
}

function boundedUnverifiedAnswer(domain: RuntimeEvidenceGateDecision["claim_domain"]): string {
  switch (domain) {
    case "workspace_state":
      return [
        "I can't verify the current workspace or repository state from this turn because no trusted file/tool evidence was produced.",
        "I should not claim that a file, directory, path, or repository entry exists without that evidence.",
        "Please run an explicit workspace/file check, or try again from a surface where workspace read tools are available.",
      ].join("\n");
    case "command_or_tool":
      return [
        "I can't verify from this turn that the command or tool actually ran successfully because no trusted tool evidence was produced.",
        "I should not claim that a command, tool call, or check succeeded without that evidence.",
        "Please run an explicit check again from a surface where tool execution evidence is available.",
      ].join("\n");
    case "local_machine":
      return [
        "I can't verify the current local machine state from this turn because no trusted runtime/tool evidence was produced.",
        "I should not claim that a process, command, or local check succeeded without that evidence.",
        "Please run an explicit local status check, or try again from a surface where tool evidence is available.",
      ].join("\n");
    case "runtime_status":
      return [
        "I can't verify the current PulSeed runtime status from this turn because no trusted runtime/tool evidence was produced.",
        "I should not claim that a daemon, gateway, command, or watchdog check succeeded without that evidence.",
        "Please run an explicit runtime/status check, or try again from a surface where runtime-control/status tools are available.",
      ].join("\n");
    case "unknown":
    case undefined:
      return [
        "I can't verify the current local state from this turn because no trusted same-turn evidence was produced.",
        "I should not claim that an inspection, command, or check succeeded without that evidence.",
        "Please run an explicit check again from a surface where tool evidence is available.",
      ].join("\n");
  }
}

function normalizeClaimDomain(value: unknown): RuntimeEvidenceClaimDomain | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && (RUNTIME_EVIDENCE_CLAIM_DOMAINS as readonly string[]).includes(value)
    ? value as RuntimeEvidenceClaimDomain
    : "unknown";
}

export async function gateRuntimeEvidenceBoundFinalAnswer(input: RuntimeEvidenceGateInput): Promise<RuntimeEvidenceGateResult> {
  if (!input.assistantOutput.trim()) {
    return { output: input.assistantOutput, blocked: false };
  }
  if (!input.llmClient) {
    return { output: input.assistantOutput, blocked: false };
  }

  let responseContent: string;
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
    responseContent = response.content;
  } catch {
    return { output: input.assistantOutput, blocked: false, reason: "Runtime evidence classifier unavailable." };
  }

  let decision: RuntimeEvidenceGateDecision;
  try {
    const rawDecision = input.llmClient.parseJSON(responseContent, RuntimeEvidenceGateDecisionSchema);
    decision = {
      verdict: rawDecision.verdict,
      reason: rawDecision.reason,
      claim_domain: normalizeClaimDomain(rawDecision.claim_domain),
    };
  } catch {
    return { output: input.assistantOutput, blocked: false, reason: "Runtime evidence classifier returned an invalid decision." };
  }

  if (decision.verdict === "allow") {
    return { output: input.assistantOutput, blocked: false, reason: decision.reason };
  }
  return {
    output: boundedUnverifiedAnswer(decision.claim_domain),
    blocked: true,
    reason: decision.reason,
  };
}
