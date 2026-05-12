// ─── pulseed runtime commands (read-only) ───

import { parseArgs } from "node:util";
import * as path from "node:path";

import type { StateManager } from "../../../base/state/state-manager.js";
import { createRuntimeSessionRegistry } from "../../../runtime/session-registry/index.js";
import { RuntimeEvidenceLedger, type RuntimeEvidenceEntry, type RuntimeEvidenceSummary } from "../../../runtime/store/evidence-ledger.js";
import {
  RuntimeExperimentQueueStore,
  type RuntimeExperimentQueueRecord,
  type RuntimeExperimentQueueRevision,
} from "../../../runtime/store/experiment-queue-store.js";
import {
  RuntimeBudgetStore,
  type RuntimeBudgetRecord,
} from "../../../runtime/store/budget-store.js";
import {
  RuntimePostmortemReportStore,
  type RuntimePostmortemReport,
} from "../../../runtime/store/postmortem-report.js";
import {
  ProactiveInterventionOutcomeSchema,
  ProactiveInterventionStore,
  ProactiveOverreachIndicatorSchema,
  type ProactiveInterventionSummary,
} from "../../../runtime/store/proactive-intervention-store.js";
import { FeedbackIngestionStore } from "../../../runtime/store/feedback-ingestion-store.js";
import {
  inspectAttentionContinuity,
  type AttentionContinuityInspection,
} from "../../../runtime/attention/attention-continuity.js";
import { createRelationshipProfileProposalsFromProactiveFeedback } from "../../../platform/profile/proactive-feedback-proposals.js";
import {
  createRuntimeDreamSidecarReview,
  RuntimeDreamSidecarReviewError,
  type RuntimeDreamSidecarReview,
} from "../../../runtime/dream-sidecar-review.js";
import type {
  BackgroundRun,
  RuntimeSession,
  RuntimeSessionRegistrySnapshot,
  RuntimeSessionRegistryWarning,
} from "../../../runtime/session-registry/types.js";
import { getCliLogger } from "../cli-logger.js";
import { formatOperationError } from "../utils.js";
import { resolveConfiguredDaemonRuntimeRoot } from "../../../runtime/daemon/runtime-root.js";
import { collectOperatorBindingStatus, printOperatorBindingStatus } from "./operator-binding-status.js";

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

type RuntimeDreamReviewValues = {
  id?: string;
  json?: boolean;
  requestGuidanceInjection?: boolean;
};

