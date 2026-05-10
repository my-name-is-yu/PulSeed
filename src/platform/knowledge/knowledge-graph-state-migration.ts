import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "../../runtime/store/control-db/index.js";
import { KnowledgeEdgeSchema } from "../../base/types/knowledge.js";
import {
  KnowledgeGraphNodeSchema,
  KnowledgeGraphStateStore,
} from "./knowledge-graph-state-store.js";

const MIGRATION_NAME = "knowledge-vector-graph-runtime-state";
const MIGRATION_VERSION = 26;
const LEGACY_KNOWLEDGE_GRAPH_FILE = path.join("knowledge", "graph.json");

const LegacyKnowledgeGraphSchema = z.object({
  nodes: z.array(KnowledgeGraphNodeSchema).default([]),
  edges: z.array(KnowledgeEdgeSchema).default([]),
});

export interface KnowledgeGraphLegacyImportReport {
  knowledgeGraphFiles: number;
  importedNodes: number;
  importedEdges: number;
  skippedAlreadyImported: number;
  retiredExistingTypedState: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

export async function importLegacyKnowledgeGraphState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<KnowledgeGraphLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const report: KnowledgeGraphLegacyImportReport = {
    knowledgeGraphFiles: 0,
    importedNodes: 0,
    importedEdges: 0,
    skippedAlreadyImported: 0,
    retiredExistingTypedState: 0,
    blockedSources: [],
  };

  try {
    const filePath = path.join(baseDir, LEGACY_KNOWLEDGE_GRAPH_FILE);
    let payload: { raw: string; checksum: string; mtimeMs: number };
    try {
      payload = await readLegacyTextFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return report;
      blockImport(baseDir, filePath, LEGACY_KNOWLEDGE_GRAPH_FILE, controlDb, report, error);
      return report;
    }

    report.knowledgeGraphFiles = 1;
    let graphData: z.infer<typeof LegacyKnowledgeGraphSchema>;
    try {
      graphData = LegacyKnowledgeGraphSchema.parse(JSON.parse(payload.raw) as unknown);
    } catch (error) {
      blockImport(baseDir, filePath, LEGACY_KNOWLEDGE_GRAPH_FILE, controlDb, report, error, payload.checksum, payload.mtimeMs);
      return report;
    }

    if (hasCompletedLegacyImport(controlDb)) {
      report.skippedAlreadyImported += 1;
      return report;
    }

    const store = new KnowledgeGraphStateStore(baseDir, { ...options, controlDb });
    const existingNodes = await store.listNodes();
    const existingEdges = await store.listEdges();
    if (existingNodes.length > 0 || existingEdges.length > 0) {
      report.retiredExistingTypedState = 1;
      controlDb.recordLegacyImport({
        sourceKind: "knowledge_graph_file",
        sourceId: LEGACY_KNOWLEDGE_GRAPH_FILE,
        sourcePath: path.relative(baseDir, filePath),
        sourceChecksum: payload.checksum,
        sourceMtimeMs: payload.mtimeMs,
        migrationName: MIGRATION_NAME,
        migrationVersion: MIGRATION_VERSION,
        status: "retired",
        details: {
          reason: "typed knowledge graph state already exists",
          existing_nodes: existingNodes.length,
          existing_edges: existingEdges.length,
        },
      });
      return report;
    }

    for (const node of graphData.nodes) {
      await store.saveNode(node);
      report.importedNodes += 1;
    }
    for (const edge of graphData.edges) {
      await store.saveEdge(edge);
      report.importedEdges += 1;
    }
    controlDb.recordLegacyImport({
      sourceKind: "knowledge_graph_file",
      sourceId: LEGACY_KNOWLEDGE_GRAPH_FILE,
      sourcePath: path.relative(baseDir, filePath),
      sourceChecksum: payload.checksum,
      sourceMtimeMs: payload.mtimeMs,
      migrationName: MIGRATION_NAME,
      migrationVersion: MIGRATION_VERSION,
      status: "imported",
      details: {
        nodes: report.importedNodes,
        edges: report.importedEdges,
      },
    });
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
  report: KnowledgeGraphLegacyImportReport,
  error: unknown,
  checksum?: string,
  mtimeMs?: number,
): void {
  const reason = error instanceof Error ? error.message : String(error);
  const sourcePath = path.relative(baseDir, filePath);
  report.blockedSources.push({ sourceKind: "knowledge_graph_file", sourcePath, reason });
  controlDb.recordLegacyImport({
    sourceKind: "knowledge_graph_file",
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

function hasCompletedLegacyImport(controlDb: ControlDatabase): boolean {
  return controlDb.listLegacyImports().some((record) =>
    record.source_kind === "knowledge_graph_file"
    && record.source_id === LEGACY_KNOWLEDGE_GRAPH_FILE
    && record.migration_name === MIGRATION_NAME
    && record.status === "imported"
  );
}
