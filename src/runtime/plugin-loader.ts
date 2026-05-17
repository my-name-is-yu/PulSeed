import * as path from "node:path";
import * as fs from "node:fs/promises";
import { getPluginsDir } from "../base/utils/paths.js";
import { getPulseedVersion as getPackageVersion } from "../base/utils/pulseed-meta.js";
import { ValidationError } from "../base/utils/errors.js";
import { readForeignPluginCompatibilityArtifact, hasForeignPluginCompatibilityArtifact } from "./foreign-plugins/compatibility.js";
import { PluginChannelRuntimeStateStore } from "./store/plugin-channel-runtime-state-store.js";
import { hasPluginManifestFile, readPluginManifest } from "./plugin-manifest-reader.js";
import type { Logger } from "./logger.js";
import {
  PluginManifestSchema,
  PluginStateSchema,
  type PluginManifest,
  type PluginState,
  type PluginType,
  type INotifier,
} from "../base/types/plugin.js";
import type { ForeignPluginCompatibilityReport } from "./foreign-plugins/types.js";
import type { AdapterRegistry, IAdapter } from "../orchestrator/execution/adapter-layer.js";
import type { DataSourceRegistry, IDataSourceAdapter } from "../platform/observation/data-source-adapter.js";
import type { NotifierRegistry } from "./notifier-registry.js";
import type { IScheduleSource } from "./schedule/source.js";

// ─── PluginLoader ───

export interface PluginLoaderOptions {
  controlBaseDir?: string;
  runtimeStateStore?: PluginChannelRuntimeStateStore;
}

/**
 * Discovers, loads, validates, and registers plugins from ~/.pulseed/plugins/.
 *
 * Design principles:
 *  - Plugin load failures never crash PulSeed. Every error is caught, logged,
 *    and returned as an error-state PluginState.
 *  - Supports both plugin.yaml and plugin.json manifest formats.
 *  - Routes each plugin to the correct registry based on manifest.type.
 */
export class PluginLoader {
  private adapterRegistry: AdapterRegistry;
  private dataSourceRegistry: DataSourceRegistry;
  private notifierRegistry: NotifierRegistry;
  private pluginsDir: string;
  private pluginStates: Map<string, PluginState> = new Map();
  private pluginDirsByName: Map<string, string> = new Map();
  private scheduleSources: Map<string, IScheduleSource> = new Map();
  private readonly logger?: Logger;
  private readonly runtimeStateStore: PluginChannelRuntimeStateStore;

  constructor(
    adapterRegistry: AdapterRegistry,
    dataSourceRegistry: DataSourceRegistry,
    notifierRegistry: NotifierRegistry,
    pluginsDir?: string,
    logger?: Logger,
    private readonly onDataSourceRegistered?: (adapter: IDataSourceAdapter) => void,
    options: PluginLoaderOptions = {},
  ) {
    this.adapterRegistry = adapterRegistry;
    this.dataSourceRegistry = dataSourceRegistry;
    this.notifierRegistry = notifierRegistry;
    this.pluginsDir = pluginsDir ?? getPluginsDir();
    this.logger = logger;
    this.runtimeStateStore = options.runtimeStateStore ?? new PluginChannelRuntimeStateStore(
      options.controlBaseDir ?? inferPluginStateBaseDir(this.pluginsDir),
    );
  }

