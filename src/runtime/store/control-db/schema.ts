import { createHash } from "node:crypto";

export interface ControlDbMigration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export const CONTROL_DB_SCHEMA_VERSION = 9;

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

export const CONTROL_DB_CHAT_AGENTLOOP_SESSION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  session_id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  title TEXT,
  parent_session_id TEXT,
  session_status TEXT,
  agent_loop_session_id TEXT,
  agent_loop_trace_id TEXT,
  message_count INTEGER NOT NULL CHECK (message_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  activity_at_ms INTEGER NOT NULL,
  session_json TEXT NOT NULL CHECK (json_valid(session_json))
);

CREATE INDEX IF NOT EXISTS chat_sessions_activity_idx
  ON chat_sessions(activity_at_ms DESC, updated_at DESC, session_id);

CREATE INDEX IF NOT EXISTS chat_sessions_cwd_idx
  ON chat_sessions(cwd, activity_at_ms DESC, session_id);

CREATE INDEX IF NOT EXISTS chat_sessions_agent_loop_idx
  ON chat_sessions(agent_loop_session_id, agent_loop_trace_id);

CREATE TABLE IF NOT EXISTS chat_cross_platform_sessions (
  session_key TEXT PRIMARY KEY,
  chat_session_id TEXT,
  identity_key TEXT,
  platform TEXT,
  conversation_id TEXT,
  user_id TEXT,
  cwd TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  info_json TEXT NOT NULL CHECK (json_valid(info_json))
);

CREATE INDEX IF NOT EXISTS chat_cross_platform_sessions_chat_idx
  ON chat_cross_platform_sessions(chat_session_id, last_used_at DESC, session_key);

CREATE INDEX IF NOT EXISTS chat_cross_platform_sessions_identity_idx
  ON chat_cross_platform_sessions(identity_key, platform, conversation_id, user_id);

CREATE TABLE IF NOT EXISTS agent_loop_session_states (
  session_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  parent_session_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('task', 'chat', 'review', 'unknown')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  goal_id TEXT NOT NULL,
  task_id TEXT,
  cwd TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  model_ref TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json))
);

CREATE INDEX IF NOT EXISTS agent_loop_session_states_trace_idx
  ON agent_loop_session_states(trace_id, updated_at, session_id);

CREATE INDEX IF NOT EXISTS agent_loop_session_states_status_idx
  ON agent_loop_session_states(kind, status, updated_at, session_id);

CREATE INDEX IF NOT EXISTS agent_loop_session_states_goal_idx
  ON agent_loop_session_states(goal_id, updated_at, session_id);

