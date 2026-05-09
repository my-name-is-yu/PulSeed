import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { getControlDatabasePath } from "../../../base/utils/paths.js";
import {
  CONTROL_DB_MIGRATIONS,
  CONTROL_DB_SCHEMA_VERSION,
  type ControlDbMigration,
} from "./schema.js";

export type SqliteDatabase = Database.Database;

export interface ControlDbOpenOptions {
  baseDir?: string;
  dbPath?: string;
  migrations?: readonly ControlDbMigration[];
}

export interface ControlDbMigrationRecord {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
}

export interface ControlDbMigrationReport {
  schemaVersion: number;
  applied: ControlDbMigrationRecord[];
  newlyApplied: ControlDbMigrationRecord[];
}

export type ControlLegacyImportStatus = "validated" | "imported" | "retired" | "blocked";

export interface ControlLegacyImportInput {
  importId?: string;
  sourceKind: string;
  sourceId: string;
  sourcePath?: string | null;
  sourceChecksum?: string | null;
  sourceMtimeMs?: number | null;
  migrationName: string;
  migrationVersion: number;
  status: ControlLegacyImportStatus;
  details?: Record<string, unknown>;
  importedAt?: string;
  retiredAt?: string | null;
}

export interface ControlLegacyImportRecord {
  import_id: string;
  source_kind: string;
  source_id: string;
  source_path: string | null;
  source_checksum: string | null;
  source_mtime_ms: number | null;
  migration_name: string;
  migration_version: number;
  status: ControlLegacyImportStatus;
  details: Record<string, unknown>;
  imported_at: string;
  retired_at: string | null;
}

export interface ControlDbInspection {
  dbPath: string;
  exists: boolean;
  readable: boolean;
  status: "missing" | "ready" | "pending_migration" | "ahead_of_code" | "unreadable";
  schemaVersion: number | null;
  expectedSchemaVersion: number;
  appliedMigrations: ControlDbMigrationRecord[];
  pendingMigrations: ControlDbMigration[];
  legacyImportCount: number | null;
  error?: string;
}

function expectedVersion(migrations: readonly ControlDbMigration[]): number {
  return migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
}

export function resolveControlDbPath(options: Pick<ControlDbOpenOptions, "baseDir" | "dbPath"> = {}): string {
  return path.resolve(options.dbPath ?? getControlDatabasePath(options.baseDir));
}

function assertValidMigrations(migrations: readonly ControlDbMigration[]): void {
  const versions = new Set<number>();
  let previous = 0;
  for (const migration of migrations) {
    if (migration.version <= 0) {
      throw new Error(`Control DB migration version must be positive: ${migration.version}`);
    }
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate Control DB migration version: ${migration.version}`);
    }
    if (migration.version <= previous) {
      throw new Error("Control DB migrations must be sorted by ascending version.");
    }
    versions.add(migration.version);
    previous = migration.version;
  }
}

function tableExists(db: SqliteDatabase, tableName: string): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName) as { name: string } | undefined;
  return row !== undefined;
}

function readUserVersion(db: SqliteDatabase): number {
  const version = db.pragma("user_version", { simple: true });
  return typeof version === "number" ? version : Number(version ?? 0);
}

function readAppliedMigrations(db: SqliteDatabase): ControlDbMigrationRecord[] {
  if (!tableExists(db, "control_schema_migrations")) {
    return [];
  }
  return db.prepare(`
    SELECT version, name, checksum, applied_at
    FROM control_schema_migrations
    ORDER BY version ASC
  `).all() as ControlDbMigrationRecord[];
}

function verifyAppliedMigrations(
  applied: readonly ControlDbMigrationRecord[],
  migrations: readonly ControlDbMigration[]
): void {
  const known = new Map(migrations.map((migration) => [migration.version, migration]));
  const supported = expectedVersion(migrations);
  for (const record of applied) {
    const migration = known.get(record.version);
    if (!migration || record.version > supported) {
      throw new Error(
        `Control DB schema version ${record.version} is newer than supported version ${supported}.`
      );
    }
    if (migration.checksum !== record.checksum) {
      throw new Error(`Control DB migration checksum mismatch for version ${record.version}.`);
    }
  }
}

export function initializeControlDatabase(
  db: SqliteDatabase,
  migrations: readonly ControlDbMigration[] = CONTROL_DB_MIGRATIONS
): ControlDbMigrationReport {
  assertValidMigrations(migrations);

  const supportedVersion = expectedVersion(migrations);
  const userVersion = readUserVersion(db);
  if (userVersion > supportedVersion) {
    throw new Error(
      `Control DB schema version ${userVersion} is newer than supported version ${supportedVersion}.`
    );
  }

  const appliedBefore = readAppliedMigrations(db);
  verifyAppliedMigrations(appliedBefore, migrations);

  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");

  const appliedVersions = new Set(appliedBefore.map((record) => record.version));
  const newlyApplied: ControlDbMigrationRecord[] = [];

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }
    const appliedAt = new Date().toISOString();
    const runMigration = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(`
        INSERT INTO control_schema_migrations (version, name, checksum, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(migration.version, migration.name, migration.checksum, appliedAt);
      db.pragma(`user_version = ${migration.version}`);
    });
    runMigration();
    newlyApplied.push({
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum,
      applied_at: appliedAt,
    });
  }

  const applied = readAppliedMigrations(db);
  const schemaVersion = Math.max(readUserVersion(db), ...applied.map((record) => record.version), 0);
  return { schemaVersion, applied, newlyApplied };
}

