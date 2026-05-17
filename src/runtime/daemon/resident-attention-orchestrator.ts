import type { ResidentActivity } from "../../base/types/daemon.js";
import {
  admitInitiativeGateDecision,
  buildSignalContextFromAttentionInputs,
  createAttentionInput,
  createUrgeCandidate,
  decideInhibition,
  mergeUrgesIntoAgenda,
  ref,
  runAttentionCycle,
  selectInitiativeGateDecision,
  type AttentionCycleResult,
  type AttentionSafetyTrigger,
  type AttentionAdmissionCandidate,
} from "../attention/index.js";
import { refKey, stableId } from "../attention/attention-refs.js";
import { AttentionStateStore } from "../store/attention-state-store.js";
import { RuntimeOperationStore } from "../store/runtime-operation-store.js";
import type { RuntimeControlOperation } from "../store/runtime-operation-schemas.js";
import type {
  AutonomyCheck,
  CompanionAutonomyRef,
  AttentionScope,
  OutcomeClass,
  OutcomeDecision,
} from "../types/companion-autonomy.js";
import type {
  CompanionStateMode,
  CompanionWideControl,
} from "../types/companion-state.js";
import { resolveDaemonRuntimeRoot } from "./runtime-root.js";
import type {
  DaemonRunnerResidentContext,
  ResidentAttentionActivityMetadata,
  ResidentSurfaceActivityMetadata,
} from "./runner-resident-shared.js";

export type ResidentAttentionAction =
  | "sleep"
  | "suggest_goal"
  | "investigate"
  | "preemptive_check"
  | "peer_initiative"
  | "curiosity"
  | "curiosity_noop";

export interface ResidentAttentionAdmission {
  action: ResidentAttentionAction;
  source_kind: "resident_proactive_maintenance" | "resident_curiosity";
  attention_input_id: string;
  signal_context_id: string;
  urge_id: string;
  agenda_item_id: string;
  inhibition_decision_id: string;
  initiative_gate_decision_id: string;
  outcome_decision_id?: string;
  replay_disposition: "accepted" | "duplicate";
  requested_outcome: OutcomeClass;
  admission_status: OutcomeDecision["admission_status"] | "not_selected";
  final_outcome?: OutcomeClass;
  outcome_decision?: OutcomeDecision;
  branch_admitted: boolean;
  summary: string;
}

export interface ResidentAttentionEvaluationInput {
  action: ResidentAttentionAction;
  trigger: ResidentActivity["trigger"];
  summary: string;
  details?: Record<string, unknown>;
  goalId?: string;
  now?: string;
  surfaceActivityMetadata?: ResidentSurfaceActivityMetadata;
}

interface ResidentCompanionControlSnapshot {
  controls: CompanionWideControl[];
  epoch: string;
  evidenceRefs: CompanionAutonomyRef[];
  unavailableReason?: string;
}

type ResidentAttentionContext = Pick<
  DaemonRunnerResidentContext,
  "baseDir" | "config" | "state" | "logger"
> & Partial<Pick<DaemonRunnerResidentContext, "attentionStateStore" | "runtimeOperationStore">>;

