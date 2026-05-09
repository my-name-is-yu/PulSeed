import { createHash } from "node:crypto";

export interface ControlDbMigration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export const CONTROL_DB_SCHEMA_VERSION = 2;

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

export const CONTROL_DB_RUNTIME_CONTROL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runtime_operations (
  operation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  operation_json TEXT NOT NULL CHECK (json_valid(operation_json))
);

CREATE INDEX IF NOT EXISTS runtime_operations_state_idx
  ON runtime_operations(state, updated_at, operation_id);

CREATE INDEX IF NOT EXISTS runtime_operations_kind_idx
  ON runtime_operations(kind, updated_at, operation_id);

CREATE INDEX IF NOT EXISTS runtime_operations_terminal_idx
  ON runtime_operations(terminal, updated_at, operation_id);

CREATE TABLE IF NOT EXISTS runtime_operation_events (
  event_id TEXT PRIMARY KEY,
  operation_id TEXT,
  occurred_at TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  FOREIGN KEY (operation_id) REFERENCES runtime_operations(operation_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS runtime_operation_events_operation_idx
  ON runtime_operation_events(operation_id, occurred_at, event_id);

CREATE INDEX IF NOT EXISTS runtime_operation_events_occurred_idx
  ON runtime_operation_events(occurred_at, event_id);

CREATE TABLE IF NOT EXISTS background_runs (
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  parent_session_id TEXT,
  child_session_id TEXT,
  process_session_id TEXT,
  goal_id TEXT,
  created_at TEXT,
  updated_at TEXT,
  run_json TEXT NOT NULL CHECK (json_valid(run_json))
);

CREATE INDEX IF NOT EXISTS background_runs_status_idx
  ON background_runs(status, updated_at, run_id);

CREATE INDEX IF NOT EXISTS background_runs_kind_idx
  ON background_runs(kind, updated_at, run_id);

CREATE INDEX IF NOT EXISTS background_runs_parent_session_idx
  ON background_runs(parent_session_id, updated_at, run_id);

CREATE INDEX IF NOT EXISTS background_runs_child_session_idx
  ON background_runs(child_session_id, updated_at, run_id);

CREATE INDEX IF NOT EXISTS background_runs_process_session_idx
  ON background_runs(process_session_id, updated_at, run_id);

CREATE INDEX IF NOT EXISTS background_runs_goal_idx
  ON background_runs(goal_id, updated_at, run_id);

CREATE TABLE IF NOT EXISTS runtime_health_records (
  record_kind TEXT PRIMARY KEY CHECK (record_kind IN ('daemon', 'components')),
  checked_at INTEGER NOT NULL,
  status TEXT,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS runtime_health_records_checked_idx
  ON runtime_health_records(checked_at, record_kind);
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
  createControlDbMigration(
    2,
    "runtime-control-plane-stores",
    CONTROL_DB_RUNTIME_CONTROL_SCHEMA_SQL
  ),
];
