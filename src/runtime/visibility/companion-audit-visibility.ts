import {
  AuditTraceSchema,
  VisibilityPolicySchema,
  canVisibilityPolicyExposeRawContent,
  type AuditRepairOption,
  type AuditTrace,
  type AuditTraceRecord,
  type AutonomyCheck,
  type CompanionAutonomyContentLifecycle,
  type CompanionAutonomyRef,
  type CompanionAutonomySourceRef,
  type OutcomeClass,
  type OutcomeDecision,
  type VisibilityPolicy,
} from "../types/companion-autonomy.js";
import type {
  Authority,
  CompanionStateSnapshot,
  ControlPolicy,
  RuntimeItem,
  RuntimeItemControl,
  RuntimeItemVisibilityPolicy,
} from "../types/companion-state.js";

export type CompanionVisibilitySurface =
  | "chat"
  | "tui"
  | "cli"
  | "daemon_snapshot"
  | "gui"
  | "gateway"
  | "audit"
  | "debug"
  | "digest";

export type CompanionVisibilityPreset =
  | "normal_runtime"
  | "inspectable_hidden"
  | "digest_only"
  | "audit_visible"
  | "never_direct"
  | "redacted";

export type CreateCompanionVisibilityPolicyInput = {
  visibility_policy_id: string;
  applies_to: CompanionAutonomyRef[];
  preset: CompanionVisibilityPreset;
  rationale: string;
  audit_refs?: CompanionAutonomyRef[];
  inspectable_summary?: string;
  content_lifecycle?: CompanionAutonomyContentLifecycle;
};

export type VisibilitySurfaceDecision = {
  surface: CompanionVisibilitySurface;
  visibility_policy_ref: CompanionAutonomyRef;
  visible: boolean;
  inspectable: boolean;
  raw_content_allowed: boolean;
  redacted: boolean;
  summary: string;
  reason: string;
};

export type CreateAutonomyAuditTraceInput = {
  trace_id: string;
  subject_ref: CompanionAutonomyRef;
  trigger_refs: CompanionAutonomySourceRef[];
  created_at: string;
  outcome_decision?: OutcomeDecision;
  surface_refs?: CompanionAutonomyRef[];
  memory_refs?: CompanionAutonomySourceRef[];
  permission_checks?: AutonomyCheck[];
  staleness_checks?: AutonomyCheck[];
  authority_checks?: AutonomyCheck[];
  safety_checks?: AutonomyCheck[];
  companion_state_refs?: CompanionAutonomyRef[];
  visibility_policy_refs?: CompanionAutonomyRef[];
  repair_options?: AuditRepairOption[];
  actions_taken?: AuditTraceRecord[];
  actions_withheld?: AuditTraceRecord[];
  quiet_work?: AuditTraceRecord[];
  suppressed_alternatives?: AuditTraceRecord[];
  suppressed_outcomes?: OutcomeClass[];
  user_visible_outputs?: AuditTraceRecord[];
};

export type AuditInspectionRecord = {
  record_id: string;
  summary: string;
  source_refs: CompanionAutonomySourceRef[];
  redacted: boolean;
};

export type AuditInspectionView = {
  schema_version: "audit-inspection-view-v1";
  trace_id: string;
  subject_ref: CompanionAutonomyRef;
  created_at: string;
  redaction_state: AuditTrace["redaction_state"];
  repair_options: AuditRepairOption[];
  visibility_policy_refs: CompanionAutonomyRef[];
  actions_taken: AuditInspectionRecord[];
  actions_withheld: AuditInspectionRecord[];
  quiet_work: AuditInspectionRecord[];
  suppressed_alternatives: AuditInspectionRecord[];
  user_visible_outputs: AuditInspectionRecord[];
};

export type CompanionStateInspectionRuntimeItem = {
  item_id: string;
  type: RuntimeItem["type"];
  status: RuntimeItem["status"];
  posture: RuntimeItem["posture"];
  source: string;
  visibility_policy: RuntimeItemVisibilityPolicy;
  audit_trace_refs: string[];
  authority: Pick<
    Authority,
    | "approval_scope"
    | "inspectable"
    | "resumable"
    | "actionable"
    | "speakable"
    | "requires_confirmation"
  >;
  control_policy: Pick<
    ControlPolicy,
    "allowed_controls" | "forbidden_controls" | "required_confirmation" | "repair_options"
  >;
};

