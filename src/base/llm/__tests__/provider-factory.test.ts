import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock heavy dependencies so no real clients are constructed ───

vi.mock("../llm-client.js", () => ({
  LLMClient: vi.fn().mockImplementation(function() { return { _tag: "LLMClient" }; }),
}));

vi.mock("../ollama-client.js", () => ({
  OllamaLLMClient: vi.fn().mockImplementation(function() { return { _tag: "OllamaLLMClient" }; }),
}));

vi.mock("../openai-client.js", () => ({
  OpenAILLMClient: vi.fn().mockImplementation(function() { return { _tag: "OpenAILLMClient" }; }),
}));

vi.mock("../codex-llm-client.js", () => ({
  CodexLLMClient: vi.fn().mockImplementation(function() { return { _tag: "CodexLLMClient" }; }),
  isCodexOAuthAccessToken: vi.fn((token: string | undefined) => token === "oauth-token"),
}));

vi.mock("../../execution/adapter-layer.js", () => ({
  AdapterRegistry: vi.fn().mockImplementation(function() { return { register: vi.fn() }; }),
}));

vi.mock("../../adapters/agents/claude-code-cli.js", () => ({
  ClaudeCodeCLIAdapter: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../../adapters/agents/claude-api.js", () => ({
  ClaudeAPIAdapter: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../../adapters/agents/openai-codex.js", () => ({
  OpenAICodexCLIAdapter: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../../../adapters/agents/openai-codex.js", () => ({
  OpenAICodexCLIAdapter: vi.fn().mockImplementation(function() { return {}; }),
}));

vi.mock("../../adapters/github-issue.js", () => ({
  GitHubIssueAdapter: vi.fn().mockImplementation(function() { return {}; }),
}));

// ─── Mock provider-config so we control what each test sees ───

const mockLoadProviderConfig = vi.fn();

vi.mock("../provider-config.js", () => ({
  loadProviderConfig: () => mockLoadProviderConfig(),
}));

import { buildAdapterRegistry, buildLLMClient } from "../provider-factory.js";
import { LLMClient } from "../llm-client.js";
import { OpenAILLMClient } from "../openai-client.js";
import { CodexLLMClient } from "../codex-llm-client.js";
import { OpenAICodexCLIAdapter } from "../../../adapters/agents/openai-codex.js";

// ─── Tests ───