type RuntimeProactiveFeedbackValues = {
  interventionId?: string;
  outcome?: string;
  reason?: string;
  overreachIndicator?: string[];
  followThroughSuccess?: boolean;
  json?: boolean;
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

function currentExperimentQueueRevision(queue: RuntimeExperimentQueueRecord): RuntimeExperimentQueueRevision {
  const revision = queue.revisions.find((candidate) => candidate.version === queue.current_version);
  if (!revision) {
    throw new Error(`Experiment queue ${queue.queue_id} is missing current version ${queue.current_version}`);
  }
  return revision;
}

function printExperimentQueueRows(queues: RuntimeExperimentQueueRecord[]): void {
  if (queues.length === 0) {
    console.log("No runtime experiment queues found.");
    return;
  }

  console.log("Runtime experiment queues:\n");
  console.log(
    `${"ID".padEnd(ID_WIDTH)} ${"VERSION".padEnd(8)} ${"PHASE".padEnd(24)} ${"STATUS".padEnd(10)} ${"UPDATED".padEnd(UPDATED_WIDTH)} TITLE`
  );
  console.log("-".repeat(116));
  for (const queue of queues) {
    const revision = currentExperimentQueueRevision(queue);
    console.log(
      `${formatCell(queue.queue_id, ID_WIDTH).padEnd(ID_WIDTH)} ${String(revision.version).padEnd(8)} ${revision.phase.padEnd(24)} ${revision.status.padEnd(10)} ${dateLabel(revision.updated_at).padEnd(UPDATED_WIDTH)} ${formatCell(queue.title, TITLE_WIDTH)}`
    );
  }
  console.log(`\nTotal: ${queues.length} experiment queue(s)`);
}

function printExperimentQueueDetail(queue: RuntimeExperimentQueueRecord): void {
  const revision = currentExperimentQueueRevision(queue);
  const pending = revision.items.filter((item) => item.status === "pending").length;
  const running = revision.items.filter((item) => item.status === "running").length;
  const terminal = revision.items.filter((item) => item.status === "succeeded" || item.status === "failed" || item.status === "skipped" || item.status === "cancelled").length;
  console.log(`Runtime experiment queue: ${queue.queue_id}`);
  console.log(`  Title:       ${queue.title ?? "-"}`);
  console.log(`  Goal:        ${queue.goal_id ?? "-"}`);
  console.log(`  Run:         ${queue.run_id ?? "-"}`);
  console.log(`  Version:     ${revision.version}`);
  console.log(`  Phase:       ${revision.phase}`);
  console.log(`  Status:      ${revision.status}`);
  console.log(`  Created:     ${revision.created_at}`);
  console.log(`  Frozen:      ${revision.frozen_at ?? "-"}`);
  console.log(`  Updated:     ${revision.updated_at}`);
  console.log(`  Revision of: ${revision.revision_of ?? "-"}`);
  console.log(`  Reason:      ${revision.revision_reason ?? "-"}`);
  console.log(`  Items:       ${revision.items.length} total, ${pending} pending, ${running} running, ${terminal} terminal`);
  console.log(`  Provenance:  ${revision.provenance.source}`);
  const next = revision.items.find((item) => item.status === "pending");
  console.log(`  Next item:   ${next ? `${next.item_id} (${next.idempotency_key})` : "-"}`);
}

function printBudgetRows(store: RuntimeBudgetStore, budgets: RuntimeBudgetRecord[]): void {
  if (budgets.length === 0) {
    console.log("No runtime budgets found.");
    return;
  }

  console.log("Runtime budgets:\n");
  console.log(
    `${"ID".padEnd(ID_WIDTH)} ${"MODE".padEnd(14)} ${"UPDATED".padEnd(UPDATED_WIDTH)} ${"SCOPE".padEnd(WORKSPACE_WIDTH)} TITLE`
  );
  console.log("-".repeat(116));
  for (const budget of budgets) {
    const status = store.status(budget);
    const scope = budget.scope.run_id ?? budget.scope.goal_id ?? "-";
    console.log(
      `${formatCell(budget.budget_id, ID_WIDTH).padEnd(ID_WIDTH)} ${status.mode.padEnd(14)} ${dateLabel(budget.updated_at).padEnd(UPDATED_WIDTH)} ${formatCell(scope, WORKSPACE_WIDTH).padEnd(WORKSPACE_WIDTH)} ${formatCell(budget.title, TITLE_WIDTH)}`
    );
  }
  console.log(`\nTotal: ${budgets.length} budget(s)`);
}

function printBudgetDetail(store: RuntimeBudgetStore, budget: RuntimeBudgetRecord): void {
  const status = store.status(budget);
  console.log(`Runtime budget: ${budget.budget_id}`);
  console.log(`  Title:       ${budget.title ?? "-"}`);
  console.log(`  Goal:        ${budget.scope.goal_id ?? "-"}`);
  console.log(`  Run:         ${budget.scope.run_id ?? "-"}`);
  console.log(`  Mode:        ${status.mode}`);
  console.log(`  Approval:    ${status.approval_required ? "required" : "-"}`);
  console.log(`  Handoff:     ${status.handoff_required ? "required" : "-"}`);
  console.log(`  Finalize:    ${status.finalization_required ? "required" : "-"}`);
  console.log(`  Exhausted:   ${status.exhausted ? "yes" : "no"}`);
  console.log("  Dimensions:");
  for (const dimension of status.dimensions) {
    const actions = dimension.threshold_actions.length > 0 ? ` actions=${dimension.threshold_actions.join(",")}` : "";
    console.log(`    - ${dimension.dimension}: used=${dimension.used} remaining=${dimension.remaining} limit=${dimension.limit}${actions}`);
  }
  if (status.recent_consumption.length > 0) {
    console.log("  Recent consumption:");
    for (const entry of status.recent_consumption.slice(0, 5)) {
      console.log(`    - ${entry.observed_at} ${entry.source} +${entry.amount}${entry.reason ? ` ${entry.reason}` : ""}`);
    }
  } else {
    console.log("  Recent consumption: -");
  }
}

function printProactiveSummary(summary: ProactiveInterventionSummary): void {
  console.log("Proactive intervention quality:");
  console.log(`  Interventions: ${summary.total_interventions}`);
  console.log(`  Pending:       ${summary.pending_count}`);
  console.log(`  Accepted:      ${summary.accepted_count}`);
  console.log(`  Ignored:       ${summary.ignored_count}`);
  console.log(`  Dismissed:     ${summary.dismissed_count}`);
  console.log(`  Corrected:     ${summary.corrected_count}`);
  console.log(`  Overreach:     ${summary.overreach_count}`);
  if (summary.average_time_to_response_ms !== null) {
    console.log(`  Avg response:  ${Math.round(summary.average_time_to_response_ms)}ms`);
  }
  if (summary.policy_adjustment_recommendation) {
    console.log(
      `  Policy:        ${summary.policy_adjustment_recommendation.suggested_action} for ${summary.policy_adjustment_recommendation.relationship_profile_key}`
    );
  }
}

function printAttentionContinuitySummary(inspection: AttentionContinuityInspection): void {
  console.log("Attention continuity:");
  console.log(`  Status:          ${inspection.status}`);
  console.log(`  Generated:       ${inspection.generated_at}`);
  console.log(`  Attention inputs:${inspection.summary.attention_input_count}`);
  console.log(`  Agenda:          ${inspection.summary.agenda_item_count} total, ${inspection.summary.pending_agenda_count} pending, ${inspection.summary.held_agenda_count} held, ${inspection.summary.suppressed_agenda_count} suppressed, ${inspection.summary.stale_agenda_count} stale`);
  console.log(`  Outcomes:        ${inspection.summary.held_outcome_count} held, ${inspection.summary.quiet_outcome_count} quiet, ${inspection.summary.suppressed_outcome_count} suppressed, ${inspection.summary.stale_decision_count} stale decisions`);
  console.log(`  Quiet prep:      ${inspection.summary.quiet_preparation_count}`);
  console.log(`  Runtime:         ${inspection.summary.pending_runtime_operation_count} pending operation(s), ${inspection.summary.runtime_event_count} event(s), ${inspection.summary.runtime_item_count} item(s)`);
  console.log(`  Presence:        ${inspection.presence_status.active_refs.length} active, ${inspection.presence_status.hidden_inspectable_refs.length} hidden inspectable, ${inspection.presence_status.stale_refs.length} stale`);
  console.log(`  Feedback effects:${inspection.summary.feedback_effect_count}`);
  if (inspection.warnings.length > 0) {
    console.log("  Warnings:");
    for (const warning of inspection.warnings.slice(0, 8)) {
      console.log(`    - ${warning.severity} ${warning.code}${warning.ref ? ` ${warning.ref}` : ""}: ${warning.detail}`);
    }
    if (inspection.warnings.length > 8) {
      console.log(`    - ... ${inspection.warnings.length - 8} more`);
    }
  }
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

function parseDreamReviewArgs(args: string[]): RuntimeDreamReviewValues {
  const logger = getCliLogger();
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        json: { type: "boolean" },
        "request-guidance-injection": { type: "boolean" },
        "inject-guidance": { type: "boolean" },
      },
      allowPositionals: true,
      strict: false,
    }) as {
      values: {
        json?: boolean;
        "request-guidance-injection"?: boolean;
        "inject-guidance"?: boolean;
      };
      positionals: string[];
    };
    return {
      id: positionals[0],
      json: values.json,
      requestGuidanceInjection: values["request-guidance-injection"] === true || values["inject-guidance"] === true,
    };
  } catch (err) {
    logger.error(formatOperationError("parse runtime dream-review arguments", err));
    return {};
  }
}