export type CompanionStateInspectionView = {
  schema_version: "companion-state-inspection-view-v1";
  snapshot_id: string;
  computed_at: string;
  mode: CompanionStateSnapshot["mode"];
  current_capacity: CompanionStateSnapshot["current_capacity"];
  active_surface_ref: string | null;
  global_control_state_ref: string | null;
  control_overlays: CompanionStateSnapshot["control_overlays"];
  budgets: {
    interruption_budget: number;
    quiet_work_budget: number;
    named: Record<string, number>;
  };
  held_runtime_refs: string[];
  active_runtime_refs: string[];
  active_watch_refs: string[];
  active_wait_refs: string[];
  active_quiet_work_refs: string[];
  blocked_refs: string[];
  stale_refs: string[];
  affected_runtime_items: CompanionStateInspectionRuntimeItem[];
  audit_traces: AuditInspectionView[];
};

export type AuditRepairAction =
  | {
      kind: "runtime_control";
      option: "stop" | "retry";
      runtime_item_ref: string;
      control: RuntimeItemControl;
      requires_confirmation: boolean;
      reason: string;
    }
  | {
      kind: "permission_control";
      option: "narrow" | "revoke";
      runtime_item_ref: string;
      control: RuntimeItemControl;
      requires_confirmation: boolean;
      reason: string;
    }
  | {
      kind: "memory_correction";
      option: "forget";
      runtime_item_ref: string;
      control: RuntimeItemControl;
      requires_confirmation: boolean;
      reason: string;
    }
  | {
      kind: "surface_control";
      option: "reground" | "suppress";
      runtime_item_ref: string;
      control: RuntimeItemControl | null;
      requires_confirmation: boolean;
      reason: string;
    }
  | {
      kind: "inspection";
      option: "inspect";
      runtime_item_ref: string;
      control: RuntimeItemControl;
      requires_confirmation: boolean;
      reason: string;
    };

export type AuditRepairActionInput = {
  option: AuditRepairOption;
  runtime_item: RuntimeItem;
  reason: string;
  preferred_control?: RuntimeItemControl;
  extra_options?: AuditRepairOption[];
};

const REMOVED_LIFECYCLES = new Set<CompanionAutonomyContentLifecycle>([
  "deleted",
  "tombstone",
]);

const QUIET_OUTCOMES = new Set<OutcomeClass>([
  "keep_watching",
  "hold_in_agenda",
  "prepare_silently",
  "run_authorized_work",
  "delegate_bounded_work",
  "prepare_action_candidate",
  "write_governed_memory_candidate",
  "update_surface_candidate",
  "add_to_digest",
]);

const SURFACE_FACING_OUTCOMES = new Set<OutcomeClass>([
  "add_to_digest",
  "express_to_user",
  "request_approval",
  "escalate",
]);

const REPAIR_BY_CONTROL: Partial<Record<RuntimeItemControl, AuditRepairOption>> = {
  inspect_item: "inspect",
  pause_item: "stop",
  cancel_item: "stop",
  forget_item: "forget",
  reground_item: "reground",
  revoke_permission: "revoke",
  narrow_permission: "narrow",
  require_confirmation: "retry",
};

const CONTROL_BY_REPAIR: Record<Exclude<AuditRepairOption, "suppress">, RuntimeItemControl[]> = {
  stop: ["cancel_item", "pause_item"],
  narrow: ["narrow_permission"],
  revoke: ["revoke_permission"],
  forget: ["forget_item"],
  reground: ["reground_item"],
  inspect: ["inspect_item"],
  retry: ["require_confirmation"],
};

function uniqueOptions(options: AuditRepairOption[]): AuditRepairOption[] {
  return [...new Set(options)];
}

function sourceIsRemoved(sourceRef: CompanionAutonomySourceRef): boolean {
  return REMOVED_LIFECYCLES.has(sourceRef.lifecycle);
}

function auditTraceRef(id: string): CompanionAutonomyRef {
  return { kind: "audit_trace", id };
}

function visibilityPolicyRef(id: string): CompanionAutonomyRef {
  return { kind: "visibility_policy", id };
}