CREATE TABLE IF NOT EXISTS agent_loop_trace_events (
  event_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  event_json TEXT NOT NULL CHECK (json_valid(event_json))
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_loop_trace_events_trace_sequence_idx
  ON agent_loop_trace_events(trace_id, sequence);

CREATE INDEX IF NOT EXISTS agent_loop_trace_events_session_idx
  ON agent_loop_trace_events(session_id, created_at, event_id);

CREATE INDEX IF NOT EXISTS agent_loop_trace_events_type_idx
  ON agent_loop_trace_events(event_type, created_at, event_id);
`.trim();

export const CONTROL_DB_GOAL_TASK_DURABLE_LOOP_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS goal_records (
  goal_id TEXT PRIMARY KEY,
  parent_goal_id TEXT,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  goal_json TEXT NOT NULL CHECK (json_valid(goal_json))
);

CREATE INDEX IF NOT EXISTS goal_records_status_idx
  ON goal_records(archived, status, updated_at, goal_id);

CREATE INDEX IF NOT EXISTS goal_records_parent_idx
  ON goal_records(parent_goal_id, archived, goal_id);

CREATE TABLE IF NOT EXISTS goal_tree_records (
  root_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  tree_json TEXT NOT NULL CHECK (json_valid(tree_json))
);

CREATE TABLE IF NOT EXISTS goal_observation_logs (
  goal_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  log_json TEXT NOT NULL CHECK (json_valid(log_json))
);

CREATE TABLE IF NOT EXISTS goal_gap_histories (
  goal_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  history_json TEXT NOT NULL CHECK (json_valid(history_json))
);

CREATE TABLE IF NOT EXISTS goal_loop_checkpoints (
  goal_id TEXT PRIMARY KEY,
  adapter_type TEXT,
  cycle_number INTEGER NOT NULL CHECK (cycle_number >= 0),
  updated_at TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json))
);

CREATE INDEX IF NOT EXISTS goal_loop_checkpoints_cycle_idx
  ON goal_loop_checkpoints(cycle_number, updated_at, goal_id);

CREATE TABLE IF NOT EXISTS goal_stall_records (
  goal_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE TABLE IF NOT EXISTS task_records (
  goal_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  primary_dimension TEXT NOT NULL,
  strategy_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  task_json TEXT NOT NULL CHECK (json_valid(task_json)),
  PRIMARY KEY (goal_id, task_id)
);

CREATE INDEX IF NOT EXISTS task_records_goal_status_idx
  ON task_records(goal_id, status, updated_at, task_id);

CREATE INDEX IF NOT EXISTS task_records_status_idx
  ON task_records(status, updated_at, goal_id, task_id);

CREATE INDEX IF NOT EXISTS task_records_strategy_idx
  ON task_records(goal_id, strategy_id, status, updated_at, task_id);

CREATE TABLE IF NOT EXISTS task_history_records (
  history_id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id TEXT NOT NULL,
  task_id TEXT,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS task_history_records_goal_order_idx
  ON task_history_records(goal_id, sort_order, history_id);

CREATE INDEX IF NOT EXISTS task_history_records_task_idx
  ON task_history_records(goal_id, task_id, history_id);

CREATE TABLE IF NOT EXISTS task_outcome_events (
  goal_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  event_index INTEGER NOT NULL CHECK (event_index >= 0),
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  PRIMARY KEY (goal_id, task_id, event_index)
);

CREATE INDEX IF NOT EXISTS task_outcome_events_goal_idx
  ON task_outcome_events(goal_id, occurred_at, task_id, event_index);

CREATE INDEX IF NOT EXISTS task_outcome_events_type_idx
  ON task_outcome_events(event_type, occurred_at, goal_id, task_id);

CREATE TABLE IF NOT EXISTS task_outcome_summaries (
  goal_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  latest_event_type TEXT,
  latest_event_at TEXT,
  task_status TEXT NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  updated_at TEXT NOT NULL,
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  PRIMARY KEY (goal_id, task_id)
);

CREATE INDEX IF NOT EXISTS task_outcome_summaries_goal_idx
  ON task_outcome_summaries(goal_id, latest_event_at, task_id);

CREATE INDEX IF NOT EXISTS task_outcome_summaries_type_idx
  ON task_outcome_summaries(latest_event_type, latest_event_at, goal_id, task_id);

CREATE TABLE IF NOT EXISTS task_failure_contexts (
  goal_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  context_json TEXT NOT NULL CHECK (json_valid(context_json))
);

CREATE TABLE IF NOT EXISTS task_verification_results (
  task_id TEXT PRIMARY KEY,
  goal_id TEXT,
  verdict TEXT,
  result_timestamp TEXT,
  updated_at TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json))
);

CREATE INDEX IF NOT EXISTS task_verification_results_goal_idx
  ON task_verification_results(goal_id, result_timestamp, task_id);

CREATE INDEX IF NOT EXISTS task_verification_results_verdict_idx
  ON task_verification_results(verdict, result_timestamp, task_id);

CREATE TABLE IF NOT EXISTS task_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json))
);

CREATE INDEX IF NOT EXISTS task_checkpoints_goal_created_idx
  ON task_checkpoints(goal_id, created_at, checkpoint_id);

CREATE INDEX IF NOT EXISTS task_checkpoints_task_created_idx
  ON task_checkpoints(goal_id, task_id, created_at, checkpoint_id);

CREATE INDEX IF NOT EXISTS task_checkpoints_agent_idx
  ON task_checkpoints(agent_id, created_at, checkpoint_id);

CREATE TABLE IF NOT EXISTS pipeline_state_records (
  task_id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_stage_index INTEGER NOT NULL CHECK (current_stage_index >= 0),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  pipeline_json TEXT NOT NULL CHECK (json_valid(pipeline_json))
);

CREATE UNIQUE INDEX IF NOT EXISTS pipeline_state_records_pipeline_idx
  ON pipeline_state_records(pipeline_id);

CREATE INDEX IF NOT EXISTS pipeline_state_records_status_idx
  ON pipeline_state_records(status, updated_at, task_id);
`.trim();

export const CONTROL_DB_RUNTIME_EVIDENCE_STRATEGY_DREAM_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runtime_evidence_entries (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('goal', 'run')),
  scope_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  outcome TEXT,
  goal_id TEXT,
  run_id TEXT,
  task_id TEXT,
  source_ref TEXT,
  entry_json TEXT NOT NULL CHECK (json_valid(entry_json)),
  PRIMARY KEY (scope_kind, scope_id, entry_id)
);

