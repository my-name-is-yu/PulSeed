import { createHash } from "node:crypto";

export interface ControlDbMigration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export const CONTROL_DB_SCHEMA_VERSION = 17;

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

export const CONTROL_DB_GOAL_ORCHESTRATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS goal_negotiation_logs (
  goal_id TEXT PRIMARY KEY,
  log_timestamp TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  log_json TEXT NOT NULL CHECK (json_valid(log_json))
);

CREATE INDEX IF NOT EXISTS goal_negotiation_logs_timestamp_idx
  ON goal_negotiation_logs(log_timestamp, goal_id);

CREATE TABLE IF NOT EXISTS goal_dependency_graph_state (
  graph_id TEXT PRIMARY KEY CHECK (graph_id = 'current'),
  updated_at TEXT NOT NULL,
  graph_json TEXT NOT NULL CHECK (json_valid(graph_json))
);

CREATE INDEX IF NOT EXISTS goal_dependency_graph_state_updated_idx
  ON goal_dependency_graph_state(updated_at, graph_id);
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

export const CONTROL_DB_GOAL_STATE_WRITE_LOCK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS goal_state_write_locks (
  goal_id TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  owner_pid INTEGER,
  acquired_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS goal_state_write_locks_lease_idx
  ON goal_state_write_locks(lease_until, goal_id);
`.trim();

export const CONTROL_DB_EXECUTION_SESSION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS execution_sessions (
  session_id TEXT PRIMARY KEY,
  session_type TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  task_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  updated_at TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  session_json TEXT NOT NULL CHECK (json_valid(session_json))
);

CREATE INDEX IF NOT EXISTS execution_sessions_goal_active_idx
  ON execution_sessions(goal_id, active, started_at DESC, session_id);

CREATE INDEX IF NOT EXISTS execution_sessions_started_idx
  ON execution_sessions(started_at DESC, session_id);

CREATE INDEX IF NOT EXISTS execution_sessions_goal_idx
  ON execution_sessions(goal_id, started_at DESC, session_id);
`.trim();

export const CONTROL_DB_CAPABILITY_REGISTRY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS capability_registry_metadata (
  registry_id TEXT PRIMARY KEY CHECK (registry_id = 'current'),
  last_checked TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capability_registry_entries (
  capability_id TEXT PRIMARY KEY,
  capability_name TEXT NOT NULL,
  capability_type TEXT NOT NULL,
  capability_status TEXT NOT NULL,
  provider TEXT,
  acquired_at TEXT,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  updated_at TEXT NOT NULL,
  capability_json TEXT NOT NULL CHECK (json_valid(capability_json))
);

CREATE INDEX IF NOT EXISTS capability_registry_entries_name_idx
  ON capability_registry_entries(capability_name, capability_status, sort_order, capability_id);

CREATE INDEX IF NOT EXISTS capability_registry_entries_status_idx
  ON capability_registry_entries(capability_status, updated_at, capability_id);
`.trim();

export const CONTROL_DB_RUNTIME_JOURNAL_REPLACEMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runtime_operator_handoffs (
  handoff_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('open', 'approved', 'resolved', 'dismissed')),
  goal_id TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS runtime_operator_handoffs_status_idx
  ON runtime_operator_handoffs(status, updated_at, handoff_id);

CREATE INDEX IF NOT EXISTS runtime_operator_handoffs_goal_idx
  ON runtime_operator_handoffs(goal_id, status, updated_at, handoff_id);

CREATE INDEX IF NOT EXISTS runtime_operator_handoffs_run_idx
  ON runtime_operator_handoffs(run_id, status, updated_at, handoff_id);

CREATE TABLE IF NOT EXISTS runtime_budgets (
  budget_id TEXT PRIMARY KEY,
  goal_id TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS runtime_budgets_goal_idx
  ON runtime_budgets(goal_id, updated_at, budget_id);

CREATE INDEX IF NOT EXISTS runtime_budgets_run_idx
  ON runtime_budgets(run_id, updated_at, budget_id);

CREATE TABLE IF NOT EXISTS runtime_experiment_queues (
  queue_id TEXT PRIMARY KEY,
  goal_id TEXT,
  run_id TEXT,
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS runtime_experiment_queues_goal_idx
  ON runtime_experiment_queues(goal_id, updated_at, queue_id);

CREATE INDEX IF NOT EXISTS runtime_experiment_queues_run_idx
  ON runtime_experiment_queues(run_id, updated_at, queue_id);

CREATE TABLE IF NOT EXISTS capability_verification_refs (
  verification_id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  asset_ref TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  payload_class TEXT NOT NULL,
  risk_class TEXT NOT NULL,
  side_effect_profile TEXT NOT NULL,
  verification_class TEXT NOT NULL,
  result TEXT NOT NULL,
  evidence_stage TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS capability_verification_refs_operation_idx
  ON capability_verification_refs(capability_id, provider_ref, asset_ref, operation_kind, tool_name, payload_class, risk_class, side_effect_profile, created_at, verification_id);

CREATE INDEX IF NOT EXISTS capability_verification_refs_created_idx
  ON capability_verification_refs(created_at, verification_id);

CREATE TABLE IF NOT EXISTS capability_audit_records (
  audit_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  result TEXT NOT NULL,
  follow_up_policy_effect TEXT NOT NULL,
  created_at TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS capability_audit_records_created_idx
  ON capability_audit_records(created_at, audit_id);

CREATE INDEX IF NOT EXISTS capability_audit_records_operation_idx
  ON capability_audit_records(operation_id, created_at, audit_id);

CREATE TABLE IF NOT EXISTS browser_automation_sessions (
  session_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  service_key TEXT NOT NULL,
  workspace TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('fresh', 'authenticated', 'auth_required', 'expired', 'blocked', 'unavailable')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_auth_at TEXT,
  expires_at TEXT,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS browser_automation_sessions_scope_idx
  ON browser_automation_sessions(provider_id, service_key, workspace, actor_key, state, updated_at, session_id);

CREATE INDEX IF NOT EXISTS browser_automation_sessions_state_idx
  ON browser_automation_sessions(state, updated_at, session_id);

CREATE TABLE IF NOT EXISTS runtime_auth_handoffs (
  handoff_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  service_key TEXT NOT NULL,
  workspace TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested', 'pending_operator', 'in_progress', 'completed', 'cancelled', 'expired', 'superseded', 'blocked')),
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  completed_at TEXT,
  supersedes_handoff_id TEXT,
  superseded_by_handoff_id TEXT,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS runtime_auth_handoffs_scope_idx
  ON runtime_auth_handoffs(provider_id, service_key, workspace, actor_key, state, updated_at, handoff_id);

CREATE INDEX IF NOT EXISTS runtime_auth_handoffs_state_idx
  ON runtime_auth_handoffs(state, updated_at, handoff_id);

CREATE TABLE IF NOT EXISTS proactive_intervention_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  intervention_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('intervention', 'feedback')),
  recorded_at TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('daemon', 'cli', 'gateway')),
  event_json TEXT NOT NULL CHECK (json_valid(event_json))
);

CREATE INDEX IF NOT EXISTS proactive_intervention_events_intervention_idx
  ON proactive_intervention_events(intervention_id, sequence);

CREATE INDEX IF NOT EXISTS proactive_intervention_events_recorded_idx
  ON proactive_intervention_events(recorded_at, sequence);
`.trim();

export const CONTROL_DB_CURIOSITY_STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS curiosity_state_metadata (
  state_id TEXT PRIMARY KEY CHECK (state_id = 'current'),
  last_exploration_at TEXT,
  updated_at TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json))
);

