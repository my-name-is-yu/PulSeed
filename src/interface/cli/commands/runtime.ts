// ─── pulseed runtime commands ───

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
import {
  ProactivePolicyStateStore,
  DEFAULT_RESIDENT_ACTIVATION_DAILY_NOTIFY_BUDGET,
  DEFAULT_RESIDENT_ACTIVATION_MAX_DELIVERY_KIND,
  ResidentActivationMaxDeliveryKindSchema,
  ResidentActivationStore,
  type ResidentActivationBinding,
  type ResidentActivationProposal,
  type ResidentActivationStatusProjection,
} from "../../../runtime/store/index.js";
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
import { cmdRuntimeCognitionReplay } from "./cognition-replay.js";
import { MCPServersConfigSchema } from "../../../base/types/mcp.js";
import { createBuiltinTools } from "../../../tools/builtin/factory.js";
import {
  CapabilityRegistry,
  descriptorFromGatewayChannelAction,
  descriptorFromRuntimeControlAction,
  descriptorsFromMcpServers,
  descriptorsFromPluginStates,
  type CapabilityDescriptor,
} from "../../../runtime/capability-plane.js";
import { PluginChannelRuntimeStateStore } from "../../../runtime/store/plugin-channel-runtime-state-store.js";
import { RuntimeControlOperationKindSchema } from "../../../runtime/store/runtime-operation-schemas.js";
import {
  PersonalAgentRuntimeStore,
  projectPersonalAgentNormalSurface,
  type CapabilityRegistryDecision,
  type InterventionDecision,
  type PersonalAgentNormalSurfaceProjection,
  type PersonalAgentTraceSnapshot,
  type RuntimeGraphNode,
  type SituationFrame,
} from "../../../runtime/personal-agent/index.js";
import {
  RuntimeEventLogStore,
  type RuntimeEventProjectionApplyResult,
  type RuntimeEventProjectionRebuild,
  type RuntimeGraphExplainResult,
} from "../../../runtime/store/runtime-event-log.js";
import {
  PeerInitiativeStore,
  applyPeerInitiativeCalibrationPolicy,
  createPeerInitiativeCalibrationReport,
  projectPeerInitiativeCurrentCapability,
  type PeerInitiativeCalibrationApplication,
  type PeerInitiativeCalibrationReport,
  type PeerInitiativeCurrentCapabilityProjection,
} from "../../../runtime/peer-initiative/index.js";

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
  applyPolicy?: boolean;
};