function parseDetailsJson(detailsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(detailsJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function toLegacyImportRecord(row: {
  import_id: string;
  source_kind: string;
  source_id: string;
  source_path: string | null;
  source_checksum: string | null;
  source_mtime_ms: number | null;
  migration_name: string;
  migration_version: number;
  status: ControlLegacyImportStatus;
  details_json: string;
  imported_at: string;
  retired_at: string | null;
}): ControlLegacyImportRecord {
  return {
    import_id: row.import_id,
    source_kind: row.source_kind,
    source_id: row.source_id,
    source_path: row.source_path,
    source_checksum: row.source_checksum,
    source_mtime_ms: row.source_mtime_ms,
    migration_name: row.migration_name,
    migration_version: row.migration_version,
    status: row.status,
    details: parseDetailsJson(row.details_json),
    imported_at: row.imported_at,
    retired_at: row.retired_at,
  };
}

export class ControlDatabase {
  private constructor(
    private readonly db: SqliteDatabase,
    readonly dbPath: string
  ) {}

  static async open(options: ControlDbOpenOptions = {}): Promise<ControlDatabase> {
    const dbPath = resolveControlDbPath(options);
    await fsp.mkdir(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
      initializeControlDatabase(db, options.migrations ?? CONTROL_DB_MIGRATIONS);
      return new ControlDatabase(db, dbPath);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  schemaVersion(): number {
    return Math.max(
      readUserVersion(this.db),
      ...this.listMigrations().map((migration) => migration.version),
      0
    );
  }

  listMigrations(): ControlDbMigrationRecord[] {
    return readAppliedMigrations(this.db);
  }

  read<T>(fn: (db: SqliteDatabase) => T): T {
    return fn(this.db);
  }

  transaction<T>(fn: (db: SqliteDatabase) => T): T {
    return this.db.transaction(() => fn(this.db))();
  }

  recordLegacyImport(input: ControlLegacyImportInput): ControlLegacyImportRecord {
    const importId = input.importId ?? randomUUID();
    const importedAt = input.importedAt ?? new Date().toISOString();
    const detailsJson = JSON.stringify(input.details ?? {});
    this.db.prepare(`
      INSERT INTO control_legacy_imports (
        import_id, source_kind, source_id, source_path, source_checksum, source_mtime_ms,
        migration_name, migration_version, status, details_json, imported_at, retired_at
      ) VALUES (
        @import_id, @source_kind, @source_id, @source_path, @source_checksum, @source_mtime_ms,
        @migration_name, @migration_version, @status, @details_json, @imported_at, @retired_at
      )
      ON CONFLICT(source_kind, source_id, migration_name) DO UPDATE SET
        source_path = excluded.source_path,
        source_checksum = excluded.source_checksum,
        source_mtime_ms = excluded.source_mtime_ms,
        migration_version = excluded.migration_version,
        status = excluded.status,
        details_json = excluded.details_json,
        imported_at = excluded.imported_at,
        retired_at = excluded.retired_at
    `).run({
      import_id: importId,
      source_kind: input.sourceKind,
      source_id: input.sourceId,
      source_path: input.sourcePath ?? null,
      source_checksum: input.sourceChecksum ?? null,
      source_mtime_ms: input.sourceMtimeMs ?? null,
      migration_name: input.migrationName,
      migration_version: input.migrationVersion,
      status: input.status,
      details_json: detailsJson,
      imported_at: importedAt,
      retired_at: input.retiredAt ?? null,
    });
    const record = this.db.prepare(`
      SELECT *
      FROM control_legacy_imports
      WHERE source_kind = ? AND source_id = ? AND migration_name = ?
    `).get(input.sourceKind, input.sourceId, input.migrationName) as Parameters<typeof toLegacyImportRecord>[0];
    return toLegacyImportRecord(record);
  }

  listLegacyImports(): ControlLegacyImportRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM control_legacy_imports
      ORDER BY imported_at ASC, import_id ASC
    `).all() as Array<Parameters<typeof toLegacyImportRecord>[0]>;
    return rows.map((row) => toLegacyImportRecord(row));
  }
}

export async function openControlDatabase(options: ControlDbOpenOptions = {}): Promise<ControlDatabase> {
  return ControlDatabase.open(options);
}

export function inspectControlDatabase(
  options: Pick<ControlDbOpenOptions, "baseDir" | "dbPath" | "migrations"> = {}
): ControlDbInspection {
  const migrations = options.migrations ?? CONTROL_DB_MIGRATIONS;
  const dbPath = resolveControlDbPath(options);
  const expectedSchemaVersion = Math.max(expectedVersion(migrations), CONTROL_DB_SCHEMA_VERSION);
  if (!fs.existsSync(dbPath)) {
    return {
      dbPath,
      exists: false,
      readable: false,
      status: "missing",
      schemaVersion: 0,
      expectedSchemaVersion,
      appliedMigrations: [],
      pendingMigrations: [...migrations],
      legacyImportCount: null,
    };
  }

  let db: SqliteDatabase | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
    const schemaVersion = readUserVersion(db);
    const appliedMigrations = readAppliedMigrations(db);
    const appliedMax = Math.max(...appliedMigrations.map((record) => record.version), 0);
    const ahead = schemaVersion > expectedSchemaVersion || appliedMax > expectedSchemaVersion;
    if (ahead) {
      return {
        dbPath,
        exists: true,
        readable: true,
        status: "ahead_of_code",
        schemaVersion: Math.max(schemaVersion, appliedMax),
        expectedSchemaVersion,
        appliedMigrations,
        pendingMigrations: [],
        legacyImportCount: tableExists(db, "control_legacy_imports")
          ? ((db.prepare("SELECT COUNT(*) AS count FROM control_legacy_imports").get() as { count: number }).count)
          : 0,
      };
    }

    verifyAppliedMigrations(appliedMigrations, migrations);
    const appliedVersions = new Set(appliedMigrations.map((record) => record.version));
    const pendingMigrations = migrations.filter((migration) => !appliedVersions.has(migration.version));
    const legacyImportCount = tableExists(db, "control_legacy_imports")
      ? ((db.prepare("SELECT COUNT(*) AS count FROM control_legacy_imports").get() as { count: number }).count)
      : 0;

    return {
      dbPath,
      exists: true,
      readable: true,
      status: pendingMigrations.length > 0 ? "pending_migration" : "ready",
      schemaVersion: Math.max(schemaVersion, appliedMax),
      expectedSchemaVersion,
      appliedMigrations,
      pendingMigrations,
      legacyImportCount,
    };
  } catch (error) {
    return {
      dbPath,
      exists: true,
      readable: false,
      status: "unreadable",
      schemaVersion: null,
      expectedSchemaVersion,
      appliedMigrations: [],
      pendingMigrations: [...migrations],
      legacyImportCount: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
}
