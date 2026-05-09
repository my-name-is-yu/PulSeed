import * as p from "@clack/prompts";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { getPulseedDirPath } from "../../../base/utils/paths.js";
import {
  loadProviderConfig,
  saveProviderConfig,
  validateProviderConfig,
} from "../../../base/llm/provider-config.js";
import { buildLLMClient } from "../../../base/llm/provider-factory.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import type { ProviderConfig } from "../../../base/llm/provider-config.js";
import { clearIdentityCache } from "../../../base/config/identity-loader.js";
import { seedRelationshipProfileFromSetup } from "../../../platform/profile/relationship-profile.js";
import { createRelationshipProfileProposalsFromUserMdImport } from "../../../platform/profile/user-md-profile-import.js";
import { updateGlobalConfig } from "../../../base/config/global-config.js";
import { readCodexOAuthToken } from "../../../base/llm/provider-config.js";
import { isDaemonRunning } from "../../../runtime/daemon/client.js";
import { StateManager } from "../../../base/state/state-manager.js";
import { ROOT_PRESETS } from "./presets/root-presets.js";
import { MODEL_REGISTRY, REASONING_EFFORTS, detectApiKeys, getAdaptersForModel, maskKey } from "./setup-shared.js";
import type { Provider } from "./setup-shared.js";
import { getBanner, stepExistingConfig, stepUserName, stepSeedyName } from "./setup/steps-identity.js";
import { stepRootPreset, stepProvider, stepModel, stepApiKey, runCodexOAuthLogin, stepOpenAIAuthMethod } from "./setup/steps-provider.js";
import { stepNotification } from "./setup/steps-notification.js";
import {
  formatGatewaySetupSummary,
  saveGatewayChannels,
  stepGatewayChannels,
  type GatewaySetupResult,
} from "./setup/steps-gateway.js";
import { stepDaemon, ensurePulseedDir, writeSeedMd, writeRootMd, writeUserMd } from "./setup/steps-runtime.js";
import { guardCancel } from "./setup/utils.js";
import { applySetupImportSelection } from "./setup/import/apply.js";
import { providerConfigPatchFromImport, stepSetupImport } from "./setup/import/flow.js";
import type { SetupImportSelection } from "./setup/import/types.js";
import { collectOperatorBindingStatus } from "./operator-binding-status.js";
import {
  buildResidentReadinessReport,
  printResidentReadinessReport,
} from "./setup/resident-readiness.js";
export { buildResidentReadinessReport } from "./setup/resident-readiness.js";

type SetupAnswers = {
  userName: string;
  agentName: string;
  rootPreset: keyof typeof ROOT_PRESETS;
  importedUserContent?: string;
  provider: Provider;
  model: string;
  reasoningEffort?: ProviderConfig["reasoning_effort"];
  adapter: string;
  apiKey?: string;
  startDaemon: boolean;
  daemonPort: number;
  notificationConfig: Awaited<ReturnType<typeof stepNotification>>;
  gatewaySetup: GatewaySetupResult | null;
};

type IdentityAnswers = Pick<SetupAnswers, "userName" | "agentName" | "rootPreset">;
type ExecutionAnswers = Pick<SetupAnswers, "provider" | "model" | "reasoningEffort" | "adapter" | "apiKey">;
type RuntimeAnswers = Pick<SetupAnswers, "startDaemon" | "daemonPort" | "notificationConfig" | "gatewaySetup">;
type FullSetupSection = "identity" | "execution" | "runtime" | "review";
type IdentityConfigOptions = {
  skipRootPreset?: boolean;
  skipUserName?: boolean;
};

function formatSummary(answers: SetupAnswers): string {
  const notificationChannels = answers.notificationConfig
    ? answers.notificationConfig.channels.length === 0
      ? "console only"
      : answers.notificationConfig.channels.map((channel) => channel.type).join(", ")
    : "no";

  return [
    `User:      ${answers.importedUserContent ? "imported USER.md" : answers.userName}`,
    `Agent:     ${answers.agentName}`,
    `Style:     ${ROOT_PRESETS[answers.rootPreset].name}`,
    `Provider:  ${answers.provider}`,
    `Model:     ${answers.model}`,
    ...(answers.reasoningEffort ? [`Reasoning: ${answers.reasoningEffort}`] : []),
    formatAuthSummary(answers),
    formatCredentialSummary(answers),
    `Daemon:    ${answers.startDaemon ? `configured (port ${answers.daemonPort})` : "not configured"}`,
    `Gateway:   ${formatGatewaySetupSummary(answers.gatewaySetup)}`,
    `Notify:    ${notificationChannels}`,
  ].join("\n");
}

