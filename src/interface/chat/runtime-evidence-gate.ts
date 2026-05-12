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
  verdict: z.enum(["allow", "repair", "block", "requires_evidence", "uncertain"]),
  reason: z.string().min(1),
  claim_domain: z.unknown().optional(),
  safe_repaired_answer: z.string().optional(),
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

const EVIDENCE_BOUND_PATTERNS = [
  /`[^`]+`/,
  /(?:^|[\s(])(?:\.{0,2}\/|\/[\w.-]|~\/)[^\s]*/,
  /\b[\w.-]+\.(?:cjs|cts|js|jsx|json|md|mjs|mts|ts|tsx|toml|yaml|yml)\b/i,
  /\b(?:daemon|gateway|runtime|watchdog|process)\b.{0,80}(?:\s|:)(?:running|stopped|idle|healthy|unhealthy|normal|status|succeeded|failed|checked)\b/i,
  /\b(?:daemon|gateway|runtime|watchdog|process)\b.{0,80}(?:正常|動いて|停止|起動|状態|確認|成功|失敗)/i,
  /\b(?:status|checked|ran|executed|succeeded|failed)\b.{0,80}\b(?:daemon|gateway|runtime|watchdog|process|command|tool)\b/i,
  /\b(?:workspace|repository|repo|file|directory|path|source-tree)\b.{0,80}\b(?:exists|missing|present|found|checked|read|contains)\b/i,
  /(?:作業ディレクトリ|リポジトリ|ワークスペース|ファイル|ディレクトリ|パス).{0,80}(?:あります|ありました|います|いる|存在|確認|読み|読ん|見つ)/,
  /(?:デーモン|ゲートウェイ|ランタイム|プロセス).{0,80}(?:正常|動いて|停止|起動|状態|確認|成功|失敗)/,
  /(?:コマンド|ツール).{0,80}(?:実行|成功|失敗|確認)/,
];

export function mayRequireRuntimeEvidenceGate(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return EVIDENCE_BOUND_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function buildRuntimeEvidenceGatePrompt(): string {
  return `You are a strict boundary checker for PulSeed gateway answers.

Decide whether the assistant answer contains a verified or current local/runtime/workspace status claim that requires direct evidence from this same turn.

Return only JSON:
{
  "verdict": "allow" | "repair" | "block" | "requires_evidence" | "uncertain",
  "reason": "short reason",
  "claim_domain": "runtime_status" | "workspace_state" | "local_machine" | "command_or_tool" | "unknown",
  "safe_repaired_answer": "only when verdict is repair"
}

Use "block" or "requires_evidence" when the answer claims PulSeed inspected current daemon, gateway, process, runtime, tool, command, session, local machine, workspace, file, directory, path, or source-tree state, and same-turn evidence refs do not support that kind of claim.

Use "repair" when removing only unsupported current-state claims produces a safe answer. Preserve the user's language where possible.

Use "allow" for pure conversation, general guidance, asking the user to run a check, or explicit statements that the assistant cannot verify the current state.

Do not classify by keywords alone. Judge the semantic claim and the same-turn evidence.`;
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
  if (!mayRequireRuntimeEvidenceGate(input.assistantOutput)) {
    return { output: input.assistantOutput, blocked: false };
  }
  if (input.hasRuntimeEvidence) {
    return { output: input.assistantOutput, blocked: false, reason: "Same-turn tool evidence was produced before the answer." };
  }
  if (!input.llmClient) {
    return {
      output: boundedUnverifiedAnswer("unknown"),
      blocked: true,
      reason: "Runtime evidence classifier unavailable.",
    };
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
    return {
      output: boundedUnverifiedAnswer("unknown"),
      blocked: true,
      reason: "Runtime evidence classifier unavailable.",
    };
  }

  let decision: RuntimeEvidenceGateDecision;
  try {
    const rawDecision = input.llmClient.parseJSON(responseContent, RuntimeEvidenceGateDecisionSchema);
    decision = {
      verdict: rawDecision.verdict,
      reason: rawDecision.reason,
      claim_domain: normalizeClaimDomain(rawDecision.claim_domain),
      safe_repaired_answer: rawDecision.safe_repaired_answer,
    };
  } catch {
    return {
      output: boundedUnverifiedAnswer("unknown"),
      blocked: true,
      reason: "Runtime evidence classifier returned an invalid decision.",
    };
  }

  if (decision.verdict === "allow") {
    return { output: input.assistantOutput, blocked: false, reason: decision.reason };
  }
  if (decision.verdict === "repair") {
    const repaired = decision.safe_repaired_answer?.trim();
    if (repaired) {
      return { output: repaired, blocked: true, reason: decision.reason };
    }
  }
  return {
    output: boundedUnverifiedAnswer(decision.claim_domain),
    blocked: true,
    reason: decision.reason,
  };
}
