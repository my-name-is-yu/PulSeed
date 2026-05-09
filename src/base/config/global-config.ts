// ─── Global Config ───
//
// Manages ~/.pulseed/config.json — single source for all PulSeed user preferences.

import fs from "node:fs/promises";
import * as fsSync from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getDefaultPulseedWorkspaceRootPath, getPulseedDirPath } from "../utils/paths.js";

const InteractiveAutomationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  default_desktop_provider: z.string().default("codex_app"),
  default_browser_provider: z.string().default("manus_browser"),
  default_research_provider: z.string().default("perplexity_research"),
  require_approval: z.enum(["always", "write", "destructive"]).default("always"),
  allowed_apps: z.array(z.string()).default([]),
  denied_apps: z.array(z.string()).default([
    "Password Manager",
    "Banking",
    "System Settings",
  ]),
});

const GlobalConfigSchema = z.object({
  daemon_mode: z.boolean().default(false),
  no_flicker: z.boolean().default(true),
  workspace_root: z.string().min(1).default(getDefaultPulseedWorkspaceRootPath()),
  interactive_automation: InteractiveAutomationConfigSchema.default({}),
});

const GlobalConfigPatchSchema = GlobalConfigSchema.partial().extend({
  interactive_automation: InteractiveAutomationConfigSchema.partial().optional(),
});

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
export type GlobalConfigPatch = z.infer<typeof GlobalConfigPatchSchema>;

const DEFAULT_CONFIG: GlobalConfig = {
  daemon_mode: false,
  no_flicker: true,
  workspace_root: getDefaultPulseedWorkspaceRootPath(),
  interactive_automation: {
    enabled: false,
    default_desktop_provider: "codex_app",
    default_browser_provider: "manus_browser",
    default_research_provider: "perplexity_research",
    require_approval: "always",
    allowed_apps: [],
    denied_apps: [
      "Password Manager",
      "Banking",
      "System Settings",
    ],
  },
};

function cloneGlobalConfig(config: GlobalConfig): GlobalConfig {
  return {
    ...config,
    interactive_automation: {
      ...config.interactive_automation,
      allowed_apps: [...config.interactive_automation.allowed_apps],
      denied_apps: [...config.interactive_automation.denied_apps],
    },
  };
}

function getConfigPath(): string {
  return path.join(getPulseedDirPath(), "config.json");
}

function mergeGlobalConfigPatch(base: GlobalConfig, patch: unknown): GlobalConfig {
  const parsed = GlobalConfigPatchSchema.parse(patch);
  const { interactive_automation, ...topLevel } = parsed;
  const baseConfig = cloneGlobalConfig(base);
  return GlobalConfigSchema.parse({
    ...baseConfig,
    ...topLevel,
    interactive_automation: interactive_automation === undefined
      ? baseConfig.interactive_automation
      : {
          ...baseConfig.interactive_automation,
          ...interactive_automation,
        },
  });
}

function isRecoverableConfigLoadError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || error instanceof SyntaxError || error instanceof z.ZodError;
}

export async function loadGlobalConfig(): Promise<GlobalConfig> {
  try {
    const raw = await fs.readFile(getConfigPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return mergeGlobalConfigPatch(cloneGlobalConfig(DEFAULT_CONFIG), parsed);
  } catch (err) {
    if (!isRecoverableConfigLoadError(err)) throw err;
    return cloneGlobalConfig(DEFAULT_CONFIG);
  }
}

export function loadGlobalConfigSync(): GlobalConfig {
  try {
    const raw = fsSync.readFileSync(getConfigPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return mergeGlobalConfigPatch(cloneGlobalConfig(DEFAULT_CONFIG), parsed);
  } catch (err) {
    if (!isRecoverableConfigLoadError(err)) throw err;
    return cloneGlobalConfig(DEFAULT_CONFIG);
  }
}

export async function saveGlobalConfig(config: GlobalConfig): Promise<void> {
  const configPath = getConfigPath();
  const validated = GlobalConfigSchema.parse(config);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(validated, null, 2) + "\n");
}

export async function updateGlobalConfig(updates: GlobalConfigPatch): Promise<GlobalConfig> {
  const current = await loadGlobalConfig();
  const updated = mergeGlobalConfigPatch(current, updates);
  await saveGlobalConfig(updated);
  return updated;
}

export function getConfigKeys(): string[] {
  return Object.keys(DEFAULT_CONFIG);
}

export { GlobalConfigSchema, DEFAULT_CONFIG };