function removedSourceRefs(trace: AuditTrace): CompanionAutonomySourceRef[] {
  return [
    ...trace.trigger_refs,
    ...trace.memory_refs,
    ...trace.actions_taken.flatMap((record) => record.source_refs),
    ...trace.actions_withheld.flatMap((record) => record.source_refs),
    ...trace.quiet_work.flatMap((record) => record.source_refs),
    ...trace.suppressed_alternatives.flatMap((record) => record.source_refs),
    ...trace.user_visible_outputs.flatMap((record) => record.source_refs),
    ...trace.permission_checks.flatMap((check) => check.evidence_refs),
    ...trace.staleness_checks.flatMap((check) => check.evidence_refs),
    ...trace.authority_checks.flatMap((check) => check.evidence_refs),
    ...trace.safety_checks.flatMap((check) => check.evidence_refs),
  ].filter(sourceIsRemoved);
}

function recordNeedsRedaction(record: AuditTraceRecord): boolean {
  return record.redacted || record.source_refs.some(sourceIsRemoved);
}

function redactSourceRef(sourceRef: CompanionAutonomySourceRef): CompanionAutonomySourceRef {
  if (!sourceIsRemoved(sourceRef)) return sourceRef;
  return {
    ref: {
      kind: sourceRef.ref.kind,
      id: "redacted",
      version: sourceRef.ref.version,
    },
    lifecycle: sourceRef.lifecycle,
    redaction_reason: sourceRef.redaction_reason ?? "source content was removed before inspection",
  };
}

function redactRecord(record: AuditTraceRecord): AuditInspectionRecord {
  const redacted = recordNeedsRedaction(record);
  return {
    record_id: record.record_id,
    summary: redacted
      ? `Redacted audit record ${record.record_id}; source content is deleted or tombstoned.`
      : record.summary,
    source_refs: record.source_refs.map(redactSourceRef),
    redacted,
  };
}

function sanitizedTraceRecord(record: AuditTraceRecord): AuditTraceRecord {
  if (!recordNeedsRedaction(record)) return record;
  return {
    ...record,
    summary: `Redacted audit record ${record.record_id}; source content is deleted or tombstoned.`,
    source_refs: record.source_refs.map(redactSourceRef),
    redacted: true,
  };
}

function redactionStateFor(
  refs: CompanionAutonomySourceRef[],
  records: AuditTraceRecord[],
  checks: AutonomyCheck[]
): AuditTrace["redaction_state"] {
  const sourceRefs = [
    ...refs,
    ...records.flatMap((record) => record.source_refs),
    ...checks.flatMap((check) => check.evidence_refs),
  ];
  const removed = sourceRefs.filter(sourceIsRemoved);
  if (removed.length === 0) {
    return {
      state: "none",
      redaction_applied: false,
      deleted_content_visible: false,
    };
  }
  const deleted = removed.some((sourceRef) => sourceRef.lifecycle === "deleted");
  return {
    state: deleted ? "deleted_source_removed" : "tombstone_metadata",
    redaction_applied: true,
    deleted_content_visible: false,
    reason: "deleted or tombstoned source refs were redacted before audit inspection",
  };
}

function surfaceVisible(policy: VisibilityPolicy, surface: CompanionVisibilitySurface): boolean {
  switch (surface) {
    case "chat":
    case "gateway":
      return policy.visible_in_chat;
    case "tui":
      return policy.visible_in_tui;
    case "cli":
    case "daemon_snapshot":
      return policy.visible_in_cli;
    case "gui":
      return policy.visible_in_gui;
    case "audit":
      return policy.visible_in_audit;
    case "debug":
      return policy.visible_in_debug;
    case "digest":
      return policy.visible_in_digest;
  }
}

function isDirectSurface(surface: CompanionVisibilitySurface): boolean {
  return surface !== "audit" && surface !== "debug";
}

function repairOptionAllowedByAuthority(option: AuditRepairOption, authority?: Authority): boolean {
  if (!authority) return true;
  if (authority.approval_scope === "none") return false;
  if (option === "inspect") return authority.inspectable;
  if (option === "reground") return authority.inspectable || authority.actionable || authority.resumable;
  if (option === "retry") {
    return authority.requires_confirmation || authority.actionable || authority.resumable;
  }
  if (option === "suppress") return authority.actionable || authority.can_update_surface;
  return authority.actionable || authority.resumable;
}

function controlAllowedByPolicy(control: RuntimeItemControl, policy: ControlPolicy): boolean {
  if (policy.forbidden_controls.includes(control)) return false;
  return policy.allowed_controls.includes(control) || policy.repair_options.includes(control);
}

