// ─── Provider Factory ───
//
// Shared factory helpers for building LLM clients and adapter registries.
// Used by both CLIRunner and TUI entry to avoid duplicating wiring logic.

import { LLMClient, type ILLMClient } from "./llm-client.js";
import { LLMError } from "../utils/errors.js";
import { OllamaLLMClient } from "./ollama-client.js";
import { OpenAILLMClient } from "./openai-client.js";
import { CodexLLMClient, isCodexOAuthAccessToken } from "./codex-llm-client.js";
import { loadProviderConfig } from "./provider-config.js";
import { AdapterRegistry } from "../../orchestrator/execution/adapter-layer.js";
import { ClaudeCodeCLIAdapter } from "../../adapters/agents/claude-code-cli.js";
import { ClaudeAPIAdapter } from "../../adapters/agents/claude-api.js";
import { OpenAICodexCLIAdapter } from "../../adapters/agents/openai-codex.js";
import { NativeAgentLoopAdapter } from "../../adapters/agents/native-agent-loop.js";
import { GitHubIssueAdapter } from "../../adapters/github-issue.js";
import { A2AAdapter } from "../../adapters/agents/a2a-adapter.js";
import type { ProviderConfig } from "./provider-config.js";
import { resolveExecutionPolicy } from "../../orchestrator/execution/agent-loop/execution-policy.js";

/**
 * Build an LLM client based on provider configuration.
 *
 * Configuration priority (highest to lowest):
 *   1. PULSEED_PROVIDER environment variable
 *   2. ~/.pulseed/provider.json provider field
 *   3. Default: OpenAI
 *
 * Providers:
 *   - "anthropic" → LLMClient (api_key required)
 *   - "openai"    → OpenAILLMClient or CodexLLMClient depending on adapter
 *   - "ollama"    → OllamaLLMClient
 */
export async function buildLLMClient(providerConfig?: ProviderConfig): Promise<ILLMClient> {
  const config = providerConfig ?? await loadProviderConfig();

  switch (config.provider) {
    case "openai": {
      // Use CodexLLMClient when adapter is openai_codex_cli.
      // CodexLLMClient shells out to the codex CLI which handles auth internally,
      // so no api_key check is needed here.
      if (config.adapter === "openai_codex_cli") {
        const executionPolicy = resolveExecutionPolicy({
          workspaceRoot: process.cwd(),
          security: config.agent_loop?.security,
        });
        return new CodexLLMClient({
          apiKey: isCodexOAuthAccessToken(config.api_key) ? config.api_key : undefined,
          cliPath: config.codex_cli_path,
          model: config.model,
          lightModel: config.light_model,
          timeoutMs: config.codex_timeout_ms,
          idleTimeoutMs: config.codex_idle_timeout_ms,
          retryAttempts: config.codex_retry_attempts,
          reasoningEffort: config.reasoning_effort,
          sandboxPolicy: executionPolicy.sandboxMode === "danger_full_access" ? "danger-full-access" : executionPolicy.sandboxMode.replace("_", "-"),
        });
      }
      // Otherwise use OpenAILLMClient
      if (!config.api_key) {
        throw new LLMError(
          "OPENAI_API_KEY is not set.\nSet it via: export OPENAI_API_KEY=sk-..."
        );
      }
      return new OpenAILLMClient({
        apiKey: config.api_key,
        model: config.model,
        baseURL: config.base_url,
        lightModel: config.light_model,
        reasoningEffort: config.reasoning_effort,
      });
    }

    case "ollama":
      return new OllamaLLMClient({
        baseUrl: config.base_url ?? "http://localhost:11434",
        model: config.model ?? "qwen3:4b",
        lightModel: config.light_model,
      });

    case "anthropic":
      if (!config.api_key) {
        throw new LLMError(
          "ANTHROPIC_API_KEY is not set.\nSet it via: export ANTHROPIC_API_KEY=sk-ant-..."
        );
      }
      return new LLMClient(config.api_key, undefined, config.light_model, config.model);

    default:
      // Unknown provider falls back to OpenAI
      if (!config.api_key) {
        throw new LLMError(
          "OPENAI_API_KEY is not set.\nSet it via: export OPENAI_API_KEY=sk-..."
        );
      }
      return new OpenAILLMClient({
        apiKey: config.api_key,
        model: config.model,
        baseURL: config.base_url,
        lightModel: config.light_model,
        reasoningEffort: config.reasoning_effort,
      });
  }
}