type RuntimeResidentActivationValues = {
  action?: string;
  id?: string;
  json?: boolean;
  maxDelivery?: string;
  reason?: string;
  hours?: string;
  maxNotify?: string;
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

function printPeerInitiativeCapability(projection: PeerInitiativeCurrentCapabilityProjection): void {
  console.log("Peer initiative capability:");
  console.log(`  Current:       ${projection.current_capability}`);
  console.log(`  Read-only:     ${projection.read_only ? "yes" : "no"}`);
  console.log(`  Raw refs:      ${projection.raw_refs_visible ? "visible" : "hidden"}`);
  console.log("  Delivery surfaces:");
  for (const surface of projection.delivery_surfaces) {
    console.log(`    - ${surface.surface}: ${surface.current_status}`);
    console.log(`      claim: ${surface.normal_user_claim}`);
  }
}

function printPeerInitiativeCalibrationReport(report: PeerInitiativeCalibrationReport): void {
  const evidence = report.threshold_tuning_evidence;
  console.log("Peer initiative calibration:");
  console.log(`  Surface scope: ${report.surface_scope}`);
  console.log(`  Accepted:      ${evidence.accepted_count}`);
  console.log(`  Dismissed:     ${evidence.dismissed_count}`);
  console.log(`  Corrected:     ${evidence.corrected_count}`);
  console.log(`  Wrong read:    ${evidence.wrong_read_count}`);
  console.log(`  More like this: ${evidence.more_like_this_count}`);
  console.log(`  Less like this: ${evidence.less_like_this_count}`);
  console.log(`  Not now:       ${evidence.not_now_count}`);
  console.log(`  Mute kind:     ${evidence.mute_this_kind_count}`);
  console.log(`  Recommendation: ${report.recommendation}`);
  console.log(`  Review items:  ${report.relationship_review.review_item_count}`);
  console.log(`  Mutated:       ${report.mutation_performed ? "yes" : "no"}`);
}

function printPeerInitiativeCalibrationApplication(application: PeerInitiativeCalibrationApplication): void {
  console.log("Policy application:");
  console.log(`  Policy:        ${application.policy_id}`);
  console.log(`  Applied:       ${application.policy_state_result.applied_event_count}`);
  console.log(`  Skipped:       ${application.policy_state_result.skipped_existing_event_count}`);
  console.log(`  Max delivery:  ${application.policy_state_projection.max_delivery_kind}`);
  console.log(`  Cooldowns:     ${application.policy_state_projection.cooldown_ref_count}`);
  console.log(`  Budget debits: ${application.policy_state_projection.budget_debit_count}`);
  console.log(`  Authority:     ${application.authority_escalation_performed ? "expanded" : "unchanged"}`);
}

function printResidentActivationStatus(status: ResidentActivationStatusProjection): void {
  console.log("Resident activation:");
  console.log(`  Scope:         ${status.scope}`);
  console.log(`  Surface:       ${status.surface}`);
  console.log(`  Active:        ${status.active ? "yes" : "no"}`);
  console.log(`  Pending:       ${status.pending_proposal_count}`);
  if (status.active_binding) {
    console.log(`  Binding:       ${status.active_binding.binding_id}`);
    console.log(`  Max delivery:  ${status.active_binding.max_delivery_kind}`);
    console.log(`  Notify budget: ${status.active_binding.budget.max_notify}`);
    console.log(`  Expires:       ${status.active_binding.expires_at}`);
  }
}

function printResidentActivationProposal(proposal: ResidentActivationProposal): void {
  console.log(`Resident activation proposal: ${proposal.proposal_id}`);
  console.log(`  Status:        ${proposal.status}`);
  console.log(`  Surface:       ${proposal.surface}`);
  console.log(`  Max delivery:  ${proposal.requested_max_delivery_kind}`);
  console.log(`  Notify budget: ${proposal.daily_budget.max_notify}`);
  console.log(`  Hours:         ${proposal.dogfood_duration_hours}`);
  console.log(`  Claim:         ${proposal.normal_surface_claim}`);
}

function printResidentActivationBinding(binding: ResidentActivationBinding): void {
  console.log(`Resident activation binding: ${binding.binding_id}`);
  console.log(`  Status:        ${binding.status}`);
  console.log(`  Surface:       ${binding.surface}`);
  console.log(`  Max delivery:  ${binding.max_delivery_kind}`);
  console.log(`  Notify budget: ${binding.interruption_budget.max_notify}`);
  console.log(`  Expires:       ${binding.expires_at}`);
  console.log(`  Authority:     ${binding.runtime_authority ? "expanded" : "unchanged"}`);
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

function personalAgentStore(stateManager: StateManager): PersonalAgentRuntimeStore {
  const baseDir = stateManager.getBaseDir();
  return new PersonalAgentRuntimeStore(resolveConfiguredDaemonRuntimeRoot(baseDir), {
    controlBaseDir: baseDir,
  });
}

function runtimeEventLogStore(stateManager: StateManager): RuntimeEventLogStore {
  const baseDir = stateManager.getBaseDir();
  return new RuntimeEventLogStore(resolveConfiguredDaemonRuntimeRoot(baseDir), {
    controlBaseDir: baseDir,
  });
}

async function capabilityRegistryForRuntimeExplain(stateManager: StateManager): Promise<CapabilityRegistry> {
  const registry = CapabilityRegistry.fromTools(createBuiltinTools({ stateManager }));
  for (const descriptor of descriptorsFromMcpServers(await loadMcpServersForCapabilityExplain(stateManager))) {
    registry.register(descriptor);
  }
  const pluginStore = new PluginChannelRuntimeStateStore(stateManager.getBaseDir());
  for (const descriptor of descriptorsFromPluginStates(await pluginStore.listPluginStates())) {
    registry.register(descriptor);
  }
  for (const action of RuntimeControlOperationKindSchema.options) {
    registry.register(descriptorFromRuntimeControlAction(action));
  }
  return registry;
}

async function loadMcpServersForCapabilityExplain(stateManager: StateManager) {
  for (const fileName of ["mcp-servers.json", "mcpServers.json"]) {
    const raw = await stateManager.readRaw(fileName);
    if (raw === null) continue;
    const parsed = MCPServersConfigSchema.safeParse(raw);
    return parsed.success ? parsed.data.servers : [];
  }
  return [];
}

function printCapabilityDescriptor(descriptor: CapabilityDescriptor): void {
  const usable = descriptor.readiness_state === "executable_verified"
    || descriptor.readiness_state === "configured";
  console.log(`Capability: ${descriptor.capability_id}`);
  console.log(`  Usable:       ${usable ? "yes" : "no"} (${descriptor.readiness_state})`);
  console.log(`  Provider:     ${descriptor.provider_kind}:${descriptor.provider_ref}`);
  console.log(`  Operation:    ${descriptor.operation_kind}`);
  console.log(`  Authority:    permission=${descriptor.authority_requirements.permission_level}, approval=${descriptor.authority_requirements.approval_required ? "required" : "not-required"}, runtime-control=${descriptor.authority_requirements.runtime_control_required ? "required" : "not-required"}`);
  console.log(`  Credentials:  ${descriptor.credential_scope.kind} ${descriptor.credential_scope.refs.join(", ") || "-"}`);
  console.log(`  Sandbox:      ${descriptor.sandbox_requirement.mode}${descriptor.sandbox_requirement.network ? ", network" : ""}`);
  console.log(`  Risk:         cost=${descriptor.cost_risk_class}, side-effect=${descriptor.side_effect_profile}`);
  console.log(`  Verification: ${descriptor.verification_probe.kind}${descriptor.verification_probe.required ? " required" : ""} ${descriptor.verification_probe.refs.join(", ") || "-"}`);
  console.log(`  Rollback:     ${descriptor.rollback_plan.kind}`);
  for (const step of descriptor.rollback_plan.steps) {
    console.log(`    - ${step}`);
  }
  console.log(`  Event refs:   ${descriptor.event_replay_refs.event_log_ref}, replay=${descriptor.event_replay_refs.replay_policy}`);
  console.log(`  Graph refs:   ${descriptor.runtime_graph_refs.capability_ref}, ${descriptor.runtime_graph_refs.operation_ref}`);
  console.log(`  Normal:       ${descriptor.normal_surface_affordance.safe_label}; raw catalog visible=${descriptor.normal_surface_affordance.raw_catalog_visible ? "yes" : "no"}`);
  console.log(`  Why:          ${descriptor.operator_diagnostics.summary}`);
}

function printSituationFrame(frame: SituationFrame): void {
  console.log(`SituationFrame: ${frame.frame_id}`);
  console.log(`  Caller:      ${frame.caller_path}`);
  console.log(`  Source:      ${frame.source_kind}:${frame.source_ref.ref}`);
  console.log(`  Assembled:   ${frame.assembled_at}`);
  console.log(`  Replay key:  ${frame.replay_key}`);
  console.log(`  Summary:     ${frame.summary}`);
  console.log(`  Current refs:${frame.current_refs.length}`);
  console.log(`  Memory refs: ${frame.memory_refs.length} included, ${frame.withheld_memory_refs.length} withheld, ${frame.stale_refs.length} stale`);
  console.log(`  Trace visible on normal surface: ${frame.normal_surface_trace_visible ? "yes" : "no"}`);
}

function printTraceSummary(trace: PersonalAgentTraceSnapshot): void {
  console.log(`Initiative trace: ${trace.trace_id}`);
  console.log(`  Replay key:     ${trace.replay_key}`);
  console.log(`  Situation:      ${trace.situation_frame?.frame_id ?? "-"}`);
  console.log(`  Events:         ${trace.initiative_events.length}`);
  console.log(`  Attention:      ${trace.attention_transitions.length}`);
  console.log(`  Candidates:     ${trace.task_candidates.length}`);
  console.log(`  Capability:     ${trace.capability_decisions.length}`);
  console.log(`  Intervention:   ${trace.intervention_decisions.length}`);
  console.log(`  Runtime graph:  ${trace.runtime_graph_nodes.length} node(s), ${trace.runtime_graph_edges.length} edge(s)`);
  console.log(`  Memory audits:  ${trace.memory_audits.length}`);
  for (const event of trace.initiative_events.slice(0, 8)) {
    console.log(`    - #${event.sequence} ${event.event_type}: ${formatCell(event.summary, 96)}`);
  }
}

function printNormalTraceProjection(projection: PersonalAgentNormalSurfaceProjection): void {
  console.log("Normal initiative projection:");
  console.log(`  Why now:             ${projection.why_now}`);
  console.log(`  What I will do:      ${projection.what_i_will_do}`);
  console.log(`  What I need from you:${projection.what_i_need_from_you ? ` ${projection.what_i_need_from_you}` : " -"}`);
  console.log(`  Uncertainty:         ${projection.confidence_or_uncertainty ?? "-"}`);
  console.log(`  Read-only:           ${projection.readonly_projection ? "yes" : "no"}`);
  console.log(`  Action authority:    ${projection.action_authority_increased ? "expanded" : "unchanged"}`);
  console.log(`  Raw refs visible:    ${projection.raw_refs_visible ? "yes" : "no"}`);
}

function printInterventionDecision(decision: InterventionDecision): void {
  console.log(`InterventionPolicy decision: ${decision.decision_id}`);
  console.log(`  Decision:    ${decision.decision}`);
  console.log(`  Effect:      ${decision.target_effect}`);
  console.log(`  Permission:  ${decision.permission_required ? "required" : "-"}`);
  console.log(`  Candidate:   ${decision.candidate_id}`);
  console.log(`  Capability:  ${decision.capability_decision_id}`);
  console.log(`  Policy:      ${decision.policy_ref.kind}:${decision.policy_ref.ref}`);
  console.log(`  Reason:      ${decision.reason}`);
}

function printCapabilityDecision(decision: CapabilityRegistryDecision): void {
  console.log(`Capability Registry decision: ${decision.decision_id}`);
  console.log(`  Decision:    ${decision.decision}`);
  console.log(`  Candidate:   ${decision.candidate_id}`);
  console.log(`  Registry:    ${decision.registry_epoch}`);
  console.log(`  Capabilities:${decision.capability_refs.map((ref) => `${ref.kind}:${ref.ref}`).join(", ") || "-"}`);
  console.log(`  Reason:      ${decision.reason}`);
}

function printRuntimeGraphNode(node: RuntimeGraphNode): void {
  console.log(`RuntimeGraph node: ${node.node_id}`);
  console.log(`  Kind:        ${node.node_kind}`);
  console.log(`  Ref:         ${node.ref.kind}:${node.ref.ref}`);
  console.log(`  Label:       ${node.label}`);
  console.log(`  Created:     ${node.created_at}`);
  console.log(`  Updated:     ${node.updated_at}`);
  console.log(`  Provenance:  ${node.provenance_refs.map((ref) => `${ref.kind}:${ref.ref}`).join(", ") || "-"}`);
}

function printRuntimeEventProjectionRebuild(rebuild: RuntimeEventProjectionRebuild): void {
  console.log("Runtime event-log projection rebuild:");
  console.log(`  Trace:        ${rebuild.trace_id ?? "-"}`);
  console.log(`  Events:       ${rebuild.source_event_count}`);
  console.log(`  Authority:    ${rebuild.interaction_authority_summary.decision_count} decision(s)`);
  console.log(`  Approvals:    ${rebuild.approval_resume_outcomes.length}`);
  console.log(`  Notifications:${rebuild.notification_outbox_dedupe_state.length}`);
  console.log(`  Peer delivery:${rebuild.peer_delivery_state.length}`);
  console.log(`  Memory:       ${rebuild.memory_correction_invalidation_summary.length}`);
  console.log(`  Schedule:     ${rebuild.schedule_wake_execution_summary.length}`);
  console.log(`  Tools:        ${rebuild.tool_execution_outcome_summary.length}`);
  console.log(`  Runtime ops:  ${rebuild.runtime_control_operation_summary.length}`);
  console.log(`  Commitments:  ${rebuild.attention_commitment_lifecycle_summary.length}`);
}

function printRuntimeEventProjectionApply(applied: RuntimeEventProjectionApplyResult): void {
  printRuntimeEventProjectionRebuild(applied.rebuild);
  console.log(`  Applied:      ${applied.snapshots.length} projection snapshot(s)`);
  console.log(`  Current rows: goals ${applied.current_state_projection_rows.goal_records}, tasks ${applied.current_state_projection_rows.task_records}, authority ${applied.current_state_projection_rows.interaction_authority_decisions}, runtime ops ${applied.current_state_projection_rows.runtime_operations}, commitments ${applied.current_state_projection_rows.attention_commitment_candidates}`);
  console.log(`  Event:        ${applied.event.event_id}`);
}

function printRuntimeGraphExplain(explain: RuntimeGraphExplainResult): void {
  console.log(`RuntimeGraph explanation: ${explain.trace_id}`);
  console.log(`  Events:       ${explain.events.length}`);
  console.log(`  Graph:        ${explain.runtime_graph.nodes.length} node(s), ${explain.runtime_graph.edges.length} edge(s)`);
  console.log(`  Cause refs:   ${explain.operator_debug_evidence.why_it_happened.join(", ") || "-"}`);
  console.log(`  Decisions:    ${explain.operator_debug_evidence.admitted_or_blocked_by.join(", ") || "-"}`);
  console.log(`  Touched:      ${explain.operator_debug_evidence.touched_refs.join(", ") || "-"}`);
  console.log(`  Side effects: ${explain.operator_debug_evidence.side_effect_refs.join(", ") || "-"}`);
  console.log(`  Replay keys:  ${explain.operator_debug_evidence.replay_or_dedupe_refs.join(", ") || "-"}`);
  printRuntimeEventProjectionRebuild(explain.projection_rebuild);
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
        "apply-policy": { type: "boolean" },
      },
      strict: false,
    }) as { values: RuntimeListValues & { "apply-policy"?: boolean } };
    return {
      ...values,
      applyPolicy: values["apply-policy"] === true,
    };
  } catch (err) {
    logger.error(formatOperationError(`parse runtime ${command} arguments`, err));
    return {};
  }
}