function formatExecutionSummary(
  execution: Pick<SetupAnswers, "provider" | "model" | "reasoningEffort" | "adapter" | "apiKey">
): string {
  return [
    `Provider:  ${execution.provider}`,
    `Model:     ${execution.model}`,
    ...(execution.reasoningEffort ? [`Reasoning: ${execution.reasoningEffort}`] : []),
    formatAuthSummary(execution),
    formatCredentialSummary(execution),
  ].join("\n");
}

function formatAuthSummary(execution: Pick<SetupAnswers, "provider" | "adapter">): string {
  if (execution.provider === "openai") {
    return `Auth:      ${execution.adapter === "openai_codex_cli" ? "Codex OAuth" : "OpenAI API key"}`;
  }
  if (execution.provider === "anthropic") {
    return "Auth:      Anthropic API key";
  }
  return "Auth:      local Ollama";
}

function formatCredentialSummary(execution: Pick<SetupAnswers, "provider" | "adapter" | "apiKey">): string {
  if (execution.provider === "openai" && execution.adapter === "openai_codex_cli") {
    return "Credential: Codex OAuth login";
  }
  if (execution.provider === "ollama") {
    return "Credential: local runtime";
  }
  return `API Key:   ${maskKey(execution.apiKey)}`;
}

function formatImportSetupSummary(
  selection: SetupImportSelection,
  providerPatch: Partial<ProviderConfig> | undefined
): string {
  const sourceNames = selection.sources.map((source) => source.label).join(", ");
  if (!providerPatch?.provider) {
    return [
      `Source:    ${sourceNames}`,
      "Provider:  not found",
      `User:      ${selection.userSettings ? "imported USER.md" : "PulSeed will ask"}`,
      "Style:     Default",
      "Next:      PulSeed will ask for provider settings.",
    ].join("\n");
  }

  const apiKeyStatus =
    providerPatch.api_key
      ? "found in imported settings"
      : providerPatch.provider === "ollama" || providerPatch.adapter === "openai_codex_cli"
        ? "not required for this auth method"
        : "not found";

  return [
    `Source:    ${sourceNames}`,
    `Provider:  ${providerPatch.provider}`,
    `Model:     ${providerPatch.model ?? "not found"}`,
    ...(providerPatch.reasoning_effort ? [`Reasoning: ${providerPatch.reasoning_effort}`] : []),
    formatAuthSummary({
      provider: providerPatch.provider,
      adapter: providerPatch.adapter ?? "agent_loop",
    }),
    `API Key:   ${apiKeyStatus}`,
    `User:      ${selection.userSettings ? "imported USER.md" : "PulSeed will ask"}`,
    "Style:     Default",
  ].join("\n");
}

function buildProviderConfig(
  execution: Pick<SetupAnswers, "provider" | "model" | "reasoningEffort" | "adapter" | "apiKey">,
  base?: Partial<ProviderConfig>
): ProviderConfig {
  const config: ProviderConfig = {
    ...(base ?? {}),
    provider: execution.provider,
    model: execution.model,
    adapter: execution.adapter as ProviderConfig["adapter"],
  };
  if (execution.provider === "openai" && execution.reasoningEffort) {
    config.reasoning_effort = execution.reasoningEffort;
  } else {
    delete config.reasoning_effort;
  }

  if (execution.apiKey) {
    config.api_key = execution.apiKey;
  } else {
    delete config.api_key;
  }

  if (base?.provider && base.provider !== execution.provider) {
    delete config.base_url;
    delete config.openclaw;
  }

  return config;
}

function canUseImportedModel(provider: Provider, model: string | undefined): model is string {
  if (!model) return false;
  const registryEntry = MODEL_REGISTRY[model];
  return !registryEntry || registryEntry.provider === provider;
}

function isLikelyCodexOAuthToken(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  return trimmed.startsWith("eyJ") && trimmed.split(".").length >= 3;
}

function canUseImportedApiKey(provider: Provider, adapter: string, apiKey: string | undefined): apiKey is string {
  if (!apiKey) return false;
  return !(provider === "openai" && adapter !== "openai_codex_cli" && isLikelyCodexOAuthToken(apiKey));
}