CREATE INDEX IF NOT EXISTS runtime_evidence_entries_scope_time_idx
  ON runtime_evidence_entries(scope_kind, scope_id, occurred_at, entry_id);

CREATE INDEX IF NOT EXISTS runtime_evidence_entries_goal_idx
  ON runtime_evidence_entries(goal_id, occurred_at, entry_id);

CREATE INDEX IF NOT EXISTS runtime_evidence_entries_run_idx
  ON runtime_evidence_entries(run_id, occurred_at, entry_id);

CREATE INDEX IF NOT EXISTS runtime_evidence_entries_kind_idx
  ON runtime_evidence_entries(kind, occurred_at, entry_id);

CREATE TABLE IF NOT EXISTS runtime_evidence_summary_indexes (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('goal', 'run')),
  scope_id TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  append_state_json TEXT,
  checkpoint_json TEXT,
  PRIMARY KEY (scope_kind, scope_id),
  CHECK (append_state_json IS NULL OR json_valid(append_state_json)),
  CHECK (checkpoint_json IS NULL OR json_valid(checkpoint_json))
);

CREATE INDEX IF NOT EXISTS runtime_evidence_summary_indexes_generated_idx
  ON runtime_evidence_summary_indexes(generated_at, scope_kind, scope_id);

CREATE TABLE IF NOT EXISTS strategy_portfolios (
  goal_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  portfolio_json TEXT NOT NULL CHECK (json_valid(portfolio_json))
);

CREATE TABLE IF NOT EXISTS strategy_history_records (
  goal_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  updated_at TEXT NOT NULL,
  strategy_json TEXT NOT NULL CHECK (json_valid(strategy_json)),
  PRIMARY KEY (goal_id, strategy_id)
);

CREATE INDEX IF NOT EXISTS strategy_history_records_order_idx
  ON strategy_history_records(goal_id, sort_order, strategy_id);

CREATE TABLE IF NOT EXISTS strategy_wait_metadata (
  goal_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  PRIMARY KEY (goal_id, strategy_id)
);

CREATE TABLE IF NOT EXISTS strategy_rebalance_history (
  goal_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  rebalance_at TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  PRIMARY KEY (goal_id, sort_order)
);

CREATE INDEX IF NOT EXISTS strategy_rebalance_history_time_idx
  ON strategy_rebalance_history(goal_id, rebalance_at, sort_order);

CREATE TABLE IF NOT EXISTS process_session_snapshots (
  session_id TEXT PRIMARY KEY,
  label TEXT,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  goal_id TEXT,
  task_id TEXT,
  strategy_id TEXT,
  pid INTEGER,
  running INTEGER NOT NULL CHECK (running IN (0, 1)),
  exit_code INTEGER,
  signal TEXT,
  started_at TEXT NOT NULL,
  exited_at TEXT,
  updated_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json))
);

CREATE INDEX IF NOT EXISTS process_session_snapshots_goal_idx
  ON process_session_snapshots(goal_id, strategy_id, task_id, updated_at);

CREATE INDEX IF NOT EXISTS process_session_snapshots_running_idx
  ON process_session_snapshots(running, updated_at, session_id);

CREATE TABLE IF NOT EXISTS dream_iteration_logs (
  goal_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  session_id TEXT,
  iteration INTEGER NOT NULL CHECK (iteration >= 0),
  timestamp TEXT NOT NULL,
  entry_json TEXT NOT NULL CHECK (json_valid(entry_json)),
  PRIMARY KEY (goal_id, entry_id),
  UNIQUE (goal_id, sequence)
);