function parseDetailArgs(args: string[], command: string): { id?: string; json?: boolean; normal?: boolean } {
  const logger = getCliLogger();
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        json: { type: "boolean" },
        normal: { type: "boolean" },
      },
      allowPositionals: true,
      strict: false,
    }) as { values: { json?: boolean; normal?: boolean }; positionals: string[] };
    return { id: positionals[0], json: values.json, normal: values.normal };
  } catch (err) {
    logger.error(formatOperationError(`parse runtime ${command} arguments`, err));
    return {};
  }
}

function parseRuntimeEventArgs(args: string[], command: string): { id?: string; trace?: string; json?: boolean; dryRun?: boolean } {
  const logger = getCliLogger();
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        trace: { type: "string" },
        json: { type: "boolean" },
        "dry-run": { type: "boolean" },
      },
      allowPositionals: true,
      strict: false,
    }) as { values: { trace?: string; json?: boolean; "dry-run"?: boolean }; positionals: string[] };
    return {
      id: positionals[0],
      trace: values.trace,
      json: values.json,
      dryRun: values["dry-run"],
    };
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

function parseResidentActivationArgs(args: string[]): RuntimeResidentActivationValues {
  const logger = getCliLogger();
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        json: { type: "boolean" },
        "max-delivery": { type: "string" },
        reason: { type: "string" },
        hours: { type: "string" },
        "max-notify": { type: "string" },
      },
      allowPositionals: true,
      strict: false,
    }) as {
      values: {
        json?: boolean;
        "max-delivery"?: string;
        reason?: string;
        hours?: string;
        "max-notify"?: string;
      };
      positionals: string[];
    };
    return {
      action: positionals[0],
      id: positionals[1],
      json: values.json,
      maxDelivery: values["max-delivery"],
      reason: values.reason,
      hours: values.hours,
      maxNotify: values["max-notify"],
    };
  } catch (err) {
    logger.error(formatOperationError("parse runtime resident-activation arguments", err));
    return {};
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number | null {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || !Number.isSafeInteger(parsed)) return null;
  return parsed;
}

