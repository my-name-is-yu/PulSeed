import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "../../runtime/store/control-db/index.js";
import { EmbeddingEntrySchema, type EmbeddingEntry } from "../../base/types/embedding.js";

export interface VectorIndexStateStoreOptions extends RuntimeControlDbStoreOptions {}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

export class VectorIndexStateStore {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly options: VectorIndexStateStoreOptions = {},
  ) {}

  async save(entry: EmbeddingEntry): Promise<EmbeddingEntry> {
    const parsed = EmbeddingEntrySchema.parse(entry);
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO vector_index_entries (
          entry_id,
          model,
          created_at,
          metadata_json,
          vector_json,
          entry_json
        ) VALUES (?, ?, ?, json(?), json(?), json(?))
        ON CONFLICT(entry_id) DO UPDATE SET
          model = excluded.model,
          created_at = excluded.created_at,
          metadata_json = excluded.metadata_json,
          vector_json = excluded.vector_json,
          entry_json = excluded.entry_json
      `).run(
        parsed.id,
        parsed.model,
        parsed.created_at,
        stringifyJson(parsed.metadata ?? {}),
        stringifyJson(parsed.vector),
        stringifyJson(parsed),
      );
    });
    return parsed;
  }

  async saveMany(entries: readonly EmbeddingEntry[]): Promise<EmbeddingEntry[]> {
    const parsed = entries.map((entry) => EmbeddingEntrySchema.parse(entry));
    const db = await this.database();
    db.transaction((sqlite) => {
      const statement = sqlite.prepare(`
        INSERT INTO vector_index_entries (
          entry_id,
          model,
          created_at,
          metadata_json,
          vector_json,
          entry_json
        ) VALUES (?, ?, ?, json(?), json(?), json(?))
        ON CONFLICT(entry_id) DO UPDATE SET
          model = excluded.model,
          created_at = excluded.created_at,
          metadata_json = excluded.metadata_json,
          vector_json = excluded.vector_json,
          entry_json = excluded.entry_json
      `);
      for (const entry of parsed) {
        statement.run(
          entry.id,
          entry.model,
          entry.created_at,
          stringifyJson(entry.metadata ?? {}),
          stringifyJson(entry.vector),
          stringifyJson(entry),
        );
      }
    });
    return parsed;
  }

  async load(entryId: string): Promise<EmbeddingEntry | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT entry_json
        FROM vector_index_entries
        WHERE entry_id = ?
      `).get(entryId) as { entry_json: string } | undefined;
      if (!row) return null;
      return EmbeddingEntrySchema.parse(parseJson(row.entry_json));
    });
  }

  async list(): Promise<EmbeddingEntry[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT entry_json
        FROM vector_index_entries
        ORDER BY created_at ASC, entry_id ASC
      `).all() as Array<{ entry_json: string }>;
      return rows.map((row) => EmbeddingEntrySchema.parse(parseJson(row.entry_json)));
    });
  }

  async remove(entryId: string): Promise<boolean> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const result = sqlite.prepare(`
        DELETE FROM vector_index_entries
        WHERE entry_id = ?
      `).run(entryId);
      return result.changes > 0;
    });
  }

  async clear(): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM vector_index_entries").run();
    });
  }

  async close(): Promise<void> {
    if (this.options.controlDb || !this.dbPromise) return;
    const db = await this.dbPromise;
    db.close();
    this.dbPromise = null;
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
