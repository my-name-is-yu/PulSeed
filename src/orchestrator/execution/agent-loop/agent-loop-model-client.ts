import type {
  ILLMClient,
  LLMMessage,
  ToolCallResult,
} from "../../../base/llm/llm-client.js";
import type {
  AgentLoopAssistantOutput,
  AgentLoopMessage,
  AgentLoopModelClient,
  AgentLoopModelInfo,
  AgentLoopModelRef,
  AgentLoopModelRegistry,
  AgentLoopModelRequest,
  AgentLoopModelResponse,
  AgentLoopModelTurnProtocol,
  AgentLoopToolCall,
} from "./agent-loop-model.js";
import { formatAgentLoopToolMessageContent } from "./agent-loop-model.js";
import {
  buildPromptedToolProtocolSystemPrompt,
  extractPromptedToolCalls,
} from "./prompted-tool-protocol.js";
import {
  assistantTextResponseItem,
  functionToolCallResponseItem,
} from "./response-item.js";

export class ILLMClientAgentLoopModelClient implements AgentLoopModelClient {
  constructor(
    private readonly llmClient: ILLMClient,
    private readonly registry: AgentLoopModelRegistry,
  ) {}

  async getModelInfo(ref: AgentLoopModelRef): Promise<AgentLoopModelInfo> {
    return this.registry.get(ref);
  }

  async createTurn(input: AgentLoopModelRequest): Promise<AgentLoopModelResponse> {
    const protocol = await this.createTurnProtocol(input);
    const finalAssistant = [...protocol.assistant].reverse().find((item) => item.content.trim().length > 0);
    return {
      content: finalAssistant?.content ?? "",
      toolCalls: protocol.toolCalls,
      stopReason: protocol.stopReason,
      usage: protocol.usage,
    };
  }

  async createTurnProtocol(input: AgentLoopModelRequest): Promise<AgentLoopModelTurnProtocol> {
    const messages = this.toLLMMessages(input.messages);
    const supportsNativeToolCalling = this.llmClient.supportsToolCalling?.() !== false;
    const usesExternalAgentRuntime = this.llmClient.usesExternalAgentRuntime?.() === true;
    const usePromptedToolProtocol = !supportsNativeToolCalling && !usesExternalAgentRuntime;
    const response = await this.llmClient.sendMessage(messages, {
      model: input.model.modelId,
      ...(supportsNativeToolCalling
        ? { system: input.system }
        : {
            system: usePromptedToolProtocol
              ? buildPromptedToolProtocolSystemPrompt({ systemPrompt: input.system, tools: input.tools })
              : input.system,
          }),
      max_tokens: input.maxOutputTokens,
      abortSignal: input.abortSignal,
      sandboxPolicy: formatCliSandboxPolicy(input.sandboxMode),
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      idleTimeoutMs: input.idleTimeoutMs,
      ...(supportsNativeToolCalling ? { tools: input.tools } : {}),
    });

    const toolCalls = supportsNativeToolCalling
      ? (response.tool_calls ?? []).map((call) => this.toAgentLoopToolCall(call))
      : usePromptedToolProtocol
        ? extractPromptedToolCalls({ content: response.content, tools: input.tools })
        : [];
    const assistantContent = supportsNativeToolCalling
      ? response.content
      : (usePromptedToolProtocol && toolCalls.length > 0
          ? `Calling ${toolCalls.map((call) => call.name).join(", ")}`
          : response.content);
    const assistant: AgentLoopAssistantOutput[] = assistantContent
      ? [{
          content: assistantContent,
          phase: toolCalls.length > 0 ? "commentary" : "final_answer",
        }]
      : [];
    return {
      assistant,
      toolCalls,
      responseItems: [
        ...assistant.map((item) => assistantTextResponseItem(item.content, item.phase)),
        ...toolCalls.map((call) => functionToolCallResponseItem(call)),
      ],
      stopReason: response.stop_reason,
      responseCompleted: true,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  private toLLMMessages(messages: AgentLoopMessage[]): LLMMessage[] {
    return messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.role === "tool"
          ? `Tool result${message.toolName ? ` for ${message.toolName}` : ""}:\n${formatAgentLoopToolMessageContent(message)}`
          : message.content,
      }));
  }

  private toAgentLoopToolCall(call: ToolCallResult): AgentLoopToolCall {
    let input: unknown;
    try {
      input = JSON.parse(call.function.arguments || "{}");
    } catch {
      input = call.function.arguments;
    }
    return {
      id: call.id,
      name: call.function.name,
      input,
    };
  }

}

function formatCliSandboxPolicy(
  sandboxMode: AgentLoopModelRequest["sandboxMode"],
): "read-only" | "workspace-write" | "danger-full-access" | undefined {
  if (!sandboxMode) return undefined;
  return sandboxMode === "danger_full_access" ? "danger-full-access" : sandboxMode.replace("_", "-") as "read-only" | "workspace-write";
}
