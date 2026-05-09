import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { PluginStateSchema } from "../types/plugin.js";
import { AssetRegistryFileSchema } from "../assets/types.js";
import {
  CompatibilityReviewRecordSchema,
  ForeignPluginCompatibilityReportSchema,
} from "../foreign-plugins/types.js";
import {
  FOREIGN_PLUGIN_COMPATIBILITY_REPORT_FILENAME,
  FOREIGN_PLUGIN_REVIEW_RECORD_FILENAME,
} from "../foreign-plugins/compatibility.js";
import { PluginChannelRuntimeStateStore } from "./plugin-channel-runtime-state-store.js";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";

const MIGRATION_NAME = "plugin-channel-runtime-state";
const MIGRATION_VERSION = 9;

export interface PluginChannelRuntimeLegacyImportReport {
  pluginStates: number;
  channelHealth: number;
  importedPluginReviews: number;
  assetRecords: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

export async function importLegacyPluginChannelRuntimeState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<PluginChannelRuntimeLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const store = new PluginChannelRuntimeStateStore(baseDir, { ...options, controlDb });
  const report: PluginChannelRuntimeLegacyImportReport = {
    pluginStates: 0,
    channelHealth: 0,
    importedPluginReviews: 0,
    assetRecords: 0,
    blockedSources: [],
  };

  try {
    await importPluginStates(baseDir, store, controlDb, report);
    await importGatewayChannelHealth(baseDir, store, controlDb, report);
    await importForeignPluginReviews(baseDir, store, controlDb, report);
    await importAssetRegistry(baseDir, store, controlDb, report);
    return report;
  } finally {
    if (!options.controlDb) {
      controlDb.close();
    }
  }
}

async function importPluginStates(
  baseDir: string,
  store: PluginChannelRuntimeStateStore,
  controlDb: ControlDatabase,
  report: PluginChannelRuntimeLegacyImportReport,
): Promise<void> {
  const pluginsDir = path.join(baseDir, "plugins");
  for (const filePath of await findFiles(pluginsDir, "state.json")) {
    await importJson({
      baseDir,
      filePath,
      sourceKind: "plugin-runtime-state-json",
      sourceId: relativeSourcePath(baseDir, filePath),
      controlDb,
      report,
      onImport: async (raw) => {
        await store.savePluginState(PluginStateSchema.parse(raw));
        report.pluginStates += 1;
      },
    });
  }
}

async function importGatewayChannelHealth(
  baseDir: string,
  store: PluginChannelRuntimeStateStore,
  controlDb: ControlDatabase,
  report: PluginChannelRuntimeLegacyImportReport,
): Promise<void> {
  const channelsDir = path.join(baseDir, "gateway", "channels");
  for (const entry of await readDir(channelsDir)) {
    if (!entry.isDirectory()) continue;
    const channelName = entry.name;
    const filePath = path.join(channelsDir, channelName, "health.json");
    await importJson({
      baseDir,
      filePath,
      sourceKind: "gateway-channel-health-json",
      sourceId: channelName,
      controlDb,
      report,
      onImport: async (raw) => {
        const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
        await store.saveChannelHealth(channelName, {
          last_inbound_at: typeof record["last_inbound_at"] === "string" ? record["last_inbound_at"] : null,
          last_outbound_at: typeof record["last_outbound_at"] === "string" ? record["last_outbound_at"] : null,
          last_error: typeof record["last_error"] === "string" ? record["last_error"] : null,
        });
        report.channelHealth += 1;
      },
    });
  }
}

