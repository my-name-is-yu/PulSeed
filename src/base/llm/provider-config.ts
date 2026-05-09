// ─── Provider Configuration ───
//
// Pluggable provider configuration system for PulSeed.
// Reads/writes ~/.pulseed/provider.json to configure which LLM provider
// and default adapter to use. Env vars always take precedence over config file.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { getPulseedDirPath } from "../utils/paths.js";
import { writeJsonFileAtomic } from "../utils/json-io.js";
import type { AgentLoopWorktreePolicy } from "../../orchestrator/execution/agent-loop/task-agent-loop-worktree.js";
import {
  MODEL_REGISTRY,
  defaultModelForProvider,
  isReasoningEffort,
} from "./provider-config-models.js";
import {
  parseEnvFile,
  resolveAdapter,
  resolveApiKey,
  resolveBaseUrl,
  resolveCompatibleModel,
  resolveLightModel,
  resolveModel,
  resolveProvider,
  resolveReasoningEffort,
} from "./provider-config-resolution.js";
import type {
  LegacyProviderConfig,
  LoadProviderConfigOptions,
  ProviderConfig,
  ProviderNativeAgentLoopConfig,
  ResolvedProviderNativeAgentLoopDefaults,
  ValidationResult,
} from "./provider-config-types.js";

export { MODEL_REGISTRY, isReasoningEffort } from "./provider-config-models.js";
export type {
  LoadProviderConfigOptions,
  ProviderConfig,
  ProviderNativeAgentLoopConfig,
  ResolvedProviderNativeAgentLoopDefaults,
  ValidationResult,
} from "./provider-config-types.js";

// ─── OAuth Token Helpers ───

/** Check if a JWT access token is expired. Returns true if malformed or expired. */
export function isJwtExpired(token: string): boolean {
  try {
    const parts = token.split(".");
    if (parts.length < 3) return true; // not a JWT
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (typeof payload.exp !== "number") return true;
    return payload.exp < Math.floor(Date.now() / 1000);
  } catch {
    return true; // malformed → treat as expired
  }
}

/** Read the OAuth access_token from ~/.codex/auth.json (written by `codex auth login`). */
export async function readCodexOAuthToken(): Promise<string | undefined> {
  const authPath = path.join(os.homedir(), ".codex", "auth.json");
  try {
    const raw = await fsp.readFile(authPath, "utf-8");
    const auth = JSON.parse(raw);
    const token = auth?.tokens?.access_token;
    if (typeof token !== "string" || !token) return undefined;
    if (isJwtExpired(token)) {
      console.warn("[provider-config] ~/.codex/auth.json token expired. Run `codex` to refresh.");
      return undefined;
    }
    return token;
  } catch {
    return undefined;
  }
}

// ─── Constants ───

function providerConfigPath(baseDir = getPulseedDirPath()): string {
  return path.join(baseDir, "provider.json");
}

function providerEnvPath(baseDir = getPulseedDirPath()): string {
  return path.join(baseDir, ".env");
}

const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  provider: "openai",
  model: "gpt-5.4-mini",
  adapter: "openai_codex_cli",
  agent_loop: {
    security: {
      sandbox_mode: "workspace_write",
      approval_policy: "on_request",
      network_access: false,
      trust_project_instructions: true,
    },
    worktree: {
      enabled: true,
      cleanup_policy: "on_success",
    },
  },
};

// Track whether we've already warned about provider config issues in this process
let _warnedOnce = false;

// ─── Migration ───

/**
 * Detect whether a config object is in the old nested format.
 */
function isLegacyConfig(config: Record<string, unknown>): boolean {
  return "llm_provider" in config || "default_adapter" in config;
}

/**
 * Migrate old nested format to new flat format.
 */
export function migrateProviderConfig(old: LegacyProviderConfig): ProviderConfig {
  const provider: ProviderConfig["provider"] =
    old.llm_provider === "codex" ? "openai" : (old.llm_provider ?? "openai");

  // Resolve model from the provider-specific section
  let model: string;
  switch (old.llm_provider) {
    case "codex":
      model = old.codex?.model ?? old.openai?.model ?? defaultModelForProvider(provider);
      break;
    case "openai":
      model = old.openai?.model ?? defaultModelForProvider(provider);
      break;
    case "anthropic":
      model = old.anthropic?.model ?? defaultModelForProvider(provider);
      break;
    case "ollama":
      model = old.ollama?.model ?? defaultModelForProvider(provider);
      break;
    default:
      model = defaultModelForProvider(provider);
  }

  const adapter: ProviderConfig["adapter"] = old.default_adapter ?? "openai_codex_cli";

  // Resolve api_key from the active provider section
  const api_key = old.llm_provider === "anthropic"
    ? old.anthropic?.api_key
    : (old.openai?.api_key);

  // Resolve base_url
  const base_url = old.llm_provider === "ollama"
    ? old.ollama?.base_url
    : old.openai?.base_url;

  const result: ProviderConfig = { provider, model, adapter };
  if (api_key !== undefined) result.api_key = api_key;
  if (base_url !== undefined) result.base_url = base_url;
  if (old.codex?.cli_path !== undefined) result.codex_cli_path = old.codex.cli_path;
  if (old.a2a !== undefined) result.a2a = old.a2a;

  return result;
}