export async function evaluateResidentAttentionAdmission(
  context: ResidentAttentionContext,
  input: ResidentAttentionEvaluationInput,
): Promise<ResidentAttentionAdmission> {
  const now = input.now ?? new Date().toISOString();
  const sourceKind = sourceKindForResidentAttention(input.action);
  const requestedOutcome = requestedOutcomeForResidentAction(input.action, input.details);
  const goalId = input.goalId ?? goalIdFromDetails(input.details);
  const companionSnapshot = await loadResidentCompanionControlSnapshot(context);
  const companionControls = companionSnapshot.controls;
  const sourceId = residentAttentionSourceId(input, goalId, companionSnapshot.epoch);
  const companionState = residentCompanionState(companionSnapshot);
  const companionEvidenceRefs = companionSnapshot.evidenceRefs;
  const surfaceRef = input.surfaceActivityMetadata?.surface_id
    ? ref("surface", input.surfaceActivityMetadata.surface_id)
    : undefined;
  const targetRef = targetRefForResidentAttention(input.action, sourceId, goalId);
  const attentionScope = residentAttentionScope({
    action: input.action,
    companionSnapshot,
    surfaceRef,
  });
  const attentionInput = createAttentionInput({
    source_kind: sourceKind,
    source_id: sourceId,
    source_epoch: `resident:${sourceKind}:${input.trigger}:${input.action}:${companionSnapshot.epoch}`,
    high_watermark: residentAttentionHighWatermark(input, goalId, companionSnapshot.epoch),
    emitted_at: now,
    payload_class: `resident.${input.trigger}.${input.action}`,
    summary: input.summary,
    active_surface_ref: surfaceRef,
    current_goal_refs: goalId ? [ref("goal", goalId)] : [],
    runtime_state_refs: [ref("runtime_event", `daemon-loop:${context.state.loop_count}`)],
    effect_policy: {
      wake: true,
      notify: false,
      speak: false,
      act: false,
    },
  });
  const signalContext = buildSignalContextFromAttentionInputs({
    signal_context_id: `signal:resident:${stableId(sourceId)}`,
    assembled_at: now,
    inputs: [attentionInput],
    current_goal_refs: goalId ? [ref("goal", goalId)] : [],
    runtime_state_refs: [ref("runtime_event", `daemon-loop:${context.state.loop_count}`)],
  });
  const urge = createUrgeCandidate({
    urge_id: `urge:resident:${stableId(sourceId)}`,
    signal_context: signalContext,
    origin: sourceKind === "resident_curiosity" ? "curiosity" : "runtime_event",
    target: targetRef,
    feeling: feelingForResidentAction(input.action),
    subject: input.summary,
    strength: strengthForResidentAction(input.action),
    confidence: confidenceForResidentAction(input.action),
    expected_user_benefit: expectedBenefitForResidentAction(input.action),
    maturation_state: "mature",
    surface_ref: surfaceRef,
    scope: attentionScope,
  });
  const [agendaItem] = mergeUrgesIntoAgenda({
    urges: [urge],
    now,
  });
  if (!agendaItem) {
    throw new Error("resident attention admission did not create an agenda item");
  }

  const metabolismStore = residentAttentionMetabolismStore(context);
  let metabolismResult: AttentionCycleResult | null = null;
  if (metabolismStore) {
    const revision = await metabolismStore.projectionRevision(urge.scope);
    const safetyTrigger = residentMetabolismSafetyTrigger(companionSnapshot);
    metabolismResult = await runAttentionCycle({
      store: metabolismStore,
      cycle: {
        now,
        trigger: safetyTrigger ? "suspend" : "conversation",
        safetyTrigger,
        scope: urge.scope,
        signalRefs: urge.signalRefs,
        sourceHighWatermarks: [
          {
            source: attentionInput.source.source_kind,
            highWatermark: attentionInput.source.high_watermark,
          },
        ],
        expectedProjectionRevision: revision,
        cycleIdempotencyKey: `resident:${sourceId}`,
        policyEpoch: urge.policyEpoch,
        mode: "live",
        urges: [urge],
      },
    });
  }

  const currentMetabolismAgenda = metabolismResult
    ? selectMetabolismAgendaForUrge(metabolismResult, urge.urge_id)
    : null;
  const currentAdmissionCandidates = currentMetabolismAgenda && metabolismResult
    ? metabolismResult.admissionCandidates.filter((candidate) =>
      candidate.agendaRef === currentMetabolismAgenda.agenda_item_id
    )
    : [];
  const decisionAgendaItem = currentMetabolismAgenda ?? agendaItem;

  const inhibition = decideInhibition({
    decision_id: `inhibition:resident:${stableId(sourceId)}`,
    decided_at: now,
    candidate: decisionAgendaItem,
    companion_state: companionState,
    permission_checks: [
      ...companionControls.includes("pause_proactivity")
        ? [failedCheck("permission", "pause_proactivity is active for resident attention", companionEvidenceRefs)]
        : [],
      passedCheck("permission", "resident signal only creates an inspectable agenda candidate"),
    ],
    staleness_checks: [passedCheck("staleness", "resident signal uses the current source high-watermark")],
    safety_checks: [
      ...companionSnapshot.unavailableReason
        ? [failedCheck("safety", companionSnapshot.unavailableReason, companionEvidenceRefs)]
        : [],
      ...companionControls.includes("suspend_companion")
        ? [failedCheck("safety", "suspend_companion is active for resident attention", companionEvidenceRefs)]
        : [],
      passedCheck("safety", "resident signal cannot notify, speak, or act before outcome admission"),
    ],
    policy_refs: companionSnapshot.unavailableReason ? companionEvidenceRefs : [],
  });
  const runtimeControlRefs = runtimeControlRefsForResidentAction({
    action: input.action,
    goalId,
    requestedOutcome,
    surfaceActivityMetadata: input.surfaceActivityMetadata,
  });
  const companionControlChecks = residentCompanionControlChecks(companionSnapshot);
  const gate = selectInitiativeGateDecision({
    decision_id: `gate:resident:${stableId(sourceId)}`,
    decided_at: now,
    candidate: decisionAgendaItem,
    inhibition_decision: inhibition,
    companion_state: companionState,
    requested_outcome: requestedOutcome,
    permission_checks: [passedCheck("permission", "resident branch requires typed attention admission")],
    staleness_checks: [passedCheck("staleness", "resident branch target was grounded in this source high-watermark")],
    side_effect_checks: [passedCheck("authority", "runtime-control admission remains separate from capability availability")],
    required_runtime_control_refs: runtimeControlRefs.required,
  });
  const outcome = admitInitiativeGateDecision({
    outcome_decision_id: `outcome:resident:${stableId(sourceId)}`,
    gate_decision: gate,
    decided_at: now,
    runtime_item_refs: [ref("runtime_item", decisionAgendaItem.agenda_item_id)],
    admitted_runtime_control_refs: runtimeControlRefs.admitted,
    authority_checks: [passedCheck("authority", "resident outcome has no execution authority without runtime-control admission")],
    staleness_checks: [passedCheck("staleness", "resident outcome uses the current source high-watermark")],
    companion_control_checks: companionControlChecks,
    safety_checks: [passedCheck("safety", "resident outcome remains non-GUI and non-notifying")],
    visibility_checks: [passedCheck("visibility", "resident outcome is hidden from normal surfaces until shared delivery admits it")],
    visibility_policy_ref: visibilityPolicyRefForResidentAction(input.action, sourceId),
  });

  const intake = await residentAttentionStore(context).saveCycle({
    attentionInputs: [attentionInput],
    signalContext,
    urgeCandidates: [urge],
    agendaItems: [decisionAgendaItem],
    inhibitionDecisions: [inhibition],
    initiativeGateDecisions: [gate],
    outcomeDecisions: outcome ? [outcome] : [],
    recordedAt: now,
  });
  const replayDisposition = intake && intake.accepted.length === 0 && intake.duplicates.length > 0
    ? "duplicate"
    : "accepted";

  const returnedAgendaItemId = decisionAgendaItem.agenda_item_id;
  const metabolismAdmitted = replayDisposition === "accepted"
    && residentBranchAdmitted(input.action, outcome, input.details)
    && residentMetabolismAdmitsAction(input.action, currentAdmissionCandidates, metabolismResult);
  const returnedAdmissionStatus = metabolismResult && currentAdmissionCandidates.length === 0 && outcome?.admission_status === "admitted"
    ? "not_selected"
    : outcome?.admission_status ?? "not_selected";

  return {
    action: input.action,
    source_kind: sourceKind,
    attention_input_id: attentionInput.attention_input_id,
    signal_context_id: signalContext.signal_context_id,
    urge_id: urge.urge_id,
    agenda_item_id: returnedAgendaItemId,
    inhibition_decision_id: inhibition.decision_id,
    initiative_gate_decision_id: gate.decision_id,
    outcome_decision_id: outcome?.outcome_decision_id,
    replay_disposition: replayDisposition,
    requested_outcome: requestedOutcome,
    admission_status: returnedAdmissionStatus,
    final_outcome: outcome?.final_outcome,
    outcome_decision: outcome ?? undefined,
    branch_admitted: metabolismAdmitted,
    summary: replayDisposition === "duplicate"
      ? `Resident ${input.action} reused an existing attention admission; no duplicate branch preparation was started.`
      : !outcome && companionControls.length > 0
        ? `Resident ${input.action} held by companion controls: ${companionControls.join(", ")}.`
      : metabolismResult && currentAdmissionCandidates.length === 0 && outcome?.admission_status === "admitted"
        ? residentAttentionMetabolismHeldSummary(input.action, metabolismResult)
      : residentAttentionAdmissionSummary(input.action, outcome, gate.reason),
  };
}

