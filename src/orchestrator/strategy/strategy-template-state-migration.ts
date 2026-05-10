import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "../../runtime/store/control-db/index.js";
import { StrategyTemplateSchema } from "../../base/types/cross-portfolio.js";
import { StrategyTemplateStateStore } from "./strategy-template-state-store.js";

const MIGRATION_NAME = "strategy-template-runtime-state";
const MIGRATION_VERSION = 25;
const LEGACY_STRATEGY_TEMPLATE_FILE = "strategy-templates.json";

export interface StrategyTemplateLegacyImportReport {
  strategyTemplateFiles: number;
  importedTemplates: number;
  skippedAlreadyImported: number;
  retiredExistingTypedState: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

export async function importLegacyStrategyTemplateState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<StrategyTemplateLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const report: StrategyTemplateLegacyImportReport = {
    strategyTemplateFiles: 0,
    importedTemplates: 0,
    skippedAlreadyImported: 0,
    retiredExistingTypedState: 0,
    blockedSources: [],
  };

  try {
    const filePath = path.join(baseDir, LEGACY_STRATEGY_TEMPLATE_FILE);
    let payload: { raw: string; checksum: string; mtimeMs: number };
    try {
      payload = await readLegacyTextFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return report;
      blockImport(baseDir, filePath, LEGACY_STRATEGY_TEMPLATE_FILE, controlDb, report, error);
      return report;
    }

    report.strategyTemplateFiles = 1;
    let rawTemplates: unknown;
    try {
      rawTemplates = JSON.parse(payload.raw) as unknown;
    } catch (error) {
      blockImport(baseDir, filePath, LEGACY_STRATEGY_TEMPLATE_FILE, controlDb, report, error, payload.checksum, payload.mtimeMs);
      return report;
    }

    if (!Array.isArray(rawTemplates)) {
      blockImport(
        baseDir,
        filePath,
        LEGACY_STRATEGY_TEMPLATE_FILE,
        controlDb,
        report,
        new Error("legacy strategy template file must contain an array"),
        payload.checksum,
        payload.mtimeMs,
      );
      return report;
    }

    const store = new StrategyTemplateStateStore(baseDir, { ...options, controlDb });
    for (const [index, item] of rawTemplates.entries()) {
      const parsed = StrategyTemplateSchema.safeParse(item);
      const sourceId = parsed.success ? parsed.data.template_id : `${LEGACY_STRATEGY_TEMPLATE_FILE}#${index}`;
      if (!parsed.success) {
        blockImport(
          baseDir,
          filePath,
          sourceId,
          controlDb,
          report,
          parsed.error,
          payload.checksum,
          payload.mtimeMs,
        );
        continue;
      }

      if (hasCompletedLegacyImport(controlDb, parsed.data.template_id)) {
        report.skippedAlreadyImported += 1;
        continue;
      }

      const existingTemplate = await store.load(parsed.data.template_id);
      if (existingTemplate !== null) {
        report.retiredExistingTypedState += 1;
        controlDb.recordLegacyImport({
          sourceKind: "strategy_template",
          sourceId: parsed.data.template_id,
          sourcePath: path.relative(baseDir, filePath),
          sourceChecksum: payload.checksum,
          sourceMtimeMs: payload.mtimeMs,
          migrationName: MIGRATION_NAME,
          migrationVersion: MIGRATION_VERSION,
          status: "retired",
          details: {
            reason: "typed strategy template state already exists",
            existing_created_at: existingTemplate.created_at,
          },
        });
        continue;
      }

      await store.save(parsed.data);
      report.importedTemplates += 1;
      controlDb.recordLegacyImport({
        sourceKind: "strategy_template",
        sourceId: parsed.data.template_id,
        sourcePath: path.relative(baseDir, filePath),
        sourceChecksum: payload.checksum,
        sourceMtimeMs: payload.mtimeMs,
        migrationName: MIGRATION_NAME,
        migrationVersion: MIGRATION_VERSION,
        status: "imported",
        details: {
          source_goal_id: parsed.data.source_goal_id,
          source_strategy_id: parsed.data.source_strategy_id,
          effectiveness_score: parsed.data.effectiveness_score,
        },
      });
    }

    return report;
  } finally {
    if (!options.controlDb) controlDb.close();
  }
}

async function readLegacyTextFile(filePath: string): Promise<{ raw: string; checksum: string; mtimeMs: number }> {
  const [raw, stat] = await Promise.all([
    fsp.readFile(filePath, "utf8"),
    fsp.stat(filePath),
  ]);
  return {
    raw,
    checksum: createHash("sha256").update(raw, "utf8").digest("hex"),
    mtimeMs: stat.mtimeMs,
  };
}

function blockImport(
  baseDir: string,
  filePath: string,
  sourceId: string,
  controlDb: ControlDatabase,
  report: StrategyTemplateLegacyImportReport,
  error: unknown,
  checksum?: string,
  mtimeMs?: number,
): void {
  const reason = error instanceof Error ? error.message : String(error);
  const sourcePath = path.relative(baseDir, filePath);
  report.blockedSources.push({ sourceKind: "strategy_template", sourcePath, reason });
  controlDb.recordLegacyImport({
    sourceKind: "strategy_template",
    sourceId,
    sourcePath,
    sourceChecksum: checksum ?? null,
    sourceMtimeMs: mtimeMs ?? null,
    migrationName: MIGRATION_NAME,
    migrationVersion: MIGRATION_VERSION,
    status: "blocked",
    details: { reason },
  });
}

function hasCompletedLegacyImport(controlDb: ControlDatabase, sourceId: string): boolean {
  return controlDb.listLegacyImports().some((record) =>
    record.source_kind === "strategy_template"
    && record.source_id === sourceId
    && record.migration_name === MIGRATION_NAME
    && record.status === "imported"
  );
}
