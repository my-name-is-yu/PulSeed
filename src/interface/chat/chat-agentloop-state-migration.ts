import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "../../runtime/store/control-db/index.js";
import { ChatSessionSchema, type ChatSession } from "./chat-history.js";
import { ChatSessionDataStore, CrossPlatformChatSessionInfoStore } from "./chat-session-data-store.js";
import {
  normalizeAgentLoopSessionState,
  type AgentLoopSessionState,
} from "../../orchestrator/execution/agent-loop/agent-loop-session-state.js";
import {
  SqliteAgentLoopSessionStateStore,
  SqliteAgentLoopTraceStore,
} from "../../orchestrator/execution/agent-loop/agent-loop-session-db-store.js";
import type { AgentLoopEvent } from "../../orchestrator/execution/agent-loop/agent-loop-events.js";
import type { CrossPlatformChatSessionInfo } from "./cross-platform-session-types.js";

const MIGRATION_NAME = "chat-agentloop-session-data-plane";
const MIGRATION_VERSION = 5;

export interface ChatAgentLoopLegacyImportReport {
  importedChatSessions: number;
  importedCrossPlatformSessions: number;
  importedAgentLoopStates: number;
  importedTraceEvents: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

export async function importLegacyChatAgentLoopSessionState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<ChatAgentLoopLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const storeOptions = { ...options, controlDb };
  const report: ChatAgentLoopLegacyImportReport = {
    importedChatSessions: 0,
    importedCrossPlatformSessions: 0,
    importedAgentLoopStates: 0,
    importedTraceEvents: 0,
    blockedSources: [],
  };

  try {
    const agentStateByRelativePath = await importLegacyAgentLoopStates(baseDir, controlDb, storeOptions, report);
    await importLegacyChatSessions(baseDir, controlDb, storeOptions, agentStateByRelativePath, report);
    await importLegacyCrossPlatformSessions(baseDir, controlDb, storeOptions, report);
    await importLegacyAgentLoopTraceEvents(baseDir, controlDb, storeOptions, report);
    return report;
  } finally {
    if (!options.controlDb) {
      controlDb.close();
    }
  }
}

async function importLegacyChatSessions(
  baseDir: string,
  controlDb: ControlDatabase,
  storeOptions: RuntimeControlDbStoreOptions,
  agentStateByRelativePath: Map<string, AgentLoopSessionState>,
  report: ChatAgentLoopLegacyImportReport,
): Promise<void> {
  const dir = path.join(baseDir, "chat", "sessions");
  const entries = await readDirectoryEntries(dir, report, "chat_session");
  const store = new ChatSessionDataStore(baseDir, storeOptions);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, filePath);
    try {
      const { raw, checksum, mtimeMs } = await readLegacyJsonFile(filePath);
      const parsed = ChatSessionSchema.parse(raw);
      const legacyAgentStatePath = parsed.agentLoopStatePath ?? path.join("chat", "agentloop", `${parsed.id}.state.json`);
      const linkedAgentState = legacyAgentStatePath
        ? agentStateByRelativePath.get(legacyAgentStatePath)
        : undefined;
      const session: ChatSession = linkedAgentState
        ? {
            ...parsed,
            agentLoopSessionId: parsed.agentLoopSessionId ?? linkedAgentState.sessionId,
            agentLoopTraceId: parsed.agentLoopTraceId ?? linkedAgentState.traceId,
            agentLoopStatePath: parsed.agentLoopStatePath ?? legacyAgentStatePath,
            agentLoopStatus: linkedAgentState.status,
            agentLoopResumable: linkedAgentState.status !== "completed",
            agentLoopUpdatedAt: linkedAgentState.updatedAt,
          }
        : parsed;
      await store.save(session);
      recordImport(controlDb, {
        sourceKind: "chat_session",
        sourceId: session.id,
        sourcePath: relativePath,
        sourceChecksum: checksum,
        sourceMtimeMs: mtimeMs,
        status: "imported",
      });
      report.importedChatSessions += 1;
    } catch (error) {
      blockImport(controlDb, report, "chat_session", relativePath, entry.name, error);
    }
  }
}

async function importLegacyCrossPlatformSessions(
  baseDir: string,
  controlDb: ControlDatabase,
  storeOptions: RuntimeControlDbStoreOptions,
  report: ChatAgentLoopLegacyImportReport,
): Promise<void> {
  const dir = path.join(baseDir, "chat", "cross-platform-sessions");
  const entries = await readDirectoryEntries(dir, report, "cross_platform_chat_session");
  const store = new CrossPlatformChatSessionInfoStore(baseDir, storeOptions);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, filePath);
    try {
      const { raw, checksum, mtimeMs } = await readLegacyJsonFile(filePath);
      const info = raw as CrossPlatformChatSessionInfo;
      await store.save(info);
      recordImport(controlDb, {
        sourceKind: "cross_platform_chat_session",
        sourceId: info.session_key,
        sourcePath: relativePath,
        sourceChecksum: checksum,
        sourceMtimeMs: mtimeMs,
        status: "imported",
      });
      report.importedCrossPlatformSessions += 1;
    } catch (error) {
      blockImport(controlDb, report, "cross_platform_chat_session", relativePath, entry.name, error);
    }
  }
}

