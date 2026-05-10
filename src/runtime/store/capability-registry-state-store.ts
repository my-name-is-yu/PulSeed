import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";
import {
  CapabilityRegistrySchema,
  CapabilitySchema,
  type Capability,
  type CapabilityRegistry,
} from "../../base/types/capability.js";

export interface CapabilityRegistryStateStoreOptions extends RuntimeControlDbStoreOptions {}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

export class CapabilityRegistryStateStore {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly options: CapabilityRegistryStateStoreOptions = {},
  ) {}

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async loadRegistry(): Promise<CapabilityRegistry> {
    const db = await this.database();
    return db.read((sqlite) => {
      const meta = sqlite.prepare(`
        SELECT last_checked
        FROM capability_registry_metadata
        WHERE registry_id = 'current'
      `).get() as { last_checked: string } | undefined;
      const rows = sqlite.prepare(`
        SELECT capability_json
        FROM capability_registry_entries
        ORDER BY sort_order ASC, capability_id ASC
      `).all() as Array<{ capability_json: string }>;

      return CapabilityRegistrySchema.parse({
        capabilities: rows.map((row) => CapabilitySchema.parse(parseJson(row.capability_json))),
        last_checked: meta?.last_checked ?? nowIso(),
      });
    });
  }

  async saveRegistry(registry: CapabilityRegistry): Promise<void> {
    const parsed = CapabilityRegistrySchema.parse(registry);
    const updatedAt = nowIso();
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO capability_registry_metadata (registry_id, last_checked, updated_at)
        VALUES ('current', ?, ?)
        ON CONFLICT(registry_id) DO UPDATE SET
          last_checked = excluded.last_checked,
          updated_at = excluded.updated_at
      `).run(parsed.last_checked, updatedAt);

      sqlite.prepare("DELETE FROM capability_registry_entries").run();
      const insert = sqlite.prepare(`
        INSERT INTO capability_registry_entries (
          capability_id,
          capability_name,
          capability_type,
          capability_status,
          provider,
          acquired_at,
          sort_order,
          updated_at,
          capability_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      parsed.capabilities.forEach((capability, index) => {
        insert.run(
          capability.id,
          capability.name,
          capability.type,
          capability.status,
          capability.provider ?? null,
          capability.acquired_at ?? null,
          index,
          updatedAt,
          stringifyJson(capability),
        );
      });
    });
  }

  async isCapabilityAvailable(capabilityName: string): Promise<boolean> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT capability_json
        FROM capability_registry_entries
        WHERE capability_name = ? AND capability_status = 'available'
        ORDER BY sort_order ASC, capability_id ASC
        LIMIT 1
      `).get(capabilityName) as { capability_json: string } | undefined;
      if (!row) return false;
      return CapabilitySchema.parse(parseJson<Capability>(row.capability_json)).status === "available";
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
