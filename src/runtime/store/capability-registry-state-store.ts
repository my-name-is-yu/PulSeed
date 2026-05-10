import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";
import {
  CapabilityRegistrySchema,
  CapabilityDependencySchema,
  CapabilitySchema,
  type Capability,
  type CapabilityDependency,
  type CapabilityRegistry,
} from "../../base/types/capability.js";

export interface CapabilityRegistryStateStoreOptions extends RuntimeControlDbStoreOptions {}

export const CAPABILITY_DEPENDENCIES_PATH = "capability_dependencies.json";

export interface CapabilityDependencyRawStateStoreResult {
  handled: boolean;
  value: unknown | null;
}

export interface CapabilityDependencyStateStorePort {
  ensureReady(): Promise<void>;
  loadDependencies(): Promise<CapabilityDependency[]>;
  saveDependencies(dependencies: CapabilityDependency[]): Promise<void>;
  hasDependencies(): Promise<boolean>;
  readRawPath(relativePath: string): Promise<CapabilityDependencyRawStateStoreResult>;
  writeRawPath(relativePath: string, data: unknown): Promise<boolean>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").split("/").filter(Boolean).join("/");
}

export function isCapabilityDependenciesRawPath(relativePath: string): boolean {
  return normalizeRelativePath(relativePath) === CAPABILITY_DEPENDENCIES_PATH;
}

export class CapabilityRegistryStateStore implements CapabilityDependencyStateStorePort {
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

  async loadDependencies(): Promise<CapabilityDependency[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT dependency_json
        FROM capability_dependency_entries
        ORDER BY sort_order ASC, capability_id ASC
      `).all() as Array<{ dependency_json: string }>;
      return rows.map((row) => CapabilityDependencySchema.parse(parseJson<unknown>(row.dependency_json)));
    });
  }

  async saveDependencies(dependencies: CapabilityDependency[]): Promise<void> {
    const parsed = dependencies.map((dependency) => CapabilityDependencySchema.parse(dependency));
    const updatedAt = nowIso();
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO capability_dependency_metadata (registry_id, updated_at)
        VALUES ('current', ?)
        ON CONFLICT(registry_id) DO UPDATE SET
          updated_at = excluded.updated_at
      `).run(updatedAt);
      sqlite.prepare("DELETE FROM capability_dependency_entries").run();
      const insert = sqlite.prepare(`
        INSERT INTO capability_dependency_entries (
          capability_id,
          sort_order,
          updated_at,
          dependency_json
        ) VALUES (?, ?, ?, json(?))
      `);
      parsed.forEach((dependency, index) => {
        insert.run(
          dependency.capability_id,
          index,
          updatedAt,
          stringifyJson(dependency),
        );
      });
    });
  }

  async hasDependencies(): Promise<boolean> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT 1
        FROM capability_dependency_metadata
        WHERE registry_id = 'current'
        LIMIT 1
      `).get() as unknown | undefined;
      return row !== undefined;
    });
  }

  async readRawPath(relativePath: string): Promise<CapabilityDependencyRawStateStoreResult> {
    if (!isCapabilityDependenciesRawPath(relativePath)) {
      return { handled: false, value: null };
    }
    if (!await this.hasDependencies()) {
      return { handled: true, value: null };
    }
    return { handled: true, value: await this.loadDependencies() };
  }

  async writeRawPath(relativePath: string, data: unknown): Promise<boolean> {
    if (!isCapabilityDependenciesRawPath(relativePath)) return false;
    if (data === null) {
      await this.clearDependencies();
      return true;
    }
    await this.saveDependencies(zCapabilityDependencies.parse(data));
    return true;
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

  private async clearDependencies(): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM capability_dependency_entries").run();
      sqlite.prepare("DELETE FROM capability_dependency_metadata WHERE registry_id = 'current'").run();
    });
  }
}

const zCapabilityDependencies = CapabilityDependencySchema.array();