function parseNonnegativeInteger(value: string | undefined, fallback: number): number | null {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || !Number.isSafeInteger(parsed)) return null;
  return parsed;
}

export async function cmdRuntime(stateManager: StateManager, args: string[]): Promise<number> {
  const logger = getCliLogger();
  const runtimeSubcommand = args[0];

  if (!runtimeSubcommand) {
    logger.error("Error: runtime subcommand required. Available: runtime bindings, runtime sessions, runtime runs, runtime session <id>, runtime run <id>, runtime experiment-queues, runtime experiment-queue <id>, runtime budgets, runtime budget <id>, runtime evidence <goal-id|run-id>, runtime postmortem <goal-id|run-id>, runtime dream-review <run-id>, runtime proactive-quality, runtime proactive-calibration, runtime resident-activation, runtime peer-initiative-capability, runtime proactive-feedback, runtime attention-continuity, runtime cognition-replay, runtime situation-frame <id>, runtime initiative-trace <ref>, runtime attention-state, runtime intervention-decision <id>, runtime capability-decision <id>, runtime capability explain <capability-id>, runtime runtime-graph <id>, runtime graph explain <trace-id>, runtime event-log rebuild [--dry-run], runtime replay --trace <trace-id>, runtime memory-provenance");
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

  if (runtimeSubcommand === "proactive-calibration") {
    const values = parseListArgs(args.slice(1), "proactive-calibration");
    const baseDir = stateManager.getBaseDir();
    const runtimeRoot = resolveConfiguredDaemonRuntimeRoot(baseDir);
    const proactiveStore = new ProactiveInterventionStore(runtimeRoot, { controlBaseDir: baseDir });
    const proactiveEvents = await proactiveStore.list(500);
    const proactiveSummary = await proactiveStore.summarize();
    const peerFeedbackProjections = await new PeerInitiativeStore(runtimeRoot, { controlBaseDir: baseDir })
      .listFeedbackProjections({ limit: 500 });
    const report = createPeerInitiativeCalibrationReport({
      generatedAt: new Date().toISOString(),
      proactiveSummary,
      peerFeedbackProjections,
    });
    if (values.applyPolicy) {
      const application = await applyPeerInitiativeCalibrationPolicy({
        policyStore: new ProactivePolicyStateStore(runtimeRoot, { controlBaseDir: baseDir }),
        generatedAt: report.generated_at,
        proactiveEvents,
        peerFeedbackProjections,
      });
      if (values.json) {
        printJson({ report, policy_application: application });
      } else {
        printPeerInitiativeCalibrationReport(report);
        printPeerInitiativeCalibrationApplication(application);
      }
      return 0;
    }
    values.json ? printJson(report) : printPeerInitiativeCalibrationReport(report);
    return 0;
  }

  if (runtimeSubcommand === "resident-activation") {
    const values = parseResidentActivationArgs(args.slice(1));
    const baseDir = stateManager.getBaseDir();
    const store = new ResidentActivationStore(resolveConfiguredDaemonRuntimeRoot(baseDir), { controlBaseDir: baseDir });
    const action = values.action ?? "status";
    if (action === "status") {
      const status = await store.projectStatus();
      values.json ? printJson(status) : printResidentActivationStatus(status);
      return 0;
    }
    if (action === "propose") {
      const maxDelivery = values.maxDelivery
        ? ResidentActivationMaxDeliveryKindSchema.safeParse(values.maxDelivery)
        : ResidentActivationMaxDeliveryKindSchema.safeParse(DEFAULT_RESIDENT_ACTIVATION_MAX_DELIVERY_KIND);
      if (!maxDelivery.success) {
        logger.error("Error: --max-delivery must be digest, suggest, or notify.");
        return 1;
      }
      const hours = parsePositiveInteger(values.hours, 24);
      const maxNotify = parseNonnegativeInteger(
        values.maxNotify,
        maxDelivery.data === "notify" ? DEFAULT_RESIDENT_ACTIVATION_DAILY_NOTIFY_BUDGET : 0,
      );
      if (!hours || maxNotify === null) {
        logger.error("Error: --hours must be positive and --max-notify must be nonnegative.");
        return 1;
      }
      const proposal = await store.propose({
        requestedMaxDeliveryKind: maxDelivery.data,
        dogfoodDurationHours: hours,
        dailyBudget: { max_notify: maxNotify },
        reason: values.reason,
      });
      values.json ? printJson(proposal) : printResidentActivationProposal(proposal);
      return 0;
    }
    if (action === "accept") {
      if (!values.id) {
        logger.error("Error: proposal ID is required. Usage: pulseed runtime resident-activation accept <proposal-id> [--json]");
        return 1;
      }
      const binding = await store.accept(values.id);
      values.json ? printJson(binding) : printResidentActivationBinding(binding);
      return 0;
    }
    logger.error("Error: unknown resident-activation action. Available: status, propose, accept");
    return 1;
  }

  if (runtimeSubcommand === "peer-initiative-capability") {
    const values = parseListArgs(args.slice(1), "peer-initiative-capability");
    const projection = projectPeerInitiativeCurrentCapability();
    values.json ? printJson(projection) : printPeerInitiativeCapability(projection);
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

  if (runtimeSubcommand === "cognition-replay") {
    return await cmdRuntimeCognitionReplay(stateManager, args.slice(1));
  }

  if (runtimeSubcommand === "situation-frame") {
    const values = parseDetailArgs(args.slice(1), "situation-frame");
    if (!values.id) {
      logger.error("Error: frame ID is required. Usage: pulseed runtime situation-frame <frame-id> [--json]");
      return 1;
    }
    const frame = await personalAgentStore(stateManager).loadSituationFrame(values.id);
    if (!frame) {
      console.error(`SituationFrame not found: ${values.id}`);
      return 1;
    }
    values.json ? printJson(frame) : printSituationFrame(frame);
    return 0;
  }

  if (runtimeSubcommand === "initiative-trace") {
    const values = parseDetailArgs(args.slice(1), "initiative-trace");
    if (!values.id) {
      logger.error("Error: trace/task/run/action ref is required. Usage: pulseed runtime initiative-trace <ref> [--normal] [--json]");
      return 1;
    }
    const trace = await personalAgentStore(stateManager).loadTrace(values.id);
    if (!trace) {
      console.error(`Initiative trace not found: ${values.id}`);
      return 1;
    }
    if (values.normal) {
      const projection = projectPersonalAgentNormalSurface(trace);
      values.json ? printJson(projection) : printNormalTraceProjection(projection);
      return 0;
    }
    values.json ? printJson(trace) : printTraceSummary(trace);
    return 0;
  }

  if (runtimeSubcommand === "attention-state") {
    const values = parseListArgs(args.slice(1), "attention-state");
    const pending = await personalAgentStore(stateManager).listPendingConcerns();
    values.json ? printJson(pending) : printJson(pending);
    return 0;
  }

  if (runtimeSubcommand === "intervention-decision") {
    const values = parseDetailArgs(args.slice(1), "intervention-decision");
    if (!values.id) {
      logger.error("Error: decision ID is required. Usage: pulseed runtime intervention-decision <decision-id> [--json]");
      return 1;
    }
    const decision = await personalAgentStore(stateManager).loadInterventionDecision(values.id);
    if (!decision) {
      console.error(`InterventionPolicy decision not found: ${values.id}`);
      return 1;
    }
    values.json ? printJson(decision) : printInterventionDecision(decision);
    return 0;
  }

  if (runtimeSubcommand === "capability-decision") {
    const values = parseDetailArgs(args.slice(1), "capability-decision");
    if (!values.id) {
      logger.error("Error: decision ID is required. Usage: pulseed runtime capability-decision <decision-id> [--json]");
      return 1;
    }
    const decision = await personalAgentStore(stateManager).loadCapabilityDecision(values.id);
    if (!decision) {
      console.error(`Capability Registry decision not found: ${values.id}`);
      return 1;
    }
    values.json ? printJson(decision) : printCapabilityDecision(decision);
    return 0;
  }

  if (runtimeSubcommand === "capability" && args[1] === "explain") {
    const values = parseDetailArgs(args.slice(2), "capability explain");
    if (!values.id) {
      logger.error("Error: capability ID is required. Usage: pulseed runtime capability explain <capability-id> [--json]");
      return 1;
    }
    const registry = await capabilityRegistryForRuntimeExplain(stateManager);
    const descriptor = registry.get(values.id) ?? syntheticCapabilityDescriptorForRuntimeExplain(values.id);
    if (!descriptor) {
      console.error(`CapabilityDescriptor not found: ${values.id}`);
      return 1;
    }
    values.json ? printJson(descriptor) : printCapabilityDescriptor(descriptor);
    return 0;
  }

  if (runtimeSubcommand === "runtime-graph") {
    const values = parseDetailArgs(args.slice(1), "runtime-graph");
    if (!values.id) {
      logger.error("Error: node ID or ref is required. Usage: pulseed runtime runtime-graph <node-id|ref> [--json]");
      return 1;
    }
    const store = personalAgentStore(stateManager);
    const node = await store.loadRuntimeGraphNode(values.id);
    const trace = await store.loadTrace(values.id);
    if (!node && !trace) {
      console.error(`RuntimeGraph node or lineage trace not found: ${values.id}`);
      return 1;
    }
    if (values.json) {
      printJson({ node, trace });
    } else {
      if (node) printRuntimeGraphNode(node);
      if (trace) {
        if (node) console.log("");
        printTraceSummary(trace);
      }
    }
    return 0;
  }

  if (runtimeSubcommand === "graph" && args[1] === "explain") {
    const values = parseRuntimeEventArgs(args.slice(2), "graph explain");
    const traceId = values.trace ?? values.id;
    if (!traceId) {
      logger.error("Error: trace ID is required. Usage: pulseed runtime graph explain <trace-id> [--json]");
      return 1;
    }
    const explanation = await runtimeEventLogStore(stateManager).explainTrace(traceId);
    values.json ? printJson(explanation) : printRuntimeGraphExplain(explanation);
    return 0;
  }

  if (runtimeSubcommand === "event-log" && args[1] === "rebuild") {
    const values = parseRuntimeEventArgs(args.slice(2), "event-log rebuild");
    const store = runtimeEventLogStore(stateManager);
    if (values.dryRun === true) {
      const rebuild = await store.rebuildProjections({ traceId: values.trace });
      values.json ? printJson(rebuild) : printRuntimeEventProjectionRebuild(rebuild);
      return 0;
    }
    if (values.trace) {
      logger.error(
        "Error: trace-scoped projection apply is not supported. Use --dry-run with --trace for inspection, or omit --trace to apply the full event log.",
      );
      return 1;
    }
    const applied = await store.applyProjectionRebuild();
    values.json ? printJson(applied) : printRuntimeEventProjectionApply(applied);
    return 0;
  }

  if (runtimeSubcommand === "replay") {
    const values = parseRuntimeEventArgs(args.slice(1), "replay");
    const traceId = values.trace ?? values.id;
    if (!traceId) {
      logger.error("Error: --trace <trace-id> is required. Usage: pulseed runtime replay --trace <trace-id> [--json]");
      return 1;
    }
    const explanation = await runtimeEventLogStore(stateManager).explainTrace(traceId);
    values.json ? printJson(explanation) : printRuntimeGraphExplain(explanation);
    return 0;
  }

  if (runtimeSubcommand === "memory-provenance") {
    const values = parseListArgs(args.slice(1), "memory-provenance");
    const audits = await personalAgentStore(stateManager).listMemoryAudits();
    values.json ? printJson({ memory_audits: audits }) : printJson({ memory_audits: audits });
    return 0;
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
  logger.error("Available: runtime sessions, runtime runs, runtime session <id>, runtime run <id>, runtime experiment-queues, runtime experiment-queue <id>, runtime budgets, runtime budget <id>, runtime evidence <goal-id|run-id>, runtime postmortem <goal-id|run-id>, runtime dream-review <run-id>, runtime proactive-quality, runtime proactive-calibration, runtime resident-activation, runtime peer-initiative-capability, runtime proactive-feedback, runtime attention-continuity, runtime cognition-replay, runtime situation-frame <id>, runtime initiative-trace <ref>, runtime attention-state, runtime intervention-decision <id>, runtime capability-decision <id>, runtime capability explain <capability-id>, runtime runtime-graph <id>, runtime memory-provenance");
  return 1;
}

function syntheticCapabilityDescriptorForRuntimeExplain(capabilityId: string): CapabilityDescriptor | null {
  const gatewayPrefix = "capability:gateway_channel_action:";
  if (capabilityId.startsWith(gatewayPrefix)) {
    const rest = capabilityId.slice(gatewayPrefix.length);
    const parts = rest.split(":");
    const reportType = parts.pop();
    const channelType = parts.join(":");
    if (channelType && reportType) {
      return descriptorFromGatewayChannelAction({ channelType, reportType });
    }
  }
  return null;
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