  /**
   * Discover all plugin directories and attempt to load each one.
   * Returns a PluginState for every candidate directory (success or error).
   */
  async loadAll(): Promise<PluginState[]> {
    const pluginDirs = await this.discoverPluginDirs();
    if (pluginDirs.length === 0) {
      return [];
    }

    const results = await Promise.allSettled(
      pluginDirs.map((dir) => this.loadOne(dir))
    );

    const states: PluginState[] = [];
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index]!;
      const state = result.status === "fulfilled"
        ? result.value
        : this.buildErrorState(pluginDirs[index]!, result.reason);
      await this.persistPluginState(state);
      states.push(state);
    }
    return states;
  }

  /**
   * Load a single plugin from the given directory.
   * Throws on any failure (caller catches and converts to error state).
   */
  async loadOne(pluginDir: string): Promise<PluginState> {
    const foreignCompatibility = await readForeignPluginCompatibilityArtifact(pluginDir);
    if (foreignCompatibility) {
      const state = this.buildForeignImportDisabledState(pluginDir, foreignCompatibility);
      await this.persistPluginState(state);
      return state;
    }

    // 1. Read and validate manifest
    const manifest = await this.loadManifest(pluginDir);
    this.pluginDirsByName.set(manifest.name, pluginDir);

    // 1b. Semver compatibility check
    const pulseedVersion = getPulseedVersion();
    const minVer = manifest.min_pulseed_version;
    const maxVer = manifest.max_pulseed_version;
    const range = [
      minVer ? `>=${minVer}` : "",
      maxVer ? `<=${maxVer}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    let isCompatible: boolean;
    try {
      isCompatible = satisfiesRange(pulseedVersion, minVer, maxVer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn(
        `[PluginLoader] Skipping plugin "${manifest.name}" with invalid PulSeed version constraint: ${msg}`
      );
      const state = this.buildIncompatibleState(manifest, pulseedVersion, range || "invalid semver");
      await this.persistPluginState(state);
      return state;
    }
    if (!isCompatible) {
      this.logger?.warn(
        `[PluginLoader] Skipping incompatible plugin "${manifest.name}": requires PulSeed ${range}, got ${pulseedVersion}`
      );
      const state = this.buildIncompatibleState(manifest, pulseedVersion, range);
      await this.persistPluginState(state);
      return state;
    }

    const state = this.buildCapabilityProposalState(manifest);
    await this.persistPluginState(state);
    return state;
  }

  async preparePluginImplementation(impl: unknown, pluginDir: string): Promise<unknown> {
    if (typeof impl !== "function") {
      return impl;
    }

    try {
      return new (impl as new (pluginDir: string) => unknown)(pluginDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("not a constructor") && !message.includes("Class constructor")) {
        throw err;
      }
      const result = (impl as (pluginDir: string) => unknown | Promise<unknown>)(pluginDir);
      return await result;
    }
  }

  async initPluginIfNeeded(impl: unknown): Promise<void> {
    if (typeof impl !== "object" || impl === null || !("init" in impl)) {
      return;
    }

    const init = (impl as { init?: unknown }).init;
    if (typeof init !== "function") {
      return;
    }

    await init.call(impl);
  }

  /**
   * Scan pluginsDir for subdirectories that contain plugin.yaml or plugin.json.
   */
  async discoverPluginDirs(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.pluginsDir);
    } catch {
      // Directory doesn't exist yet — not an error
      return [];
    }

    const candidates: string[] = [];
    for (const entry of entries) {
      const dirPath = path.join(this.pluginsDir, entry);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(dirPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      const hasManifest = await this.hasManifestFile(dirPath);
      if (hasManifest && await hasForeignPluginCompatibilityArtifact(dirPath)) {
        this.logger?.warn(`[PluginLoader] Skipping foreign imported plugin "${entry}" until review, adapter, and smoke verification complete`);
        continue;
      }
      if (hasManifest) {
        candidates.push(dirPath);
      }
    }
    return candidates;
  }

  /**
   * Read and parse the plugin manifest (plugin.yaml or plugin.json).
   * Validates against PluginManifestSchema.
   */
  async loadManifest(pluginDir: string): Promise<PluginManifest> {
    const result = await readPluginManifest(pluginDir);
    if (result.ok) return result.data;

    if (result.failure === "missing") {
      throw new Error(`Manifest file not found (plugin.yaml / plugin.json): ${pluginDir}`);
    }

    if (result.failure === "schema") {
      const issues = (result.schemaIssues ?? [])
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new ValidationError(
        `Plugin manifest schema validation failed:\n${issues || result.errorMessage || "invalid manifest"}`
      );
    }

    throw new Error(
      `Failed to ${result.failure} ${result.filename}: ${result.manifestPath} — ${result.errorMessage ?? "unknown error"}`
    );
  }

  /**
   * Check that the plugin implementation exports all required methods for its type.
   */
  validateInterface(type: PluginType, impl: unknown): void {
    const requiredMethods: Record<PluginType, string[]> = {
      adapter: ["execute", "adapterType"],
      data_source: ["connect", "query", "disconnect", "healthCheck"],
      notifier: ["name", "notify", "supports"],
      schedule_source: ["id", "fetchEntries", "healthCheck"],
    };

    const required = requiredMethods[type];
    for (const method of required) {
      if (!(method in (impl as object))) {
        throw new ValidationError(
          `Plugin is missing required method "${method}" (type: ${type})`
        );
      }
    }
  }

  /**
   * Register the plugin implementation in the appropriate registry.
   */
  async registerPlugin(
    manifest: PluginManifest,
    impl: unknown,
    _pluginDir: string
  ): Promise<void> {
    switch (manifest.type) {
      case "adapter":
        this.adapterRegistry.register(impl as IAdapter);
        break;
      case "data_source":
        this.dataSourceRegistry.register(impl as IDataSourceAdapter);
        this.onDataSourceRegistered?.(impl as IDataSourceAdapter);
        break;
      case "notifier":
        this.notifierRegistry.register(manifest.name, impl as INotifier);
        break;
      case "schedule_source":
        this.scheduleSources.set((impl as IScheduleSource).id, impl as IScheduleSource);
        break;
    }
  }

  /**
   * Return all loaded schedule source plugins.
   */
  getScheduleSources(): IScheduleSource[] {
    return Array.from(this.scheduleSources.values());
  }

  // ─── State builders ───

  buildSuccessState(manifest: PluginManifest): PluginState {
    const state = PluginStateSchema.parse({
      name: manifest.name,
      manifest,
      status: "loaded",
      loaded_at: new Date().toISOString(),
      trust_score: 0,
      usage_count: 0,
      success_count: 0,
      failure_count: 0,
    });
    this.pluginStates.set(manifest.name, state);
    return state;
  }

  buildCapabilityProposalState(manifest: PluginManifest): PluginState {
    const state = PluginStateSchema.parse({
      name: manifest.name,
      manifest,
      status: "disabled",
      error_message: "Plugin import is proposal-first; runtime enable/run requires CapabilityDescriptor mapping, operator review, approval fingerprint checks, and operation-specific verification.",
      loaded_at: new Date().toISOString(),
      trust_score: 0,
      usage_count: 0,
      success_count: 0,
      failure_count: 0,
    });
    this.pluginStates.set(manifest.name, state);
    return state;
  }

  buildIncompatibleState(manifest: PluginManifest, pulseedVersion: string, range: string): PluginState {
    const state = PluginStateSchema.parse({
      name: manifest.name,
      manifest,
      status: "incompatible",
      error_message: `Requires PulSeed ${range}, got ${pulseedVersion}`,
      loaded_at: new Date().toISOString(),
      trust_score: 0,
      usage_count: 0,
      success_count: 0,
      failure_count: 0,
    });
    this.pluginStates.set(manifest.name, state);
    return state;
  }

  buildForeignImportDisabledState(
    pluginDir: string,
    report: ForeignPluginCompatibilityReport
  ): PluginState {
    const manifest = PluginManifestSchema.parse({
      name: report.manifest?.name ?? sanitizeName(path.basename(pluginDir)),
      version: report.manifest?.version ?? "0.0.0",
      type: report.manifest?.type ?? "adapter",
      capabilities: report.manifest?.capabilities ?? ["unknown"],
      description: report.manifest?.description ?? "(foreign import disabled)",
      entry_point: report.manifest?.entry_point ?? "dist/index.js",
      permissions: report.permissions,
    });
    const state = PluginStateSchema.parse({
      name: manifest.name,
      manifest,
      status: "disabled",
      error_message: "Foreign plugin import is disabled until operator review, adapter mapping, and smoke verification are recorded.",
      loaded_at: new Date().toISOString(),
      trust_score: 0,
      usage_count: 0,
      success_count: 0,
      failure_count: 0,
    });
    this.pluginStates.set(manifest.name, state);
    return state;
  }

  buildErrorState(pluginDir: string, reason: unknown): PluginState {
    const errorMessage =
      reason instanceof Error ? reason.message : String(reason);
    const dirName = path.basename(pluginDir);

    this.logger?.error(`[PluginLoader] Failed to load plugin: ${pluginDir}\n  ${errorMessage}`);

    // Build a minimal manifest for the error state
    const fallbackManifest: PluginManifest = PluginManifestSchema.parse({
      name: sanitizeName(dirName),
      version: "0.0.0",
      type: "adapter",
      capabilities: ["unknown"],
      description: "(load failed)",
    });

    return PluginStateSchema.parse({
      name: sanitizeName(dirName),
      manifest: fallbackManifest,
      status: "error",
      error_message: errorMessage,
      loaded_at: new Date().toISOString(),
      trust_score: 0,
      usage_count: 0,
      success_count: 0,
      failure_count: 0,
    });
  }

  /**
   * Return the PluginState for a given plugin name, or null if not found.
   */
  getPluginState(pluginName: string): PluginState | null {
    return this.pluginStates.get(pluginName) ?? null;
  }

  /**
   * Update the in-memory plugin state and persist to disk.
   */
  async updatePluginState(
    pluginName: string,
    updates: Partial<Pick<PluginState, "trust_score" | "usage_count" | "success_count" | "failure_count">>
  ): Promise<void> {
    const existing = this.pluginStates.get(pluginName);
    if (existing === undefined) {
      return;
    }
    const updated = PluginStateSchema.parse({ ...existing, ...updates });
    this.pluginStates.set(pluginName, updated);

    await this.persistPluginState(updated);
  }

  private async persistPluginState(state: PluginState): Promise<void> {
    await this.runtimeStateStore.savePluginState(state);
  }

  // ─── Private helpers ───

  private async hasManifestFile(dirPath: string): Promise<boolean> {
    return hasPluginManifestFile(dirPath);
  }
}

// ─── Module-level helpers ───

// ─── PulSeed version (read once from package.json) ───

let _pulseedVersion: string | undefined;

function getPulseedVersion(): string {
  if (_pulseedVersion !== undefined) return _pulseedVersion;
  _pulseedVersion = getPackageVersion(import.meta.url);
  return _pulseedVersion;
}

function inferPluginStateBaseDir(pluginsDir: string): string {
  const normalized = path.resolve(pluginsDir);
  const basename = path.basename(normalized);
  if (basename === "plugins") return path.dirname(normalized);
  return normalized;
}

// ─── Semver utilities (no external deps) ───

const SEMVER_TOKEN = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseSemver(version: string): { major: number; minor: number; patch: number } {
  const match = version.match(SEMVER_TOKEN);
  if (!match) throw new Error(`Invalid semver: ${version}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    throw new Error(`Invalid semver: ${version}`);
  }
  return { major, minor, patch };
}

export function compareSemver(
  a: { major: number; minor: number; patch: number },
  b: { major: number; minor: number; patch: number }
): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  return 0;
}

export function satisfiesRange(version: string, min?: string, max?: string): boolean {
  const v = parseSemver(version);
  if (min !== undefined && compareSemver(v, parseSemver(min)) < 0) return false;
  if (max !== undefined && compareSemver(v, parseSemver(max)) > 0) return false;
  return true;
}

/**
 * Convert an arbitrary directory name to a valid plugin name.
 * Replaces invalid characters with hyphens and lowercases the result.
 */
function sanitizeName(dirName: string): string {
  const sanitized = dirName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
    .replace(/-{2,}/g, "-"); // collapse consecutive hyphens
  return sanitized || "unknown";
}