function parseProactiveFeedbackArgs(args: string[]): RuntimeProactiveFeedbackValues {
  try {
    const { values } = parseArgs({
      args,
      options: {
        intervention: { type: "string" },
        outcome: { type: "string" },
        reason: { type: "string" },
        "overreach-indicator": { type: "string", multiple: true },
        "follow-through-success": { type: "boolean" },
        json: { type: "boolean" },
      },
      strict: false,
    }) as {
      values: {
        intervention?: string;
        outcome?: string;
        reason?: string;
        "overreach-indicator"?: string[];
        "follow-through-success"?: boolean;
        json?: boolean;
      };
    };
    return {
      interventionId: values.intervention,
      outcome: values.outcome,
      reason: values.reason,
      overreachIndicator: values["overreach-indicator"],
      followThroughSuccess: values["follow-through-success"],
      json: values.json,
    };
  } catch (err) {
    getCliLogger().error(formatOperationError("parse runtime proactive-feedback arguments", err));
    return {};
  }
}

export async function cmdRuntime(stateManager: StateManager, args: string[]): Promise<number> {
  const logger = getCliLogger();
  const runtimeSubcommand = args[0];

  if (!runtimeSubcommand) {
    logger.error("Error: runtime subcommand required. Available: runtime bindings, runtime sessions, runtime runs, runtime session <id>, runtime run <id>, runtime experiment-queues, runtime experiment-queue <id>, runtime budgets, runtime budget <id>, runtime evidence <goal-id|run-id>, runtime postmortem <goal-id|run-id>, runtime dream-review <run-id>, runtime proactive-quality, runtime proactive-feedback, runtime attention-continuity");
    return 1;
  }

  const registry = createRuntimeSessionRegistry({ stateManager });

  if (runtimeSubcommand === "bindings") {
    const values = parseListArgs(args.slice(1), "bindings");
    const status = await collectOperatorBindingStatus(stateManager);
    values.json ? printJson(status) : printOperatorBindingStatus(status);
    return 0;
  }

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

  if (runtimeSubcommand === "evidence") {
    const values = parseDetailArgs(args.slice(1), "evidence");
    if (!values.id) {
      logger.error("Error: goal ID or run ID is required. Usage: pulseed runtime evidence <goal-id|run-id> [--json]");
      return 1;
    }
    const ledger = new RuntimeEvidenceLedger(path.join(stateManager.getBaseDir(), "runtime"));
    const summary = await summarizeEvidenceTarget(ledger, values.id);
    values.json ? printJson(summary) : printEvidenceSummary(summary);
    return 0;
  }

  if (runtimeSubcommand === "postmortem") {
    const values = parseDetailArgs(args.slice(1), "postmortem");
    if (!values.id) {
      logger.error("Error: goal ID or run ID is required. Usage: pulseed runtime postmortem <goal-id|run-id> [--json]");
      return 1;
    }
    const baseDir = stateManager.getBaseDir();
    const runtimeRoot = path.join(baseDir, "runtime");
    const store = new RuntimePostmortemReportStore(runtimeRoot, { controlBaseDir: baseDir });
    const report = await generatePostmortemTarget(store, values.id, runtimeRoot);
    values.json ? printJson(report) : printPostmortemSummary(report);
    return 0;
  }

  if (runtimeSubcommand === "experiment-queues") {
    const values = parseListArgs(args.slice(1), "experiment-queues");
    const baseDir = stateManager.getBaseDir();
    const store = new RuntimeExperimentQueueStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
    const queues = await store.list();
    if (values.json) {
      printJson({
        schema_version: "runtime-experiment-queues-list-v1",
        queues,
      });
    } else {
      printExperimentQueueRows(queues);
    }
    return 0;
  }

  if (runtimeSubcommand === "experiment-queue") {
    const values = parseDetailArgs(args.slice(1), "experiment-queue");
    if (!values.id) {
      logger.error("Error: queue ID is required. Usage: pulseed runtime experiment-queue <id> [--json]");
      return 1;
    }
    const baseDir = stateManager.getBaseDir();
    const store = new RuntimeExperimentQueueStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
    const queue = await store.load(values.id);
    if (!queue) {
      console.error(`Runtime experiment queue not found: ${values.id}`);
      return 1;
    }
    values.json ? printJson(queue) : printExperimentQueueDetail(queue);
    return 0;
  }

  if (runtimeSubcommand === "budgets") {
    const values = parseListArgs(args.slice(1), "budgets");
    const baseDir = stateManager.getBaseDir();
    const store = new RuntimeBudgetStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
    const budgets = await store.list();
    if (values.json) {
      printJson({
        schema_version: "runtime-budgets-list-v1",
        budgets: budgets.map((budget) => ({
          budget,
          status: store.status(budget),
        })),
      });
    } else {
      printBudgetRows(store, budgets);
    }
    return 0;
  }

  if (runtimeSubcommand === "budget") {
    const values = parseDetailArgs(args.slice(1), "budget");
    if (!values.id) {
      logger.error("Error: budget ID is required. Usage: pulseed runtime budget <id> [--json]");
      return 1;
    }
    const baseDir = stateManager.getBaseDir();
    const store = new RuntimeBudgetStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
    const budget = await store.load(values.id);
    if (!budget) {
      console.error(`Runtime budget not found: ${values.id}`);
      return 1;
    }
    values.json ? printJson({ budget, status: store.status(budget), task_generation_context: store.taskGenerationContext(budget) }) : printBudgetDetail(store, budget);
    return 0;
  }

  if (runtimeSubcommand === "dream-review") {
    const values = parseDreamReviewArgs(args.slice(1));
    if (!values.id) {
      logger.error("Error: run ID is required. Usage: pulseed runtime dream-review <run-id> [--json] [--request-guidance-injection]");
      return 1;
    }
    try {
      const review = await createRuntimeDreamSidecarReview({
        stateManager,
        runId: values.id,
        requestGuidanceInjection: values.requestGuidanceInjection === true,
      });
      values.json ? printJson(review) : printDreamSidecarReview(review);
      return 0;
    } catch (err) {
      if (err instanceof RuntimeDreamSidecarReviewError) {
        console.error(`${err.code}: ${err.message}`);
        return 1;
      }
      console.error(formatOperationError("runtime dream-review", err));
      return 1;
    }
  }

  if (runtimeSubcommand === "proactive-quality") {
    const values = parseListArgs(args.slice(1), "proactive-quality");
    const baseDir = stateManager.getBaseDir();
    const store = new ProactiveInterventionStore(resolveConfiguredDaemonRuntimeRoot(baseDir), { controlBaseDir: baseDir });
    const summary = await store.summarize();
    values.json ? printJson(summary) : printProactiveSummary(summary);
    return 0;
  }

  if (runtimeSubcommand === "attention-continuity") {
    const values = parseListArgs(args.slice(1), "attention-continuity");
    const baseDir = stateManager.getBaseDir();
    try {
      const inspection = await inspectAttentionContinuity({
        runtimeRoot: resolveConfiguredDaemonRuntimeRoot(baseDir),
        controlBaseDir: baseDir,
      });
      values.json ? printJson(inspection) : printAttentionContinuitySummary(inspection);
      return 0;
    } catch (err) {
      console.error(formatOperationError("runtime attention-continuity", err));
      return 1;
    }
  }

  if (runtimeSubcommand === "proactive-feedback") {
    const values = parseProactiveFeedbackArgs(args.slice(1));
    if (!values.interventionId || !values.outcome) {
      logger.error("Error: --intervention <id> and --outcome <accepted|ignored|dismissed|corrected|overreach> are required.");
      return 1;
    }
    const outcome = ProactiveInterventionOutcomeSchema.safeParse(values.outcome);
    if (!outcome.success) {
      logger.error(`Error: invalid proactive feedback outcome: ${values.outcome}`);
      return 1;
    }
    const indicators = values.overreachIndicator ?? [];
    const parsedIndicators = indicators.map((indicator) => ProactiveOverreachIndicatorSchema.safeParse(indicator));
    const invalidIndicator = parsedIndicators.find((indicator) => !indicator.success);
    if (invalidIndicator) {
      logger.error(`Error: invalid overreach indicator. Valid: too_frequent, wrong_context, sensitive, unwanted_timing`);
      return 1;
    }
    const overreachIndicators = parsedIndicators.flatMap((indicator) => indicator.success ? [indicator.data] : []);
    const baseDir = stateManager.getBaseDir();
    const store = new ProactiveInterventionStore(resolveConfiguredDaemonRuntimeRoot(baseDir), { controlBaseDir: baseDir });
    const event = await store.appendFeedback({
      interventionId: values.interventionId,
      outcome: outcome.data,
      reason: values.reason,
      overreachIndicators,
      followThroughSuccess: values.followThroughSuccess,
      channel: "cli",
    });
    const proposalResult = await createRelationshipProfileProposalsFromProactiveFeedback(stateManager.getBaseDir(), event);
    const feedbackStore = new FeedbackIngestionStore(resolveConfiguredDaemonRuntimeRoot(baseDir), { controlBaseDir: baseDir });
    const feedbackIngestion = await feedbackStore.ingest({
      source: "cli",
      feedback_kind: "proactive_feedback",
      outcome: event.outcome,
      target: {
        kind: "intervention",
        id: event.intervention_id,
      },
      recorded_at: event.recorded_at,
      reason: event.reason,
      overreach_indicators: event.overreach_indicators,
      follow_through_success: event.follow_through_success,
      proactive_event_ref: event.event_id,
      profile_proposal_refs: proposalResult.proposals.map((proposal) => proposal.id),
    });
    const summary = await store.summarize();
    if (values.json) {
      printJson({ event, feedback_ingestion: feedbackIngestion, proposals: proposalResult.proposals, summary });
    } else {
      console.log(`Recorded proactive feedback: ${event.outcome} for ${event.intervention_id}`);
      if (proposalResult.proposals.length > 0) {
        console.log(`Created ${proposalResult.proposals.length} relationship profile proposal(s).`);
      }
      if (event.policy_adjustment_recommendation) {
        console.log(`Policy recommendation: ${event.policy_adjustment_recommendation.suggested_action} for ${event.policy_adjustment_recommendation.relationship_profile_key}`);
      }
      printProactiveSummary(summary);
    }
    return 0;
  }

  logger.error(`Unknown runtime subcommand: "${runtimeSubcommand}"`);
  logger.error("Available: runtime sessions, runtime runs, runtime session <id>, runtime run <id>, runtime experiment-queues, runtime experiment-queue <id>, runtime budgets, runtime budget <id>, runtime evidence <goal-id|run-id>, runtime postmortem <goal-id|run-id>, runtime dream-review <run-id>, runtime proactive-quality, runtime proactive-feedback, runtime attention-continuity");
  return 1;
}

