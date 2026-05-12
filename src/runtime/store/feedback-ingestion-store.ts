import {
  createFeedbackIngestion,
  FeedbackIngestionEffectSchema,
  FeedbackIngestionRecordSchema,
  FeedbackIngestionResultSchema,
  type FeedbackIngestionEffect,
  type FeedbackIngestionInput,
  type FeedbackIngestionRecord,
  type FeedbackIngestionResult,
} from "../attention/feedback-ingestion.js";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "./runtime-paths.js";
import {
  openRuntimeControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./control-db/index.js";

export type FeedbackIngestionStoreOptions = RuntimeControlDbStoreOptions;

export class FeedbackIngestionStore {
  private readonly paths: RuntimeStorePaths;
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    runtimeRootOrPaths?: string | RuntimeStorePaths,
    options: FeedbackIngestionStoreOptions = {}
  ) {
    this.paths =
      typeof runtimeRootOrPaths === "string"
        ? createRuntimeStorePaths(runtimeRootOrPaths)
        : runtimeRootOrPaths ?? createRuntimeStorePaths();
    this.dbOptions = options;
  }

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async ingest(
    input: FeedbackIngestionInput,
    options: { now?: string } = {}
  ): Promise<FeedbackIngestionResult> {
    return this.append(createFeedbackIngestion(input, options));
  }

  async append(result: FeedbackIngestionResult): Promise<FeedbackIngestionResult> {
    const parsed = FeedbackIngestionResultSchema.parse(result);
    const db = await this.database();
    db.transaction((sqlite) => appendFeedbackIngestion(sqlite, parsed));
    return parsed;
  }

  async listRecords(limit?: number): Promise<FeedbackIngestionRecord[]> {
    const db = await this.database();
    return db.read((sqlite) => listFeedbackIngestionRecords(sqlite, limit));
  }

  async listEffects(feedbackId?: string): Promise<FeedbackIngestionEffect[]> {
    const db = await this.database();
    return db.read((sqlite) => listFeedbackIngestionEffects(sqlite, feedbackId));
  }

  private async database(): Promise<ControlDatabase> {
    this.dbPromise ??= openRuntimeControlDatabase(this.paths, this.dbOptions);
    return this.dbPromise;
  }
}

interface FeedbackRecordRow {
  feedback_json: string;
}

interface FeedbackEffectRow {
  effect_json: string;
}

function appendFeedbackIngestion(
  sqlite: SqliteDatabase,
  result: FeedbackIngestionResult
): void {
  const record = FeedbackIngestionRecordSchema.parse(result.record);
  const effects = result.effects.map((effect) => FeedbackIngestionEffectSchema.parse(effect));
  sqlite.prepare(`
    INSERT INTO feedback_ingestion_records (
      feedback_id,
      source,
      outcome,
      recorded_at,
      target_kind,
      target_id,
      feedback_json
    )
    VALUES (?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(feedback_id) DO NOTHING
  `).run(
    record.feedback_id,
    record.source,
    record.outcome,
    record.recorded_at,
    record.target.kind,
    record.target.id,
    JSON.stringify(record)
  );
  assertStoredFeedbackIngestionRecordMatches(sqlite, record);

  for (const effect of effects) {
    sqlite.prepare(`
      INSERT INTO feedback_ingestion_effects (
        effect_id,
        feedback_id,
        effect_kind,
        target_ref,
        created_at,
        effect_json
      )
      VALUES (?, ?, ?, ?, ?, json(?))
      ON CONFLICT(effect_id) DO NOTHING
    `).run(
      effect.effect_id,
      effect.feedback_id,
      effect.effect_kind,
      effect.target_ref,
      effect.created_at,
      JSON.stringify(effect)
    );
  }
  assertStoredFeedbackIngestionEffectsMatch(sqlite, record, effects);
}

function listFeedbackIngestionRecords(
  sqlite: SqliteDatabase,
  limit?: number
): FeedbackIngestionRecord[] {
  const rows = sqlite.prepare(`
    SELECT feedback_json
    FROM feedback_ingestion_records
    ORDER BY recorded_at ASC, feedback_id ASC
    ${typeof limit === "number" ? "LIMIT ?" : ""}
  `).all(...(typeof limit === "number" ? [limit] : [])) as FeedbackRecordRow[];
  return rows.map((row) => parseFeedbackRecord(row.feedback_json));
}

function listFeedbackIngestionEffects(
  sqlite: SqliteDatabase,
  feedbackId?: string
): FeedbackIngestionEffect[] {
  const rows = sqlite.prepare(`
    SELECT effect_json
    FROM feedback_ingestion_effects
    ${feedbackId ? "WHERE feedback_id = ?" : ""}
    ORDER BY created_at ASC, effect_id ASC
  `).all(...(feedbackId ? [feedbackId] : [])) as FeedbackEffectRow[];
  return rows.map((row) => parseFeedbackEffect(row.effect_json));
}

function assertStoredFeedbackIngestionRecordMatches(
  sqlite: SqliteDatabase,
  record: FeedbackIngestionRecord
): void {
  const existingRecordRow = sqlite.prepare(`
    SELECT feedback_json
    FROM feedback_ingestion_records
    WHERE feedback_id = ?
  `).get(record.feedback_id) as FeedbackRecordRow | undefined;
  if (!existingRecordRow) {
    throw new Error(`feedback ingestion ${record.feedback_id} was not persisted`);
  }

  const existingRecord = parseFeedbackRecord(existingRecordRow.feedback_json);
  if (canonicalJson(existingRecord) !== canonicalJson(record)) {
    throw new Error(`feedback ingestion ${record.feedback_id} already exists with different durable content`);
  }
}

function assertStoredFeedbackIngestionEffectsMatch(
  sqlite: SqliteDatabase,
  record: FeedbackIngestionRecord,
  effects: readonly FeedbackIngestionEffect[]
): void {
  const existingEffects = listFeedbackIngestionEffects(sqlite, record.feedback_id);
  const existingById = new Map(existingEffects.map((item) => [item.effect_id, canonicalJson(item)]));
  const nextById = new Map(effects.map((item) => [item.effect_id, canonicalJson(FeedbackIngestionEffectSchema.parse(item))]));
  if (existingById.size !== nextById.size) {
    throw new Error(`feedback ingestion ${record.feedback_id} already exists with different effect count`);
  }
  for (const [effectId, existingJson] of existingById) {
    if (nextById.get(effectId) !== existingJson) {
      throw new Error(`feedback ingestion ${record.feedback_id} already exists with different effect ${effectId}`);
    }
  }
}

function parseFeedbackRecord(raw: string): FeedbackIngestionRecord {
  try {
    const parsed = FeedbackIngestionRecordSchema.safeParse(JSON.parse(raw) as unknown);
    if (parsed.success) return parsed.data;
    throw new Error(parsed.error.message);
  } catch (error) {
    throw new Error(`invalid durable feedback ingestion record: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseFeedbackEffect(raw: string): FeedbackIngestionEffect {
  try {
    const parsed = parseStoredFeedbackEffect(raw);
    if (parsed) return parsed;
    throw new Error("schema validation failed");
  } catch (error) {
    throw new Error(`invalid durable feedback ingestion effect: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseStoredFeedbackEffect(raw: string): FeedbackIngestionEffect | null {
  const parsed = FeedbackIngestionEffectSchema.safeParse(JSON.parse(raw) as unknown);
  return parsed.success ? parsed.data : null;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}
