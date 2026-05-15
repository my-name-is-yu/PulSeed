import { z } from "zod/v3";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";
import {
  TransferCandidateSchema,
  TransferEffectivenessSchema,
  TransferResultSchema,
  type TransferCandidate,
  type TransferEffectivenessRecord,
  type TransferResult,
} from "../../base/types/cross-portfolio.js";
import {
  CrossGoalPatternSchema,
  LearnedPatternSchema,
  type CrossGoalPattern,
} from "../../base/types/learning.js";

export interface KnowledgeTransferStateStoreOptions extends RuntimeControlDbStoreOptions {}

export const KNOWLEDGE_TRANSFER_SNAPSHOT_PATH = "knowledge-transfer/snapshot.json";
export const META_PATTERN_LAST_AGGREGATED_AT_PATH = "meta-patterns/last_aggregated_at.json";

export type KnowledgeTransferRawKind = "snapshot" | "meta_pattern_last_aggregated_at";

export interface KnowledgeTransferRawPathMatch {
  kind: KnowledgeTransferRawKind;
}

export interface KnowledgeTransferRawStateStoreResult {
  handled: boolean;
  value: unknown | null;
}

export const TransferContextSnapshotSchema = z.object({
  candidate: TransferCandidateSchema,
  gap_at_apply: z.number(),
  source_pattern: LearnedPatternSchema.nullable(),
});
export type TransferContextSnapshot = z.infer<typeof TransferContextSnapshotSchema>;

export const PatternEffectivenessTrackerSnapshotSchema = z.object({
  consecutive_non_positive: z.number().int().min(0),
  invalidated: z.boolean(),
});
export type PatternEffectivenessTrackerSnapshot = z.infer<typeof PatternEffectivenessTrackerSnapshotSchema>;

export const KnowledgeTransferSnapshotSchema = z.object({
  transfers: z.array(TransferCandidateSchema).default([]),
  results: z.array(TransferResultSchema).default([]),
  effectiveness_records: z.array(TransferEffectivenessSchema).default([]),
  apply_contexts: z.record(z.string(), TransferContextSnapshotSchema).default({}),
  pattern_trackers: z.record(z.string(), PatternEffectivenessTrackerSnapshotSchema).default({}),
  cross_goal_patterns: z.array(CrossGoalPatternSchema).default([]),
});
export type KnowledgeTransferSnapshot = z.infer<typeof KnowledgeTransferSnapshotSchema>;

const MetaPatternLastAggregatedAtSchema = z.object({
  ts: z.string().datetime(),
});
type MetaPatternLastAggregatedAt = z.infer<typeof MetaPatternLastAggregatedAtSchema>;

export interface KnowledgeTransferStateStorePort {
  ensureReady(): Promise<void>;
  loadSnapshot(): Promise<KnowledgeTransferSnapshot | null>;
  saveSnapshot(snapshot: KnowledgeTransferSnapshot): Promise<void>;
  hasSnapshot(): Promise<boolean>;
  loadLastAggregatedAt(): Promise<string | null>;
  saveLastAggregatedAt(ts: string): Promise<void>;
  hasLastAggregatedAt(): Promise<boolean>;
  readRawPath(relativePath: string): Promise<KnowledgeTransferRawStateStoreResult>;
  writeRawPath(relativePath: string, data: unknown): Promise<boolean>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stringifyJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Knowledge transfer state must be JSON serializable.");
  }
  return serialized;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").split("/").filter(Boolean).join("/");
}

export function parseKnowledgeTransferRawPath(relativePath: string): KnowledgeTransferRawPathMatch | null {
  const normalized = normalizeRelativePath(relativePath);
  if (normalized === KNOWLEDGE_TRANSFER_SNAPSHOT_PATH) {
    return { kind: "snapshot" };
  }
  if (normalized === META_PATTERN_LAST_AGGREGATED_AT_PATH) {
    return { kind: "meta_pattern_last_aggregated_at" };
  }
  return null;
}

export function buildKnowledgeTransferSnapshot(input: {
  transfers: TransferCandidate[];
  results: TransferResult[];
  effectivenessRecords: TransferEffectivenessRecord[];
  applyContexts: Record<string, TransferContextSnapshot>;
  patternTrackers: Record<string, PatternEffectivenessTrackerSnapshot>;
  crossGoalPatterns: CrossGoalPattern[];
}): KnowledgeTransferSnapshot {
  return KnowledgeTransferSnapshotSchema.parse({
    transfers: input.transfers,
    results: input.results,
    effectiveness_records: input.effectivenessRecords,
    apply_contexts: input.applyContexts,
    pattern_trackers: input.patternTrackers,
    cross_goal_patterns: input.crossGoalPatterns,
  });
}