function selectMetabolismAgendaForUrge(
  result: AttentionCycleResult,
  urgeId: string,
): AttentionCycleResult["agendaUpdates"][number] | null {
  return result.agendaUpdates.find((item) =>
    item.source_urge_refs.some((urgeRef) => urgeRef.id === urgeId)
  ) ?? null;
}

export function residentAttentionActivityMetadata(
  admission: ResidentAttentionAdmission,
): ResidentAttentionActivityMetadata {
  return {
    attention_input_id: admission.attention_input_id,
    attention_replay_disposition: admission.replay_disposition,
    agenda_item_id: admission.agenda_item_id,
    outcome_decision_id: admission.outcome_decision_id,
  };
}

function residentAttentionStore(context: ResidentAttentionContext): Pick<AttentionStateStore, "saveCycle"> {
  if (context.attentionStateStore?.saveCycle) {
    return context.attentionStateStore as Pick<AttentionStateStore, "saveCycle">;
  }
  return new AttentionStateStore(
    resolveDaemonRuntimeRoot(context.baseDir, context.config.runtime_root),
    { controlBaseDir: context.baseDir },
  );
}

function residentAttentionMetabolismStore(context: ResidentAttentionContext): Pick<
  AttentionStateStore,
  | "loadConcernState"
  | "saveMetabolismCycle"
  | "projectionRevision"
  | "listPendingBlocks"
  | "clearPendingBlocks"