CREATE INDEX IF NOT EXISTS dream_iteration_logs_goal_sequence_idx
  ON dream_iteration_logs(goal_id, sequence);

CREATE INDEX IF NOT EXISTS dream_iteration_logs_timestamp_idx
  ON dream_iteration_logs(timestamp, goal_id, sequence);

CREATE TABLE IF NOT EXISTS dream_session_logs (
  session_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  entry_json TEXT NOT NULL CHECK (json_valid(entry_json))
);

CREATE INDEX IF NOT EXISTS dream_session_logs_goal_time_idx
  ON dream_session_logs(goal_id, timestamp, sequence);

CREATE TABLE IF NOT EXISTS dream_event_logs (
  goal_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL,
  task_id TEXT,
  timestamp TEXT NOT NULL,
  entry_json TEXT NOT NULL CHECK (json_valid(entry_json)),
  PRIMARY KEY (goal_id, entry_id),
  UNIQUE (goal_id, sequence)
);

CREATE INDEX IF NOT EXISTS dream_event_logs_goal_sequence_idx
  ON dream_event_logs(goal_id, sequence);

CREATE INDEX IF NOT EXISTS dream_event_logs_type_idx
  ON dream_event_logs(event_type, timestamp, goal_id, sequence);

CREATE TABLE IF NOT EXISTS dream_importance_entries (
  entry_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  sequence INTEGER UNIQUE NOT NULL,
  timestamp TEXT NOT NULL,
  importance REAL NOT NULL,
  processed INTEGER NOT NULL CHECK (processed IN (0, 1)),
  entry_json TEXT NOT NULL CHECK (json_valid(entry_json))
);

CREATE INDEX IF NOT EXISTS dream_importance_entries_goal_sequence_idx
  ON dream_importance_entries(goal_id, sequence);

CREATE INDEX IF NOT EXISTS dream_importance_entries_processed_idx
  ON dream_importance_entries(processed, timestamp, entry_id);

CREATE TABLE IF NOT EXISTS dream_watermark_state (
  state_id TEXT PRIMARY KEY CHECK (state_id = 'current'),
  updated_at TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json))
);

CREATE TABLE IF NOT EXISTS dream_schedule_suggestions (
  suggestion_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected', 'dismissed')),
  generated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  goal_id TEXT,
  suggestion_json TEXT NOT NULL CHECK (json_valid(suggestion_json))
);

CREATE INDEX IF NOT EXISTS dream_schedule_suggestions_status_idx
  ON dream_schedule_suggestions(status, updated_at, suggestion_id);

CREATE TABLE IF NOT EXISTS dream_playbooks (
  playbook_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('candidate', 'promoted', 'disabled')),
  updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS dream_playbooks_status_idx
  ON dream_playbooks(status, updated_at, playbook_id);

CREATE TABLE IF NOT EXISTS dream_activation_artifacts (
  artifact_id TEXT PRIMARY KEY,
  artifact_type TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  updated_at TEXT NOT NULL,
  artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json))
);

CREATE INDEX IF NOT EXISTS dream_activation_artifacts_type_idx
  ON dream_activation_artifacts(artifact_type, valid_from, artifact_id);

CREATE TABLE IF NOT EXISTS dream_workflows (
  workflow_id TEXT PRIMARY KEY,
  workflow_type TEXT NOT NULL CHECK (workflow_type IN ('stall_recovery', 'verification_recovery')),
  updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS dream_workflows_type_idx
  ON dream_workflows(workflow_type, updated_at, workflow_id);
`.trim();

export const CONTROL_DB_KNOWLEDGE_MEMORY_SOIL_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
`.trim();

export const CONTROL_DB_PLUGIN_CHANNEL_RUNTIME_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS plugin_runtime_states (
  plugin_name TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('loaded', 'error', 'disabled', 'incompatible')),
  manifest_name TEXT NOT NULL,
  manifest_version TEXT NOT NULL,
  manifest_type TEXT NOT NULL,
  loaded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  trust_score INTEGER NOT NULL,
  usage_count INTEGER NOT NULL,
  success_count INTEGER NOT NULL,
  failure_count INTEGER NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json))
);