async function importedExecutionIsComplete(
  execution: Pick<SetupAnswers, "provider" | "model" | "adapter" | "apiKey">,
  base?: Partial<ProviderConfig>
): Promise<boolean> {
  if (!execution.provider || !execution.model || !execution.adapter) return false;
  if (!canUseImportedModel(execution.provider, execution.model)) return false;
  if (!getAdaptersForModel(execution.model, execution.provider).includes(execution.adapter)) return false;
  if (execution.provider === "openai" && execution.adapter === "openai_codex_cli") {
    const token = await readCodexOAuthToken();
    if (!token) return false;
  }
  if (execution.provider === "openai" && execution.adapter !== "openai_codex_cli") {
    if (!execution.apiKey) return false;
    if (!canUseImportedApiKey(execution.provider, execution.adapter, execution.apiKey)) return false;
  }
  return validateProviderConfig(buildProviderConfig(execution, base)).valid;
}

async function stepMissingOpenAiAuth(
  model: string,
  adapter: string,
  adaptersForModel: string[],
  importedApiKey: string | undefined
): Promise<{ adapter: string; apiKey?: string }> {
  const details = [
    "OpenAI API key was not found in the imported settings.",
    "PulSeed needs an OpenAI API key unless you use Codex CLI OAuth.",
  ];
  if (importedApiKey && isLikelyCodexOAuthToken(importedApiKey)) {
    details.push("The imported auth value looks like a Codex OAuth token, not an OpenAI API key.");
  }
  p.note(details.join("\n"), "OpenAI authentication needed");

  const canUseCodexCli = adaptersForModel.includes("openai_codex_cli");
  const authChoice = guardCancel(
    await p.select({
      message: "How should PulSeed handle OpenAI authentication?",
      options: [
        { value: "enter" as const, label: "Enter OpenAI API key" },
        ...(canUseCodexCli
          ? [
              {
                value: "oauth" as const,
                label: "Use Codex CLI OAuth instead",
                hint: `use Codex CLI authentication for ${model}`,
              },
              {
                value: "skip" as const,
                label: "Skip for now",
                hint: "use OpenAI Codex CLI and run codex login later",
              },
            ]
          : []),
      ],
      initialValue: "enter" as const,
    })
  );

  if (authChoice === "oauth") {
    const token = await runCodexOAuthLogin();
    if (token) return { adapter: "openai_codex_cli" };

    p.log.warn("Codex OAuth login did not produce a usable token.");
    const fallback = guardCancel(
      await p.select({
        message: "Codex CLI authentication is not ready. How should setup continue?",
        options: [
          { value: "enter" as const, label: "Enter OpenAI API key instead" },
          {
            value: "skip" as const,
            label: "Skip for now",
            hint: "use OpenAI Codex CLI and run codex login later",
          },
        ],
        initialValue: "enter" as const,
      })
    );
    if (fallback === "skip") {
      p.log.warn("Skipping Codex OAuth login. Run `codex login` before using OpenAI Codex CLI.");
      return { adapter: "openai_codex_cli" };
    }
    const apiKey = await stepApiKey("openai", detectApiKeys(), undefined, adapter);
    return { adapter, apiKey };
  }
  if (authChoice === "skip") {
    p.log.warn("Skipping OpenAI API key. PulSeed will use OpenAI Codex CLI; run `codex login` before using it.");
    return { adapter: "openai_codex_cli" };
  }

  const apiKey = await stepApiKey("openai", detectApiKeys(), undefined, adapter);
  return { adapter, apiKey };
}

function defaultExecutionAdapter(provider: Provider, model: string): string {
  const adapters = getAdaptersForModel(model, provider);
  if (adapters.includes("agent_loop")) return "agent_loop";
  return adapters[0] ?? "";
}

async function stepReasoningEffort(
  provider: Provider,
  model: string,
  initialReasoningEffort?: ProviderConfig["reasoning_effort"]
): Promise<ProviderConfig["reasoning_effort"] | undefined> {
  if (provider !== "openai") return undefined;
  if (!initialReasoningEffort && model !== "gpt-5.5") return undefined;
  const choice = guardCancel(
    await p.select({
      message: "Select OpenAI reasoning effort:",
      options: [
        { value: "__unset__" as const, label: "Default", hint: "use provider/model default" },
        ...REASONING_EFFORTS.map((effort) => ({
          value: effort,
          label: effort,
        })),
      ],
      initialValue: initialReasoningEffort ?? "__unset__",
    })
  );
  return choice === "__unset__" ? undefined : choice as ProviderConfig["reasoning_effort"];
}