async function summarizeEvidenceTarget(ledger: RuntimeEvidenceLedger, id: string): Promise<RuntimeEvidenceSummary> {
  if (id.startsWith("run:")) {
    return ledger.summarizeRun(id);
  }
  const goalSummary = await ledger.summarizeGoal(id);
  if (goalSummary.total_entries > 0) {
    return goalSummary;
  }
  const runSummary = await ledger.summarizeRun(id);
  return runSummary.total_entries > 0 ? runSummary : goalSummary;
}

async function generatePostmortemTarget(
  store: RuntimePostmortemReportStore,
  id: string,
  runtimeRoot: string
): Promise<RuntimePostmortemReport> {
  if (id.startsWith("run:")) {
    return store.generate({ runId: id, trigger: "operator_request" });
  }
  const ledger = new RuntimeEvidenceLedger(runtimeRoot);
  const goalSummary = await ledger.summarizeGoal(id);
  if (goalSummary.total_entries > 0) {
    return store.generate({ goalId: id, trigger: "operator_request" });
  }
  const runSummary = await ledger.summarizeRun(id);
  return runSummary.total_entries > 0
    ? store.generate({ runId: id, trigger: "operator_request" })
    : store.generate({ goalId: id, trigger: "operator_request" });
}

function printPostmortemSummary(report: RuntimePostmortemReport): void {
  const target = report.scope.run_id
    ? `run ${report.scope.run_id}`
    : `goal ${report.scope.goal_id ?? "-"}`;
  console.log(`Runtime postmortem: ${target}`);
  console.log(`  Status:       ${report.final_status}`);
  console.log(`  Generated:    ${report.generated_at}`);
  console.log(`  Markdown:     ${report.artifact_paths.markdown_path}`);
  console.log(`  JSON:         ${report.artifact_paths.json_path}`);
  console.log(`  Timeline:     ${report.timeline.length} event(s)`);
  console.log(`  Metrics:      ${report.metric_timeline.length} trend(s)`);
  console.log(`  Outputs:      ${report.final_outputs.length}`);
  console.log(`  Manifests:    ${report.manifests.length}`);
  console.log(`  Follow-ups:   ${report.follow_up_actions.length} proposed, auto_create=false`);
  if (report.warnings.length > 0) {
    console.log(`  Warnings:     ${report.warnings.length}`);
  }
}

