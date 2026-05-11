import type { ScheduleEntry, ScheduleInternalAttentionProjection } from "./types/schedule.js";
import {
  CapabilityOperationPlanAssemblySchema,
  type CapabilityOperationPlanAssembly,
  type CapabilityOperationPlanCandidateInput,
  type CapabilityOperationPlanSource,
} from "./types/capability-operation-plan.js";

const WAIT_RESUME_CAPABILITY_ID = "capability:schedule_wait_resume_attention";
const WAIT_RESUME_PAYLOAD_CLASS = "schedule_wait_resume_attention_projection";

export interface ScheduleOperationPlanAssemblyInput {
  entry: ScheduleEntry;
  firedAt: string;
  scheduledFor?: string | null;
  projection?: ScheduleInternalAttentionProjection;
}

export function assembleScheduleOperationPlans(
  input: ScheduleOperationPlanAssemblyInput
): CapabilityOperationPlanAssembly {
  const sourceRef = `schedule:${input.entry.id}`;
  const source = {
    kind: "schedule_tick" as const,
    source_ref: sourceRef,
    source_epoch: input.entry.updated_at,
    emitted_at: input.firedAt,
    metadata: {
      entry_id: input.entry.id,
      layer: input.entry.layer,
      activation_kind: input.entry.metadata?.activation_kind ?? null,
    },
  };

  if (input.entry.metadata?.activation_kind !== "wait_resume") {
    return CapabilityOperationPlanAssemblySchema.parse({
      schema_version: "capability-operation-plan-assembly/v1",
      assembly_id: `operation-plan-assembly:schedule:${input.entry.id}:${input.firedAt}`,
      assembled_at: input.firedAt,
      source,
      status: "no_supported_plan",
      reason: "Schedule entry is not a supported non-chat operation proposal source.",
      candidate_plans: [],
    });
  }

  const triggerGoalId = input.entry.goal_trigger?.goal_id;
  const metadataGoalId = input.entry.metadata.goal_id;
  if (!input.entry.goal_trigger || !triggerGoalId || !metadataGoalId || metadataGoalId !== triggerGoalId) {
    return failClosed(input, source, "Wait-resume schedule entry is missing a stable goal trigger context.");
  }
  if (!input.projection) {
    return failClosed(input, source, "Wait-resume schedule entry did not produce a structured attention projection.");
  }
  const expectedSignalContextId = `signal:schedule-wake:${input.entry.id}:${input.scheduledFor ?? input.firedAt}`;
  if (input.projection.signal_context_id !== expectedSignalContextId) {
    return failClosed(input, source, "Wait-resume attention projection does not match the schedule tick context.");
  }

  const operationId = `schedule.wait_resume.attention.${input.entry.id}`;
  const providerRef = sourceRef;
  const targetRefs = [
    `goal:${triggerGoalId}`,
    input.projection.signal_context_id,
    ...input.projection.urge_candidate_refs,
    ...input.projection.agenda_item_refs,
    ...input.projection.runtime_items.map((item) => item.ref),
  ];
  const candidate: CapabilityOperationPlanCandidateInput = {
    plan_id: `operation-plan:${operationId}:${input.firedAt}`,
    source_ref: sourceRef,
    operation_plan: {
      operation_id: operationId,
      capability_id: WAIT_RESUME_CAPABILITY_ID,
      operation_kind: "hint",
      provider_ref: providerRef,
      payload_class: WAIT_RESUME_PAYLOAD_CLASS,
      side_effect_profile: "none",
      risk_class: "low",
      privacy_profile: "workspace_private",
      reversibility: "reversible",
      external_action_authority: false,
      target_refs: targetRefs,
      advisory_only: true,
      preparable_when_blocked: true,
      local_only: true,
      inspectable: true,
      expected_user_visible_effect: false,
    },
    admission_scope: {
      operation_id: operationId,
      capability_id: WAIT_RESUME_CAPABILITY_ID,
      operation_kind: "hint",
      provider_ref: providerRef,
      asset_ref: providerRef,
      payload_class: WAIT_RESUME_PAYLOAD_CLASS,
      payload_epoch: input.projection.projected_at,
      side_effect_profile: "none",
      external_action_authority: false,
      requires_runtime_control: false,
      required_permission_capabilities: [],
      target_refs: targetRefs,
      target_epoch_refs: {
        [providerRef]: input.entry.updated_at,
        [input.projection.signal_context_id]: input.projection.projected_at,
      },
      provider_epoch: input.entry.updated_at,
    },
    readiness_snapshot_refs: [],
    required_approvals: [],
    reversible_preparation_steps: [
      "Record the attention projection as inspectable planning context.",
    ],
    not_allowed_steps: [
      "Do not run the goal from this planner output.",
      "Do not send external notifications from this planner output.",
      "Do not treat the attention projection as runtime-control admission.",
    ],
    user_visible_summary: "Wait-resume attention projection is available as a candidate planning hint; downstream gates decide any action.",
    audit_seed: {
      schedule_entry_id: input.entry.id,
      goal_id: triggerGoalId,
      signal_context_id: input.projection.signal_context_id,
      urge_candidate_refs: input.projection.urge_candidate_refs,
      agenda_item_refs: input.projection.agenda_item_refs,
      runtime_item_refs: input.projection.runtime_items.map((item) => item.ref),
    },
  };

  return CapabilityOperationPlanAssemblySchema.parse({
    schema_version: "capability-operation-plan-assembly/v1",
    assembly_id: `operation-plan-assembly:schedule:${input.entry.id}:${input.firedAt}`,
    assembled_at: input.firedAt,
    source,
    status: "planned",
    reason: "Wait-resume schedule attention projection assembled into an advisory candidate operation plan.",
    candidate_plans: [candidate],
  });
}

function failClosed(
  input: ScheduleOperationPlanAssemblyInput,
  source: CapabilityOperationPlanSource,
  reason: string
): CapabilityOperationPlanAssembly {
  return CapabilityOperationPlanAssemblySchema.parse({
    schema_version: "capability-operation-plan-assembly/v1",
    assembly_id: `operation-plan-assembly:schedule:${input.entry.id}:${input.firedAt}`,
    assembled_at: input.firedAt,
    source,
    status: "fail_closed",
    reason,
    candidate_plans: [],
  });
}
