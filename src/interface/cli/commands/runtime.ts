// ─── pulseed runtime commands (read-only) ───

import { parseArgs } from "node:util";

import { StateManager } from "../../../base/state/state-manager.js";
import { createRuntimeSessionRegistry } from "../../../runtime/session-registry/index.js";
import type {
  BackgroundRun,
  RuntimeSession,
  RuntimeSessionRegistrySnapshot,
  RuntimeSessionRegistryWarning,
} from "../../../runtime/session-registry/types.js";
import { getCliLogger } from "../cli-logger.js";
import { formatOperationError } from "../utils.js";

const ID_WIDTH = 34;
const KIND_WIDTH = 12;
const STATUS_WIDTH = 10;
const UPDATED_WIDTH = 24;
const WORKSPACE_WIDTH = 26;
const TITLE_WIDTH = 32;

type RuntimeListValues = {
  json?: boolean;
  active?: boolean;
  attention?: boolean;
};

function formatCell(value: string | null | undefined, maxLen: number): string {
  const normalized = (value ?? "-").replace(/\s+/g, " ").trim() || "-";
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 3)}...` : normalized;
}

function dateLabel(value: string | null | undefined): string {
  return value ? formatCell(value, UPDATED_WIDTH) : "-";
}

function activeSession(session: RuntimeSession): boolean {
  return session.status === "active";
}

function activeRun(run: BackgroundRun): boolean {
  return run.status === "queued" || run.status === "running";
}

function attentionRun(run: BackgroundRun): boolean {
  return run.status === "failed" || run.status === "timed_out" || run.status === "lost";
}

function filterSessions(snapshot: RuntimeSessionRegistrySnapshot, activeOnly: boolean): RuntimeSession[] {
  return activeOnly ? snapshot.sessions.filter(activeSession) : snapshot.sessions;
}

function filterRuns(snapshot: RuntimeSessionRegistrySnapshot, activeOnly: boolean, attentionOnly: boolean): BackgroundRun[] {
  return snapshot.background_runs.filter((run) => {
    if (activeOnly && !activeRun(run)) return false;
    if (attentionOnly && !attentionRun(run)) return false;
    return true;
  });
}

function printWarningsSummary(warnings: RuntimeSessionRegistryWarning[]): void {
  if (warnings.length > 0) {
    console.log(`Warnings: ${warnings.length}`);
  }
}

function printSessionRows(sessions: RuntimeSession[], warnings: RuntimeSessionRegistryWarning[]): void {
  if (sessions.length === 0) {
    console.log("No runtime sessions found.");
    printWarningsSummary(warnings);
    return;
  }

  console.log("Runtime sessions:\n");
  console.log(
    `${"ID".padEnd(ID_WIDTH)} ${"KIND".padEnd(KIND_WIDTH)} ${"STATUS".padEnd(STATUS_WIDTH)} ${"UPDATED".padEnd(UPDATED_WIDTH)} ${"WORKSPACE".padEnd(WORKSPACE_WIDTH)} TITLE`
  );
  console.log("-".repeat(116));
  for (const session of sessions) {
    console.log(
      `${formatCell(session.id, ID_WIDTH).padEnd(ID_WIDTH)} ${session.kind.padEnd(KIND_WIDTH)} ${session.status.padEnd(STATUS_WIDTH)} ${dateLabel(session.updated_at).padEnd(UPDATED_WIDTH)} ${formatCell(session.workspace, WORKSPACE_WIDTH).padEnd(WORKSPACE_WIDTH)} ${formatCell(session.title, TITLE_WIDTH)}`
    );
  }
  console.log(`\nTotal: ${sessions.length} session(s)`);
  printWarningsSummary(warnings);
}

function printRunRows(runs: BackgroundRun[], warnings: RuntimeSessionRegistryWarning[]): void {
  if (runs.length === 0) {
    console.log("No runtime runs found.");
    printWarningsSummary(warnings);
    return;
  }

  console.log("Runtime runs:\n");
  console.log(
    `${"ID".padEnd(ID_WIDTH)} ${"KIND".padEnd(KIND_WIDTH)} ${"STATUS".padEnd(STATUS_WIDTH)} ${"UPDATED".padEnd(UPDATED_WIDTH)} ${"WORKSPACE".padEnd(WORKSPACE_WIDTH)} TITLE`
  );
  console.log("-".repeat(116));
  for (const run of runs) {
    console.log(
      `${formatCell(run.id, ID_WIDTH).padEnd(ID_WIDTH)} ${run.kind.padEnd(KIND_WIDTH)} ${run.status.padEnd(STATUS_WIDTH)} ${dateLabel(run.updated_at).padEnd(UPDATED_WIDTH)} ${formatCell(run.workspace, WORKSPACE_WIDTH).padEnd(WORKSPACE_WIDTH)} ${formatCell(run.title, TITLE_WIDTH)}`
    );
  }
  console.log(`\nTotal: ${runs.length} run(s)`);
  printWarningsSummary(warnings);
}

function refLabel(ref: { kind: string; id: string | null; relative_path: string | null; path: string | null } | null): string {
  if (!ref) return "-";
  const target = ref.relative_path ?? ref.path ?? ref.id ?? "-";
  return `${ref.kind}:${target}`;
}

function printSessionDetail(session: RuntimeSession): void {
  console.log(`Runtime session: ${session.id}`);
  console.log(`  Kind:        ${session.kind}`);
  console.log(`  Status:      ${session.status}`);
  console.log(`  Parent:      ${session.parent_session_id ?? "-"}`);
  console.log(`  Title:       ${session.title ?? "-"}`);
  console.log(`  Workspace:   ${session.workspace ?? "-"}`);
  console.log(`  Created:     ${session.created_at ?? "-"}`);
  console.log(`  Updated:     ${session.updated_at ?? "-"}`);
  console.log(`  Last event:  ${session.last_event_at ?? "-"}`);
  console.log(`  Resumable:   ${session.resumable ? "yes" : "no"}`);
  console.log(`  Attachable:  ${session.attachable ? "yes" : "no"}`);
  console.log(`  Transcript:  ${refLabel(session.transcript_ref)}`);
  console.log(`  State:       ${refLabel(session.state_ref)}`);
  console.log(`  Reply:       ${session.reply_target ? session.reply_target.channel : "-"}`);
  console.log(`  Sources:     ${session.source_refs.map(refLabel).join(", ") || "-"}`);
}

function printRunDetail(run: BackgroundRun): void {
  console.log(`Runtime run: ${run.id}`);
  console.log(`  Kind:        ${run.kind}`);
  console.log(`  Status:      ${run.status}`);
  console.log(`  Parent:      ${run.parent_session_id ?? "-"}`);
  console.log(`  Child:       ${run.child_session_id ?? "-"}`);
  console.log(`  Process:     ${run.process_session_id ?? "-"}`);
  console.log(`  Notify:      ${run.notify_policy}`);
  console.log(`  Title:       ${run.title ?? "-"}`);
  console.log(`  Workspace:   ${run.workspace ?? "-"}`);
  console.log(`  Created:     ${run.created_at ?? "-"}`);
  console.log(`  Started:     ${run.started_at ?? "-"}`);
  console.log(`  Updated:     ${run.updated_at ?? "-"}`);
  console.log(`  Completed:   ${run.completed_at ?? "-"}`);
  console.log(`  Summary:     ${run.summary ?? "-"}`);
  console.log(`  Error:       ${run.error ?? "-"}`);
  console.log(`  Artifacts:   ${run.artifacts.map((artifact) => artifact.label).join(", ") || "-"}`);
  console.log(`  Sources:     ${run.source_refs.map(refLabel).join(", ") || "-"}`);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function parseListArgs(args: string[], command: string): RuntimeListValues {
  const logger = getCliLogger();
  try {
    const { values } = parseArgs({
      args,
      options: {
        json: { type: "boolean" },
        active: { type: "boolean" },
        attention: { type: "boolean" },
      },
      strict: false,
    }) as { values: RuntimeListValues };
    return values;
  } catch (err) {
    logger.error(formatOperationError(`parse runtime ${command} arguments`, err));
    return {};
  }
}

function parseDetailArgs(args: string[], command: string): { id?: string; json?: boolean } {
  const logger = getCliLogger();
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        json: { type: "boolean" },
      },
      allowPositionals: true,
      strict: false,
    }) as { values: { json?: boolean }; positionals: string[] };
    return { id: positionals[0], json: values.json };
  } catch (err) {
    logger.error(formatOperationError(`parse runtime ${command} arguments`, err));
    return {};
  }
}

export async function cmdRuntime(stateManager: StateManager, args: string[]): Promise<number> {
  const logger = getCliLogger();
  const runtimeSubcommand = args[0];

  if (!runtimeSubcommand) {
    logger.error("Error: runtime subcommand required. Available: runtime sessions, runtime runs, runtime session <id>, runtime run <id>");
    return 1;
  }

  const registry = createRuntimeSessionRegistry({ stateManager });

  if (runtimeSubcommand === "sessions") {
    const values = parseListArgs(args.slice(1), "sessions");
    const snapshot = await registry.snapshot();
    const sessions = filterSessions(snapshot, values.active === true);
    if (values.json) {
      printJson({
        schema_version: snapshot.schema_version,
        generated_at: snapshot.generated_at,
        warnings: snapshot.warnings,
        sessions,
      });
    } else {
      printSessionRows(sessions, snapshot.warnings);
    }
    return 0;
  }

  if (runtimeSubcommand === "runs") {
    const values = parseListArgs(args.slice(1), "runs");
    const snapshot = await registry.snapshot();
    const runs = filterRuns(snapshot, values.active === true, values.attention === true);
    if (values.json) {
      printJson({
        schema_version: snapshot.schema_version,
        generated_at: snapshot.generated_at,
        warnings: snapshot.warnings,
        background_runs: runs,
      });
    } else {
      printRunRows(runs, snapshot.warnings);
    }
    return 0;
  }

  if (runtimeSubcommand === "session") {
    const values = parseDetailArgs(args.slice(1), "session");
    if (!values.id) {
      logger.error("Error: session ID is required. Usage: pulseed runtime session <id> [--json]");
      return 1;
    }
    const session = await registry.getSession(values.id);
    if (!session) {
      console.error(`Runtime session not found: ${values.id}`);
      return 1;
    }
    values.json ? printJson(session) : printSessionDetail(session);
    return 0;
  }

  if (runtimeSubcommand === "run") {
    const values = parseDetailArgs(args.slice(1), "run");
    if (!values.id) {
      logger.error("Error: run ID is required. Usage: pulseed runtime run <id> [--json]");
      return 1;
    }
    const run = await registry.getRun(values.id);
    if (!run) {
      console.error(`Runtime run not found: ${values.id}`);
      return 1;
    }
    values.json ? printJson(run) : printRunDetail(run);
    return 0;
  }

  logger.error(`Unknown runtime subcommand: "${runtimeSubcommand}"`);
  logger.error("Available: runtime sessions, runtime runs, runtime session <id>, runtime run <id>");
  return 1;
}
