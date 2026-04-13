import * as path from "node:path";
import type { ProviderConfig } from "../../../../../base/llm/provider-config.js";
import { PROVIDERS, getAdaptersForModel } from "../../setup-shared.js";
import type { Provider } from "../../setup-shared.js";
import { SOURCE_LABELS } from "./constants.js";
import { collectRecords, firstString, nestedRecord } from "./parse.js";
import type {
  SetupImportItem,
  SetupImportProviderSettings,
  SetupImportSourceId,
} from "./types.js";

const PROVIDER_KEYS = [
  "provider",
  "llm_provider",
  "llmProvider",
  "model_provider",
  "modelProvider",
  "defaultProvider",
];

const MODEL_KEYS = ["model", "default_model", "defaultModel", "modelName"];
const ADAPTER_KEYS = ["adapter", "default_adapter", "defaultAdapter", "backend", "terminalBackend"];
const API_KEY_KEYS = ["api_key", "apiKey", "key", "token", "authToken"];
const BASE_URL_KEYS = ["base_url", "baseUrl", "baseURL", "endpoint", "api_base"];
const CLI_PATH_KEYS = ["codex_cli_path", "codexCliPath", "cli_path", "cliPath"];

function normalizeProvider(value: string | undefined): Provider | undefined {
  const normalized = value?.toLowerCase().trim();
  if (!normalized) return undefined;
  if (normalized === "codex" || normalized === "openai_codex" || normalized.includes("openai")) {
    return "openai";
  }
  if (normalized === "claude" || normalized.includes("anthropic")) {
    return "anthropic";
  }
  if (normalized.includes("ollama")) {
    return "ollama";
  }
  return PROVIDERS.includes(normalized as Provider) ? (normalized as Provider) : undefined;
}

function normalizeAdapter(
  value: string | undefined,
  provider: ProviderConfig["provider"] | undefined,
  model: string | undefined
): ProviderConfig["adapter"] | undefined {
  const normalized = value?.toLowerCase().trim();
  const knownAdapters: ProviderConfig["adapter"][] = [
    "claude_code_cli",
    "claude_api",
    "openai_codex_cli",
    "openai_api",
    "agent_loop",
  ];
  if (knownAdapters.includes(normalized as ProviderConfig["adapter"])) {
    return normalized as ProviderConfig["adapter"];
  }
  if (normalized?.includes("codex")) return "openai_codex_cli";
  if (normalized?.includes("claude") && normalized.includes("code")) return "claude_code_cli";
  if (normalized?.includes("claude") || normalized?.includes("anthropic")) return "claude_api";
  if (normalized?.includes("openai")) return "openai_api";
  if (normalized?.includes("agent")) return "agent_loop";
  if (provider && model) {
    const adapters = getAdaptersForModel(model, provider);
    return adapters[0] as ProviderConfig["adapter"] | undefined;
  }
  return undefined;
}

function providerSection(
  records: Record<string, unknown>[],
  provider: ProviderConfig["provider"] | undefined
): Record<string, unknown> | undefined {
  if (!provider) return undefined;
  for (const record of records) {
    const direct = nestedRecord(record, provider);
    if (direct) return direct;
    if (provider === "anthropic") {
      const claude = nestedRecord(record, "claude");
      if (claude) return claude;
    }
    if (provider === "openai") {
      const codex = nestedRecord(record, "codex");
      if (codex) return codex;
    }
  }
  return undefined;
}

function openclawSettings(
  records: Record<string, unknown>[],
  model: string | undefined
): ProviderConfig["openclaw"] | undefined {
  const cliPath = firstString(records, ["openclaw_cli_path", "openclawCliPath", "cli_path", "cliPath"]);
  const profile = firstString(records, ["profile", "openclawProfile"]);
  const workDir = firstString(records, ["work_dir", "workDir", "workspace", "workspacePath"]);
  if (!cliPath && !profile && !model && !workDir) return undefined;
  return {
    ...(cliPath ? { cli_path: cliPath } : {}),
    ...(profile ? { profile } : {}),
    ...(model ? { model } : {}),
    ...(workDir ? { work_dir: workDir } : {}),
  };
}

export function extractProviderSettings(
  raw: unknown,
  source: SetupImportSourceId
): SetupImportProviderSettings | undefined {
  const records = collectRecords(raw);
  if (records.length === 0) return undefined;

  const provider = normalizeProvider(firstString(records, PROVIDER_KEYS));
  const section = providerSection(records, provider);
  const searchable = section ? [section, ...records] : records;
  const model = firstString(searchable, MODEL_KEYS);
  const adapter = normalizeAdapter(firstString(searchable, ADAPTER_KEYS), provider, model);
  const apiKey = firstString(searchable, API_KEY_KEYS);
  const baseUrl = firstString(searchable, BASE_URL_KEYS);
  const codexCliPath = firstString(searchable, CLI_PATH_KEYS);
  const openclaw = source === "openclaw" ? openclawSettings(searchable, model) : undefined;

  const settings: SetupImportProviderSettings = {};
  if (provider) settings.provider = provider;
  if (model) settings.model = model;
  if (adapter) settings.adapter = adapter;
  if (apiKey) settings.apiKey = apiKey;
  if (baseUrl) settings.baseUrl = baseUrl;
  if (codexCliPath) settings.codexCliPath = codexCliPath;
  if (openclaw) settings.openclaw = openclaw;

  return Object.keys(settings).length > 0 ? settings : undefined;
}

export function buildProviderItem(
  source: SetupImportSourceId,
  configPath: string,
  settings: SetupImportProviderSettings
): SetupImportItem {
  const labelParts = [
    settings.provider,
    settings.model,
    settings.adapter,
  ].filter(Boolean);
  return {
    id: `${source}:provider:${path.basename(configPath)}`,
    source,
    sourceLabel: SOURCE_LABELS[source],
    kind: "provider",
    label: labelParts.length > 0 ? labelParts.join(" / ") : path.basename(configPath),
    sourcePath: configPath,
    decision: "import",
    reason: "provider, model, adapter, and auth defaults",
    providerSettings: settings,
  };
}