function selectControlForRepair(
  option: Exclude<AuditRepairOption, "suppress">,
  policy: ControlPolicy,
  preferredControl?: RuntimeItemControl
): RuntimeItemControl {
  const controls = CONTROL_BY_REPAIR[option];
  if (
    preferredControl &&
    controls.includes(preferredControl) &&
    controlAllowedByPolicy(preferredControl, policy)
  ) {
    return preferredControl;
  }
  const allowedControl = controls.find((control) => controlAllowedByPolicy(control, policy));
  if (!allowedControl) {
    throw new Error(`repair option ${option} is not allowed by runtime item control policy`);
  }
  return allowedControl;
}

function record(record_id: string, summary: string, source_refs: CompanionAutonomySourceRef[] = []): AuditTraceRecord {
  return {
    record_id,
    summary,
    source_refs,
    redacted: false,
  };
}

export function createCompanionVisibilityPolicy(
  input: CreateCompanionVisibilityPolicyInput
): VisibilityPolicy {
  const contentLifecycle = input.content_lifecycle ?? (input.preset === "redacted" ? "redacted" : "active");
  const removed = REMOVED_LIFECYCLES.has(contentLifecycle);
  const redactionRequired = input.preset === "redacted" || contentLifecycle !== "active";

  const base = {
    schema_version: "visibility-policy-v1" as const,
    visibility_policy_id: input.visibility_policy_id,
    applies_to: input.applies_to,
    content_lifecycle: contentLifecycle,
    redaction_required: redactionRequired,
    inspectable_summary: input.inspectable_summary,
    rationale: input.rationale,
    audit_refs: input.audit_refs ?? [],
  };

  switch (input.preset) {
    case "normal_runtime":
      return VisibilityPolicySchema.parse({
        ...base,
        hidden_by_default: false,
        visible_in_gui: true,
        visible_in_chat: true,
        visible_in_tui: true,
        visible_in_cli: true,
        visible_in_audit: true,
        visible_in_debug: false,
        digest_only: false,
        visible_in_digest: false,
        never_directly_show: false,
        raw_content_allowed: !removed && !redactionRequired,
      });
    case "inspectable_hidden":
      return VisibilityPolicySchema.parse({
        ...base,
        hidden_by_default: true,
        visible_in_gui: false,
        visible_in_chat: false,
        visible_in_tui: false,
        visible_in_cli: false,
        visible_in_audit: true,
        visible_in_debug: true,
        digest_only: false,
        visible_in_digest: false,
        never_directly_show: false,
        raw_content_allowed: false,
      });
    case "digest_only":
      return VisibilityPolicySchema.parse({
        ...base,
        hidden_by_default: true,
        visible_in_gui: false,
        visible_in_chat: false,
        visible_in_tui: false,
        visible_in_cli: false,
        visible_in_audit: true,
        visible_in_debug: false,
        digest_only: true,
        visible_in_digest: true,
        never_directly_show: false,
        raw_content_allowed: false,
      });
    case "audit_visible":
      return VisibilityPolicySchema.parse({
        ...base,
        hidden_by_default: true,
        visible_in_gui: false,
        visible_in_chat: false,
        visible_in_tui: false,
        visible_in_cli: false,
        visible_in_audit: true,
        visible_in_debug: false,
        digest_only: false,
        visible_in_digest: false,
        never_directly_show: false,
        raw_content_allowed: !removed && !redactionRequired,
      });
    case "never_direct":
      return VisibilityPolicySchema.parse({
        ...base,
        hidden_by_default: true,
        visible_in_gui: false,
        visible_in_chat: false,
        visible_in_tui: false,
        visible_in_cli: false,
        visible_in_audit: true,
        visible_in_debug: true,
        digest_only: false,
        visible_in_digest: false,
        never_directly_show: true,
        raw_content_allowed: false,
      });
    case "redacted":
      return VisibilityPolicySchema.parse({
        ...base,
        hidden_by_default: true,
        visible_in_gui: false,
        visible_in_chat: false,
        visible_in_tui: false,
        visible_in_cli: false,
        visible_in_audit: true,
        visible_in_debug: true,
        digest_only: false,
        visible_in_digest: false,
        never_directly_show: true,
        raw_content_allowed: false,
      });
  }
}