/**
 * Validate provider config for model/adapter compatibility and required fields.
 * Logs warnings but does not throw — allows unknown models for flexibility.
 */
export function validateProviderConfig(config: ProviderConfig): ValidationResult {
  const errors: string[] = [];

  // Check model-adapter compatibility (skip for ollama or unknown models)
  const registryEntry = MODEL_REGISTRY[config.model];
  if (registryEntry) {
    if (registryEntry.provider !== config.provider) {
      errors.push(
        `Model "${config.model}" requires provider "${registryEntry.provider}" but got "${config.provider}"`
      );
    }
    if (!registryEntry.adapters.includes(config.adapter)) {
      errors.push(
        `Model "${config.model}" is not compatible with adapter "${config.adapter}". Compatible: ${registryEntry.adapters.join(", ")}`
      );
    }
  }

  // Check required api_key
  const requiresOpenAiApiKey =
    config.provider === "openai" && config.adapter !== "openai_codex_cli";
  const requiresAnthropicApiKey = config.provider === "anthropic";
  const requiresAdapterApiKey = config.adapter === "openai_api";
  const requiresApiKey = requiresOpenAiApiKey || requiresAnthropicApiKey || requiresAdapterApiKey;
  if (!config.api_key && requiresApiKey) {
    const envName = requiresAdapterApiKey || requiresOpenAiApiKey ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    const providerLabel = requiresAdapterApiKey ? 'adapter "openai_api"' : `provider "${config.provider}"`;
    errors.push(`API key required for ${providerLabel}. Set ${envName} or add api_key to config.`);
  }

  if (config.reasoning_effort !== undefined) {
    if (config.provider !== "openai") {
      errors.push("reasoning_effort is only supported for provider \"openai\".");
    }
    if (!isReasoningEffort(config.reasoning_effort)) {
      errors.push(`Invalid reasoning_effort "${String(config.reasoning_effort)}". Valid: none, minimal, low, medium, high, xhigh`);
    }
  }

  return { valid: errors.length === 0, errors };
}

async function readProviderEnvFile(baseDir?: string): Promise<Record<string, string>> {
  try {
    return parseEnvFile(await fsp.readFile(providerEnvPath(baseDir), "utf-8"));
  } catch {
    return {};
  }
}

async function readProviderConfigFile(baseDir?: string): Promise<Partial<ProviderConfig>> {
  const configPath = providerConfigPath(baseDir);
  try {
    await fsp.access(configPath);
    const raw = await fsp.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return isLegacyConfig(parsed)
      ? migrateProviderConfig(parsed as unknown as LegacyProviderConfig)
      : parsed as Partial<ProviderConfig>;
  } catch {
    return {};
  }
}

// ─── Public API ───

interface LoadedProviderFileConfig {
  fileConfig: Partial<ProviderConfig>;
  needsMigrationSave: boolean;
}

async function loadProviderFileConfig(configPath: string): Promise<LoadedProviderFileConfig> {
  try {
    await fsp.access(configPath);
  } catch {
    return { fileConfig: {}, needsMigrationSave: false };
  }

  try {
    const raw = await fsp.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (isLegacyConfig(parsed)) {
      return {
        fileConfig: migrateProviderConfig(parsed as unknown as LegacyProviderConfig),
        needsMigrationSave: true,
      };
    }
    return { fileConfig: parsed as Partial<ProviderConfig>, needsMigrationSave: false };
  } catch {
    return { fileConfig: {}, needsMigrationSave: false };
  }
}

async function resolveApiKeyWithFallback(
  fileKey: string | undefined,
  provider: ProviderConfig["provider"],
  adapter: ProviderConfig["adapter"],
  envFile: Record<string, string>
): Promise<string | undefined> {
  const apiKey = resolveApiKey(fileKey, provider, adapter, envFile);
  if (apiKey || provider !== "openai" || adapter !== "openai_codex_cli") {
    return apiKey;
  }
  return readCodexOAuthToken();
}