async function stepExecutionConfig(
  current?: ExecutionAnswers,
  mode: "interactive" | "imported" = "interactive"
): Promise<ExecutionAnswers> {
  const provider = mode === "imported" && current?.provider ? current.provider : await stepProvider(current?.provider);
  const importedModel = mode === "imported" && canUseImportedModel(provider, current?.model);
  const model =
    importedModel
      ? current.model
      : await stepModel(
          provider,
          mode === "interactive" && current?.provider === provider ? current.model : undefined
        );
  const reasoningEffort = mode === "imported"
    ? current?.reasoningEffort
    : await stepReasoningEffort(
        provider,
        model,
        current?.provider === provider ? current.reasoningEffort : undefined
      );
  const adaptersForModel = getAdaptersForModel(model, provider);
  const compatibleCurrentAdapter =
    current?.adapter && adaptersForModel.includes(current.adapter)
      ? current.adapter
      : undefined;
  let adapter = compatibleCurrentAdapter ?? defaultExecutionAdapter(provider, model);
  if (!adapter) return { provider, model, reasoningEffort, adapter, apiKey: current?.apiKey };

  if (
    provider === "openai" &&
    !(mode === "imported" && compatibleCurrentAdapter)
  ) {
    const authMethod = await stepOpenAIAuthMethod(
      compatibleCurrentAdapter === "openai_codex_cli" ? "codex_oauth" : "api_key",
      { canUseCodexOAuth: adaptersForModel.includes("openai_codex_cli") }
    );
    adapter =
      authMethod === "codex_oauth"
        ? "openai_codex_cli"
        : compatibleCurrentAdapter && compatibleCurrentAdapter !== "openai_codex_cli"
          ? compatibleCurrentAdapter
          : defaultExecutionAdapter(provider, model);
  }

  const detectedKeys = detectApiKeys();
  const openAiEnvKey = process.env["OPENAI_API_KEY"];
  const hasUsableOpenAiEnvKey = Boolean(openAiEnvKey) && !isLikelyCodexOAuthToken(openAiEnvKey);
  const validImportedApiKey =
    mode === "imported" &&
    adapter !== "openai_codex_cli" &&
    canUseImportedApiKey(provider, adapter, current?.apiKey);
  if (
    mode === "imported" &&
    provider === "openai" &&
    adapter !== "openai_codex_cli" &&
    !hasUsableOpenAiEnvKey &&
    !validImportedApiKey
  ) {
    const auth = await stepMissingOpenAiAuth(model, adapter, adaptersForModel, current?.apiKey);
    return { provider, model, reasoningEffort, adapter: auth.adapter, apiKey: auth.apiKey };
  }

  const apiKey =
    validImportedApiKey
      ? current.apiKey
      : current?.provider === provider
        ? await stepApiKey(provider, detectedKeys, current.apiKey, adapter)
        : await stepApiKey(provider, detectedKeys, undefined, adapter);
  return { provider, model, reasoningEffort, adapter, apiKey };
}

async function stepIdentityConfig(
  current?: Partial<IdentityAnswers>,
  options: IdentityConfigOptions = {}
): Promise<IdentityAnswers> {
  return {
    userName: options.skipUserName
      ? (current?.userName ?? "Imported USER.md")
      : await stepUserName(current?.userName),
    agentName: await stepSeedyName(current?.agentName),
    rootPreset: options.skipRootPreset
      ? current?.rootPreset ?? "default"
      : await stepRootPreset(current?.rootPreset),
  };
}

async function stepRuntimeConfig(): Promise<RuntimeAnswers> {
  const daemonConfig = await stepDaemon();
  const gatewaySetup = await stepGatewayChannels(getPulseedDirPath());
  return {
    startDaemon: daemonConfig.start,
    daemonPort: daemonConfig.port,
    gatewaySetup,
    notificationConfig: await stepNotification(),
  };
}

async function stepSectionNavigation(
  message: string,
  backLabel?: string
): Promise<"continue" | "back" | "edit" | "cancel"> {
  const options: p.Option<"continue" | "back" | "edit" | "cancel">[] = [
    { value: "continue", label: "Continue" },
    { value: "edit", label: "Edit this section" },
  ];

  if (backLabel) {
    options.push({ value: "back", label: backLabel });
  }
  options.push({ value: "cancel", label: "Cancel setup" });

  return guardCancel(
    await p.select({
      message,
      options,
      initialValue: "continue" as const,
    })
  );
}

