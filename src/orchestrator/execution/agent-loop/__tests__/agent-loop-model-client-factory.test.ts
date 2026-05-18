import { describe, expect, it } from "vitest";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../../../../base/llm/llm-client.js";
import type { ProviderConfig } from "../../../../base/llm/provider-config.js";
import {
  AnthropicMessagesAgentLoopModelClient,
  ILLMClientAgentLoopModelClient,
  OpenAIResponsesAgentLoopModelClient,
  StaticAgentLoopModelRegistry,
  createProviderNativeAgentLoopModelClient,
  defaultAgentLoopCapabilities,
} from "../index.js";

function makeLLMClient(): ILLMClient {
  return {
    async sendMessage(_messages: LLMMessage[], _options?: LLMRequestOptions): Promise<LLMResponse> {
      return {
        content: "",
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string): T {
      return JSON.parse(content) as T;
    },
    supportsToolCalling: () => true,
  };
}

function makeCodexOAuthToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  return `${header}.${payload}.signature`;
}

const registry = new StaticAgentLoopModelRegistry([{
  ref: { providerId: "test", modelId: "model" },
  displayName: "test/model",
  capabilities: { ...defaultAgentLoopCapabilities },
}]);

describe("createProviderNativeAgentLoopModelClient", () => {
  it("selects OpenAI Responses client for openai provider", () => {
    const client = createProviderNativeAgentLoopModelClient({
      providerConfig: {
        provider: "openai",
        model: "gpt-5.4-mini",
        adapter: "agent_loop",
        api_key: "test-key",
      } as ProviderConfig,
      llmClient: makeLLMClient(),
      modelRegistry: registry,
    });

    expect(client).toBeInstanceOf(OpenAIResponsesAgentLoopModelClient);
  });

  it("keeps Codex OAuth backed OpenAI runs on the configured LLM client transport", () => {
    const client = createProviderNativeAgentLoopModelClient({
      providerConfig: {
        provider: "openai",
        model: "gpt-5.5",
        adapter: "openai_codex_cli",
        api_key: makeCodexOAuthToken(),
      } as ProviderConfig,
      llmClient: makeLLMClient(),
      modelRegistry: registry,
    });

    expect(client).toBeInstanceOf(ILLMClientAgentLoopModelClient);
  });

  it("selects Anthropic native client for anthropic provider", () => {
    const client = createProviderNativeAgentLoopModelClient({
      providerConfig: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        adapter: "agent_loop",
        api_key: "test-key",
      } as ProviderConfig,
      llmClient: makeLLMClient(),
      modelRegistry: registry,
    });

    expect(client).toBeInstanceOf(AnthropicMessagesAgentLoopModelClient);
  });
});