async function importLegacyAgentLoopStates(
  baseDir: string,
  controlDb: ControlDatabase,
  storeOptions: RuntimeControlDbStoreOptions,
  report: ChatAgentLoopLegacyImportReport,
): Promise<Map<string, AgentLoopSessionState>> {
  const states = new Map<string, AgentLoopSessionState>();
  const dir = path.join(baseDir, "chat", "agentloop");
  const entries = await readDirectoryEntries(dir, report, "agentloop_state");
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".state.json")) continue;
    const filePath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, filePath);
    try {
      const { raw, checksum, mtimeMs } = await readLegacyJsonFile(filePath);
      const state = normalizeAgentLoopSessionState(raw);
      if (!state) {
        throw new Error("legacy AgentLoop state does not match the typed state contract");
      }
      await new SqliteAgentLoopSessionStateStore(baseDir, state.sessionId, "chat", storeOptions).save(state);
      states.set(relativePath, state);
      recordImport(controlDb, {
        sourceKind: "agentloop_state",
        sourceId: state.sessionId,
        sourcePath: relativePath,
        sourceChecksum: checksum,
        sourceMtimeMs: mtimeMs,
        status: "imported",
      });
      report.importedAgentLoopStates += 1;
    } catch (error) {
      blockImport(controlDb, report, "agentloop_state", relativePath, entry.name, error);
    }
  }
  return states;
}

async function importLegacyAgentLoopTraceEvents(
  baseDir: string,
  controlDb: ControlDatabase,
  storeOptions: RuntimeControlDbStoreOptions,
  report: ChatAgentLoopLegacyImportReport,
): Promise<void> {
  const traceFiles = await listJsonlFiles(path.join(baseDir, "traces", "agentloop"));
  const store = new SqliteAgentLoopTraceStore(baseDir, storeOptions);
  for (const filePath of traceFiles) {
    const relativePath = path.relative(baseDir, filePath);
    try {
      const stat = await fsp.stat(filePath);
      const text = await fsp.readFile(filePath, "utf-8");
      const checksum = sha256(text);
      let imported = 0;
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as AgentLoopEvent;
        if (!event.eventId || !event.traceId || !event.sessionId || !event.turnId || !event.goalId || !event.type || !event.createdAt) {
          throw new Error("legacy AgentLoop trace event does not match the typed event contract");
        }
        await store.append(event);
        imported += 1;
      }
      recordImport(controlDb, {
        sourceKind: "agentloop_trace",
        sourceId: relativePath,
        sourcePath: relativePath,
        sourceChecksum: checksum,
        sourceMtimeMs: stat.mtimeMs,
        status: "imported",
        details: { importedEvents: imported },
      });
      report.importedTraceEvents += imported;
    } catch (error) {
      blockImport(controlDb, report, "agentloop_trace", relativePath, relativePath, error);
    }
  }
}

async function readDirectoryEntries(
  dir: string,
  report: ChatAgentLoopLegacyImportReport,
  sourceKind: string,
): Promise<Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    report.blockedSources.push({
      sourceKind,
      sourcePath: path.relative(path.dirname(dir), dir),
      reason: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function readLegacyJsonFile(filePath: string): Promise<{ raw: unknown; checksum: string; mtimeMs: number }> {
  const stat = await fsp.stat(filePath);
  const text = await fsp.readFile(filePath, "utf-8");
  return {
    raw: JSON.parse(text) as unknown,
    checksum: sha256(text),
    mtimeMs: stat.mtimeMs,
  };
}

function recordImport(
  db: ControlDatabase,
  input: {
    sourceKind: string;
    sourceId: string;
    sourcePath: string;
    sourceChecksum: string;
    sourceMtimeMs: number;
    status: "imported" | "blocked";
    details?: Record<string, unknown>;
  },
): void {
  db.recordLegacyImport({
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    sourcePath: input.sourcePath,
    sourceChecksum: input.sourceChecksum,
    sourceMtimeMs: input.sourceMtimeMs,
    migrationName: MIGRATION_NAME,
    migrationVersion: MIGRATION_VERSION,
    status: input.status,
    details: input.details,
  });
}

function blockImport(
  db: ControlDatabase,
  report: ChatAgentLoopLegacyImportReport,
  sourceKind: string,
  sourcePath: string,
  sourceId: string,
  error: unknown,
): void {
  const reason = error instanceof Error ? error.message : String(error);
  report.blockedSources.push({ sourceKind, sourcePath, reason });
  db.recordLegacyImport({
    sourceKind,
    sourceId,
    sourcePath,
    migrationName: MIGRATION_NAME,
    migrationVersion: MIGRATION_VERSION,
    status: "blocked",
    details: { reason },
  });
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
