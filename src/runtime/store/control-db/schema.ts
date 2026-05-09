import { createHash } from "node:crypto";

export interface ControlDbMigration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export const CONTROL_DB_SCHEMA_VERSION = 1;

export const CONTROL_DB_INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS control_schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS control_legacy_imports (
  import_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_path TEXT,
  source_checksum TEXT,
  source_mtime_ms INTEGER,
  migration_name TEXT NOT NULL,
  migration_version INTEGER NOT NULL CHECK (migration_version > 0),
  status TEXT NOT NULL CHECK (status IN ('validated', 'imported', 'retired', 'blocked')),
  details_json TEXT NOT NULL DEFAULT '{}',
  imported_at TEXT NOT NULL,
  retired_at TEXT,
  UNIQUE (source_kind, source_id, migration_name)
);

CREATE INDEX IF NOT EXISTS control_legacy_imports_source_idx
  ON control_legacy_imports(source_kind, source_id, status);

CREATE INDEX IF NOT EXISTS control_legacy_imports_migration_idx
  ON control_legacy_imports(migration_name, migration_version, imported_at);
`.trim();

export function controlDbMigrationChecksum(sql: string): string {
  return createHash("sha256").update(sql.trim()).digest("hex");
}

export function createControlDbMigration(
  version: number,
  name: string,
  sql: string
): ControlDbMigration {
  return {
    version,
    name,
    sql: sql.trim(),
    checksum: controlDbMigrationChecksum(sql),
  };
}

export const CONTROL_DB_MIGRATIONS: readonly ControlDbMigration[] = [
  createControlDbMigration(
    1,
    "control-db-foundation",
    CONTROL_DB_INITIAL_SCHEMA_SQL
  ),
];