> | null {
  if (
    context.attentionStateStore
    && "loadConcernState" in context.attentionStateStore
    && "saveMetabolismCycle" in context.attentionStateStore
    && "projectionRevision" in context.attentionStateStore
    && "listPendingBlocks" in context.attentionStateStore
    && "clearPendingBlocks" in context.attentionStateStore
  ) {
    return context.attentionStateStore as Pick<
      AttentionStateStore,
      | "loadConcernState"
      | "saveMetabolismCycle"
      | "projectionRevision"
      | "listPendingBlocks"
      | "clearPendingBlocks"
    >;
  }
  if (context.attentionStateStore) return null;
  return new AttentionStateStore(
    resolveDaemonRuntimeRoot(context.baseDir, context.config.runtime_root),
    { controlBaseDir: context.baseDir },
  );
}

async function loadResidentCompanionControlSnapshot(
  context: ResidentAttentionContext,
): Promise<ResidentCompanionControlSnapshot> {
  const store = context.runtimeOperationStore ?? new RuntimeOperationStore(
    resolveDaemonRuntimeRoot(context.baseDir, context.config.runtime_root),
    { controlBaseDir: context.baseDir },
  );
  let allOperations: RuntimeControlOperation[];
  try {
    allOperations = [
      ...await store.listCompleted(),
      ...await store.listPending(),
    ];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.logger.warn("Failed to inspect resident companion controls; holding resident attention closed", {
      error: message,
    });
    const unavailableReason = "runtime companion controls unavailable; holding resident attention closed";
    return {
      controls: [],
      epoch: `controls-unavailable:${stableId(message)}`,
      evidenceRefs: [ref("companion_state", "resident-control-store-unavailable")],
      unavailableReason,
    };
  }
  const operations = allOperations.filter((operation): operation is RuntimeControlOperation & { kind: CompanionWideControl } =>
    operation.state === "verified" && isResidentCompanionControl(operation.kind)
  );
  operations.sort((left, right) =>
    `${left.updated_at}:${left.operation_id}`.localeCompare(`${right.updated_at}:${right.operation_id}`)
  );

  const active = new Set<CompanionWideControl>();
  for (const operation of operations) {
    applyResidentCompanionControlOperation(active, operation.kind);
  }
  const controls = [...active].sort();
  return {
    controls,
    epoch: `controls:${controls.length > 0 ? controls.join("|") : "none"}`,
    evidenceRefs: controls.map((control) => ref("runtime_control", `companion-control:${control}`)),
  };
}

function isResidentCompanionControl(kind: RuntimeControlOperation["kind"]): kind is CompanionWideControl {
  return [
    "enter_quiet_mode",
    "leave_quiet_mode",
    "pause_proactivity",
    "resume_proactivity",
    "suspend_companion",
    "resume_companion",
    "stop_all_quiet_work",
    "stop_all_watches",
    "suppress_nonessential_agenda",
    "require_confirmation_for_proactivity",
  ].includes(kind);
}