async function resolveProviderConfig(
  fileConfig: Partial<ProviderConfig>,
  envFile: Record<string, string>
): Promise<ProviderConfig> {
  const provider = resolveProvider(fileConfig.provider);
  const adapter = resolveAdapter(fileConfig.adapter);
  const model = resolveCompatibleModel(resolveModel(fileConfig.model, provider), provider, adapter);
  const apiKey = await resolveApiKeyWithFallback(fileConfig.api_key, provider, adapter, envFile);
  const baseUrl = resolveBaseUrl(fileConfig.base_url, provider, envFile);
  const lightModel = resolveLightModel(fileConfig.light_model, envFile);
  const reasoningEffort = resolveReasoningEffort(fileConfig.reasoning_effort, provider, envFile);

  const config: ProviderConfig = { provider, model, adapter };
  if (apiKey !== undefined) config.api_key = apiKey;
  if (baseUrl !== undefined) config.base_url = baseUrl;
  if (fileConfig.codex_cli_path !== undefined) config.codex_cli_path = fileConfig.codex_cli_path;
  if (fileConfig.codex_timeout_ms !== undefined) config.codex_timeout_ms = fileConfig.codex_timeout_ms;
  if (fileConfig.codex_idle_timeout_ms !== undefined) config.codex_idle_timeout_ms = fileConfig.codex_idle_timeout_ms;
  if (fileConfig.codex_retry_attempts !== undefined) config.codex_retry_attempts = fileConfig.codex_retry_attempts;
  if (fileConfig.terminal_backend !== undefined) config.terminal_backend = fileConfig.terminal_backend;
  if (fileConfig.a2a !== undefined) config.a2a = fileConfig.a2a;
  if (lightModel !== undefined) config.light_model = lightModel;
  if (reasoningEffort !== undefined) config.reasoning_effort = reasoningEffort;
  if (fileConfig.openclaw !== undefined) config.openclaw = fileConfig.openclaw;
  config.agent_loop = resolveProviderNativeAgentLoopConfigShape(fileConfig);
  return config;
}

export function resolveProviderNativeAgentLoopDefaults(
  providerConfig: Pick<ProviderConfig, "agent_loop"> | Partial<ProviderConfig> = {},
): ResolvedProviderNativeAgentLoopDefaults {
  const resolved = resolveProviderNativeAgentLoopConfigShape(providerConfig);
  return {
    security: resolved.security,
    worktreePolicy: resolveProviderNativeAgentLoopWorktreePolicy(resolved.worktree),
  };
}

export function resolveProviderNativeAgentLoopConfig(
  providerConfig: Pick<ProviderConfig, "agent_loop"> | Partial<ProviderConfig> = {},
): ProviderNativeAgentLoopConfig {
  return resolveProviderNativeAgentLoopConfigShape(providerConfig);
}

function warnOnceForInvalidProviderConfig(config: ProviderConfig): void {
  const validation = validateProviderConfig(config);
  if (validation.valid || _warnedOnce) return;
  for (const err of validation.errors) {
    console.warn(`[provider-config] Warning: ${err}`);
  }
  _warnedOnce = true;
}

function providerFileOnlyConfig(fileConfig: Partial<ProviderConfig>): ProviderConfig {
  const fileOnly: ProviderConfig = {
    provider: fileConfig.provider ?? "openai",
    model: fileConfig.model ?? "gpt-5.4-mini",
    adapter: fileConfig.adapter ?? "openai_codex_cli",
  };
  if (fileConfig.api_key !== undefined) fileOnly.api_key = fileConfig.api_key;
  if (fileConfig.base_url !== undefined) fileOnly.base_url = fileConfig.base_url;
  if (fileConfig.codex_cli_path !== undefined) fileOnly.codex_cli_path = fileConfig.codex_cli_path;
  if (fileConfig.codex_timeout_ms !== undefined) fileOnly.codex_timeout_ms = fileConfig.codex_timeout_ms;
  if (fileConfig.codex_idle_timeout_ms !== undefined) fileOnly.codex_idle_timeout_ms = fileConfig.codex_idle_timeout_ms;
  if (fileConfig.codex_retry_attempts !== undefined) fileOnly.codex_retry_attempts = fileConfig.codex_retry_attempts;
  if (fileConfig.terminal_backend !== undefined) fileOnly.terminal_backend = fileConfig.terminal_backend;
  if (fileConfig.a2a !== undefined) fileOnly.a2a = fileConfig.a2a;
  if (fileConfig.reasoning_effort !== undefined) fileOnly.reasoning_effort = fileConfig.reasoning_effort;
  if (fileConfig.agent_loop !== undefined) fileOnly.agent_loop = fileConfig.agent_loop;
  return fileOnly;
}