function printEvidenceSummary(summary: RuntimeEvidenceSummary): void {
  const target = summary.scope.run_id
    ? `run ${summary.scope.run_id}`
    : `goal ${summary.scope.goal_id ?? "-"}`;
  console.log(`Runtime evidence: ${target}`);
  console.log(`  Entries:         ${summary.total_entries}`);
  console.log(`  Latest strategy: ${entryLabel(summary.latest_strategy)}`);
  console.log(`  Best evidence:   ${entryLabel(summary.best_evidence)}`);
  if (summary.metric_trends.length > 0) {
    console.log("  Metric trends:");
    for (const trend of summary.metric_trends) {
      console.log(`    - ${trend.metric_key} ${trend.trend}: latest=${trend.latest_value}, best=${trend.best_value}, confidence=${trend.confidence.toFixed(2)}`);
    }
  } else {
    console.log("  Metric trends:   -");
  }
  printEvaluatorSummary(summary.evaluator_summary);
  printArtifactRetentionSummary(summary);
  printResearchMemos(summary);
  printDreamCheckpoints(summary);
  if (summary.recent_failed_attempts.length > 0) {
    console.log("  Recent failures:");
    for (const entry of summary.recent_failed_attempts) {
      console.log(`    - ${entryLabel(entry)}`);
    }
  } else {
    console.log("  Recent failures: -");
  }
  if (summary.warnings.length > 0) {
    console.log(`  Warnings:        ${summary.warnings.length}`);
  }
}

