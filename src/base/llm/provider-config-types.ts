import type { AgentLoopSecurityConfig } from "../../orchestrator/execution/agent-loop/execution-policy.js";
import type { AgentLoopWorktreePolicy } from "../../orchestrator/execution/agent-loop/task-agent-loop-worktree.js";

export interface ProviderConfig {
  /** Which provider to use for internal LLM calls */
  provider: "openai" | "anthropic" | "ollama";

  /** Which model to use */
  model: string;

  /** Optional lighter model for routine tasks (observation, verification, reflection).
   *  When not set, all calls use `model`. */
  light_model?: string;

  /** Optional OpenAI reasoning effort for supported reasoning models. */
  reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

  /** Which adapter to use by default for task execution */
  adapter: "claude_code_cli" | "claude_api" | "openai_codex_cli" | "openai_api" | "agent_loop";

  /** API key (for openai or anthropic) */
  api_key?: string;

  /** Base URL (for ollama or custom endpoints) */
  base_url?: string;

  /** CLI path for openai_codex_cli adapter */
  codex_cli_path?: string;

  /** Total Codex request timeout in milliseconds. */
  codex_timeout_ms?: number;

  /** Codex idle timeout in milliseconds. Disabled when omitted. */
  codex_idle_timeout_ms?: number;

  /** Maximum Codex retry attempts. */
  codex_retry_attempts?: number;

  /** Optional terminal backend for CLI execution adapters. */
  terminal_backend?: {
    type: "local" | "docker";
    docker?: {
      image: string;
      workdir?: string;
      network?: "none" | "host" | "bridge";
      env?: Record<string, string>;
      volumes?: string[];
    };
  };

  /** A2A protocol agent endpoints */
  a2a?: {
    agents?: Record<string, {
      base_url: string;
      auth_token?: string;
      capabilities?: string[];
      prefer_streaming?: boolean;
      poll_interval_ms?: number;
      max_wait_ms?: number;
    }>;
  };

  /** Optional local-only OpenClaw ACP adapter configuration */
  openclaw?: {
    cli_path?: string;
    profile?: string;
    model?: string;
    work_dir?: string;
  };

  /** Native agentloop runtime settings */
  agent_loop?: {
    security?: AgentLoopSecurityConfig;
    worktree?: {
      enabled?: boolean;
      base_dir?: string;
      keep_for_debug?: boolean;
      cleanup_policy?: "on_success" | "always" | "never";
    };
  };
}

export type ProviderNativeAgentLoopConfig = NonNullable<ProviderConfig["agent_loop"]>;

export interface ResolvedProviderNativeAgentLoopDefaults {
  security?: AgentLoopSecurityConfig;
  worktreePolicy?: AgentLoopWorktreePolicy;
}

/** Old nested provider config format (for migration) */
export interface LegacyProviderConfig {
  llm_provider: "anthropic" | "openai" | "ollama" | "codex";
  default_adapter: "claude_code_cli" | "claude_api" | "openai_codex_cli" | "openai_api" | "agent_loop";
  anthropic?: { api_key?: string; model?: string };
  openai?: { api_key?: string; model?: string; base_url?: string };
  ollama?: { base_url?: string; model?: string };
  codex?: { cli_path?: string; model?: string };
  a2a?: ProviderConfig["a2a"];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface LoadProviderConfigOptions {
  baseDir?: string;
  saveMigration?: boolean;
}