async function validateAndSaveProviderConfig(config: ProviderConfig): Promise<number | undefined> {
  const validation = validateProviderConfig(config);
  if (!validation.valid) {
    for (const err of validation.errors) {
      p.log.error(err);
    }
    return 1;
  }

  const fileConfig: ProviderConfig = { ...config };
  const apiKey = fileConfig.api_key;
  delete fileConfig.api_key;
  await saveProviderConfig(fileConfig);
  if (apiKey) {
    saveProviderApiKeyToEnv(config.provider, apiKey);
  }
  return undefined;
}

function saveProviderApiKeyToEnv(provider: ProviderConfig["provider"], apiKey: string): void {
  const envKey = provider === "openai"
    ? "OPENAI_API_KEY"
    : provider === "anthropic"
      ? "ANTHROPIC_API_KEY"
      : undefined;
  if (!envKey) return;

  const dir = ensurePulseedDir();
  chmodSyncBestEffort(dir, 0o700);
  const envPath = path.join(dir, ".env");
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
  } catch {
    lines = [];
  }

  const replacement = `${envKey}=${apiKey}`;
  let replaced = false;
  lines = lines.map((line) => {
    if (line.startsWith(`${envKey}=`)) {
      replaced = true;
      return replacement;
    }
    return line;
  }).filter((line, index, all) => line || index < all.length - 1);
  if (!replaced) lines.push(replacement);
  fs.writeFileSync(envPath, `${lines.join("\n")}\n`, { encoding: "utf-8", mode: 0o600 });
  chmodSyncBestEffort(envPath, 0o600);
}

function chmodSyncBestEffort(targetPath: string, mode: number): void {
  try {
    const chmodSync = Reflect.get(fs, "chmodSync") as unknown;
    if (typeof chmodSync !== "function") return;
    chmodSync(targetPath, mode);
  } catch {
    // Best-effort hardening; setup should not fail solely because chmod is unavailable.
  }
}

async function startDaemonDetached(baseDir: string): Promise<number | undefined> {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error("Could not determine CLI entrypoint for daemon start.");
  }

  const child = spawn(process.execPath, [scriptPath, "daemon", "start", "--detach"], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PULSEED_HOME: baseDir,
    },
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  child.unref();
  return child.pid;
}