function applyResidentCompanionControlOperation(
  active: Set<CompanionWideControl>,
  kind: CompanionWideControl,
): void {
  switch (kind) {
    case "leave_quiet_mode":
      active.delete("enter_quiet_mode");
      return;
    case "resume_proactivity":
      active.delete("pause_proactivity");
      active.delete("require_confirmation_for_proactivity");
      return;
    case "resume_companion":
      active.delete("suspend_companion");
      return;
    case "inspect_companion_state":
      return;
    default:
      active.add(kind);
  }
}

function residentCompanionState(
  snapshot: ResidentCompanionControlSnapshot,
): { mode: CompanionStateMode; control_overlays: CompanionWideControl[]; blocked_refs: string[]; stale_refs: string[] } {
  const controls = snapshot.controls;
  let mode: CompanionStateMode = "resting";
  if (snapshot.unavailableReason) {
    mode = "holding_back";
  } else if (controls.includes("suspend_companion")) {
    mode = "suspended";
  } else if (controls.includes("pause_proactivity")) {
    mode = "proactivity_paused";
  } else if (controls.includes("enter_quiet_mode")) {
    mode = "quieted";
  } else if (controls.some((control) =>
    control === "stop_all_quiet_work"
      || control === "stop_all_watches"
      || control === "suppress_nonessential_agenda"
  )) {
    mode = "holding_back";
  }

  return {
    mode,
    control_overlays: controls,
    blocked_refs: snapshot.unavailableReason
      ? ["companion_state:resident-control-store-unavailable"]
      : controls.map((control) => `runtime_control:companion-control:${control}`),
    stale_refs: [],
  };
}

function residentCompanionControlChecks(
  snapshot: ResidentCompanionControlSnapshot,
): AutonomyCheck[] {
  if (snapshot.unavailableReason) {
    return [failedCheck("companion_control", snapshot.unavailableReason, snapshot.evidenceRefs)];
  }
  const controls = snapshot.controls;
  const failedControls = controls.filter((control) =>
    control === "stop_all_quiet_work"
      || control === "stop_all_watches"
      || control === "suppress_nonessential_agenda"
      || control === "require_confirmation_for_proactivity"
  );
  return [
    ...failedControls.map((control) =>
      failedCheck("companion_control", `${control} is active for resident attention`, snapshot.evidenceRefs)
    ),
    passedCheck(
      "companion_control",
      controls.length > 0
        ? `resident attention observed active companion controls: ${controls.join(", ")}`
        : "no companion-wide suppression is active in this resident tick",
    ),
  ];
}

function residentAttentionScope(input: {
  action: ResidentAttentionAction;
  companionSnapshot: ResidentCompanionControlSnapshot;
  surfaceRef?: CompanionAutonomyRef;
}): AttentionScope {
  return {
    userId: null,
    identityId: null,
    workspaceId: null,
    conversationId: null,
    sessionId: null,
    surfaceClass: "daemon",
    surfaceRef: input.surfaceRef ? refKey(input.surfaceRef) : null,
    permissionScope: input.action === "preemptive_check" ? "write_allowed" : "read_only",
    sensitivity: "medium",
    memoryOwner: null,
    policyEpoch: `resident:${input.companionSnapshot.epoch}`,
  };
}

function residentMetabolismSafetyTrigger(
  snapshot: ResidentCompanionControlSnapshot,
): AttentionSafetyTrigger | null {
  if (snapshot.unavailableReason) return "suspend";
  return snapshot.controls.some((control) =>
    control === "suspend_companion"
      || control === "pause_proactivity"
      || control === "enter_quiet_mode"
      || control === "stop_all_quiet_work"
      || control === "stop_all_watches"
      || control === "suppress_nonessential_agenda"
      || control === "require_confirmation_for_proactivity"
  ) ? "suspend" : null;
}

function residentAttentionMetabolismHeldSummary(
  action: ResidentAttentionAction,
  result: AttentionCycleResult,
): string {
  const reason = result.silenceReasons[0]?.reason ?? "concern metabolism did not admit a child";
  return `Resident ${action} held by concern metabolism: ${reason}`;
}