/**
 * Build the LLM client used by direct gateway/chat surfaces.
 *
 * The provider config's adapter still controls task execution, but short
 * gateway replies should not pay the `codex exec` process startup cost when the
 * same configured OpenAI model can be reached through the configured API key.
 * This preserves the selected provider/model; it only changes the transport
 * used for gateway chat.
 */
export async function buildGatewayLLMClient(providerConfig?: ProviderConfig): Promise<ILLMClient> {
  const config = providerConfig ?? await loadProviderConfig();

  if (
    config.provider === "openai"
    && config.adapter === "openai_codex_cli"
    && config.api_key
    && !isCodexOAuthAccessToken(config.api_key)
  ) {
    return new OpenAILLMClient({
      apiKey: config.api_key,
      model: config.model,
      baseURL: config.base_url,
      reasoningEffort: config.reasoning_effort,
    });
  }

  return buildLLMClient(config);
}

/**
 * Build an AdapterRegistry pre-populated with the standard adapters.
 * Registers core execution adapters and any A2A agents configured in provider
 * config or environment variables.
 */
export async function buildAdapterRegistry(
  llmClient: ILLMClient,
  providerConfig?: ProviderConfig
): Promise<AdapterRegistry> {
  const registry = new AdapterRegistry();
  // Register CLI adapters after loading config so terminal_backend can wrap
  // their child processes without changing adapter public names.
  const config = providerConfig ?? await loadProviderConfig();
  registry.register(new ClaudeCodeCLIAdapter({ terminalBackend: config.terminal_backend }));
  registry.register(new ClaudeAPIAdapter(llmClient));
  registry.register(new ClaudeAPIAdapter(llmClient, "openai_api"));
  registry.register(new OpenAICodexCLIAdapter({
    cliPath: config.codex_cli_path,
    model: config.model,
    reasoningEffort: config.reasoning_effort,
    sandboxPolicy: resolveExecutionPolicy({
      workspaceRoot: process.cwd(),
      security: config.agent_loop?.security,
    }).sandboxMode === "danger_full_access"
      ? "danger-full-access"
      : resolveExecutionPolicy({
          workspaceRoot: process.cwd(),
          security: config.agent_loop?.security,
        }).sandboxMode.replace("_", "-"),
    terminalBackend: config.terminal_backend,
  }));
  registry.register(new NativeAgentLoopAdapter());
  registry.register(new GitHubIssueAdapter());

  // Register A2A agents from config
  if (config.a2a?.agents) {
    for (const [name, agentConfig] of Object.entries(config.a2a.agents)) {
      registry.register(new A2AAdapter({
        adapterType: name.startsWith("a2a") ? name : `a2a_${name}`,
        baseUrl: agentConfig.base_url,
        authToken: agentConfig.auth_token,
        capabilities: agentConfig.capabilities,
        preferStreaming: agentConfig.prefer_streaming,
        pollIntervalMs: agentConfig.poll_interval_ms,
        maxWaitMs: agentConfig.max_wait_ms,
      }));
    }
  }

  // Single-agent env var shortcut
  const envBaseUrl = process.env["PULSEED_A2A_BASE_URL"];
  if (envBaseUrl && !config.a2a?.agents) {
    registry.register(new A2AAdapter({
      baseUrl: envBaseUrl,
      authToken: process.env["PULSEED_A2A_AUTH_TOKEN"],
    }));
  }

  return registry;
}