export class KnowledgeTransferStateStore implements KnowledgeTransferStateStorePort {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly options: KnowledgeTransferStateStoreOptions = {},
  ) {}

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async loadSnapshot(): Promise<KnowledgeTransferSnapshot | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT snapshot_json
        FROM knowledge_transfer_snapshots
        WHERE snapshot_id = 'current'
      `).get() as { snapshot_json: string } | undefined;
      if (!row) return null;
      return KnowledgeTransferSnapshotSchema.parse(parseJson<unknown>(row.snapshot_json));
    });
  }

  async saveSnapshot(snapshot: KnowledgeTransferSnapshot): Promise<void> {
    const parsed = KnowledgeTransferSnapshotSchema.parse(snapshot);
    const updatedAt = nowIso();
    const serialized = stringifyJson(parsed);
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO knowledge_transfer_snapshots (
          snapshot_id,
          updated_at,
          snapshot_json
        ) VALUES ('current', ?, json(?))
        ON CONFLICT(snapshot_id) DO UPDATE SET
          updated_at = excluded.updated_at,
          snapshot_json = excluded.snapshot_json
      `).run(updatedAt, serialized);
    });
  }

  async hasSnapshot(): Promise<boolean> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT 1
        FROM knowledge_transfer_snapshots
        WHERE snapshot_id = 'current'
      `).get() as unknown | undefined;
      return row !== undefined;
    });
  }

  async loadLastAggregatedAt(): Promise<string | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT timestamp
        FROM knowledge_transfer_meta_pattern_watermarks
        WHERE watermark_id = 'last_aggregated_at'
      `).get() as { timestamp: string } | undefined;
      return row?.timestamp ?? null;
    });
  }

  async saveLastAggregatedAt(ts: string): Promise<void> {
    const parsed = MetaPatternLastAggregatedAtSchema.parse({ ts });
    await this.saveMetaPatternLastAggregatedAt(parsed);
  }

  async hasLastAggregatedAt(): Promise<boolean> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT 1
        FROM knowledge_transfer_meta_pattern_watermarks
        WHERE watermark_id = 'last_aggregated_at'
      `).get() as unknown | undefined;
      return row !== undefined;
    });
  }

  async readRawPath(relativePath: string): Promise<KnowledgeTransferRawStateStoreResult> {
    const match = parseKnowledgeTransferRawPath(relativePath);
    if (!match) return { handled: false, value: null };
    if (match.kind === "snapshot") {
      return { handled: true, value: await this.loadSnapshot() };
    }
    const ts = await this.loadLastAggregatedAt();
    return { handled: true, value: ts === null ? null : { ts } };
  }

  async writeRawPath(relativePath: string, data: unknown): Promise<boolean> {
    const match = parseKnowledgeTransferRawPath(relativePath);
    if (!match) return false;
    if (match.kind === "snapshot") {
      if (data === null) {
        await this.deleteSnapshot();
      } else {
        await this.saveSnapshot(KnowledgeTransferSnapshotSchema.parse(data));
      }
      return true;
    }
    if (data === null) {
      await this.deleteLastAggregatedAt();
      return true;
    }
    await this.saveMetaPatternLastAggregatedAt(MetaPatternLastAggregatedAtSchema.parse(data));
    return true;
  }

  private async saveMetaPatternLastAggregatedAt(input: MetaPatternLastAggregatedAt): Promise<void> {
    const updatedAt = nowIso();
    const serialized = stringifyJson(input);
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO knowledge_transfer_meta_pattern_watermarks (
          watermark_id,
          updated_at,
          timestamp,
          watermark_json
        ) VALUES ('last_aggregated_at', ?, ?, json(?))
        ON CONFLICT(watermark_id) DO UPDATE SET
          updated_at = excluded.updated_at,
          timestamp = excluded.timestamp,
          watermark_json = excluded.watermark_json
      `).run(updatedAt, input.ts, serialized);
    });
  }

  private async deleteSnapshot(): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM knowledge_transfer_snapshots WHERE snapshot_id = 'current'").run();
    });
  }

  private async deleteLastAggregatedAt(): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM knowledge_transfer_meta_pattern_watermarks WHERE watermark_id = 'last_aggregated_at'").run();
    });
  }

  private async database(): Promise<ControlDatabase> {
    if (this.options.controlDb) {
      return this.options.controlDb;
    }
    this.dbPromise ??= openControlDatabase({
      baseDir: this.options.controlBaseDir ?? this.baseDir,
      dbPath: this.options.controlDbPath,
    });
    return this.dbPromise;
  }
}