CREATE TABLE IF NOT EXISTS curiosity_proposals (
  proposal_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'auto_closed')),
  goal_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  reviewed_at TEXT,
  rejection_cooldown_until TEXT,
  loop_count INTEGER NOT NULL CHECK (loop_count >= 0),
  trigger_type TEXT NOT NULL,
  trigger_source_goal_id TEXT,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  updated_at TEXT NOT NULL,
  proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json))
);

CREATE INDEX IF NOT EXISTS curiosity_proposals_status_idx
  ON curiosity_proposals(status, created_at, proposal_id);

CREATE INDEX IF NOT EXISTS curiosity_proposals_goal_idx
  ON curiosity_proposals(goal_id, status, created_at, proposal_id);

CREATE INDEX IF NOT EXISTS curiosity_proposals_trigger_idx
  ON curiosity_proposals(trigger_type, trigger_source_goal_id, created_at, proposal_id);

CREATE TABLE IF NOT EXISTS curiosity_learning_records (
  record_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id TEXT NOT NULL,
  dimension_name TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'partial')),
  recorded_at TEXT NOT NULL,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE INDEX IF NOT EXISTS curiosity_learning_records_goal_idx
  ON curiosity_learning_records(goal_id, recorded_at, record_sequence);

CREATE INDEX IF NOT EXISTS curiosity_learning_records_dimension_idx
  ON curiosity_learning_records(dimension_name, recorded_at, record_sequence);

