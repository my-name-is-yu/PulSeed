import { createHash } from "node:crypto";

export interface ControlDbMigration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export const CONTROL_DB_SCHEMA_VERSION = 4;

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

export const CONTROL_DB_RUNTIME_STATE_OWNERSHIP_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS approval_records (
  approval_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  expires_at INTEGER NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS approval_records_state_idx
  ON approval_records(state, expires_at, approval_id);

CREATE INDEX IF NOT EXISTS approval_records_resolved_idx
  ON approval_records(resolved_at, approval_id);

CREATE TABLE IF NOT EXISTS permission_grants (
  grant_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  state_epoch INTEGER NOT NULL,
  expires_at INTEGER,
  review_due_at INTEGER,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS permission_grants_state_idx
  ON permission_grants(state, updated_at, grant_id);

CREATE INDEX IF NOT EXISTS permission_grants_scope_idx
  ON permission_grants(scope_kind, updated_at, grant_id);

CREATE INDEX IF NOT EXISTS permission_grants_subject_idx
  ON permission_grants(subject_kind, subject_id, updated_at, grant_id);

CREATE INDEX IF NOT EXISTS permission_grants_expiry_idx
  ON permission_grants(expires_at, grant_id);

CREATE INDEX IF NOT EXISTS permission_grants_review_idx
  ON permission_grants(review_due_at, grant_id);

CREATE TABLE IF NOT EXISTS permission_wait_plans (
  wait_plan_id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL,
  goal_id TEXT,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  resolved_at INTEGER,
  resumed_at INTEGER,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS permission_wait_plans_state_idx
  ON permission_wait_plans(state, updated_at, wait_plan_id);

CREATE INDEX IF NOT EXISTS permission_wait_plans_approval_idx
  ON permission_wait_plans(approval_id, updated_at, wait_plan_id);

CREATE INDEX IF NOT EXISTS permission_wait_plans_goal_idx
  ON permission_wait_plans(goal_id, updated_at, wait_plan_id);

CREATE TABLE IF NOT EXISTS outbox_records (
  seq INTEGER PRIMARY KEY CHECK (seq > 0),
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS outbox_records_created_idx
  ON outbox_records(created_at, seq);

CREATE TABLE IF NOT EXISTS runtime_safe_pauses (
  goal_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS runtime_safe_pauses_state_idx
  ON runtime_safe_pauses(state, updated_at, goal_id);

CREATE TABLE IF NOT EXISTS guardrail_breakers (
  breaker_key TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS guardrail_breakers_state_idx
  ON guardrail_breakers(state, updated_at, breaker_key);

CREATE TABLE IF NOT EXISTS guardrail_backpressure_snapshots (
  snapshot_id TEXT PRIMARY KEY CHECK (snapshot_id = 'current'),
  updated_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json))
);

CREATE TABLE IF NOT EXISTS leader_locks (
  lock_id TEXT PRIMARY KEY CHECK (lock_id = 'runtime_leader'),
  owner_token TEXT NOT NULL,
  pid INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  last_renewed_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS leader_locks_lease_idx
  ON leader_locks(lease_until, lock_id);

CREATE TABLE IF NOT EXISTS goal_leases (
  goal_id TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  last_renewed_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS goal_leases_lease_idx
  ON goal_leases(lease_until, goal_id);

CREATE INDEX IF NOT EXISTS goal_leases_worker_idx
  ON goal_leases(worker_id, lease_until, goal_id);
`.trim();

export const CONTROL_DB_QUEUE_DAEMON_SCHEDULE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runtime_queue_records (
  message_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'inflight', 'completed', 'deadletter')),
  priority TEXT NOT NULL CHECK (priority IN ('critical', 'high', 'normal', 'low')),
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  queue_order INTEGER,
  worker_id TEXT,
  claim_token TEXT UNIQUE,
  lease_until INTEGER,
  claimed_at INTEGER,
  completed_at INTEGER,
  deadletter_reason TEXT,
  dedupe_key TEXT,
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS runtime_queue_records_pending_idx
  ON runtime_queue_records(status, priority, queue_order, message_id);

CREATE INDEX IF NOT EXISTS runtime_queue_records_claim_idx
  ON runtime_queue_records(claim_token, lease_until, message_id);

CREATE INDEX IF NOT EXISTS runtime_queue_records_dedupe_idx
  ON runtime_queue_records(dedupe_key, status, message_id);

CREATE INDEX IF NOT EXISTS runtime_queue_records_updated_idx
  ON runtime_queue_records(updated_at, message_id);

CREATE TABLE IF NOT EXISTS daemon_state_snapshots (
  state_id TEXT PRIMARY KEY CHECK (state_id = 'current'),
  pid INTEGER,
  status TEXT NOT NULL,
  runtime_root TEXT,
  loop_count INTEGER NOT NULL CHECK (loop_count >= 0),
  updated_at TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json))
);

CREATE INDEX IF NOT EXISTS daemon_state_snapshots_status_idx
  ON daemon_state_snapshots(status, updated_at);

CREATE TABLE IF NOT EXISTS daemon_shutdown_markers (
  marker_id TEXT PRIMARY KEY CHECK (marker_id = 'current'),
  marker_state TEXT NOT NULL CHECK (marker_state IN ('running', 'clean_shutdown')),
  reason TEXT NOT NULL CHECK (reason IN ('signal', 'stop', 'max_retries', 'startup')),
  marker_timestamp TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  marker_json TEXT NOT NULL CHECK (json_valid(marker_json))
);

CREATE INDEX IF NOT EXISTS daemon_shutdown_markers_state_idx
  ON daemon_shutdown_markers(marker_state, marker_timestamp);

CREATE TABLE IF NOT EXISTS supervisor_state_snapshots (
  state_id TEXT PRIMARY KEY CHECK (state_id = 'current'),
  updated_at INTEGER NOT NULL,
  active_goal_count INTEGER NOT NULL CHECK (active_goal_count >= 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json))
);

CREATE INDEX IF NOT EXISTS supervisor_state_snapshots_updated_idx
  ON supervisor_state_snapshots(updated_at, state_id);

CREATE TABLE IF NOT EXISTS schedule_entries (
  entry_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  layer TEXT NOT NULL CHECK (layer IN ('heartbeat', 'probe', 'cron', 'goal_trigger')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  next_fire_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  internal INTEGER NOT NULL CHECK (internal IN (0, 1)),
  activation_kind TEXT,
  goal_id TEXT,
  wait_strategy_id TEXT,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  entry_json TEXT NOT NULL CHECK (json_valid(entry_json))
);

CREATE INDEX IF NOT EXISTS schedule_entries_due_idx
  ON schedule_entries(enabled, next_fire_at, layer, entry_id);

CREATE INDEX IF NOT EXISTS schedule_entries_wait_projection_idx
  ON schedule_entries(internal, activation_kind, goal_id, wait_strategy_id, next_fire_at);

CREATE INDEX IF NOT EXISTS schedule_entries_order_idx
  ON schedule_entries(sort_order, entry_id);

CREATE TABLE IF NOT EXISTS schedule_store_locks (
  lock_id TEXT PRIMARY KEY CHECK (lock_id = 'schedule_entries'),
  owner_token TEXT NOT NULL,
  owner_pid INTEGER,
  acquired_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS schedule_store_locks_lease_idx
  ON schedule_store_locks(lease_until, lock_id);

CREATE TABLE IF NOT EXISTS schedule_run_history (
  history_id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  entry_name TEXT NOT NULL,
  layer TEXT NOT NULL CHECK (layer IN ('heartbeat', 'probe', 'cron', 'goal_trigger')),
  reason TEXT NOT NULL CHECK (reason IN ('cadence', 'retry', 'escalation_target', 'manual_run')),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  internal INTEGER NOT NULL CHECK (internal IN (0, 1)),
  tokens_used INTEGER NOT NULL CHECK (tokens_used >= 0),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS schedule_run_history_finished_idx
  ON schedule_run_history(finished_at, history_id);

CREATE INDEX IF NOT EXISTS schedule_run_history_entry_idx
  ON schedule_run_history(entry_id, finished_at, history_id);

CREATE INDEX IF NOT EXISTS schedule_run_history_order_idx
  ON schedule_run_history(sort_order, history_id);
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
  createControlDbMigration(
    3,
    "runtime-state-ownership-stores",
    CONTROL_DB_RUNTIME_STATE_OWNERSHIP_SCHEMA_SQL
  ),
  createControlDbMigration(
    4,
    "queue-daemon-schedule-supervisor-state",
    CONTROL_DB_QUEUE_DAEMON_SCHEDULE_SCHEMA_SQL
  ),
];
