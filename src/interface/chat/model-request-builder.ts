import type {
  LLMMessage,
  LLMRequestOptions,
  ToolDefinition,
} from "../../base/llm/llm-client.js";
import {
  buildPromptedToolProtocolSystemPrompt,
} from "../../orchestrator/execution/agent-loop/prompted-tool-protocol.js";
import { toToolDefinitionsFiltered } from "../../tools/tool-definition-adapter.js";
import type { ITool } from "../../tools/types.js";
import {
  renderSystemPromptWithTurnContext,
  type ChatTurnContext,
} from "./turn-context.js";

export const CHAT_MODEL_REQUEST_SCHEMA_VERSION = "chat-model-request-v1";

export type ChatModelRequestPurpose = "ordinary_chat" | "tool_call";
export type ChatToolMode = "none" | "native" | "prompted";

export interface ChatModelRequest {
  schema_version: typeof CHAT_MODEL_REQUEST_SCHEMA_VERSION;
  purpose: ChatModelRequestPurpose;
  messages: LLMMessage[];
  options: LLMRequestOptions;
  toolDefinitions: ToolDefinition[];
  toolMode: ChatToolMode;
  structuredOutput: {
    finalJsonRequired: boolean;
    reason: "ordinary_text" | "native_tool_calls" | "prompted_tool_protocol";
  };
}

export interface BuildOrdinaryChatModelRequestInput {
  purpose: "ordinary_chat";
  turnContext: ChatTurnContext;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface BuildToolCallModelRequestInput {
  purpose: "tool_call";
  turnContext: ChatTurnContext;
  systemPrompt?: string;
  availableTools: ITool[];
  activatedTools?: Set<string>;
  supportsNativeToolCalling: boolean;
  messages?: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
}

export type BuildChatModelRequestInput =
  | BuildOrdinaryChatModelRequestInput
  | BuildToolCallModelRequestInput;

export function buildChatModelRequest(input: BuildChatModelRequestInput): ChatModelRequest {
  if (input.purpose === "ordinary_chat") {
    return buildOrdinaryChatRequest(input);
  }
  return buildToolCallRequest(input);
}

function buildOrdinaryChatRequest(input: BuildOrdinaryChatModelRequestInput): ChatModelRequest {
  return {
    schema_version: CHAT_MODEL_REQUEST_SCHEMA_VERSION,
    purpose: "ordinary_chat",
    messages: [
      ...input.turnContext.modelVisible.conversation.priorTurns,
      { role: "user", content: input.turnContext.modelVisible.input.text },
    ],
    options: {
      system: renderSystemPromptWithTurnContext(input.systemPrompt, input.turnContext.modelVisible),
      max_tokens: input.maxTokens ?? 1000,
      temperature: input.temperature ?? 0,
    },
    toolDefinitions: [],
    toolMode: "none",
    structuredOutput: {
      finalJsonRequired: false,
      reason: "ordinary_text",
    },
  };
}

function buildToolCallRequest(input: BuildToolCallModelRequestInput): ChatModelRequest {
  const activatedTools = input.activatedTools ?? new Set(input.turnContext.modelVisible.tools.activatedTools);
  const toolDefinitions = toToolDefinitionsFiltered(input.availableTools, {
    activatedTools,
  });
  const baseSystemPrompt = renderSystemPromptWithTurnContext(input.systemPrompt, input.turnContext.modelVisible);
  const messages: LLMMessage[] = input.messages
    ? [...input.messages]
    : [{ role: "user", content: input.turnContext.modelVisible.prompts.prompt }];

  if (input.supportsNativeToolCalling) {
    return {
      schema_version: CHAT_MODEL_REQUEST_SCHEMA_VERSION,
      purpose: "tool_call",
      messages,
      options: {
        ...(toolDefinitions.length > 0 ? { tools: toolDefinitions } : {}),
        ...(baseSystemPrompt ? { system: baseSystemPrompt } : {}),
        model_tier: "light",
        max_tokens: input.maxTokens ?? 1000,
        temperature: input.temperature ?? 0,
      },
      toolDefinitions,
      toolMode: "native",
      structuredOutput: {
        finalJsonRequired: false,
        reason: "native_tool_calls",
      },
    };
  }

  return {
    schema_version: CHAT_MODEL_REQUEST_SCHEMA_VERSION,
    purpose: "tool_call",
    messages,
    options: {
      system: buildPromptedToolProtocolSystemPrompt({
        systemPrompt: baseSystemPrompt,
        tools: toolDefinitions,
      }),
      model_tier: "light",
      max_tokens: input.maxTokens ?? 1000,
      temperature: input.temperature ?? 0,
    },
    toolDefinitions,
    toolMode: "prompted",
    structuredOutput: {
      finalJsonRequired: true,
      reason: "prompted_tool_protocol",
    },
  };
}