function printArtifactRetentionSummary(summary: RuntimeEvidenceSummary): void {
  const retention = summary.artifact_retention;
  if (retention.total_artifacts === 0) {
    console.log("  Artifact footprint: -");
    return;
  }
  const cleanupCandidates = retention.cleanup_plan.actions.filter((action) => action.destructive).length;
  console.log(`  Artifact footprint: ${retention.total_artifacts} artifacts, ${retention.total_size_bytes} bytes known, ${retention.protected_count} protected`);
  console.log(`  Retention classes: final=${retention.by_retention_class.final_deliverable}, best=${retention.by_retention_class.best_candidate}, robust=${retention.by_retention_class.robust_candidate}, near_miss=${retention.by_retention_class.near_miss}, repro=${retention.by_retention_class.reproducibility_critical}`);
  console.log(`  Cleanup plan:     ${cleanupCandidates} destructive candidates, approval_required`);
}

function printDreamSidecarReview(review: RuntimeDreamSidecarReview): void {
  console.log(`Runtime Dream review: ${review.run.id}`);
  console.log(`  Mode:            ${review.sidecar_session.mode}`);
  console.log(`  Run status:      ${review.run.kind}/${review.run.status}`);
  console.log(`  Runtime session: ${review.runtime_session?.id ?? "-"}`);
  console.log(`  Summary:         ${formatCell(review.status_summary, 120)}`);
  console.log(`  Trend:           ${review.trend_state.state}${review.trend_state.metric_key ? ` (${review.trend_state.metric_key})` : ""}`);
  console.log(`  Best evidence:   ${review.best_evidence ? `${review.best_evidence.kind}: ${formatCell(review.best_evidence.summary ?? review.best_evidence.id, 96)}` : "-"}`);
  console.log(`  Strategies:      ${review.strategy_families.join(", ") || "-"}`);
  if (review.known_gaps.length > 0) {
    console.log("  Known gaps:");
    for (const gap of review.known_gaps.slice(0, 4)) {
      console.log(`    - ${formatCell(gap, 100)}`);
    }
  } else {
    console.log("  Known gaps:      -");
  }
  console.log("  Suggested next moves:");
  for (const move of review.suggested_next_moves.slice(0, 5)) {
    console.log(`    - ${formatCell(move.title, 80)} (${move.source})`);
    console.log(`      ${formatCell(move.rationale, 100)}`);
  }
  if (review.operator_decisions.length > 0) {
    console.log("  Operator decisions:");
    for (const decision of review.operator_decisions.slice(0, 5)) {
      console.log(`    - ${formatCell(decision.label, 80)} approval_required=${decision.approval_required}`);
    }
  } else {
    console.log("  Operator decisions: -");
  }
  console.log(`  Guidance injection: ${review.guidance_injection.status}`);
  console.log(`  Evidence refs:    ${review.evidence_refs.length}`);
  console.log(`  Artifacts:        ${review.artifact_refs.map((artifact) => artifact.label).join(", ") || "-"}`);
  if (review.warnings.length > 0) {
    console.log(`  Warnings:         ${review.warnings.length}`);
  }
}

