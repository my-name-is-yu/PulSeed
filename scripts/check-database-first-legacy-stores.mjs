#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CATEGORY = Object.freeze({
  MIGRATE_NOW: "migrate now",
  TYPED_STORE_MIGRATE_NOW: "typed-store migrate now",
  MIGRATION_ONLY_INPUT: "migration-only input",
  DEBUG_EXPORT_OUTPUT: "debug/export output",
  DEBUG_EXPORT_ARTIFACT: "debug/export artifact",
  CONFIG_SECRET: "config/secret",
  USER_AUTHORED_CONTENT: "user-authored content",
  WORKSPACE_CONTENT: "workspace content",
  WORKSPACE_USER_ARTIFACT: "workspace/user artifact",
  SOIL_IMPORT_PUBLISH_ARTIFACT: "Soil import/publish artifact",
  REPRODUCIBILITY_ARTIFACT: "reproducibility artifact",
  BOUNDED_IPC_SPOOL: "bounded IPC/spool",
  PRODUCT_DECISION_NEEDED: "product decision needed",
});

const CLASSIFICATIONS = new Set(Object.values(CATEGORY));
const DEBT_CATEGORIES = new Set([
  CATEGORY.MIGRATE_NOW,
  CATEGORY.TYPED_STORE_MIGRATE_NOW,
  CATEGORY.PRODUCT_DECISION_NEEDED,
]);

const ALLOWLIST_RULES_BY_ID = new Map(Object.entries({
  "state-manager-final-raw-boundary": [
    "capability-dependencies-json-state",
    "mcp-server-config-json",
    "profile-json-state",
  ],
  "capability-dependency-store-logical-path-parser": ["capability-dependencies-json-state"],
  "reporting-report-artifact": ["state-manager-raw-call", "reports-json-artifact"],
  "mcp-server-config-raw-caller": ["state-manager-raw-call", "mcp-server-config-json"],
  "legacy-archived-goal-recovery": ["goal-task-json-state"],
  "legacy-goal-wal-input": ["goal-wal-jsonl"],
  "legacy-execution-session-input": ["execution-session-json"],
  "dream-filesystem-metrics": ["goal-task-json-state", "memory-dream-json-state", "strategy-dream-json-state"],
  "soil-import-overlay-queue": ["soil-import-publish-artifact"],
  "goal-task-store-logical-path-parser": ["goal-task-json-state"],
  "strategy-dream-store-logical-path-parser": ["strategy-dream-json-state"],
  "knowledge-transfer-store-logical-path-parser": ["knowledge-transfer-json-state"],
  "transfer-trust-store-logical-path-parser": ["transfer-trust-json-state"],
  "soil-publish-artifact-state": ["plugin-channel-runtime-json", "soil-import-publish-artifact"],
  "legacy-capability-registry-input": ["capability-registry-json-state"],
  "relationship-profile-user-content": ["profile-json-state"],
  "character-config-user-content": ["state-manager-raw-call", "profile-json-state"],
  "character-config-source-ref-user-content": ["profile-json-state"],
  "test-redesign-inventory-artifact": ["goal-lock-file"],
  "run-spec-legacy-import-input": ["run-spec-json-state"],
  "drive-schedule-legacy-import-input": ["drive-schedule-json-state"],
  "drive-system-event-spool": ["drive-event-spool-json"],
  "daemon-drive-event-spool-callers": ["drive-event-spool-json"],
  "daemon-event-directory-config": ["drive-event-spool-json"],
  "mcp-event-spool-tool": ["drive-event-spool-json"],
  "runtime-event-server-spool": ["drive-event-spool-json"],
  "runtime-event-server-spool-support": ["drive-event-spool-json"],
  "runtime-event-file-ingestion-spool": ["drive-event-spool-json"],
  "runtime-event-spool-boundary": ["drive-event-spool-json"],
  "strategy-template-legacy-import-input": ["strategy-template-json-state"],
  "vector-index-legacy-import-input": ["vector-index-json-state"],
  "knowledge-graph-legacy-import-input": ["knowledge-graph-json-state"],
  "reflection-report-legacy-import-input": ["reflection-report-json-state"],
  "database-first-guard-script": [
    "agentloop-json-store-class",
    "runtime-journal-owner",
    "runtime-jsonl-ledger",
    "memory-knowledge-raw-state-manager-write",
    "knowledge-graph-json-state",
    "unclassified-direct-runtime-json-state",
    "drive-schedule-json-state",
    "drive-event-spool-json",
    "strategy-template-json-state",
    "vector-index-json-state",
    "profile-json-state",
    "capability-registry-json-state",
    "run-spec-json-state",
    "plugin-channel-runtime-json",
    "ethics-log-json-state",
    "memory-dream-json-state",
  ],
  "goal-canary-debug-export": ["daemon-json-state", "goal-task-json-state"],
  "doctor-legacy-import-boundary": ["daemon-json-state"],
  "schedule-legacy-migration": ["memory-dream-json-state"],
  "foreign-plugin-legacy-constants": ["plugin-channel-runtime-json"],
  "legacy-curiosity-state-import-input": ["plugin-channel-runtime-json"],
  "legacy-dream-decision-import-input": ["memory-dream-json-state"],
  "legacy-ethics-log-import-input": ["ethics-log-json-state"],
  "legacy-goal-orchestration-import-input": [
    "goal-dependency-graph-json-state",
    "goal-negotiation-log-json-state",
  ],
  "legacy-goal-task-import-input": ["goal-wal-jsonl", "goal-task-json-state"],
  "legacy-knowledge-memory-import-input": ["memory-dream-json-state"],
  "legacy-memory-lifecycle-import-input": ["memory-dream-json-state", "goal-task-json-state"],
  "legacy-plugin-channel-runtime-import-input": ["plugin-channel-runtime-json"],
  "legacy-queue-daemon-schedule-import-input": ["runtime-queue-json", "daemon-json-state"],
  "legacy-relationship-profile-proposal-import-input": ["profile-json-state"],
  "legacy-runtime-evidence-strategy-dream-import-input": [
    "strategy-dream-json-state",
    "memory-dream-json-state",
  ],
  "legacy-runtime-journal-import-input": ["runtime-jsonl-ledger"],
  "legacy-trust-state-import-input": ["memory-dream-json-state"],
}));

