import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";
import { RuntimeEvidenceStateStore } from "./runtime-evidence-state-store.js";
import { StrategyDreamStateStore } from "./strategy-dream-state-store.js";
import { ProcessSessionStateStore } from "./process-session-state-store.js";
import { RuntimeEvidenceEntrySchema } from "./evidence-types.js";
import {
  DreamActivationArtifactFileSchema,
  EventLogSchema,
  ImportanceEntrySchema,
  IterationLogSchema,
  ScheduleSuggestionFileSchema,
  SessionLogSchema,
  WatermarkStateSchema,
} from "../../platform/dream/dream-types.js";

const MIGRATION_NAME = "runtime-evidence-strategy-dream-state";
const MIGRATION_VERSION = 7;

export interface RuntimeEvidenceStrategyDreamLegacyImportReport {
  runtimeEvidenceEntries: number;
  processSessionSnapshots: number;
  strategyRecords: number;
  dreamIterationLogs: number;
  dreamSessionLogs: number;
  dreamEventLogs: number;
  dreamImportanceEntries: number;
  dreamWatermarks: boolean;
  dreamScheduleSuggestions: number;
  dreamPlaybooks: number;
  dreamActivationArtifacts: number;
  dreamWorkflows: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

export async function importLegacyRuntimeEvidenceStrategyDreamState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions & { runtimeRoot?: string } = {},
): Promise<RuntimeEvidenceStrategyDreamLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const runtimeRoot = options.runtimeRoot ?? path.join(baseDir, "runtime");
  const evidenceStore = new RuntimeEvidenceStateStore(runtimeRoot, { ...options, controlDb });
  const stateStore = new StrategyDreamStateStore(baseDir, { ...options, controlDb });
  const processSessionStore = new ProcessSessionStateStore(baseDir, { ...options, controlDb });
  const report: RuntimeEvidenceStrategyDreamLegacyImportReport = {
    runtimeEvidenceEntries: 0,
    processSessionSnapshots: 0,
    strategyRecords: 0,
    dreamIterationLogs: 0,
    dreamSessionLogs: 0,
    dreamEventLogs: 0,
    dreamImportanceEntries: 0,
    dreamWatermarks: false,
    dreamScheduleSuggestions: 0,
    dreamPlaybooks: 0,
    dreamActivationArtifacts: 0,
    dreamWorkflows: 0,
    blockedSources: [],
  };

  try {
    await importRuntimeEvidence(baseDir, runtimeRoot, evidenceStore, controlDb, report);
    await importProcessSessionState(baseDir, runtimeRoot, processSessionStore, controlDb, report);
    await importStrategyState(baseDir, stateStore, controlDb, report);
    await importDreamState(baseDir, stateStore, controlDb, report);
    return report;
  } finally {
    if (!options.controlDb) {
      controlDb.close();
    }
  }
}

async function importRuntimeEvidence(
  baseDir: string,
  runtimeRoot: string,
  store: RuntimeEvidenceStateStore,
  controlDb: ControlDatabase,
  report: RuntimeEvidenceStrategyDreamLegacyImportReport,
): Promise<void> {
  const roots = [
    path.join(runtimeRoot, "evidence-ledger"),
    path.join(baseDir, "evidence-ledger"),
  ];
  for (const root of roots) {
    for (const scopeKind of ["goals", "runs"] as const) {
      const dir = path.join(root, scopeKind);
      for (const entry of await readDir(dir)) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const filePath = path.join(dir, entry.name);
        const scopeId = decodeURIComponent(entry.name.slice(0, -".jsonl".length));
        await importJsonl({
          baseDir,
          filePath,
          sourceKind: scopeKind === "goals" ? "runtime_evidence_goal" : "runtime_evidence_run",
          sourceId: scopeId,
          controlDb,
          report,
          onImport: async (raw, line) => {
            const parsed = RuntimeEvidenceEntrySchema.parse(raw);
            await store.append(parsed, { sourceRef: `${relativeSourcePath(baseDir, filePath)}#L${line}` });
            report.runtimeEvidenceEntries += 1;
          },
        });
      }
    }
  }
}

