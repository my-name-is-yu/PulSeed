import type { ProviderConfig } from "./provider-config-types.js";

/**
 * Known models and their compatible providers/adapters.
 * Ollama models are dynamic and not listed here.
 */
export const MODEL_REGISTRY: Record<string, { provider: string; adapters: string[] }> = {
  "gpt-5.5": { provider: "openai", adapters: ["openai_codex_cli", "openai_api", "agent_loop"] },
  "gpt-5.4": { provider: "openai", adapters: ["openai_codex_cli", "openai_api", "agent_loop"] },
  "gpt-5.2-codex": { provider: "openai", adapters: ["openai_codex_cli", "openai_api", "agent_loop"] },
  "gpt-5.1-codex-max": { provider: "openai", adapters: ["openai_codex_cli", "openai_api", "agent_loop"] },
  "gpt-5.4-mini": { provider: "openai", adapters: ["openai_codex_cli", "openai_api", "agent_loop"] },
  "gpt-5.3-codex": { provider: "openai", adapters: ["openai_codex_cli", "openai_api", "agent_loop"] },
  "gpt-5.3-codex-spark": { provider: "openai", adapters: ["openai_codex_cli", "openai_api", "agent_loop"] },
  "gpt-5.2": { provider: "openai", adapters: ["openai_codex_cli", "openai_api", "agent_loop"] },
  "gpt-5.1-codex-mini": { provider: "openai", adapters: ["openai_codex_cli", "openai_api", "agent_loop"] },
  "gpt-4.1": { provider: "openai", adapters: ["openai_codex_cli", "openai_api", "agent_loop"] },
  "gpt-4o-mini": { provider: "openai", adapters: ["openai_api", "agent_loop"] },
  "o3-mini": { provider: "openai", adapters: ["openai_api", "agent_loop"] },
  "claude-sonnet-4-6": { provider: "anthropic", adapters: ["claude_code_cli", "claude_api", "agent_loop"] },
  "claude-haiku-4-5": { provider: "anthropic", adapters: ["claude_code_cli", "claude_api", "agent_loop"] },
};

/** Default model for a given provider. Single source of truth. */
export function defaultModelForProvider(provider: ProviderConfig["provider"]): string {
  switch (provider) {
    case "anthropic": return "claude-sonnet-4-6";
    case "ollama": return "qwen3:4b";
    default: return "gpt-5.4-mini";
  }
}

export function isReasoningEffort(value: unknown): value is NonNullable<ProviderConfig["reasoning_effort"]> {
  return value === "none"
    || value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh";
}