describe("buildLLMClient — early API key validation", () => {
  beforeEach(() => {
    mockLoadProviderConfig.mockReset();
  });

  // ── anthropic ──────────────────────────────────────────────────────────────

  describe("provider: anthropic", () => {
    it("throws when api_key is absent", async () => {
      mockLoadProviderConfig.mockResolvedValue({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        adapter: "claude_api",
      });

      await expect(buildLLMClient()).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);
    });

    it("throws with setup instructions mentioning export", async () => {
      mockLoadProviderConfig.mockResolvedValue({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        adapter: "claude_api",
      });

      await expect(buildLLMClient()).rejects.toThrow(/export ANTHROPIC_API_KEY/);
    });

    it("succeeds when api_key is present", async () => {
      mockLoadProviderConfig.mockResolvedValue({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        adapter: "claude_api",
        api_key: "sk-ant-test",
      });

      await expect(buildLLMClient()).resolves.not.toThrow();
    });

    it("passes config.model to LLMClient constructor", async () => {
      const MockedLLMClient = vi.mocked(LLMClient);
      MockedLLMClient.mockClear();

      mockLoadProviderConfig.mockResolvedValue({
        provider: "anthropic",
        model: "claude-opus-4-5",
        adapter: "claude_api",
        api_key: "sk-ant-test",
      });

      await buildLLMClient();

      expect(MockedLLMClient).toHaveBeenCalledOnce();
      // constructor: (apiKey, guardrailRunner, lightModel, model)
      expect(MockedLLMClient).toHaveBeenCalledWith("sk-ant-test", undefined, undefined, "claude-opus-4-5");
    });
  });

  // ── openai ─────────────────────────────────────────────────────────────────

  describe("provider: openai", () => {
    it("throws when api_key is absent (openai_api adapter)", async () => {
      mockLoadProviderConfig.mockResolvedValue({
        provider: "openai",
        model: "gpt-5.4-mini",
        adapter: "openai_api",
      });

      await expect(buildLLMClient()).rejects.toThrow(/OPENAI_API_KEY is not set/);
    });

    it("throws with setup instructions mentioning export", async () => {
      mockLoadProviderConfig.mockResolvedValue({
        provider: "openai",
        model: "gpt-5.4-mini",
        adapter: "openai_api",
      });

      await expect(buildLLMClient()).rejects.toThrow(/export OPENAI_API_KEY/);
    });

    it("succeeds when api_key is present (openai_api adapter)", async () => {
      mockLoadProviderConfig.mockResolvedValue({
        provider: "openai",
        model: "gpt-5.4-mini",
        adapter: "openai_api",
        api_key: "sk-test",
      });

      await expect(buildLLMClient()).resolves.not.toThrow();
    });

    it("uses OpenAILLMClient for native agent_loop", async () => {
      const MockedOpenAILLMClient = vi.mocked(OpenAILLMClient);
      MockedOpenAILLMClient.mockClear();
      mockLoadProviderConfig.mockResolvedValue({
        provider: "openai",
        model: "gpt-5.4-mini",
        adapter: "agent_loop",
        api_key: "sk-test",
      });

      await buildLLMClient();

      expect(MockedOpenAILLMClient).toHaveBeenCalledOnce();
    });

    it("passes reasoning effort to OpenAILLMClient", async () => {
      const MockedOpenAILLMClient = vi.mocked(OpenAILLMClient);
      MockedOpenAILLMClient.mockClear();
      mockLoadProviderConfig.mockResolvedValue({
        provider: "openai",
        model: "gpt-5.5",
        reasoning_effort: "low",
        adapter: "agent_loop",
        api_key: "sk-test",
      });

      await buildLLMClient();

      expect(MockedOpenAILLMClient).toHaveBeenCalledWith(expect.objectContaining({
        model: "gpt-5.5",
        reasoningEffort: "low",
      }));
    });
  });

  // ── openai with codex adapter ─────────────────────────────────────────────

  describe("provider: openai with openai_codex_cli adapter", () => {
    it("succeeds when api_key is absent (CodexLLMClient uses codex CLI auth)", async () => {
      mockLoadProviderConfig.mockResolvedValue({
        provider: "openai",
        model: "gpt-5.4-mini",
        adapter: "openai_codex_cli",
      });

      await expect(buildLLMClient()).resolves.not.toThrow();
    });

    it("passes Codex timeout and retry config through to CodexLLMClient", async () => {
      const MockedCodexLLMClient = vi.mocked(CodexLLMClient);
      MockedCodexLLMClient.mockClear();

      mockLoadProviderConfig.mockResolvedValue({
        provider: "openai",
        model: "gpt-5.4-mini",
        adapter: "openai_codex_cli",
        codex_cli_path: "/usr/local/bin/codex",
        codex_timeout_ms: 180000,
        codex_idle_timeout_ms: 30000,
        codex_retry_attempts: 4,
        reasoning_effort: "high",
      });

      await buildLLMClient();

      expect(MockedCodexLLMClient).toHaveBeenCalledOnce();
      expect(MockedCodexLLMClient).toHaveBeenCalledWith(expect.objectContaining({
        cliPath: "/usr/local/bin/codex",
        model: "gpt-5.4-mini",
        timeoutMs: 180000,
        idleTimeoutMs: 30000,
        retryAttempts: 4,
        reasoningEffort: "high",
      }));
    });

    it("does not pass OpenAI API keys as Codex OAuth tokens", async () => {
      const MockedCodexLLMClient = vi.mocked(CodexLLMClient);
      MockedCodexLLMClient.mockClear();

      mockLoadProviderConfig.mockResolvedValue({
        provider: "openai",
        model: "gpt-5.4-mini",
        adapter: "openai_codex_cli",
        api_key: "sk-test",
      });

      await expect(buildLLMClient()).resolves.not.toThrow();
      expect(MockedCodexLLMClient).toHaveBeenCalledWith(expect.objectContaining({
        apiKey: undefined,
      }));
    });

    it("passes resolved Codex OAuth tokens to CodexLLMClient", async () => {
      const MockedCodexLLMClient = vi.mocked(CodexLLMClient);
      MockedCodexLLMClient.mockClear();

      mockLoadProviderConfig.mockResolvedValue({
        provider: "openai",
        model: "gpt-5.4-mini",
        adapter: "openai_codex_cli",
        api_key: "oauth-token",
      });

      await expect(buildLLMClient()).resolves.not.toThrow();
      expect(MockedCodexLLMClient).toHaveBeenCalledWith(expect.objectContaining({
        apiKey: "oauth-token",
      }));
    });
  });

  describe("adapter registry", () => {
    it("passes reasoning effort to OpenAICodexCLIAdapter", async () => {
      const MockedOpenAICodexCLIAdapter = vi.mocked(OpenAICodexCLIAdapter);
      MockedOpenAICodexCLIAdapter.mockClear();

      await buildAdapterRegistry({} as never, {
        provider: "openai",
        model: "gpt-5.5",
        reasoning_effort: "xhigh",
        adapter: "openai_codex_cli",
      });

      expect(MockedOpenAICodexCLIAdapter).toHaveBeenCalledWith(expect.objectContaining({
        model: "gpt-5.5",
        reasoningEffort: "xhigh",
      }));
    });
  });

  // ── ollama ─────────────────────────────────────────────────────────────────

  describe("provider: ollama", () => {
    it("succeeds without any API key (ollama needs no key)", async () => {
      mockLoadProviderConfig.mockResolvedValue({
        provider: "ollama",
        model: "qwen3:4b",
        adapter: "claude_api",
      });

      await expect(buildLLMClient()).resolves.not.toThrow();
    });
  });

  // ── default fallback (unknown provider → OpenAI) ───────────────────────────

  describe("provider: default fallback", () => {
    it("throws when api_key is absent in default fallback path", async () => {
      mockLoadProviderConfig.mockResolvedValue({
        provider: "unknown-provider",
        model: "gpt-5.4-mini",
        adapter: "openai_api",
      });

      await expect(buildLLMClient()).rejects.toThrow(/OPENAI_API_KEY is not set/);
    });

    it("succeeds when api_key is present in default fallback path", async () => {
      mockLoadProviderConfig.mockResolvedValue({
        provider: "unknown-provider",
        model: "gpt-5.4-mini",
        adapter: "openai_api",
        api_key: "sk-test",
      });

      await expect(buildLLMClient()).resolves.not.toThrow();
    });
  });
});