export function renderVisibilityPolicyForSurface(
  policy: VisibilityPolicy,
  surface: CompanionVisibilitySurface
): VisibilitySurfaceDecision {
  const blockedByDirectRule = policy.never_directly_show && isDirectSurface(surface);
  const visible = surfaceVisible(policy, surface) && !blockedByDirectRule;
  const redacted = policy.redaction_required || policy.content_lifecycle !== "active";

  return {
    surface,
    visibility_policy_ref: visibilityPolicyRef(policy.visibility_policy_id),
    visible,
    inspectable: policy.visible_in_audit || policy.visible_in_debug || Boolean(policy.inspectable_summary),
    raw_content_allowed: visible && canVisibilityPolicyExposeRawContent(policy),
    redacted,
    summary: policy.inspectable_summary ?? policy.rationale,
    reason: visible
      ? policy.rationale
      : `visibility policy ${policy.visibility_policy_id} does not expose content on ${surface}`,
  };
}

export function runtimeItemVisibilityFromPolicy(
  policy: VisibilityPolicy,
  reason = policy.rationale
): RuntimeItemVisibilityPolicy {
  return {
    display: policy.redaction_required ? "redacted" : policy.hidden_by_default ? "hidden" : "normal",
    inspectable: policy.visible_in_audit || policy.visible_in_debug || Boolean(policy.inspectable_summary),
    auditable: policy.visible_in_audit,
    policy_ref: policy.visibility_policy_id,
    reason,
  };
}

export function deriveAuditRepairOptions(input: {
  authority?: Authority;
  control_policy?: ControlPolicy;
  extra_options?: AuditRepairOption[];
}): AuditRepairOption[] {
  const candidateOptions: AuditRepairOption[] = [];
  const policy = input.control_policy;

  if (policy) {
    const controlCandidates = uniqueOptions([
      ...policy.allowed_controls,
      ...policy.repair_options,
    ].map((control) => REPAIR_BY_CONTROL[control]).filter((option): option is AuditRepairOption => Boolean(option)));

    for (const option of controlCandidates) {
      const controls = option === "suppress" ? [] : CONTROL_BY_REPAIR[option];
      const hasAllowedControl = controls.some((control) => controlAllowedByPolicy(control, policy));
      if (hasAllowedControl) candidateOptions.push(option);
    }
  }

  candidateOptions.push(...(input.extra_options ?? []));

  return uniqueOptions(candidateOptions).filter((option) =>
    repairOptionAllowedByAuthority(option, input.authority)
  );
}