function printDreamCheckpoints(summary: RuntimeEvidenceSummary): void {
  if (summary.dream_checkpoints.length === 0) {
    console.log("  Dream checkpoints: -");
    return;
  }
  console.log("  Dream checkpoints:");
  for (const checkpoint of summary.dream_checkpoints.slice(0, 3)) {
    const dimensions = checkpoint.active_dimensions.slice(0, 3).join(", ") || "-";
    console.log(`    - ${checkpoint.trigger}: ${formatCell(checkpoint.summary, 96)}`);
    console.log(`      Dimensions: ${formatCell(dimensions, 96)}`);
  }
}

function printResearchMemos(summary: RuntimeEvidenceSummary): void {
  if (summary.research_memos.length === 0) {
    console.log("  Public research: -");
    return;
  }
  console.log("  Public research:");
  for (const memo of summary.research_memos.slice(0, 3)) {
    const sources = memo.sources.map((source) => source.url).slice(0, 2).join(", ");
    console.log(`    - ${memo.trigger}: ${formatCell(memo.summary, 96)}`);
    console.log(`      Sources: ${formatCell(sources, 96)}`);
  }
}

function printEvaluatorSummary(summary: RuntimeEvidenceSummary["evaluator_summary"]): void {
  if (summary.observations.length === 0 && summary.approval_required_actions.length === 0) {
    console.log("  Evaluators:      -");
    return;
  }
  console.log("  Evaluators:");
  console.log(`    Local best:      ${evaluatorObservationLabel(summary.local_best)}`);
  console.log(`    External best:   ${evaluatorObservationLabel(summary.external_best)}`);
  console.log(`    Gap:             ${summary.gap ? `${summary.gap.kind}: ${formatCell(summary.gap.summary, 96)}` : "-"}`);
  if (summary.approval_required_actions.length > 0) {
    console.log("    Approval needed:");
    for (const action of summary.approval_required_actions) {
      console.log(`      - ${formatCell(action.label, 48)} candidate=${formatCell(action.candidate_id, 32)} source=${formatCell(action.source, 32)}`);
    }
  }
}

function entryLabel(entry: RuntimeEvidenceEntry | null): string {
  if (!entry) return "-";
  const status = entry.outcome ?? entry.result?.status ?? entry.verification?.verdict ?? entry.kind;
  const summary = entry.summary ?? entry.result?.summary ?? entry.decision_reason ?? entry.task?.description ?? "-";
  return `${entry.occurred_at} ${entry.kind}/${status}: ${formatCell(summary, 96)}`;
}

function evaluatorObservationLabel(
  observation: RuntimeEvidenceSummary["evaluator_summary"]["local_best"]
): string {
  if (!observation) return "-";
  const candidate = observation.candidate_label ?? observation.candidate_id;
  const score = observation.score === undefined ? "" : ` score=${String(observation.score)}`;
  return `${observation.evaluator_id}/${observation.source} ${candidate} status=${observation.status}${score}`;
}