async function importProcessSessionState(
  baseDir: string,
  runtimeRoot: string,
  store: ProcessSessionStateStore,
  controlDb: ControlDatabase,
  report: RuntimeEvidenceStrategyDreamLegacyImportReport,
): Promise<void> {
  const processSessionDir = path.join(runtimeRoot, "process-sessions");
  for (const entry of await readDir(processSessionDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const sessionId = entry.name.slice(0, -".json".length);
    await importJson({
      baseDir,
      filePath: path.join(processSessionDir, entry.name),
      sourceKind: "process_session_snapshot",
      sourceId: sessionId,
      controlDb,
      report,
      onImport: async (raw) => {
        const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
        await store.saveSnapshot({
          ...record,
          session_id: sessionId,
          metadataRef: store.metadataRef(sessionId),
        });
        report.processSessionSnapshots += 1;
      },
    });
  }
}

async function importStrategyState(
  baseDir: string,
  store: StrategyDreamStateStore,
  controlDb: ControlDatabase,
  report: RuntimeEvidenceStrategyDreamLegacyImportReport,
): Promise<void> {
  const strategiesRoot = path.join(baseDir, "strategies");
  for (const goalDir of await readDir(strategiesRoot)) {
    if (!goalDir.isDirectory()) continue;
    const goalId = goalDir.name;
    for (const relativePath of [
      `strategies/${goalId}/portfolio.json`,
      `strategies/${goalId}/strategy-history.json`,
      `strategies/${goalId}/rebalance-history.json`,
    ]) {
      await importJson({
        baseDir,
        filePath: path.join(baseDir, relativePath),
        sourceKind: "strategy_state",
        sourceId: relativePath,
        controlDb,
        report,
        onImport: async (raw) => {
          if (await store.writeRawPath(relativePath, raw)) report.strategyRecords += 1;
        },
      });
    }
    const waitMetaDir = path.join(strategiesRoot, goalId, "wait-meta");
    for (const entry of await readDir(waitMetaDir)) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const relativePath = `strategies/${goalId}/wait-meta/${entry.name}`;
      await importJson({
        baseDir,
        filePath: path.join(baseDir, relativePath),
        sourceKind: "strategy_wait_metadata",
        sourceId: relativePath,
        controlDb,
        report,
        onImport: async (raw) => {
          if (await store.writeRawPath(relativePath, raw)) report.strategyRecords += 1;
        },
      });
    }
  }
}

async function importDreamState(
  baseDir: string,
  store: StrategyDreamStateStore,
  controlDb: ControlDatabase,
  report: RuntimeEvidenceStrategyDreamLegacyImportReport,
): Promise<void> {
  const goalsRoot = path.join(baseDir, "goals");
  for (const goalDir of await readDir(goalsRoot)) {
    if (!goalDir.isDirectory()) continue;
    await importJsonl({
      baseDir,
      filePath: path.join(goalsRoot, goalDir.name, "iteration-logs.jsonl"),
      sourceKind: "dream_iteration_logs",
      sourceId: goalDir.name,
      controlDb,
      report,
      onImport: async (raw) => {
        await store.appendIterationLog(IterationLogSchema.parse(raw));
        report.dreamIterationLogs += 1;
      },
    });
  }

  await importJsonl({
    baseDir,
    filePath: path.join(baseDir, "dream", "session-logs.jsonl"),
    sourceKind: "dream_session_logs",
    sourceId: "session-logs",
    controlDb,
    report,
    onImport: async (raw) => {
      await store.appendSessionLog(SessionLogSchema.parse(raw));
      report.dreamSessionLogs += 1;
    },
  });

  for (const entry of await readDir(path.join(baseDir, "dream", "events"))) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    await importJsonl({
      baseDir,
      filePath: path.join(baseDir, "dream", "events", entry.name),
      sourceKind: "dream_event_logs",
      sourceId: entry.name,
      controlDb,
      report,
      onImport: async (raw) => {
        await store.appendEventLog(EventLogSchema.parse(raw));
        report.dreamEventLogs += 1;
      },
    });
  }

  await importJsonl({
    baseDir,
    filePath: path.join(baseDir, "dream", "importance-buffer.jsonl"),
    sourceKind: "dream_importance_entries",
    sourceId: "importance-buffer",
    controlDb,
    report,
    onImport: async (raw) => {
      await store.appendImportanceEntry(ImportanceEntrySchema.parse(raw));
      report.dreamImportanceEntries += 1;
    },
  });

  await importJson({
    baseDir,
    filePath: path.join(baseDir, "dream", "watermarks.json"),
    sourceKind: "dream_watermarks",
    sourceId: "current",
    controlDb,
    report,
    onImport: async (raw) => {
      await store.saveWatermarks(WatermarkStateSchema.parse(raw));
      report.dreamWatermarks = true;
    },
  });

  await importJson({
    baseDir,
    filePath: path.join(baseDir, "dream", "schedule-suggestions.json"),
    sourceKind: "dream_schedule_suggestions",
    sourceId: "current",
    controlDb,
    report,
    onImport: async (raw) => {
      const parsed = ScheduleSuggestionFileSchema.parse(raw);
      await store.saveScheduleSuggestions(parsed.suggestions, parsed.generated_at);
      report.dreamScheduleSuggestions += parsed.suggestions.length;
    },
  });

  for (const entry of await readDir(path.join(baseDir, "dream", "playbooks"))) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "index.json") continue;
    await importJson({
      baseDir,
      filePath: path.join(baseDir, "dream", "playbooks", entry.name),
      sourceKind: "dream_playbook",
      sourceId: entry.name,
      controlDb,
      report,
      onImport: async (raw) => {
        const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
        if (!record || typeof record["playbook_id"] !== "string") throw new Error("Invalid playbook record");
        await store.upsertDreamPlaybook(record as { playbook_id: string; status: string; updated_at: string } & Record<string, unknown>);
        report.dreamPlaybooks += 1;
      },
    });
  }

  await importJson({
    baseDir,
    filePath: path.join(baseDir, "dream", "activation-artifacts.json"),
    sourceKind: "dream_activation_artifacts",
    sourceId: "current",
    controlDb,
    report,
    onImport: async (raw) => {
      const parsed = DreamActivationArtifactFileSchema.parse(raw);
      await store.replaceActivationArtifacts(parsed.artifacts);
      report.dreamActivationArtifacts += parsed.artifacts.length;
    },
  });

  await importJson({
    baseDir,
    filePath: path.join(baseDir, "dream", "workflows.json"),
    sourceKind: "dream_workflows",
    sourceId: "current",
    controlDb,
    report,
    onImport: async (raw) => {
      const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const workflows = Array.isArray(record["workflows"]) ? record["workflows"] as Array<Record<string, unknown>> : [];
      await store.saveDreamWorkflows(workflows);
      report.dreamWorkflows += workflows.length;
    },
  });
}