export function createAutonomyAuditTrace(input: CreateAutonomyAuditTraceInput): AuditTrace {
  const outcomeDecision = input.outcome_decision;
  const attentionDecisionRefs: CompanionAutonomyRef[] = [];
  const actionsTaken = [...(input.actions_taken ?? [])];
  const actionsWithheld = [...(input.actions_withheld ?? [])];
  const quietWork = [...(input.quiet_work ?? [])];
  const suppressedAlternatives = [...(input.suppressed_alternatives ?? [])];
  const userVisibleOutputs = [...(input.user_visible_outputs ?? [])];

  if (outcomeDecision) {
    attentionDecisionRefs.push(outcomeDecision.initiative_decision_ref);
    attentionDecisionRefs.push({
      kind: "outcome_decision",
      id: outcomeDecision.outcome_decision_id,
    });
    if (outcomeDecision.expression_decision_ref) {
      attentionDecisionRefs.push(outcomeDecision.expression_decision_ref);
    }

    if (outcomeDecision.final_outcome) {
      actionsTaken.push(record(
        `audit-record:${outcomeDecision.outcome_decision_id}:admitted`,
        `Outcome ${outcomeDecision.final_outcome} was ${outcomeDecision.admission_status}.`
      ));
      if (QUIET_OUTCOMES.has(outcomeDecision.final_outcome)) {
        quietWork.push(record(
          `audit-record:${outcomeDecision.outcome_decision_id}:quiet-work`,
          `Outcome ${outcomeDecision.final_outcome} remains inspectable as quiet runtime work.`
        ));
      }
      if (SURFACE_FACING_OUTCOMES.has(outcomeDecision.final_outcome) && outcomeDecision.expression_decision_ref) {
        userVisibleOutputs.push(record(
          `audit-record:${outcomeDecision.outcome_decision_id}:surface-output`,
          `Surface-facing outcome ${outcomeDecision.final_outcome} has an expression decision.`
        ));
      }
    }

    if (outcomeDecision.admission_status !== "admitted" || !outcomeDecision.final_outcome) {
      actionsWithheld.push(record(
        `audit-record:${outcomeDecision.outcome_decision_id}:withheld`,
        `Requested outcome ${outcomeDecision.requested_outcome} was withheld as ${outcomeDecision.admission_status}.`
      ));
    } else if (outcomeDecision.requested_outcome !== outcomeDecision.final_outcome) {
      actionsWithheld.push(record(
        `audit-record:${outcomeDecision.outcome_decision_id}:downgraded`,
        `Requested outcome ${outcomeDecision.requested_outcome} was not shown directly.`
      ));
    }
  }

  for (const outcome of input.suppressed_outcomes ?? []) {
    suppressedAlternatives.push(record(
      `audit-record:${input.trace_id}:suppressed:${outcome}`,
      `Suppressed alternative outcome ${outcome}.`
    ));
  }

  const permissionChecks = input.permission_checks ?? [];
  const stalenessChecks = input.staleness_checks ?? outcomeDecision?.staleness_checks ?? [];
  const authorityChecks = input.authority_checks ?? outcomeDecision?.authority_checks ?? [];
  const safetyChecks = input.safety_checks ?? outcomeDecision?.safety_checks ?? [];
  const allRecords = [
    ...actionsTaken,
    ...actionsWithheld,
    ...quietWork,
    ...suppressedAlternatives,
    ...userVisibleOutputs,
  ];
  const redactionState = redactionStateFor(
    [...input.trigger_refs, ...(input.memory_refs ?? [])],
    allRecords,
    [...permissionChecks, ...stalenessChecks, ...authorityChecks, ...safetyChecks]
  );

  return AuditTraceSchema.parse({
    schema_version: "audit-trace-v1",
    trace_id: input.trace_id,
    subject_ref: input.subject_ref,
    trigger_refs: input.trigger_refs.map(redactSourceRef),
    surface_refs: input.surface_refs ?? [],
    memory_refs: (input.memory_refs ?? []).map(redactSourceRef),
    permission_checks: permissionChecks,
    staleness_checks: stalenessChecks,
    authority_checks: authorityChecks,
    safety_checks: safetyChecks,
    redaction_state: redactionState,
    attention_decision_refs: attentionDecisionRefs,
    companion_state_refs: input.companion_state_refs ?? [],
    actions_taken: actionsTaken.map(sanitizedTraceRecord),
    actions_withheld: actionsWithheld.map(sanitizedTraceRecord),
    quiet_work: quietWork.map(sanitizedTraceRecord),
    suppressed_alternatives: suppressedAlternatives.map(sanitizedTraceRecord),
    user_visible_outputs: userVisibleOutputs.map(sanitizedTraceRecord),
    repair_options: input.repair_options ?? [],
    visibility_policy_refs: input.visibility_policy_refs ?? [],
    created_at: input.created_at,
  });
}

export function createAuditInspectionView(trace: AuditTrace): AuditInspectionView {
  const removedRefs = removedSourceRefs(trace);
  const redactionState = removedRefs.length > 0
    ? {
        state: removedRefs.some((sourceRef) => sourceRef.lifecycle === "deleted")
          ? "deleted_source_removed"
          : "tombstone_metadata",
        redaction_applied: true,
        deleted_content_visible: false,
        reason: "deleted or tombstoned source refs were redacted before audit inspection",
      } satisfies AuditTrace["redaction_state"]
    : trace.redaction_state;

  return {
    schema_version: "audit-inspection-view-v1",
    trace_id: trace.trace_id,
    subject_ref: trace.subject_ref,
    created_at: trace.created_at,
    redaction_state: redactionState,
    repair_options: trace.repair_options,
    visibility_policy_refs: trace.visibility_policy_refs,
    actions_taken: trace.actions_taken.map(redactRecord),
    actions_withheld: trace.actions_withheld.map(redactRecord),
    quiet_work: trace.quiet_work.map(redactRecord),
    suppressed_alternatives: trace.suppressed_alternatives.map(redactRecord),
    user_visible_outputs: trace.user_visible_outputs.map(redactRecord),
  };
}