CREATE TABLE IF NOT EXISTS curiosity_rejected_proposal_hashes (
  proposal_hash TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS curiosity_rejected_proposal_hashes_order_idx
  ON curiosity_rejected_proposal_hashes(sort_order, proposal_hash);
`.trim();

export const CONTROL_DB_TRUST_ETHICS_PROFILE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS trust_state_metadata (
  state_id TEXT PRIMARY KEY CHECK (state_id = 'current'),
  updated_at TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json))
);

CREATE TABLE IF NOT EXISTS trust_balances (
  domain TEXT PRIMARY KEY,
  balance REAL NOT NULL CHECK (balance >= -100 AND balance <= 100),
  success_delta REAL NOT NULL,
  failure_delta REAL NOT NULL,
  updated_at TEXT NOT NULL,
  balance_json TEXT NOT NULL CHECK (json_valid(balance_json))
);

CREATE TABLE IF NOT EXISTS trust_permanent_gates (
  domain TEXT NOT NULL,
  category TEXT NOT NULL,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (domain, category)
);

CREATE INDEX IF NOT EXISTS trust_permanent_gates_domain_idx
  ON trust_permanent_gates(domain, sort_order, category);

CREATE TABLE IF NOT EXISTS trust_override_log (
  log_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_timestamp TEXT NOT NULL,
  override_type TEXT NOT NULL CHECK (override_type IN ('trust_grant', 'permanent_gate')),
  domain TEXT NOT NULL,
  target_category TEXT,
  balance_before REAL,
  balance_after REAL,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  entry_json TEXT NOT NULL CHECK (json_valid(entry_json))
);

CREATE INDEX IF NOT EXISTS trust_override_log_domain_idx
  ON trust_override_log(domain, event_timestamp, log_sequence);

CREATE TABLE IF NOT EXISTS ethics_log_entries (
  log_id TEXT PRIMARY KEY,
  event_timestamp TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('goal', 'subgoal', 'task')),
  subject_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'flag', 'reject')),
  category TEXT,
  layer1_triggered INTEGER NOT NULL CHECK (layer1_triggered IN (0, 1)),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  entry_json TEXT NOT NULL CHECK (json_valid(entry_json))
);

CREATE INDEX IF NOT EXISTS ethics_log_entries_subject_idx
  ON ethics_log_entries(subject_id, event_timestamp, log_id);

CREATE INDEX IF NOT EXISTS ethics_log_entries_verdict_idx
  ON ethics_log_entries(verdict, event_timestamp, log_id);

CREATE TABLE IF NOT EXISTS relationship_profile_proposal_metadata (
  profile_id TEXT PRIMARY KEY,
  updated_at TEXT,
  store_json TEXT NOT NULL CHECK (json_valid(store_json))
);

CREATE TABLE IF NOT EXISTS relationship_profile_proposals (
  proposal_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert_item', 'retract_item')),
  approval_state TEXT NOT NULL CHECK (approval_state IN ('pending', 'approved', 'rejected', 'applied', 'superseded', 'expired')),
  source TEXT NOT NULL CHECK (source IN ('cli_proposal', 'setup_import', 'proactive_feedback', 'system_migration')),
  stable_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json)),
  FOREIGN KEY (profile_id) REFERENCES relationship_profile_proposal_metadata(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS relationship_profile_proposals_state_idx
  ON relationship_profile_proposals(approval_state, updated_at, proposal_id);

CREATE INDEX IF NOT EXISTS relationship_profile_proposals_stable_key_idx
  ON relationship_profile_proposals(stable_key, approval_state, proposal_id);

CREATE TABLE IF NOT EXISTS relationship_profile_proposal_audit_events (
  event_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  event_timestamp TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'approved', 'rejected', 'applied', 'superseded', 'expired')),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  FOREIGN KEY (proposal_id) REFERENCES relationship_profile_proposals(proposal_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS relationship_profile_proposal_events_proposal_idx
  ON relationship_profile_proposal_audit_events(proposal_id, event_timestamp, event_id);
`.trim();

export const CONTROL_DB_MEMORY_LIFECYCLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_lifecycle_short_term_entries (
  entry_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  data_type TEXT NOT NULL CHECK (data_type IN ('experience_log', 'observation', 'strategy', 'task', 'knowledge')),
  loop_number INTEGER NOT NULL CHECK (loop_number >= 0),
  event_timestamp TEXT NOT NULL,
  memory_tier TEXT NOT NULL CHECK (memory_tier IN ('core', 'recall', 'archival')),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  entry_json TEXT NOT NULL CHECK (json_valid(entry_json))
);

CREATE INDEX IF NOT EXISTS memory_lifecycle_short_term_goal_type_idx
  ON memory_lifecycle_short_term_entries(goal_id, data_type, sort_order, entry_id);

CREATE INDEX IF NOT EXISTS memory_lifecycle_short_term_goal_idx
  ON memory_lifecycle_short_term_entries(goal_id, sort_order, entry_id);

CREATE TABLE IF NOT EXISTS memory_lifecycle_index_entries (
  index_id TEXT PRIMARY KEY,
  layer TEXT NOT NULL CHECK (layer IN ('short-term', 'long-term')),
  entry_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  event_timestamp TEXT NOT NULL,
  last_accessed TEXT NOT NULL,
  access_count INTEGER NOT NULL CHECK (access_count >= 0),
  memory_tier TEXT NOT NULL CHECK (memory_tier IN ('core', 'recall', 'archival')),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  entry_json TEXT NOT NULL CHECK (json_valid(entry_json))
);

CREATE INDEX IF NOT EXISTS memory_lifecycle_index_layer_goal_idx
  ON memory_lifecycle_index_entries(layer, goal_id, sort_order, index_id);

CREATE INDEX IF NOT EXISTS memory_lifecycle_index_entry_idx
  ON memory_lifecycle_index_entries(layer, entry_id, index_id);

CREATE TABLE IF NOT EXISTS memory_lifecycle_lessons (
  lesson_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'archived')),
  extracted_at TEXT NOT NULL,
  lesson_json TEXT NOT NULL CHECK (json_valid(lesson_json))
);