async function importJson(input: {
  baseDir: string;
  filePath: string;
  sourceKind: string;
  sourceId: string;
  controlDb: ControlDatabase;
  report: RuntimeEvidenceStrategyDreamLegacyImportReport;
  onImport: (raw: unknown) => Promise<void>;
}): Promise<void> {
  if (hasCompletedLegacyImport(input.controlDb, input.sourceKind, input.sourceId)) return;
  let rawText: string;
  try {
    rawText = await fsp.readFile(input.filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    await input.onImport(JSON.parse(rawText) as unknown);
    recordImport(input.controlDb, input, rawText);
  } catch (error) {
    input.report.blockedSources.push({
      sourceKind: input.sourceKind,
      sourcePath: relativeSourcePath(input.baseDir, input.filePath),
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

async function importJsonl(input: {
  baseDir: string;
  filePath: string;
  sourceKind: string;
  sourceId: string;
  controlDb: ControlDatabase;
  report: RuntimeEvidenceStrategyDreamLegacyImportReport;
  onImport: (raw: unknown, line: number) => Promise<void>;
}): Promise<void> {
  if (hasCompletedLegacyImport(input.controlDb, input.sourceKind, input.sourceId)) return;
  let rawText: string;
  try {
    rawText = await fsp.readFile(input.filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const lines = rawText.split(/\r?\n/);
  let imported = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.trim()) continue;
    try {
      await input.onImport(JSON.parse(line) as unknown, index + 1);
      imported += 1;
    } catch (error) {
      input.report.blockedSources.push({
        sourceKind: input.sourceKind,
        sourcePath: `${relativeSourcePath(input.baseDir, input.filePath)}#L${index + 1}`,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (imported > 0) {
    recordImport(input.controlDb, input, rawText, { imported });
  }
}

function recordImport(
  controlDb: ControlDatabase,
  input: { baseDir: string; filePath: string; sourceKind: string; sourceId: string },
  rawText: string,
  details: Record<string, unknown> = {},
): void {
  controlDb.recordLegacyImport({
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    sourcePath: relativeSourcePath(input.baseDir, input.filePath),
    sourceChecksum: createHash("sha256").update(rawText).digest("hex"),
    sourceMtimeMs: null,
    migrationName: MIGRATION_NAME,
    migrationVersion: MIGRATION_VERSION,
    status: "imported",
    details,
  });
}

function hasCompletedLegacyImport(
  controlDb: ControlDatabase,
  sourceKind: string,
  sourceId: string,
): boolean {
  return controlDb.listLegacyImports().some((record) =>
    record.migration_name === MIGRATION_NAME
    && record.source_kind === sourceKind
    && record.source_id === sourceId
    && (record.status === "imported" || record.status === "retired")
  );
}

async function readDir(dir: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function relativeSourcePath(baseDir: string, filePath: string): string {
  const relative = path.relative(baseDir, filePath);
  return relative.startsWith("..") ? filePath : relative;
}