function residentMetabolismAdmitsAction(
  action: ResidentAttentionAction,
  candidates: readonly AttentionAdmissionCandidate[],
  result: AttentionCycleResult | null,
): boolean {
  if (!result) return true;
  const childTypes = new Set(candidates.map((candidate) => candidate.child.childType));
  switch (action) {
    case "preemptive_check":
      return childTypes.has("action_candidate");
    case "sleep":
    case "suggest_goal":
    case "investigate":
    case "curiosity":
      return childTypes.has("prepare") || childTypes.has("digest");
    case "peer_initiative":
      return childTypes.has("digest") || childTypes.has("ask") || childTypes.has("prepare");
    case "curiosity_noop":
      return childTypes.has("watch") || childTypes.has("silence");
  }
}

function residentAttentionSourceId(
  input: ResidentAttentionEvaluationInput,
  goalId: string,
  controlEpoch: string,
): string {
  const detailsHash = stableId(JSON.stringify(input.details ?? {}));
  const goalPart = goalId || "daemon";
  return [input.trigger, input.action, goalPart, detailsHash, controlEpoch].join(":");
}

function residentAttentionHighWatermark(
  input: ResidentAttentionEvaluationInput,
  goalId: string,
  controlEpoch: string,
): string {
  const detailsHash = stableId(JSON.stringify(input.details ?? {}));
  return [input.trigger, input.action, goalId || "daemon", detailsHash, controlEpoch].join(":");
}

function sourceKindForResidentAttention(
  action: ResidentAttentionAction,
): ResidentAttentionAdmission["source_kind"] {
  return action === "curiosity" || action === "curiosity_noop"
    ? "resident_curiosity"
    : "resident_proactive_maintenance";
}

function requestedOutcomeForResidentAction(action: ResidentAttentionAction, details?: Record<string, unknown>): OutcomeClass {
  switch (action) {
    case "sleep":
    case "suggest_goal":
    case "investigate":
    case "curiosity":
      return "prepare_silently";
    case "preemptive_check":
      return "prepare_action_candidate";
    case "peer_initiative":
      return requestedOutcomeForPeerInitiative(details);
    case "curiosity_noop":
      return "keep_watching";
  }
}

function residentBranchAdmitted(
  action: ResidentAttentionAction,
  outcome: OutcomeDecision | null,
  details?: Record<string, unknown>,
): boolean {
  if (!outcome || outcome.admission_status !== "admitted") return false;
  return outcome.final_outcome === requestedOutcomeForResidentAction(action, details);
}

function runtimeControlRefsForResidentAction(input: {
  action: ResidentAttentionAction;
  goalId: string;
  requestedOutcome: OutcomeClass;
  surfaceActivityMetadata?: ResidentSurfaceActivityMetadata;
}): { required: CompanionAutonomyRef[]; admitted: CompanionAutonomyRef[] } {
  if (input.action === "preemptive_check") {
    return {
      required: [ref("runtime_control", `resident-preemptive-check:${input.goalId || "unknown"}`)],
      admitted: [],
    };
  }
  const requiresPeerSurfaceControl = input.action === "peer_initiative" && (
    input.requestedOutcome === "express_to_user" ||
    input.requestedOutcome === "request_approval"
  );
  if (!requiresPeerSurfaceControl) {
    return { required: [], admitted: [] };
  }

  const controlRef = peerInitiativeSurfaceRuntimeControlRef(input.surfaceActivityMetadata);
  if (!controlRef) {
    return {
      required: [ref("runtime_control", "resident-peer-initiative-surface:missing")],
      admitted: [],
    };
  }
  return {
    required: [controlRef],
    admitted: (input.surfaceActivityMetadata?.surface_included_count ?? 0) > 0 ? [controlRef] : [],
  };
}

function peerInitiativeSurfaceRuntimeControlRef(
  metadata?: ResidentSurfaceActivityMetadata,
): CompanionAutonomyRef | null {
  const surfaceId = metadata?.surface_id?.trim();
  if (!surfaceId) return null;
  return ref("runtime_control", `resident-peer-initiative-surface:${stableId(surfaceId)}`);
}

function visibilityPolicyRefForResidentAction(
  action: ResidentAttentionAction,
  sourceId: string,
): CompanionAutonomyRef | undefined {
  if (action !== "peer_initiative") return undefined;
  return ref("visibility_policy", `visibility:resident-peer-initiative:${stableId(sourceId)}`);
}