async function saveMigratedProviderConfig(configPath: string, fileConfig: Partial<ProviderConfig>): Promise<void> {
  try {
    await writeJsonFileAtomic(configPath, providerFileOnlyConfig(fileConfig), {
      mode: 0o600,
      directoryMode: 0o700,
    });
  } catch {
    // Best-effort — don't fail if we can't save
  }
}

/**
 * Load provider configuration.
 *
 * Priority (highest to lowest):
 *   1. Environment variables for provider/adapter selection
 *   2. ~/.pulseed/provider.json
 *   3. Defaults (openai + gpt-5.4-mini + openai_codex_cli)
 *
 * Auto-migrates old nested format to new flat format.
 */
export async function loadProviderConfig(options: LoadProviderConfigOptions = {}): Promise<ProviderConfig> {
  const envFile = await readProviderEnvFile(options.baseDir);
  const configPath = providerConfigPath(options.baseDir);
  const { fileConfig, needsMigrationSave } = await loadProviderFileConfig(configPath);
  const config = await resolveProviderConfig(fileConfig, envFile);
  warnOnceForInvalidProviderConfig(config);
  if (needsMigrationSave && options.saveMigration !== false) {
    await saveMigratedProviderConfig(configPath, fileConfig);
  }
  return config;
}

export async function loadProviderConfigFile(options: { baseDir?: string } = {}): Promise<Partial<ProviderConfig>> {
  const { fileConfig } = await loadProviderFileConfig(providerConfigPath(options.baseDir));
  return fileConfig;
}

export async function resolveOpenAIApiKey(options: { baseDir?: string } = {}): Promise<string | undefined> {
  const envFile = await readProviderEnvFile(options.baseDir);
  const envKey = process.env["OPENAI_API_KEY"] ?? envFile["OPENAI_API_KEY"];
  if (envKey) {
    return envKey;
  }

  const fileConfig = await readProviderConfigFile(options.baseDir);
  if (fileConfig.provider === "openai" || fileConfig.adapter === "openai_api") {
    return fileConfig.api_key;
  }
  return undefined;
}

export async function getProviderRuntimeFingerprint(): Promise<string> {
  const config = await loadProviderConfig();
  const fingerprintSource = {
    provider: config.provider,
    model: config.model,
    adapter: config.adapter,
    light_model: config.light_model ?? null,
    reasoning_effort: config.reasoning_effort ?? null,
    base_url: config.base_url ?? null,
    codex_cli_path: config.codex_cli_path ?? null,
    codex_timeout_ms: config.codex_timeout_ms ?? null,
    codex_idle_timeout_ms: config.codex_idle_timeout_ms ?? null,
    codex_retry_attempts: config.codex_retry_attempts ?? null,
    terminal_backend: config.terminal_backend ?? null,
    api_key_hash: config.api_key
      ? createHash("sha256").update(config.api_key).digest("hex")
      : null,
    a2a: config.a2a ?? null,
    openclaw: config.openclaw ?? null,
    agent_loop: config.agent_loop ?? null,
  };

  return JSON.stringify(fingerprintSource);
}

/**
 * Save provider configuration to ~/.pulseed/provider.json.
 * Creates the ~/.pulseed directory if it does not exist.
 */
export async function saveProviderConfig(config: ProviderConfig | Partial<ProviderConfig>, options: { baseDir?: string } = {}): Promise<void> {
  await writeJsonFileAtomic(providerConfigPath(options.baseDir), config, {
    mode: 0o600,
    directoryMode: 0o700,
  });
}

// Re-export default for tests that need it
export { DEFAULT_PROVIDER_CONFIG };

function resolveProviderNativeAgentLoopConfigShape(
  providerConfig: Pick<ProviderConfig, "agent_loop"> | Partial<ProviderConfig> = {},
): ProviderNativeAgentLoopConfig {
  const defaults = DEFAULT_PROVIDER_CONFIG.agent_loop;
  const configured = providerConfig.agent_loop;
  return {
    security: mergeAgentLoopConfig(defaults?.security, configured?.security),
    worktree: mergeAgentLoopConfig(defaults?.worktree, configured?.worktree),
  };
}

function resolveProviderNativeAgentLoopWorktreePolicy(
  worktree: ProviderNativeAgentLoopConfig["worktree"] | undefined,
): AgentLoopWorktreePolicy | undefined {
  if (!worktree) return undefined;
  return {
    enabled: worktree.enabled,
    baseDir: worktree.base_dir,
    keepForDebug: worktree.keep_for_debug,
    cleanupPolicy: worktree.cleanup_policy,
  };
}

function mergeAgentLoopConfig<T extends object>(defaults: T | undefined, configured: T | undefined): T | undefined {
  if (!defaults && !configured) return undefined;
  return {
    ...(defaults ?? {}),
    ...(configured ?? {}),
  } as T;
}