const RULES = [
  {
    id: "state-manager-raw-call",
    owner: "StateManager raw fallback boundary / typed store APIs",
    pattern: /\.\s*(?:readRaw|writeRaw)\s*\(/,
  },
  {
    id: "memory-knowledge-raw-state-manager-write",
    owner: "MemoryTruthMaintenanceStore / typed memory, Soil, and knowledge owner stores",
    pattern: /\.\s*writeRaw\s*\(\s*["'`][^"'`]*(?:memory|knowledge|soil)[^"'`]*/,
  },
  {
    id: "goal-negotiation-log-json-state",
    owner: "Goal negotiation typed store / control DB negotiation log table",
    pattern: /\bnegotiation-log\.json\b/,
  },
  {
    id: "goal-dependency-graph-json-state",
    owner: "Goal dependency graph typed store / control DB dependency graph table",
    pattern: /\bdependency-graph\.json\b/,
  },
  {
    id: "stall-json-state",
    owner: "Stall detector typed store / control DB stall state table",
    pattern: /\bstalls\/[^`'"]+\.json\b/,
  },
  {
    id: "learning-runtime-json-state",
    owner: "Learning runtime typed store / Soil learning store",
    pattern: /\blearning\/[^`'"]+_(?:logs|patterns|feedback|structural_feedback)\.json\b/,
  },
  {
    id: "knowledge-transfer-json-state",
    owner: "Knowledge transfer typed store / Soil transfer store",
    pattern: /\b(?:knowledge-transfer\/snapshot\.json|meta-patterns\/last_aggregated_at\.json)\b/,
  },
  {
    id: "transfer-trust-json-state",
    owner: "Transfer trust typed store / Soil transfer trust store",
    pattern: /\b(?:transfer-trust(?:-history)?\/[^`'"]+\.json|transfer-trust\/_index\.json)\b/,
  },
  {
    id: "capability-dependencies-json-state",
    owner: "Capability dependency typed registry / control DB capability dependency table",
    pattern: /\bcapability_dependencies\.json\b/,
  },
  {
    id: "reports-json-artifact",
    owner: "Report export/debug artifact boundary",
    pattern: /\breports\/[^`'"]+\/[^`'"]+\.json\b/,
  },
  {
    id: "mcp-server-config-json",
    owner: "MCP server configuration file",
    pattern: /\bmcp-?servers\.json\b|\bmcpServers\.json\b/,
  },
  {
    id: "daemon-json-state",
    owner: "DaemonStateStore / control DB daemon tables",
    pattern: /\b(?:daemon-state|shutdown-state|supervisor-state)\.json\b/,
  },
  {
    id: "runtime-queue-json",
    owner: "JournalBackedQueue SQLite queue table",
    pattern: /(?:^|[\\/'"`])(?:runtime\/queue\.json|queue\.json)\b/,
  },
  {
    id: "plugin-channel-runtime-json",
    owner: "PluginChannelRuntimeStateStore or another typed runtime state store",
    pattern: /(?:^|[\\/'"`])(?:state|health)\.json\b|\bruntime\/assets\/registry\.json\b|\bpulseed-foreign-plugin-(?:compatibility|review)\.json\b/,
  },
  {
    id: "chat-agentloop-json",
    owner: "ChatSessionDataStore / AgentLoop session DB store",
    pattern: /\b(?:chat\/sessions\/[^`'"]+\.json|chat\/agentloop\/[^`'"]+\.state\.json|traces\/agentloop\/[^`'"]+\.jsonl)\b/,
  },
  {
    id: "execution-session-json",
    owner: "ExecutionSessionStateStore / control DB execution session tables",
    pattern: /\bsessions\/(?:index\.json|[^`'"]+\.json)\b/,
  },
  {
    id: "goal-wal-jsonl",
    owner: "Goal WAL control DB ownership",
    pattern: /\bwal\.jsonl\b/,
  },
  {
    id: "goal-lock-file",
    owner: "Goal lock control DB ownership",
    pattern: /\b(?:locks\/goals|goals\/[^`'"]+\/\.lock)\b|["'`]\.lock["'`]/,
  },
  {
    id: "goal-task-json-state",
    owner: "GoalTaskStateStore",
    pattern: /\b(?:goal\.json|observations\.json|gap-history\.json|checkpoint\.json|verification-result\.json|tasks\/[^`'"]+\/[^`'"]+\.json|pipelines\/[^`'"]+\.json|checkpoints\/[^`'"]+\/(?:index\.json|[^`'"]+\.json))\b/,
  },
  {
    id: "goal-current-gap-json-state",
    owner: "StateManager typed gap history/current gap APIs",
    pattern: /\bgaps\/[^`'"]+\/current\.json\b/,
  },
  {
    id: "strategy-dream-json-state",
    owner: "StrategyDreamStateStore / runtime evidence DB stores",
    pattern: /\b(?:strategy-history\.json|portfolio\.json|rebalance-history\.json|wait-meta\/[^`'"]+\.json|importance-buffer\.jsonl|schedule-suggestions\.json|activation-artifacts\.json|watermarks\.json)\b/,
  },
  {
    id: "capability-registry-json-state",
    owner: "future typed capability registry store",
    pattern: /\bcapability_registry\.json\b/,
  },
  {
    id: "agentloop-json-store-class",
    owner: "AgentLoop database session and trace stores",
    pattern: /\b(?:JsonAgentLoopSessionStateStore|JsonlAgentLoopTraceStore)\b/,
  },
  {
    id: "agentloop-path-shaped-resume",
    owner: "AgentLoop database session id resume contract",
    pattern: /\bresumeStatePath\b/,
  },
  {
    id: "runtime-journal-owner",
    owner: "typed SQLite runtime store replacing RuntimeJournal",
    pattern: /\bRuntimeJournal\b/,
  },
  {
    id: "runtime-jsonl-ledger",
    owner: "typed SQLite runtime event store",
    pattern: /\b(?:events\.jsonl|proactiveInterventionLedgerPath|evidenceLedger(?:Goals|Runs)?Dir)\b/,
  },
  {
    id: "memory-dream-json-state",
    owner: "Soil/control DB memory and dream typed stores",
    pattern: /\b(?:entries\.json|trust-store\.json|decision-history\.json|decision-heuristics\.json|session-logs\.jsonl|iteration-logs\.jsonl|experience-log\.json|strategies\.json|tasks\.json|knowledge\.json)\b/,
  },
  {
    id: "ethics-log-json-state",
    owner: "EthicsLogStore / control DB ethics log table",
    pattern: /\bethics-log\.json\b/,
  },
  {
    id: "profile-json-state",
    owner: "Relationship/profile typed runtime store or explicit user-authored config/profile content",
    pattern: /\b(?:relationship-profile\.json|relationship-profile-proposals\.json|character-config\.json)\b/,
  },
  {
    id: "soil-import-publish-artifact",
    owner: "Soil import/publish artifact boundary",
    pattern: /\b(?:overlay-queue\.json|publish\.json|\.publish\/state\.json)\b/,
  },
  {
    id: "run-spec-json-state",
    owner: "RunSpecStore typed control DB table",
    pattern: /\brun-specs\b|\brunSpecsDir\b/,
  },
  {
    id: "drive-schedule-json-state",
    owner: "DriveSystem schedule typed control DB table",
    pattern: /\bschedule\/<goalId>\.json\b|\bschedule\/\$\{goalId\}\.json\b|\bscheduleDir\b/,
  },
  {
    id: "drive-event-spool-json",
    owner: "DriveSystem bounded runtime event IPC spool",
    pattern: /\bevents\/\*\.json\b|\beventsDir\b|\breadEventQueue\b|\barchiveEvent\b|\bprocessEvents\b|\bwriteEvent\b|\bstartWatcher\b|\bhandleWatchEvent\b/,
  },
  {
    id: "strategy-template-json-state",
    owner: "Strategy template typed store or explicit import/export artifact",
    pattern: /\bstrategy-templates\.json\b|\bpersistPath\b/,
  },
  {
    id: "vector-index-json-state",
    owner: "Vector index typed store or rebuildable cache boundary",
    pattern: /\bvector-index\.json\b|\bprivate readonly indexPath\b|\bthis\.indexPath\b|\bnew VectorIndex\(indexPath\b|\bVectorIndex\.create\([^)]*indexPath\b/,
  },
  {
    id: "knowledge-graph-json-state",
    owner: "Knowledge graph typed store or rebuildable cache boundary",
    pattern: /\bknowledge\/graph\.json\b|path\.join\("knowledge",\s*"graph\.json"\)|\bgraphPath\b|\bthis\.graphPath\b/,
  },
  {
    id: "unclassified-direct-runtime-json-state",
    owner: "direct filesystem runtime state must be typed SQLite/Soil or explicitly categorized",
    pattern: /\b(?:runtime\/state\.json|state\/[^`'"]+\.json|cache\.json|queue\.jsonl|stateDir|cacheDir|queueDir)\b/,
  },
  {
    id: "reflection-report-json-state",
    owner: "Reflection report typed store or explicit report artifact boundary",
    pattern: /\breflectionsDir\b|path\.join\([^)]*"reflections"[^)]*\)|\bpersistReflectionReport\(baseDir\b|\b(?:morning|evening|dream)-\$\{date\}\.json\b|\bweekly-\$\{week\}\.json\b|\breflections\/(?:morning|evening|weekly|dream)-[^`'"]+\.json\b|\bLEGACY_REFLECTION_REPORT_DIR\b/,
  },
];

const EVENT_SOURCED_PROJECTION_TABLES = [
  "attention_commitment_candidates",
  "goal_records",
  "interaction_authority_decisions",
  "memory_projection_records",
  "runtime_event_projection_snapshots",
  "runtime_operations",
  "task_records",
];

const EVENT_SOURCED_PROJECTION_WRITE_PATTERN = new RegExp(
  String.raw`\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:${EVENT_SOURCED_PROJECTION_TABLES.join("|")})\b`,
  "i",
);

const EVENT_SOURCED_PROJECTION_EVENT_PATTERN =
  /\b(?:appendRuntimeEventEnvelopeInTransaction|appendAuthorityDecisionWithDisposition|appendGoalTaskMutation|appendRuntimeControlOperation|appendAttentionCommitment|runtimeEventFromAttentionCommitment|runtimeEventFromRuntimeControlOperationTransition)\b/;

const EVENT_SOURCED_PROJECTION_SKIP_PATH = /(^|\/)(?:__tests__|tests|docs|tmp)\//;
const EVENT_SOURCED_PROJECTION_SCHEMA_PATH = /(^|\/)src\/runtime\/store\/control-db\/schema\.ts$/;

const DIRECT_FILE_OWNER_INVENTORY = [
  inventory({
    id: "drive-system-schedule",
    surface: "src/platform/drive/drive-system.ts",
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    owner: "DriveSystem goal activation schedule",
    boundary: "goal_drive_schedules control DB table; legacy schedule/<goalId>.json is doctor/repair import input only",
    nextSlice: null,
    reason: "activation, cooldown, and next-check data moved to typed control DB state",
  }),
  inventory({
    id: "drive-system-event-spool",
    surface: "src/platform/drive/drive-system.ts; src/runtime/event/*; daemon writeEvent callers",
    category: CATEGORY.BOUNDED_IPC_SPOOL,
    owner: "DriveSystem runtime event ingestion spool",
    boundary: "events/*.json and events/{archive,processed,failed}/*.json",
    nextSlice: null,
    reason: "event files are a bounded IPC spool with filename validation, payload byte limits, pending-file limits, atomic writes, retained-directory pruning, and non-overwriting archive/quarantine moves",
  }),
  inventory({
    id: "strategy-template-registry",
    surface: "src/orchestrator/strategy/strategy-template-registry.ts",
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    owner: "successful strategy template reuse",
    boundary: "strategy_templates control DB table; legacy strategy-templates.json is doctor/repair import input only",
    nextSlice: null,
    reason: "normal strategy reuse moved to typed control DB state; legacy JSON is not read by runtime callers",
  }),
  inventory({
    id: "vector-index",
    surface: "src/platform/knowledge/vector-index.ts",
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    owner: "runtime semantic vector index",
    boundary: "vector_index_entries control DB table; legacy memory/vector-index.json is doctor/repair import input only",
    nextSlice: null,
    reason: "normal semantic search index state moved to typed control DB state",
  }),
  inventory({
    id: "knowledge-graph",
    surface: "src/platform/knowledge/knowledge-graph.ts",
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    owner: "cross-goal knowledge graph",
    boundary: "knowledge_graph_nodes and knowledge_graph_edges control DB tables; legacy knowledge/graph.json is doctor/repair import input only",
    nextSlice: null,
    reason: "normal graph traversal state moved to typed control DB state",
  }),
  inventory({
    id: "runtime-report-artifacts",
    surface: "src/runtime/store/reproducibility-manifest.ts; src/runtime/store/postmortem-report.ts; src/tools/runtime/*; reporting outputs",
    category: CATEGORY.REPRODUCIBILITY_ARTIFACT,
    owner: "runtime reports, manifests, postmortems, and long-running result artifacts",
    boundary: "report/result/manifest artifact files",
    nextSlice: null,
    reason: "file-backed artifacts are confirmed output boundaries, not authoritative runtime state",
  }),
  inventory({
    id: "reflection-reports",
    surface: "src/reflection/*",
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    owner: "morning/evening/weekly/dream reflection reports",
    boundary: "reflection_reports control DB table; legacy reflections/*.json is doctor/repair import input only",
    nextSlice: null,
    reason: "normal reflection report state moved to typed control DB state; legacy JSON files are not read by runtime callers",
  }),
  inventory({
    id: "tool-workspace-artifacts",
    surface: "src/tools/fs/*; src/tools/kaggle/*; workspace preparation/edit/write paths; code-search read indexes",
    category: CATEGORY.WORKSPACE_CONTENT,
    owner: "user workspace and tool-produced deliverables",
    boundary: "workspace files and external task artifacts",
    nextSlice: null,
    reason: "workspace content is intentionally file-backed and user-visible, not internal runtime state",
  }),
  inventory({
    id: "config-setup-plugin-gateway-channel-files",
    surface: "src/interface/cli/commands/config.ts; setup-wizard.ts; plugin.ts; gateway/channel setup; hook/global config",
    category: CATEGORY.CONFIG_SECRET,
    owner: "operator configuration, credentials, plugin manifests, gateway/channel config",
    boundary: "provider/daemon/notification/datasource/gateway/plugin/MCP config files",
    nextSlice: null,
    reason: "admin-managed configuration remains file-backed with schema validation and is not authoritative runtime state",
  }),
  inventory({
    id: "user-authored-profile-content",
    surface: "src/platform/profile/relationship-profile.ts; character configuration paths",
    category: CATEGORY.USER_AUTHORED_CONTENT,
    owner: "user-authored relationship profile and character content",
    boundary: "relationship-profile.json and character-config.json",
    nextSlice: null,
    reason: "explicitly authored content is schema-validated user/admin content, not internal runtime state",
  }),
  inventory({
    id: "migration-inputs",
    surface: "src/runtime/store/*migration.ts; legacy recovery helpers; doctor repair paths",
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    owner: "doctor/repair compatibility inputs",
    boundary: "legacy JSON/JSONL/lock files",
    nextSlice: null,
    reason: "normal runtime code must not silently fall back to these files",
  }),
  inventory({
    id: "soil-import-publish-surfaces",
    surface: "src/platform/soil/importer/publish/compiler/projections/doctor paths",
    category: CATEGORY.SOIL_IMPORT_PUBLISH_ARTIFACT,
    owner: "Soil import, compile, projection, and publish artifacts",
    boundary: "Soil-owned files and publish state",
    nextSlice: null,
    reason: "Soil import/publish artifacts are outside normal runtime durable state ownership",
  }),
  inventory({
    id: "debug-logs-and-daemon-pid",
    surface: "src/runtime/logger.ts; src/interface/tui/debug-log.ts; src/runtime/pid-manager.ts; daemon health logs",
    category: CATEGORY.DEBUG_EXPORT_ARTIFACT,
    owner: "debug logs, rotated logs, process pid/health files",
    boundary: "log, pid, and health diagnostic files",
    nextSlice: null,
    reason: "diagnostic outputs remain file-backed as debug/export artifacts, not hidden durable runtime state",
  }),
];

const PATH_ALLOWLIST = [
  allow({
    id: "test-fixtures",
    pattern: /(^|\/)__tests__\//,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "tests may contain legacy fixtures and assertions",
  }),
  allow({
    id: "test-fixtures-directory",
    pattern: /(^|\/)tests\//,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "tests may contain legacy fixtures and assertions",
  }),
  allow({
    id: "documentation",
    pattern: /(^|\/)docs\//,
    category: CATEGORY.WORKSPACE_USER_ARTIFACT,
    reason: "docs are repository artifacts, not runtime code",
  }),
  allow({
    id: "tmp-status-artifacts",
    pattern: /(^|\/)tmp\//,
    category: CATEGORY.DEBUG_EXPORT_OUTPUT,
    reason: "tmp status and audit artifacts are not runtime code",
  }),
  allow({
    id: "transfer-trust-store-logical-path-parser",
    pattern: /(^|\/)src\/runtime\/store\/transfer-trust-state-(?:store|migration)\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "typed transfer trust store parses legacy logical paths for compatibility and explicit repair import",
    owner: "Transfer trust typed store / Soil transfer trust store",
  }),
  allow({
    id: "state-manager-final-raw-boundary",
    pattern: /(^|\/)src\/base\/state\/state-manager\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "StateManager declares typed legacy routes and the final explicit raw fallback boundary",
    owner: "StateManager raw fallback boundary / typed store APIs",
  }),
  allow({
    id: "capability-dependency-store-logical-path-parser",
    pattern: /(^|\/)src\/runtime\/store\/capability-registry-state-store\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "typed capability dependency store parses its legacy logical path for compatibility and explicit repair import",
    owner: "Capability dependency typed registry / control DB capability dependency table",
  }),
  allow({
    id: "reporting-report-artifact",
    pattern: /(^|\/)src\/reporting\/reporting-engine\.ts$/,
    category: CATEGORY.DEBUG_EXPORT_OUTPUT,
    reason: "reports are generated user/debug artifacts under the explicit report output boundary",
    owner: "report artifact boundary",
  }),
  allow({
    id: "mcp-server-config-raw-caller",
    pattern: /(^|\/)(?:src\/runtime\/capability-execution-resolver\.ts|src\/interface\/cli\/commands\/operator-binding-status\.ts)$/,
    category: CATEGORY.CONFIG_SECRET,
    reason: "MCP server files are user-editable configuration, not durable runtime state",
    owner: "MCP server configuration",
  }),
  allow({
    id: "goal-canary-debug-export",
    pattern: /(^|\/)scripts\/goal-canary-supervisor\.mjs$/,
    category: CATEGORY.DEBUG_EXPORT_OUTPUT,
    reason: "dogfood debug export artifact collector",
  }),
  allow({
    id: "database-first-guard-script",
    pattern: /(^|\/)scripts\/check-database-first-legacy-stores\.mjs$/,
    category: CATEGORY.DEBUG_EXPORT_OUTPUT,
    reason: "this check contains legacy filename rules",
  }),
  allow({
    id: "legacy-curiosity-state-import-input",
    pattern: /(^|\/)src\/runtime\/store\/curiosity-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "doctor/repair imports legacy curiosity/state.json into the typed curiosity control DB state",
    owner: "curiosity runtime typed control DB state",
  }),
  allow({
    id: "legacy-dream-decision-import-input",
    pattern: /(^|\/)src\/runtime\/store\/dream-decision-heuristic-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "doctor/repair imports legacy dream decision heuristic files into typed runtime stores",
    owner: "dream decision runtime typed store",
  }),
  allow({
    id: "legacy-ethics-log-import-input",
    pattern: /(^|\/)src\/runtime\/store\/ethics-log-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "doctor/repair imports legacy ethics-log.json into the typed ethics log control DB table",
    owner: "EthicsLogStore / control DB ethics log table",
  }),
  allow({
    id: "legacy-goal-orchestration-import-input",
    pattern: /(^|\/)src\/runtime\/store\/goal-orchestration-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "doctor/repair imports legacy goal orchestration files into typed negotiation/dependency stores",
    owner: "goal orchestration typed control DB stores",
  }),
  allow({
    id: "legacy-goal-task-import-input",
    pattern: /(^|\/)src\/runtime\/store\/goal-task-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "doctor/repair imports legacy goal/task/checkpoint/WAL files into typed goal task stores",
    owner: "GoalTaskStateStore typed APIs",
  }),
  allow({
    id: "legacy-knowledge-memory-import-input",
    pattern: /(^|\/)src\/runtime\/store\/knowledge-memory-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "doctor/repair imports legacy knowledge and agent memory entries into typed memory stores",
    owner: "memory and knowledge typed stores",
  }),
  allow({
    id: "legacy-memory-lifecycle-import-input",
    pattern: /(^|\/)src\/runtime\/store\/memory-lifecycle-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "doctor/repair imports legacy memory lifecycle files into typed memory lifecycle stores",
    owner: "memory lifecycle typed stores",
  }),
  allow({
    id: "legacy-plugin-channel-runtime-import-input",
    pattern: /(^|\/)src\/runtime\/store\/plugin-channel-runtime-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "doctor/repair imports legacy plugin/channel runtime state into typed plugin/channel stores",
    owner: "plugin and channel runtime typed stores",
  }),
  allow({
    id: "legacy-queue-daemon-schedule-import-input",
    pattern: /(^|\/)src\/runtime\/store\/queue-daemon-schedule-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "doctor/repair imports legacy queue, daemon, shutdown, and supervisor state into typed stores",
    owner: "queue and daemon typed control DB stores",
  }),
  allow({
    id: "legacy-relationship-profile-proposal-import-input",
    pattern: /(^|\/)src\/runtime\/store\/relationship-profile-proposal-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "doctor/repair imports legacy relationship profile proposals into the typed proposal workflow store",
    owner: "relationship-profile proposal typed store",
  }),
  allow({
    id: "legacy-runtime-evidence-strategy-dream-import-input",
    pattern: /(^|\/)src\/runtime\/store\/runtime-evidence-strategy-dream-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "doctor/repair imports legacy runtime evidence, strategy, dream, and iteration logs into typed stores",
    owner: "runtime evidence, strategy, and dream typed stores",
  }),
  allow({
    id: "legacy-runtime-journal-import-input",
    pattern: /(^|\/)src\/runtime\/store\/runtime-journal-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "doctor/repair imports legacy RuntimeJournal and proactive JSONL ledgers into typed runtime tables",
    owner: "typed SQLite runtime event stores",
  }),
  allow({
    id: "legacy-trust-state-import-input",
    pattern: /(^|\/)src\/runtime\/store\/trust-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "doctor/repair imports legacy trust-store.json into typed trust control DB state",
    owner: "trust runtime typed control DB state",
  }),
  allow({
    id: "chat-agentloop-migration",
    pattern: /(^|\/)src\/interface\/chat\/chat-agentloop-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "explicit chat migration boundary",
  }),
  allow({
    id: "schedule-legacy-migration",
    pattern: /(^|\/)src\/runtime\/schedule\/legacy-cron-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "explicit schedule migration boundary",
  }),
  allow({
    id: "doctor-legacy-import-boundary",
    pattern: /(^|\/)src\/interface\/cli\/commands\/doctor\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "doctor is the compatibility boundary",
  }),
  allow({
    id: "legacy-archived-goal-recovery",
    pattern: /(^|\/)src\/base\/state\/legacy-archived-goal-recovery\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "explicit legacy archive recovery boundary",
  }),
  allow({
    id: "legacy-goal-wal-input",
    pattern: /(^|\/)src\/base\/state\/legacy-state-wal\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "explicit legacy goal WAL import/repair boundary",
  }),
  allow({
    id: "knowledge-documents-compatibility",
    pattern: /(^|\/)src\/platform\/knowledge\/knowledge-manager\.ts$/,
    category: CATEGORY.WORKSPACE_USER_ARTIFACT,
    reason: "documents compatibility facade only",
  }),
  allow({
    id: "legacy-execution-session-input",
    pattern: /(^|\/)src\/runtime\/store\/execution-session-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "explicit legacy execution session import/repair boundary",
    owner: "ExecutionSessionStateStore",
  }),
  allow({
    id: "dream-filesystem-metrics",
    pattern: /(^|\/)src\/platform\/dream\/dream-consolidator(?:\/fs-metrics)?\.ts$/,
    category: CATEGORY.DEBUG_EXPORT_OUTPUT,
    reason: "Dream operational report file counters are diagnostic metrics, not authoritative runtime state",
    owner: "debug metric boundary over exported artifacts",
  }),
  allow({
    id: "soil-import-overlay-queue",
    pattern: /(^|\/)src\/platform\/soil\/importer\.ts$/,
    category: CATEGORY.SOIL_IMPORT_PUBLISH_ARTIFACT,
    reason: "Soil import overlay queue is outside normal runtime state ownership",
    owner: "explicit Soil import artifact",
  }),
  allow({
    id: "foreign-plugin-legacy-constants",
    pattern: /(^|\/)src\/runtime\/foreign-plugins\/compatibility\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "legacy filename constants for migration/debug references",
  }),
  allow({
    id: "goal-task-store-logical-path-parser",
    pattern: /(^|\/)src\/runtime\/store\/goal-task-state-store\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "legacy logical-path adapter retained for explicit migration/compatibility coverage; normal callers use typed APIs",
    owner: "GoalTaskStateStore typed APIs",
  }),
  allow({
    id: "strategy-dream-store-logical-path-parser",
    pattern: /(^|\/)src\/runtime\/store\/strategy-dream-state-store\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "legacy logical-path adapter retained for explicit migration/compatibility coverage; normal callers use typed APIs",
    owner: "StrategyDreamStateStore typed APIs",
  }),
  allow({
    id: "knowledge-transfer-store-logical-path-parser",
    pattern: /(^|\/)src\/runtime\/store\/knowledge-transfer-state-store\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "legacy logical-path adapter retained for explicit migration/compatibility coverage; normal callers use typed APIs",
    owner: "KnowledgeTransferStateStore typed APIs",
  }),
  allow({
    id: "soil-publish-artifact-state",
    pattern: /(^|\/)src\/platform\/soil\/publish\/config\.ts$/,
    category: CATEGORY.SOIL_IMPORT_PUBLISH_ARTIFACT,
    reason: "Soil publish state is an explicit publish artifact",
    owner: "explicit Soil publish artifact",
  }),
  allow({
    id: "legacy-capability-registry-input",
    pattern: /(^|\/)src\/runtime\/store\/capability-registry-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "legacy capability_registry.json is an explicit repair import input",
    owner: "CapabilityRegistryStateStore",
  }),
  allow({
    id: "relationship-profile-user-content",
    pattern: /(^|\/)src\/platform\/profile\/relationship-profile\.ts$/,
    category: CATEGORY.WORKSPACE_USER_ARTIFACT,
    reason: "relationship profile is explicit user-authored profile content, not internal runtime state",
    owner: "relationship profile user content",
  }),
  allow({
    id: "character-config-user-content",
    pattern: /(^|\/)src\/platform\/traits\/character-config\.ts$/,
    category: CATEGORY.CONFIG_SECRET,
    reason: "character config is explicit user-editable configuration",
    owner: "character configuration",
  }),
  allow({
    id: "character-config-source-ref-user-content",
    pattern: /(^|\/)(?:src\/interface\/chat\/chat-runner\.ts|src\/runtime\/decision\/companion-character-policy-projection\.ts)$/,
    category: CATEGORY.USER_AUTHORED_CONTENT,
    reason: "source refs name explicit user-authored character configuration without making it authoritative runtime state",
    owner: "character configuration source refs",
  }),
  allow({
    id: "test-redesign-inventory-artifact",
    pattern: /(^|\/)scripts\/inventory-test-redesign\.mjs$/,
    category: CATEGORY.DEBUG_EXPORT_OUTPUT,
    reason: "test redesign inventory records legacy deletion evidence, not runtime ownership",
    owner: "test redesign inventory artifact",
  }),
  allow({
    id: "run-spec-legacy-import-input",
    pattern: /(^|\/)src\/runtime\/run-spec\/run-spec-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "legacy run-specs JSON is read only through explicit doctor/repair import",
    owner: "RunSpecStore typed control DB table",
  }),
  allow({
    id: "drive-schedule-legacy-import-input",
    pattern: /(^|\/)src\/platform\/drive\/drive-schedule-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "legacy schedule JSON is read only through explicit doctor/repair import",
    owner: "DriveSystem schedule typed control DB table",
  }),
  allow({
    id: "drive-system-event-spool",
    pattern: /(^|\/)src\/platform\/drive\/drive-system\.ts$/,
    category: CATEGORY.BOUNDED_IPC_SPOOL,
    reason: "DriveSystem event files are bounded IPC spool inputs, not authoritative durable runtime state",
    owner: "DriveSystem bounded runtime event IPC spool",
  }),
  allow({
    id: "daemon-drive-event-spool-callers",
    pattern: /(^|\/)src\/runtime\/daemon\/(?:runner-startup|runner-resident-proactive|runner-resident-shared|maintenance|runner-commands)\.ts$/,
    category: CATEGORY.BOUNDED_IPC_SPOOL,
    reason: "daemon callers enqueue transient runtime events through the bounded event-spool boundary",
    owner: "DriveSystem bounded runtime event IPC spool",
  }),
  allow({
    id: "daemon-event-directory-config",
    pattern: /(^|\/)src\/interface\/cli\/commands\/daemon\.ts$/,
    category: CATEGORY.BOUNDED_IPC_SPOOL,
    reason: "daemon command wires the runtime event spool directory into the event server",
    owner: "DriveSystem bounded runtime event IPC spool",
  }),
  allow({
    id: "mcp-event-spool-tool",
    pattern: /(^|\/)src\/interface\/mcp-server\/tools\.ts$/,
    category: CATEGORY.BOUNDED_IPC_SPOOL,
    reason: "MCP tool writes explicit bounded event spool files for runtime ingestion",
    owner: "DriveSystem bounded runtime event IPC spool",
  }),
  allow({
    id: "runtime-event-server-spool",
    pattern: /(^|\/)src\/runtime\/event\/server(?:-trigger-handler)?\.ts$/,
    category: CATEGORY.BOUNDED_IPC_SPOOL,
    reason: "event server writes and dispatches trigger events through the bounded event-spool boundary",
    owner: "DriveSystem bounded runtime event IPC spool",
  }),
  allow({
    id: "runtime-event-server-spool-support",
    pattern: /(^|\/)src\/runtime\/event\/(?:server-auth|server-snapshot-reader|server-types)\.ts$/,
    category: CATEGORY.BOUNDED_IPC_SPOOL,
    reason: "event server support types and auth resolve paths relative to the runtime event spool",
    owner: "DriveSystem bounded runtime event IPC spool",
  }),
  allow({
    id: "runtime-event-file-ingestion-spool",
    pattern: /(^|\/)src\/runtime\/event\/server-file-ingestion\.ts$/,
    category: CATEGORY.BOUNDED_IPC_SPOOL,
    reason: "file ingestion moves event files through processed/failed spool directories with bounded filename, size, retry, and retention semantics",
    owner: "runtime event file ingestion spool",
  }),
  allow({
    id: "runtime-event-spool-boundary",
    pattern: /(^|\/)src\/base\/utils\/event-spool\.ts$/,
    category: CATEGORY.BOUNDED_IPC_SPOOL,
    reason: "shared event spool boundary centralizes filename, size, pending-count, atomic-write, move, and retention limits",
    owner: "DriveSystem bounded runtime event IPC spool",
  }),
  allow({
    id: "strategy-template-legacy-import-input",
    pattern: /(^|\/)src\/orchestrator\/strategy\/strategy-template-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "doctor/repair imports legacy strategy-templates.json into the typed strategy_templates control DB table",
    owner: "Strategy template typed store legacy import boundary",
  }),
  allow({
    id: "vector-index-legacy-import-input",
    pattern: /(^|\/)src\/platform\/knowledge\/vector-index-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "doctor/repair imports legacy memory/vector-index.json into the typed vector_index_entries control DB table",
    owner: "Vector index typed store legacy import boundary",
  }),
  allow({
    id: "knowledge-graph-legacy-import-input",
    pattern: /(^|\/)src\/platform\/knowledge\/knowledge-graph-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "doctor/repair imports legacy knowledge/graph.json into the typed knowledge graph control DB tables",
    owner: "Knowledge graph typed store legacy import boundary",
  }),
  allow({
    id: "reflection-report-legacy-import-input",
    pattern: /(^|\/)src\/reflection\/reflection-report-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "doctor/repair imports legacy reflections/*.json into the typed reflection_reports control DB table",
    owner: "Reflection report typed store legacy import boundary",
  }),
];

const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".pulseed-sandbox"]);

export function scanText(filePath, text) {
  return scanTextDetailed(filePath, text).findings;
}

export function scanTextDetailed(filePath, text) {
  const normalizedPath = normalizePath(filePath);
  const pathAllowlist = PATH_ALLOWLIST.filter((entry) => entry.pattern.test(normalizedPath));
  const findings = [];
  const classifiedFindings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line) && !isLineAllowedForRule(rule, line)) {
        const finding = {
          filePath: normalizedPath,
          line: index + 1,
          rule: rule.id,
          owner: rule.owner,
          text: line.trim(),
        };
        const allow = pathAllowlist.find((entry) => isAllowlistedRule(entry, rule.id));
        if (allow) {
          classifiedFindings.push({
            ...finding,
            allowlistId: allow.id,
            category: allow.category,
            reason: allow.reason,
            expectedOwner: allow.owner ?? rule.owner,
            nextSlice: allow.nextSlice ?? null,
            debtRank: allow.debtRank ?? null,
          });
        } else {
          const pathOnlyAllow = pathAllowlist[0];
          findings.push({
            ...finding,
            allowlistId: pathOnlyAllow?.id,
            allowlistReason: pathOnlyAllow
              ? `allowlist entry "${pathOnlyAllow.id}" does not permit rule "${rule.id}"`
              : undefined,
          });
        }
      }
    }
  });
  findings.push(...scanEventSourcedProjectionWriteBypasses(normalizedPath, text));
  return { findings, classifiedFindings };
}

export function scanFiles(roots) {
  return scanFilesDetailed(roots).findings;
}

export function scanFilesDetailed(roots) {
  const findings = [];
  const classifiedFindings = [];
  for (const root of roots) {
    const absoluteRoot = path.resolve(repoRoot, root);
    for (const filePath of walkFiles(absoluteRoot)) {
      const scanned = scanTextDetailed(path.relative(repoRoot, filePath), fs.readFileSync(filePath, "utf8"));
      findings.push(...scanned.findings);
      classifiedFindings.push(...scanned.classifiedFindings);
    }
  }
  return {
    findings,
    classifiedFindings,
    allowlistReport: buildAllowlistReport(classifiedFindings),
    debtReport: buildDebtReport(classifiedFindings),
    directFileOwnerReport: buildDirectFileOwnerReport(),
    directFileDebtReport: buildDirectFileDebtReport(),
  };
}

function allow(entry) {
  if (!entry.id) throw new Error("database-first legacy store allowlist entries require an id");
  if (!CLASSIFICATIONS.has(entry.category)) {
    throw new Error(`database-first legacy store allowlist entry "${entry.id}" has invalid category "${entry.category}"`);
  }
  const rules = entry.rules ?? ALLOWLIST_RULES_BY_ID.get(entry.id);
  if (isDebtAllowlistEntry(entry) && rules === undefined) {
    throw new Error(`database-first legacy store allowlist entry "${entry.id}" requires precise rule ids`);
  }
  return rules === undefined ? entry : { ...entry, rules };
}

function isDebtAllowlistEntry(entry) {
  return (entry.debtRank !== undefined && entry.debtRank !== null)
    || DEBT_CATEGORIES.has(entry.category);
}

function isAllowlistedRule(allowlistEntry, ruleId) {
  return allowlistEntry.rules === undefined || allowlistEntry.rules.includes(ruleId);
}

function buildDebtReport(classifiedFindings) {
  return buildAllowlistReport(classifiedFindings)
    .filter((entry) => entry.matchCount > 0 && isDebtAllowlistEntry(entry))
    .sort((left, right) => {
      const leftRank = left.debtRank ?? Number.MAX_SAFE_INTEGER;
      const rightRank = right.debtRank ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.id.localeCompare(right.id);
    });
}

function buildAllowlistReport(classifiedFindings) {
  const findingsByAllowlistId = new Map();
  for (const finding of classifiedFindings) {
    const existing = findingsByAllowlistId.get(finding.allowlistId) ?? [];
    existing.push(finding);
    findingsByAllowlistId.set(finding.allowlistId, existing);
  }

  return PATH_ALLOWLIST
    .map((entry) => {
      const matches = findingsByAllowlistId.get(entry.id) ?? [];
      return {
        id: entry.id,
        category: entry.category,
        reason: entry.reason,
        owner: entry.owner ?? null,
        nextSlice: entry.nextSlice ?? null,
        debtRank: entry.debtRank ?? null,
        rules: entry.rules ?? null,
        pathPattern: entry.pattern.source,
        matchCount: matches.length,
        matches,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function inventory(entry) {
  if (!entry.id) throw new Error("direct file owner inventory entries require an id");
  if (!CLASSIFICATIONS.has(entry.category)) {
    throw new Error(`direct file owner inventory entry "${entry.id}" has invalid category "${entry.category}"`);
  }
  return {
    nextSlice: null,
    ...entry,
  };
}

function buildDirectFileOwnerReport() {
  return DIRECT_FILE_OWNER_INVENTORY
    .map((entry) => ({ ...entry, debt: DEBT_CATEGORIES.has(entry.category) }))
    .sort((left, right) => {
      const leftSlice = left.nextSlice ?? Number.MAX_SAFE_INTEGER;
      const rightSlice = right.nextSlice ?? Number.MAX_SAFE_INTEGER;
      if (leftSlice !== rightSlice) return leftSlice - rightSlice;
      return left.id.localeCompare(right.id);
    });
}

function buildDirectFileDebtReport() {
  return buildDirectFileOwnerReport().filter((entry) => entry.debt);
}

function printDebtReport(debtReport) {
  if (debtReport.length === 0) return;
  console.log("classified legacy store debt report:");
  for (const entry of debtReport) {
    const rank = entry.debtRank === null ? "artifact" : `rank ${entry.debtRank}`;
    const next = entry.nextSlice === null ? "no follow-up slice" : `Slice ${entry.nextSlice}`;
    console.log(`- ${entry.id}: ${entry.category}; ${rank}; ${next}; owner: ${entry.owner}; matches: ${entry.matchCount}`);
  }
  console.log("run with --json for line-level classified matches and reasons");
}

function printDirectFileDebtReport(directFileDebtReport) {
  if (directFileDebtReport.length === 0) return;
  console.log("classified direct filesystem owner debt report:");
  for (const entry of directFileDebtReport) {
    const next = entry.nextSlice === null ? "no follow-up slice" : `Slice ${entry.nextSlice}`;
    console.log(`- ${entry.id}: ${entry.category}; ${next}; owner: ${entry.owner}; boundary: ${entry.boundary}`);
  }
}

function isLineAllowedForRule(rule, line) {
  if (rule.id === "state-manager-raw-call") return false;
  if (rule.id === "mcp-server-config-json") return isConfigAllowed(line);
  return false;
}

function isConfigAllowed(line) {
  return /\b(?:provider|notification|daemon|config|plugin|package|tsconfig)\.json\b/.test(line)
    || /\bmcp-?servers\.json\b/.test(line)
    || /\bmcpServers\.json\b/.test(line)
    || /\bplugin\.ya?ml\b/.test(line)
    || /\bgateway\/channels\/[^`'"]+\/config\.json\b/.test(line);
}

function scanEventSourcedProjectionWriteBypasses(normalizedPath, text) {
  if (EVENT_SOURCED_PROJECTION_SKIP_PATH.test(normalizedPath)) return [];
  if (EVENT_SOURCED_PROJECTION_SCHEMA_PATH.test(normalizedPath)) return [];
  if (!EVENT_SOURCED_PROJECTION_WRITE_PATTERN.test(text)) return [];
  if (EVENT_SOURCED_PROJECTION_EVENT_PATTERN.test(text)) return [];
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!EVENT_SOURCED_PROJECTION_WRITE_PATTERN.test(line)) return [];
    return [{
      filePath: normalizedPath,
      line: index + 1,
      rule: "event-sourced-projection-write",
      owner: "RuntimeEventLogStore event append plus RuntimeGraph linkage before projection/current-state writes",
      text: line.trim(),
      allowlistReason: "production projection/current-state writes to event-sourced tables must use the runtime event-log pattern in the same module",
    }];
  });
}

function* walkFiles(root) {
  if (!fs.existsSync(root)) return;
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (EXTENSIONS.has(path.extname(root))) yield root;
    return;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(entryPath);
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      yield entryPath;
    }
  }
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const roots = args.filter((arg) => arg !== "--json");
  const result = scanFilesDetailed(roots.length > 0 ? roots : ["src", "scripts"]);

  if (json) {
    console.log(JSON.stringify({
      ok: result.findings.length === 0,
      findings: result.findings,
      classifiedFindings: result.classifiedFindings,
      allowlistReport: result.allowlistReport,
      debtReport: result.debtReport,
      directFileOwnerReport: result.directFileOwnerReport,
      directFileDebtReport: result.directFileDebtReport,
    }, null, 2));
    if (result.findings.length > 0) process.exitCode = 1;
    return;
  }

  const findings = result.findings;
  if (findings.length === 0) {
    console.log("database-first legacy store check passed");
    printDebtReport(result.debtReport);
    printDirectFileDebtReport(result.directFileDebtReport);
    return;
  }
  console.error("database-first legacy store check failed:");
  for (const finding of findings) {
    console.error(`${finding.filePath}:${finding.line} [${finding.rule}] ${finding.owner}`);
    console.error(`  ${finding.text}`);
    if (finding.allowlistReason) {
      console.error(`  ${finding.allowlistReason}`);
    }
  }
  console.error("Unclassified legacy store references must be moved to typed stores or categorized as migration, debug/export, config/secret, workspace/user artifact, Soil import/publish artifact, or product-decision debt.");
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