async function waitForDaemonReady(
  baseDir: string,
  expectedPort: number,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { running, port } = await isDaemonRunning(baseDir);
    if (running && port === expectedPort) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Daemon did not respond on port ${expectedPort} within ${timeoutMs}ms.`);
}

async function startDaemonAfterSetup(baseDir: string, port: number): Promise<void> {
  p.log.info(`Starting daemon and gateway on port ${port}...`);
  const pid = await startDaemonDetached(baseDir);
  await waitForDaemonReady(baseDir, port);
  p.log.success(`Daemon and gateway started${pid ? ` (PID: ${pid})` : ""} on port ${port}.`);
}

export async function runSetupWizard(): Promise<number> {
  console.log(getBanner());
  p.intro("PulSeed Setup");

  const accepted = guardCancel(
    await p.confirm({
      message:
        "PulSeed is experimental software. It autonomously orchestrates AI agents " +
        "that may incur API costs, modify files, and execute commands. " +
        "Do you accept the risks and wish to continue?",
      initialValue: true,
    })
  );
  if (!accepted) {
    p.cancel("Setup cancelled.");
    return 0;
  }

  const importSelection = await stepSetupImport();
  const importedProviderPatch = providerConfigPatchFromImport(importSelection?.providerSettings);
  let executionMode: "interactive" | "imported" = importedProviderPatch?.provider ? "imported" : "interactive";
  if (importSelection) {
    p.note(formatImportSetupSummary(importSelection, importedProviderPatch), "Imported setup defaults");
  }

  if (!importSelection) {
    const existingChoice = await stepExistingConfig();
    if (existingChoice === "keep") {
      p.outro("Keeping existing configuration.");
      return 0;
    }

    if (existingChoice === "modify") {
      const existingConfig = await loadProviderConfig();
      let execution = await stepExecutionConfig({
        provider: existingConfig.provider,
        model: existingConfig.model,
        reasoningEffort: existingConfig.reasoning_effort,
        adapter: existingConfig.adapter,
        apiKey: existingConfig.api_key,
      });
      if (!execution.adapter) return 1;

      for (;;) {
        p.note(formatExecutionSummary(execution), "Review provider settings");

        const action = guardCancel(
          await p.select({
            message: "Save these provider settings?",
            options: [
              { value: "save" as const, label: "Save provider settings" },
              { value: "edit" as const, label: "Edit provider, model, auth" },
              { value: "cancel" as const, label: "Cancel setup" },
            ],
            initialValue: "save" as const,
          })
        );

        if (action === "save") break;
        if (action === "cancel") {
          p.cancel("Setup cancelled.");
          return 0;
        }
        execution = await stepExecutionConfig(execution, "interactive");
        if (!execution.adapter) return 1;
      }

      const saveResult = await validateAndSaveProviderConfig(buildProviderConfig(execution, existingConfig));
      if (saveResult !== undefined) return saveResult;
      p.outro("Provider settings updated.");
      return 0;
    }
  }

  const answers: SetupAnswers = {
    userName: importSelection?.userSettings ? "Imported USER.md" : "",
    agentName: "Seedy",
    rootPreset: "default",
    importedUserContent: importSelection?.userSettings?.content,
    provider: importedProviderPatch?.provider ?? "openai",
    model: importedProviderPatch?.model ?? "",
    reasoningEffort: importedProviderPatch?.reasoning_effort,
    adapter: importedProviderPatch?.adapter ?? "",
    apiKey: importedProviderPatch?.api_key,
    startDaemon: false,
    daemonPort: 0,
    notificationConfig: null,
    gatewaySetup: null,
  };
  const skipImportedExecution =
    Boolean(importSelection) && (await importedExecutionIsComplete(answers, importedProviderPatch));
  let section: FullSetupSection = "identity";
  let finalAnswers: SetupAnswers | undefined;

  while (!finalAnswers) {
    if (section === "identity") {
      Object.assign(
        answers,
        await stepIdentityConfig(answers.userName ? answers : undefined, {
          skipRootPreset: Boolean(importSelection),
          skipUserName: Boolean(importSelection?.userSettings),
        })
      );
      const next = await stepSectionNavigation("Identity settings complete.");
      if (next === "cancel") {
        p.cancel("Setup cancelled.");
        return 0;
      }
      if (next === "continue") {
        if (skipImportedExecution) {
          p.note("Provider settings were imported completely and applied as defaults.", "Imported setup defaults");
          executionMode = "interactive";
          section = "runtime";
        } else {
          section = "execution";
        }
      }
      continue;
    }

    if (section === "execution") {
      Object.assign(answers, await stepExecutionConfig(answers, executionMode));
      executionMode = "interactive";
      if (!answers.adapter) return 1;
      const next = await stepSectionNavigation(
        "Provider settings complete.",
        "Back to identity settings"
      );
      if (next === "cancel") {
        p.cancel("Setup cancelled.");
        return 0;
      }
      if (next === "back") {
        section = "identity";
      } else if (next === "continue") {
        section = "runtime";
      }
      continue;
    }

    if (section === "runtime") {
      Object.assign(answers, await stepRuntimeConfig());
      const next = await stepSectionNavigation(
        "Daemon and notification settings complete.",
        "Back to provider settings"
      );
      if (next === "cancel") {
        p.cancel("Setup cancelled.");
        return 0;
      }
      if (next === "back") {
        section = "execution";
      } else if (next === "continue") {
        section = "review";
      }
      continue;
    }

    if (section === "review") {
      p.note(formatSummary(answers), "Review configuration");

      const action = guardCancel(
        await p.select({
          message: "Save this configuration?",
          options: [
            { value: "save" as const, label: "Save configuration", hint: "write files and finish" },
            { value: "edit-execution" as const, label: "Edit provider, model, auth" },
            { value: "edit-identity" as const, label: "Edit user, agent, style" },
            { value: "edit-runtime" as const, label: "Edit daemon and notifications" },
            { value: "cancel" as const, label: "Cancel setup" },
          ],
          initialValue: "save" as const,
        })
      );

      if (action === "save") {
        finalAnswers = answers;
      } else if (action === "cancel") {
        p.cancel("Setup cancelled.");
        return 0;
      } else if (action === "edit-execution") {
        section = "execution";
      } else if (action === "edit-identity") {
        section = "identity";
      } else if (action === "edit-runtime") {
        section = "runtime";
      }
    }
  }

  const dir = ensurePulseedDir();

  const saveResult = await validateAndSaveProviderConfig(buildProviderConfig(finalAnswers, importedProviderPatch));
  if (saveResult !== undefined) return saveResult;
  writeSeedMd(dir, finalAnswers.agentName);
  writeRootMd(dir, finalAnswers.rootPreset);
  if (finalAnswers.importedUserContent !== undefined) {
    writeUserMd(dir, finalAnswers.userName, finalAnswers.importedUserContent);
  } else {
    writeUserMd(dir, finalAnswers.userName);
  }
  try {
    await seedRelationshipProfileFromSetup({
      baseDir: dir,
      userName: finalAnswers.userName,
      importedUserContent: finalAnswers.importedUserContent,
    });
    if (finalAnswers.importedUserContent !== undefined) {
      let importLlmClient: ILLMClient | undefined;
      try {
        importLlmClient = await buildLLMClient();
      } catch (err) {
        p.log.warn(`USER.md profile extraction will use review-only fallback: ${err instanceof Error ? err.message : String(err)}`);
      }
      const proposalResult = await createRelationshipProfileProposalsFromUserMdImport({
        baseDir: dir,
        importedUserContent: finalAnswers.importedUserContent,
        llmClient: importLlmClient,
      });
      if (proposalResult.proposals.length > 0) {
        p.log.info(`Created ${proposalResult.proposals.length} relationship profile proposal(s) from imported USER.md.`);
      }
    }
  } catch (err) {
    p.log.warn(`Setup saved, but could not seed relationship profile: ${err instanceof Error ? err.message : String(err)}`);
  }
  clearIdentityCache();

  let daemonStartupError: string | null = null;
  if (finalAnswers.startDaemon) {
    const daemonConfigPath = path.join(dir, "daemon.json");
    try {
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(daemonConfigPath)) {
        existing = JSON.parse(fs.readFileSync(daemonConfigPath, "utf-8")) as Record<string, unknown>;
      }
      existing["event_server_port"] = finalAnswers.daemonPort;
      fs.writeFileSync(daemonConfigPath, JSON.stringify(existing, null, 2), "utf-8");
    } catch {
      p.log.warn("Setup saved, but could not save daemon port to daemon.json");
    }
    p.log.info("Daemon port " + finalAnswers.daemonPort + " saved. Start it later with pulseed daemon start or pulseed start --goal <goal-id>.");
  }

  if (finalAnswers.notificationConfig) {
    const notifPath = path.join(dir, "notification.json");
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(notifPath, JSON.stringify(finalAnswers.notificationConfig, null, 2));
    } catch (err) {
      p.log.warn(`Setup saved, but could not save notification config: ${err}`);
    }
  }

  if (finalAnswers.gatewaySetup) {
    try {
      await saveGatewayChannels(dir, finalAnswers.gatewaySetup);
    } catch (err) {
      p.log.warn(`Setup saved, but could not save gateway channel config: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (importSelection) {
    try {
      const report = await applySetupImportSelection(dir, importSelection);
      const appliedCount = report.items.filter((item) => item.status === "applied").length;
      const failedCount = report.items.filter((item) => item.status === "failed").length;
      p.log.info(
        `Imported ${appliedCount} item${appliedCount === 1 ? "" : "s"}` +
          (failedCount > 0 ? ` (${failedCount} failed; see import report).` : ".")
      );
    } catch (err) {
      p.log.warn(`Setup saved, but import side effects failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (finalAnswers.startDaemon) {
    try {
      await startDaemonAfterSetup(dir, finalAnswers.daemonPort);
      try {
        await updateGlobalConfig({ daemon_mode: true });
      } catch {
        p.log.warn("Daemon started, but could not enable daemon mode in config.json");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      daemonStartupError = message;
      p.log.warn(
        `Setup saved, but daemon/gateway did not start: ${message}. ` +
          "Run `pulseed daemon start --detach` to try again."
      );
    }
  }

  try {
    const readiness = buildResidentReadinessReport(
      finalAnswers,
      await collectOperatorBindingStatus(new StateManager(dir)),
      daemonStartupError
    );
    printResidentReadinessReport(readiness);
  } catch (err) {
    p.log.warn(`Setup saved, but resident readiness check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  p.outro("\ud83c\udf31 Seeds planted. Time to grow.");
  return 0;
}