function targetRefForResidentAttention(
  action: ResidentAttentionAction,
  sourceId: string,
  goalId: string,
): CompanionAutonomyRef {
  if (goalId) return ref("goal", goalId);
  if (action === "curiosity" || action === "curiosity_noop") {
    return ref("curiosity", sourceId);
  }
  if (action === "peer_initiative") {
    return ref("runtime_event", `resident-peer-initiative:${sourceId}`);
  }
  return ref("runtime_event", `resident-proactive:${sourceId}`);
}

function feelingForResidentAction(action: ResidentAttentionAction) {
  switch (action) {
    case "sleep":
    case "curiosity_noop":
      return "care" as const;
    case "suggest_goal":
    case "investigate":
    case "curiosity":
      return "curiosity" as const;
    case "peer_initiative":
      return "care" as const;
    case "preemptive_check":
      return "staleness_pressure" as const;
  }
}

function strengthForResidentAction(action: ResidentAttentionAction): number {
  return action === "curiosity_noop" ? 0.42 : action === "preemptive_check" ? 0.78 : action === "peer_initiative" ? 0.72 : 0.76;
}

function confidenceForResidentAction(action: ResidentAttentionAction): number {
  return action === "preemptive_check" ? 0.72 : action === "curiosity_noop" ? 0.62 : action === "peer_initiative" ? 0.7 : 0.76;
}

function expectedBenefitForResidentAction(action: ResidentAttentionAction): string {
  switch (action) {
    case "sleep":
      return "PulSeed can stay quiet while keeping idle maintenance auditable.";
    case "suggest_goal":
      return "PulSeed can prepare a goal suggestion without notifying or creating work.";
    case "investigate":
    case "curiosity":
      return "PulSeed can prepare curiosity follow-up without user-visible interruption.";
    case "preemptive_check":
      return "PulSeed can hold a possible proactive check until runtime-control admission exists.";
    case "peer_initiative":
      return "PulSeed can express a low-pressure peer initiative only after attention, threshold, and visibility admission.";
    case "curiosity_noop":
      return "PulSeed can record that resident curiosity stayed quiet.";
  }
}

function requestedOutcomeForPeerInitiative(details?: Record<string, unknown>): OutcomeClass {
  const peer = details?.["peer_initiative"];
  const peerRecord = peer && typeof peer === "object" && !Array.isArray(peer)
    ? peer as Record<string, unknown>
    : details ?? {};
  const actionPlan = peerRecord["action_plan"];
  if (actionPlan && typeof actionPlan === "object" && !Array.isArray(actionPlan)) {
    const mode = (actionPlan as Record<string, unknown>)["mode"];
    const permissionRequired = (actionPlan as Record<string, unknown>)["permission_required"];
    if (mode === "permissioned_external_action" || permissionRequired === true) {
      return "request_approval";
    }
  }
  return peerRecord["max_delivery_kind"] === "digest" ? "add_to_digest" : "express_to_user";
}

function residentAttentionAdmissionSummary(
  action: ResidentAttentionAction,
  outcome: OutcomeDecision | null,
  gateReason: string,
): string {
  if (!outcome) {
    return `Resident ${action} did not pass the Initiative Gate: ${gateReason}`;
  }
  if (outcome.admission_status === "admitted") {
    return `Resident ${action} admitted as ${outcome.final_outcome}.`;
  }
  const reason = outcome.downgrade_or_rejection_reason?.detail ?? outcome.admission_status;
  return `Resident ${action} held by attention admission: ${reason}`;
}

function goalIdFromDetails(details?: Record<string, unknown>): string {
  return typeof details?.["goal_id"] === "string" ? details["goal_id"].trim() : "";
}

function passedCheck(kind: AutonomyCheck["kind"], reason: string): AutonomyCheck {
  return {
    check_id: `${kind}:resident-attention`,
    kind,
    status: "passed",
    reason,
    evidence_refs: [],
  };
}

function failedCheck(
  kind: AutonomyCheck["kind"],
  reason: string,
  evidenceRefs: CompanionAutonomyRef[] = [],
): AutonomyCheck {
  return {
    check_id: `${kind}:resident-attention`,
    kind,
    status: "failed",
    reason,
    evidence_refs: evidenceRefs.map((evidenceRef) => ({
      ref: evidenceRef,
      lifecycle: "active" as const,
    })),
  };
}