CREATE INDEX IF NOT EXISTS plugin_runtime_states_status_idx
  ON plugin_runtime_states(status, updated_at, plugin_name);

CREATE INDEX IF NOT EXISTS plugin_runtime_states_manifest_idx
  ON plugin_runtime_states(manifest_type, manifest_name, manifest_version);

CREATE TABLE IF NOT EXISTS gateway_channel_health (
  channel_name TEXT PRIMARY KEY,
  last_inbound_at TEXT,
  last_outbound_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  health_json TEXT NOT NULL CHECK (json_valid(health_json))
);

CREATE INDEX IF NOT EXISTS gateway_channel_health_updated_idx
  ON gateway_channel_health(updated_at, channel_name);

CREATE TABLE IF NOT EXISTS gateway_channel_bindings (
  channel_name TEXT PRIMARY KEY,
  home_target_id TEXT,
  first_bound_actor_id TEXT,
  updated_at TEXT NOT NULL,
  binding_json TEXT NOT NULL CHECK (json_valid(binding_json))
);

CREATE INDEX IF NOT EXISTS gateway_channel_bindings_home_idx
  ON gateway_channel_bindings(home_target_id, channel_name);

CREATE TABLE IF NOT EXISTS imported_plugin_compatibility_reports (
  plugin_dir TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  plugin_name TEXT NOT NULL,
  status TEXT NOT NULL,
  runtime_loadable INTEGER NOT NULL CHECK (runtime_loadable IN (0, 1)),
  report_ref TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  report_json TEXT NOT NULL CHECK (json_valid(report_json))
);

CREATE INDEX IF NOT EXISTS imported_plugin_compatibility_status_idx
  ON imported_plugin_compatibility_reports(status, recorded_at, plugin_dir);

CREATE TABLE IF NOT EXISTS imported_plugin_review_records (
  plugin_dir TEXT PRIMARY KEY,
  plugin_name TEXT NOT NULL,
  status TEXT NOT NULL,
  report_ref TEXT NOT NULL,
  review_ref TEXT NOT NULL,
  runtime_loadable INTEGER NOT NULL CHECK (runtime_loadable IN (0, 1)),
  load_authority TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  review_json TEXT NOT NULL CHECK (json_valid(review_json)),
  FOREIGN KEY (plugin_dir) REFERENCES imported_plugin_compatibility_reports(plugin_dir) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS imported_plugin_review_status_idx
  ON imported_plugin_review_records(status, created_at, plugin_dir);

CREATE TABLE IF NOT EXISTS runtime_asset_records (
  asset_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  source_agent TEXT NOT NULL,
  imported_path TEXT,
  updated_at TEXT NOT NULL,
  asset_json TEXT NOT NULL CHECK (json_valid(asset_json))
);

CREATE INDEX IF NOT EXISTS runtime_asset_records_kind_idx
  ON runtime_asset_records(kind, status, updated_at, asset_id);

CREATE INDEX IF NOT EXISTS runtime_asset_records_source_idx
  ON runtime_asset_records(source_agent, updated_at, asset_id);
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
  createControlDbMigration(
    5,
    "chat-agentloop-session-data-plane",
    CONTROL_DB_CHAT_AGENTLOOP_SESSION_SCHEMA_SQL
  ),
  createControlDbMigration(
    6,
    "goal-task-durable-loop-state",
    CONTROL_DB_GOAL_TASK_DURABLE_LOOP_SCHEMA_SQL
  ),
  createControlDbMigration(
    7,
    "runtime-evidence-strategy-dream-state",
    CONTROL_DB_RUNTIME_EVIDENCE_STRATEGY_DREAM_SCHEMA_SQL
  ),
  createControlDbMigration(
    8,
    "knowledge-memory-soil-state",
    CONTROL_DB_KNOWLEDGE_MEMORY_SOIL_SCHEMA_SQL
  ),
  createControlDbMigration(
    9,
    "plugin-channel-runtime-state",
    CONTROL_DB_PLUGIN_CHANNEL_RUNTIME_SCHEMA_SQL
  ),
];