export function createCompanionStateInspectionView(input: {
  snapshot: CompanionStateSnapshot;
  runtime_items: RuntimeItem[];
  audit_traces?: AuditTrace[];
}): CompanionStateInspectionView {
  return {
    schema_version: "companion-state-inspection-view-v1",
    snapshot_id: input.snapshot.snapshot_id,
    computed_at: input.snapshot.computed_at,
    mode: input.snapshot.mode,
    current_capacity: input.snapshot.current_capacity,
    active_surface_ref: input.snapshot.active_surface_ref,
    global_control_state_ref: input.snapshot.global_control_state_ref,
    control_overlays: [...input.snapshot.control_overlays],
    budgets: {
      interruption_budget: input.snapshot.interruption_budget,
      quiet_work_budget: input.snapshot.quiet_work_budget,
      named: { ...input.snapshot.budgets },
    },
    held_runtime_refs: [...input.snapshot.held_runtime_refs],
    active_runtime_refs: [...input.snapshot.active_refs],
    active_watch_refs: [...input.snapshot.active_watch_refs],
    active_wait_refs: [...input.snapshot.active_wait_refs],
    active_quiet_work_refs: [...input.snapshot.active_quiet_work_refs],
    blocked_refs: [...input.snapshot.blocked_refs],
    stale_refs: [...input.snapshot.stale_refs],
    affected_runtime_items: input.runtime_items.map((item) => ({
      item_id: item.item_id,
      type: item.type,
      status: item.status,
      posture: item.posture,
      source: item.source,
      visibility_policy: { ...item.visibility_policy },
      audit_trace_refs: [...item.audit_trace_refs],
      authority: {
        approval_scope: item.authority.approval_scope,
        inspectable: item.authority.inspectable,
        resumable: item.authority.resumable,
        actionable: item.authority.actionable,
        speakable: item.authority.speakable,
        requires_confirmation: item.authority.requires_confirmation,
      },
      control_policy: {
        allowed_controls: [...item.control_policy.allowed_controls],
        forbidden_controls: [...item.control_policy.forbidden_controls],
        required_confirmation: [...item.control_policy.required_confirmation],
        repair_options: [...item.control_policy.repair_options],
      },
    })),
    audit_traces: (input.audit_traces ?? []).map(createAuditInspectionView),
  };
}

export function createAuditRepairAction(input: AuditRepairActionInput): AuditRepairAction {
  const options = deriveAuditRepairOptions({
    authority: input.runtime_item.authority,
    control_policy: input.runtime_item.control_policy,
    extra_options: input.extra_options,
  });

  if (!options.includes(input.option)) {
    throw new Error(`repair option ${input.option} is not available for ${input.runtime_item.item_id}`);
  }

  if (input.option === "suppress") {
    return {
      kind: "surface_control",
      option: "suppress",
      runtime_item_ref: input.runtime_item.item_id,
      control: null,
      requires_confirmation: false,
      reason: input.reason,
    };
  }

  const control = selectControlForRepair(
    input.option,
    input.runtime_item.control_policy,
    input.preferred_control
  );
  const requiresConfirmation = input.runtime_item.control_policy.required_confirmation.includes(control);

  switch (input.option) {
    case "stop":
    case "retry":
      return {
        kind: "runtime_control",
        option: input.option,
        runtime_item_ref: input.runtime_item.item_id,
        control,
        requires_confirmation: requiresConfirmation,
        reason: input.reason,
      };
    case "narrow":
    case "revoke":
      return {
        kind: "permission_control",
        option: input.option,
        runtime_item_ref: input.runtime_item.item_id,
        control,
        requires_confirmation: requiresConfirmation,
        reason: input.reason,
      };
    case "forget":
      return {
        kind: "memory_correction",
        option: input.option,
        runtime_item_ref: input.runtime_item.item_id,
        control,
        requires_confirmation: requiresConfirmation,
        reason: input.reason,
      };
    case "reground":
      return {
        kind: "surface_control",
        option: input.option,
        runtime_item_ref: input.runtime_item.item_id,
        control,
        requires_confirmation: requiresConfirmation,
        reason: input.reason,
      };
    case "inspect":
      return {
        kind: "inspection",
        option: input.option,
        runtime_item_ref: input.runtime_item.item_id,
        control,
        requires_confirmation: requiresConfirmation,
        reason: input.reason,
      };
  }
}

export function createAuditTraceRef(trace: AuditTrace): CompanionAutonomyRef {
  return auditTraceRef(trace.trace_id);
}
