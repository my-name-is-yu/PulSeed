import type { ProviderConfig } from "./provider-config-types.js";
import {
  MODEL_REGISTRY,
  defaultModelForProvider,
  isReasoningEffort,
} from "./provider-config-models.js";

export type ModelSource = "file" | "env" | "default";

export function resolveProvider(
  fileProvider: ProviderConfig["provider"] | undefined,
): ProviderConfig["provider"] {
  const envProvider = process.env["PULSEED_PROVIDER"] ?? process.env["PULSEED_LLM_PROVIDER"];
  if (envProvider === "anthropic" || envProvider === "openai" || envProvider === "ollama") {
    return envProvider;
  }
  // "codex" env var maps to "openai"
  if (envProvider === "codex") {
    return "openai";
  }
  return fileProvider ?? "openai";
}

export function resolveAdapter(
  fileAdapter: ProviderConfig["adapter"] | undefined,
): ProviderConfig["adapter"] {
  const envAdapter = process.env["PULSEED_ADAPTER"] ?? process.env["PULSEED_DEFAULT_ADAPTER"];
  if (
    envAdapter === "claude_code_cli" ||
    envAdapter === "claude_api" ||
    envAdapter === "openai_codex_cli" ||
    envAdapter === "openai_api" ||
    envAdapter === "agent_loop"
  ) {
    return envAdapter;
  }
  return fileAdapter ?? "openai_codex_cli";
}

export function resolveModel(
  fileModel: string | undefined,
  provider: ProviderConfig["provider"],
): { model: string; source: ModelSource } {
  if (fileModel) {
    return { model: fileModel, source: "file" };
  }

  const envModel = process.env["PULSEED_MODEL"];
  if (envModel) return { model: envModel, source: "env" };

  // Provider-specific env vars apply only as fallback when model is not set in provider.json
  if (provider === "openai") {
    const m = process.env["OPENAI_MODEL"];
    if (m) return { model: m, source: "env" };
  } else if (provider === "anthropic") {
    const m = process.env["ANTHROPIC_MODEL"];
    if (m) return { model: m, source: "env" };
  } else if (provider === "ollama") {
    const m = process.env["OLLAMA_MODEL"];
    if (m) return { model: m, source: "env" };
  }

  return { model: defaultModelForProvider(provider), source: "default" };
}

export function resolveApiKey(
  fileKey: string | undefined,
  provider: ProviderConfig["provider"],
  adapter: ProviderConfig["adapter"],
  envFile: Record<string, string>,
): string | undefined {
  if (adapter === "openai_api") {
    return process.env["OPENAI_API_KEY"] ?? envFile["OPENAI_API_KEY"] ?? fileKey;
  }
  if (provider === "anthropic") {
    return process.env["ANTHROPIC_API_KEY"] ?? envFile["ANTHROPIC_API_KEY"] ?? fileKey;
  }
  // openai (and codex) both use OPENAI_API_KEY
  if (provider === "openai") {
    return process.env["OPENAI_API_KEY"] ?? envFile["OPENAI_API_KEY"] ?? fileKey;
  }
  return fileKey;
}

export function resolveBaseUrl(
  fileUrl: string | undefined,
  provider: ProviderConfig["provider"],
  envFile: Record<string, string>,
): string | undefined {
  if (provider === "ollama") {
    return process.env["OLLAMA_BASE_URL"] ?? envFile["OLLAMA_BASE_URL"] ?? fileUrl;
  }
  if (provider === "openai") {
    return process.env["OPENAI_BASE_URL"] ?? envFile["OPENAI_BASE_URL"] ?? fileUrl;
  }
  return fileUrl;
}

export function resolveLightModel(
  fileLightModel: string | undefined,
  envFile: Record<string, string>,
): string | undefined {
  return process.env["PULSEED_LIGHT_MODEL"] ?? envFile["PULSEED_LIGHT_MODEL"] ?? fileLightModel;
}

export function resolveReasoningEffort(
  fileReasoningEffort: ProviderConfig["reasoning_effort"] | undefined,
  provider: ProviderConfig["provider"],
  envFile: Record<string, string>,
): ProviderConfig["reasoning_effort"] | undefined {
  if (provider !== "openai") return undefined;
  const envValue = process.env["PULSEED_REASONING_EFFORT"]
    ?? process.env["OPENAI_REASONING_EFFORT"]
    ?? envFile["PULSEED_REASONING_EFFORT"]
    ?? envFile["OPENAI_REASONING_EFFORT"];
  if (isReasoningEffort(envValue)) return envValue;
  if (envValue) {
    console.warn(`[provider-config] Ignoring invalid reasoning effort "${envValue}".`);
  }
  return isReasoningEffort(fileReasoningEffort) ? fileReasoningEffort : undefined;
}

export function parseEnvFile(raw: string): Record<string, string> {
  const entries = raw
    .split(/\r?\n/)
    .flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return [];
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
      if (!match) return [];
      const value = match[2]!.trim().replace(/^['"]|['"]$/g, "");
      return [[match[1]!, value] as const];
    });
  return Object.fromEntries(entries);
}

export function resolveCompatibleModel(
  resolvedModel: { model: string; source: ModelSource },
  provider: ProviderConfig["provider"],
  adapter: ProviderConfig["adapter"],
): string {
  const registryEntry = MODEL_REGISTRY[resolvedModel.model];
  if (!registryEntry || registryEntry.adapters.includes(adapter)) {
    return resolvedModel.model;
  }

  if (resolvedModel.source === "file") {
    console.warn(
      `[provider-config] Model "${resolvedModel.model}" is not compatible with adapter "${adapter}". Keeping provider.json model and relying on validation to surface the mismatch.`,
    );
    return resolvedModel.model;
  }

  const fallback = defaultModelForProvider(provider);
  console.warn(
    `[provider-config] Model "${resolvedModel.model}" is not compatible with adapter "${adapter}". Falling back to "${fallback}".`,
  );
  return fallback;
}
