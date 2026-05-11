import { z } from "zod";
import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
} from "../../base/llm/llm-client.js";
import type { ITool } from "../../tools/types.js";
import type { ChatTurnContext } from "./turn-context.js";

const GatewayToolUseContractDecisionSchema = z.object({
  verdict: z.enum(["allow", "retry_with_tools", "tool_unavailable"]),
  reason: z.string().min(1),
  retry_instruction: z.string().optional(),
});

export type GatewayToolUseContractDecision = z.infer<typeof GatewayToolUseContractDecisionSchema>;

export interface GatewayToolUseContractInput {
  readonly turnContext: ChatTurnContext;
  readonly assistantOutput: string;
  readonly availableTools: ITool[];
  readonly llmClient?: Pick<ILLMClient, "sendMessage" | "sendMessageStream" | "parseJSON">;
}

export async function evaluateGatewayToolUseContract(
  input: GatewayToolUseContractInput,
): Promise<GatewayToolUseContractDecision> {
  if (!input.llmClient || input.availableTools.length === 0 || !input.assistantOutput.trim()) {
    return { verdict: "allow", reason: "No tool-use contract check was needed." };
  }

  let response: LLMResponse;
  try {
    response = await sendContractModelRequest(input.llmClient, [
      {
        role: "user",
        content: JSON.stringify({
          user_input: input.turnContext.modelVisible.input.text,
          selected_route: input.turnContext.modelVisible.tools.selectedRoute,
          assistant_final_without_tool_calls: input.assistantOutput,
          available_tools: input.availableTools.slice(0, 24).map((tool) => ({
            name: tool.metadata.name,
            description: tool.description().slice(0, 500),
            read_only: tool.metadata.isReadOnly,
            permission_level: tool.metadata.permissionLevel,
            tags: tool.metadata.tags,
          })),
        }),
      },
    ], {
      system: buildGatewayToolUseContractPrompt(),
      max_tokens: 260,
      temperature: 0,
      model_tier: "light",
    });
  } catch {
    return {
      verdict: "tool_unavailable",
      reason: "The gateway tool-use contract checker was unavailable.",
    };
  }

  try {
    return input.llmClient.parseJSON(response.content, GatewayToolUseContractDecisionSchema);
  } catch {
    return {
      verdict: "tool_unavailable",
      reason: "The gateway tool-use contract checker returned an invalid decision.",
    };
  }
}

export function buildGatewayToolUseRetryMessage(decision: GatewayToolUseContractDecision): string {
  return [
    "The previous no-tool final answer violated the gateway tool-use contract.",
    decision.retry_instruction?.trim()
      || "If the user request depends on current workspace, repository, local machine, PulSeed runtime, or command/tool state, call an appropriate available read-only/status tool before finalizing.",
    "Do not ask the user to run local commands manually when an available tool can perform the safe check in this turn.",
    `Reason: ${decision.reason}`,
  ].join("\n");
}

function buildGatewayToolUseContractPrompt(): string {
  return `You are a strict contract checker for PulSeed gateway chat.

The model was given a gateway tool catalog but returned a final answer with no tool calls.

Return only JSON:
{
  "verdict": "allow" | "retry_with_tools" | "tool_unavailable",
  "reason": "short reason",
  "retry_instruction": "only for retry_with_tools"
}

Use "retry_with_tools" when the user semantically asked PulSeed to inspect, check, verify, or report current workspace, repository, file, local-machine, command/tool, gateway, daemon, or runtime state, and the listed tools include a safe read-only/status capability that could provide same-turn evidence.

Use "retry_with_tools" when the no-tool final answer deflects to the user to run local commands, says it cannot verify, or gives manual check steps even though an available safe tool can do the check.

Use "allow" for ordinary casual chat, general guidance, brainstorming, explanation, or requests that do not require current local/runtime/workspace evidence.

Use "tool_unavailable" only when the request requires current evidence but the listed tools cannot safely produce that evidence, or when the checker cannot make a confident decision.

Do not classify from keywords alone. Judge the semantic request, the assistant final answer, and the typed tool capabilities.`;
}

async function sendContractModelRequest(
  llmClient: Pick<ILLMClient, "sendMessage" | "sendMessageStream">,
  messages: LLMMessage[],
  options: LLMRequestOptions,
): Promise<LLMResponse> {
  return llmClient.sendMessage(messages, options);
}
