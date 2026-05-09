import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  DomainKnowledgeSchema,
  SharedKnowledgeEntrySchema,
} from "../../base/types/knowledge.js";
import { KnowledgeMemoryStateStore } from "../../platform/knowledge/knowledge-memory-state-store.js";
import { AgentMemoryStoreSchema } from "../../platform/knowledge/types/agent-memory.js";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";

const MIGRATION_NAME = "knowledge-memory-soil-state";
const MIGRATION_VERSION = 8;

export interface KnowledgeMemoryLegacyImportReport {
  domainKnowledge: number;
  sharedKnowledgeEntries: number;
  agentMemoryEntries: number;
  agentMemoryCorrections: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

export async function importLegacyKnowledgeMemoryState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<KnowledgeMemoryLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const store = new KnowledgeMemoryStateStore(baseDir);
  const report: KnowledgeMemoryLegacyImportReport = {
    domainKnowledge: 0,
    sharedKnowledgeEntries: 0,
    agentMemoryEntries: 0,
    agentMemoryCorrections: 0,
    blockedSources: [],
  };

  try {
    await importDomainKnowledge(baseDir, store, controlDb, report);
    await importSharedKnowledge(baseDir, store, controlDb, report);
    await importAgentMemory(baseDir, store, controlDb, report);
    return report;
  } finally {
    if (!options.controlDb) {
      controlDb.close();
    }
  }
}

async function importDomainKnowledge(
  baseDir: string,
  store: KnowledgeMemoryStateStore,
  controlDb: ControlDatabase,
  report: KnowledgeMemoryLegacyImportReport,
): Promise<void> {
  const goalsDir = path.join(baseDir, "goals");
  for (const entry of await readDir(goalsDir)) {
    if (!entry.isDirectory()) continue;
    const goalId = entry.name;
    await importJson({
      baseDir,
      filePath: path.join(goalsDir, goalId, "domain_knowledge.json"),
      sourceKind: "knowledge_domain_state",
      sourceId: goalId,
      controlDb,
      report,
      onImport: async (raw) => {
        const parsed = DomainKnowledgeSchema.parse(raw);
        if (parsed.goal_id !== goalId) {
          throw new Error(`domain knowledge goal_id "${parsed.goal_id}" does not match legacy path goal "${goalId}"`);
        }
        await store.saveDomainKnowledge(parsed);
        report.domainKnowledge += 1;
      },
    });
  }
}

async function importSharedKnowledge(
  baseDir: string,
  store: KnowledgeMemoryStateStore,
  controlDb: ControlDatabase,
  report: KnowledgeMemoryLegacyImportReport,
): Promise<void> {
  await importJson({
    baseDir,
    filePath: path.join(baseDir, "memory", "shared-knowledge", "entries.json"),
    sourceKind: "knowledge_shared_state",
    sourceId: "shared",
    controlDb,
    report,
    onImport: async (raw) => {
      if (!Array.isArray(raw)) {
        throw new Error("shared knowledge legacy state must be an array");
      }
      const entries = raw.map((entry) => SharedKnowledgeEntrySchema.parse(entry));
      await store.saveSharedKnowledgeEntries(entries);
      report.sharedKnowledgeEntries += entries.length;
    },
  });
}

async function importAgentMemory(
  baseDir: string,
  store: KnowledgeMemoryStateStore,
  controlDb: ControlDatabase,
  report: KnowledgeMemoryLegacyImportReport,
): Promise<void> {
  await importJson({
    baseDir,
    filePath: path.join(baseDir, "memory", "agent-memory", "entries.json"),
    sourceKind: "knowledge_agent_memory_state",
    sourceId: "agent-memory",
    controlDb,
    report,
    onImport: async (raw) => {
      const parsed = AgentMemoryStoreSchema.parse(raw);
      await store.saveAgentMemoryStore(parsed);
      report.agentMemoryEntries += parsed.entries.length;
      report.agentMemoryCorrections += parsed.corrections.length;
    },
  });
}

async function importJson(input: {
  baseDir: string;
  filePath: string;
  sourceKind: string;
  sourceId: string;
  controlDb: ControlDatabase;
  report: KnowledgeMemoryLegacyImportReport;
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
    report: KnowledgeMemoryLegacyImportReport;
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