async function importForeignPluginReviews(
  baseDir: string,
  store: PluginChannelRuntimeStateStore,
  controlDb: ControlDatabase,
  report: PluginChannelRuntimeLegacyImportReport,
): Promise<void> {
  const importsDir = path.join(baseDir, "plugins-imported-disabled");
  for (const filePath of await findFiles(importsDir, FOREIGN_PLUGIN_COMPATIBILITY_REPORT_FILENAME)) {
    const pluginDir = path.dirname(filePath);
    await importJson({
      baseDir,
      filePath,
      sourceKind: "foreign-plugin-compatibility-json",
      sourceId: relativeSourcePath(baseDir, pluginDir),
      controlDb,
      report,
      onImport: async (raw) => {
        const reportArtifact = ForeignPluginCompatibilityReportSchema.parse(raw);
        const reviewRaw = await readJson(path.join(pluginDir, FOREIGN_PLUGIN_REVIEW_RECORD_FILENAME));
        const reviewRecord = CompatibilityReviewRecordSchema.parse(reviewRaw);
        await store.saveForeignPluginCompatibility(pluginDir, reportArtifact, reviewRecord);
        report.importedPluginReviews += 1;
      },
    });
  }
}

async function importAssetRegistry(
  baseDir: string,
  store: PluginChannelRuntimeStateStore,
  controlDb: ControlDatabase,
  report: PluginChannelRuntimeLegacyImportReport,
): Promise<void> {
  const filePath = path.join(baseDir, "runtime", "assets", "registry.json");
  await importJson({
    baseDir,
    filePath,
    sourceKind: "runtime-asset-registry-json",
    sourceId: "asset-registry",
    controlDb,
    report,
    onImport: async (raw) => {
      const registry = AssetRegistryFileSchema.parse(raw);
      await store.saveAssetRecords(registry.assets);
      report.assetRecords += registry.assets.length;
    },
  });
}

async function importJson(input: {
  baseDir: string;
  filePath: string;
  sourceKind: string;
  sourceId: string;
  controlDb: ControlDatabase;
  report: PluginChannelRuntimeLegacyImportReport;
  onImport: (raw: unknown) => Promise<void>;
}): Promise<void> {
  if (hasCompletedLegacyImport(input.controlDb, input.sourceKind, input.sourceId)) return;
  let rawText: string;
  try {
    rawText = await fsp.readFile(input.filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    recordBlockedImport(input, error);
    return;
  }
  try {
    await input.onImport(JSON.parse(rawText) as unknown);
    input.controlDb.recordLegacyImport({
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      sourcePath: relativeSourcePath(input.baseDir, input.filePath),
      sourceChecksum: createHash("sha256").update(rawText).digest("hex"),
      sourceMtimeMs: null,
      migrationName: MIGRATION_NAME,
      migrationVersion: MIGRATION_VERSION,
      status: "imported",
      details: {},
    });
  } catch (error) {
    recordBlockedImport(input, error);
  }
}

function recordBlockedImport(
  input: {
    baseDir: string;
    filePath: string;
    sourceKind: string;
    sourceId: string;
    controlDb: ControlDatabase;
    report: PluginChannelRuntimeLegacyImportReport;
  },
  error: unknown,
): void {
  const reason = error instanceof Error ? error.message : String(error);
  const sourcePath = relativeSourcePath(input.baseDir, input.filePath);
  input.report.blockedSources.push({ sourceKind: input.sourceKind, sourcePath, reason });
  input.controlDb.recordLegacyImport({
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    sourcePath,
    sourceChecksum: null,
    sourceMtimeMs: null,
    migrationName: MIGRATION_NAME,
    migrationVersion: MIGRATION_VERSION,
    status: "blocked",
    details: { reason },
  });
}

function hasCompletedLegacyImport(controlDb: ControlDatabase, sourceKind: string, sourceId: string): boolean {
  return controlDb.listLegacyImports().some((record) =>
    record.migration_name === MIGRATION_NAME
    && record.source_kind === sourceKind
    && record.source_id === sourceId
    && (record.status === "imported" || record.status === "retired")
  );
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fsp.readFile(filePath, "utf8")) as unknown;
}

async function readDir(dir: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function findFiles(root: string, fileName: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readDir(dir)) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && entry.name === fileName) {
        found.push(entryPath);
      }
    }
  }
  await visit(root);
  return found.sort();
}

function relativeSourcePath(baseDir: string, filePath: string): string {
  const relative = path.relative(baseDir, filePath);
  return relative.startsWith("..") ? filePath : relative;
}