CREATE INDEX IF NOT EXISTS memory_lifecycle_lessons_goal_idx
  ON memory_lifecycle_lessons(goal_id, status, extracted_at, lesson_id);

CREATE INDEX IF NOT EXISTS memory_lifecycle_lessons_status_idx
  ON memory_lifecycle_lessons(status, extracted_at, lesson_id);

CREATE TABLE IF NOT EXISTS memory_lifecycle_statistics (
  goal_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json))
);

CREATE TABLE IF NOT EXISTS memory_lifecycle_archives (
  archive_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  archive_kind TEXT NOT NULL,
  data_type TEXT,
  archived_at TEXT NOT NULL,
  archive_json TEXT NOT NULL CHECK (json_valid(archive_json))
);

CREATE INDEX IF NOT EXISTS memory_lifecycle_archives_goal_idx
  ON memory_lifecycle_archives(goal_id, archived_at, archive_id);

CREATE TABLE IF NOT EXISTS dream_decision_heuristics (
  heuristic_id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  updated_at TEXT NOT NULL,
  heuristic_json TEXT NOT NULL CHECK (json_valid(heuristic_json))
);

CREATE INDEX IF NOT EXISTS dream_decision_heuristics_order_idx
  ON dream_decision_heuristics(sort_order, heuristic_id);
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
  createControlDbMigration(
    10,
    "goal-state-write-locks",
    CONTROL_DB_GOAL_STATE_WRITE_LOCK_SCHEMA_SQL
  ),
  createControlDbMigration(
    11,
    "execution-session-state",
    CONTROL_DB_EXECUTION_SESSION_SCHEMA_SQL
  ),
  createControlDbMigration(
    12,
    "capability-registry-state",
    CONTROL_DB_CAPABILITY_REGISTRY_SCHEMA_SQL
  ),
  createControlDbMigration(
    13,
    "runtime-journal-replacement-stores",
    CONTROL_DB_RUNTIME_JOURNAL_REPLACEMENT_SCHEMA_SQL
  ),
  createControlDbMigration(
    14,
    "curiosity-runtime-state",
    CONTROL_DB_CURIOSITY_STATE_SCHEMA_SQL
  ),
  createControlDbMigration(
    15,
    "trust-ethics-profile-runtime-state",
    CONTROL_DB_TRUST_ETHICS_PROFILE_SCHEMA_SQL
  ),
  createControlDbMigration(
    16,
    "memory-dream-boundary-runtime-state",
    CONTROL_DB_MEMORY_LIFECYCLE_SCHEMA_SQL
  ),
  createControlDbMigration(
    17,
    "goal-orchestration-runtime-state",
    CONTROL_DB_GOAL_ORCHESTRATION_SCHEMA_SQL
  ),
];
