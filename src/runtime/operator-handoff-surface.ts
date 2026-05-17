import type { Task } from "../base/types/task.js";
import type { RuntimeOperatorHandoffRecord } from "./store/operator-handoff-store.js";
import {
  createSurfaceActionBinding,
  createSurfaceProjection,
  findSurfaceActionBindingByToken,
  normalRuntimeGraphRef,
  normalSourceEventRef,
  validateSurfaceActionBinding,
  type SurfaceActionBinding,
  type SurfaceProjection,
} from "./surface-projection-protocol.js";

export interface OperatorHandoffSurfaceEvent {
  requestId: string;
  handoff_id: string;
  goalId?: string;
  goal_id?: string;
  title: string;
  recommended_action: string;
  status: "open";
  triggers: RuntimeOperatorHandoffRecord["triggers"];
  task: Task;
  approval_prompt: NonNullable<SurfaceProjection["approval_prompt"]>;
  surface_projection: SurfaceProjection;
}

export interface OperatorHandoffResolutionBinding {
  surfaceActionBindingId?: string;
  surfaceActionBindingToken?: string;
}

export function projectOperatorHandoffSurface(record: RuntimeOperatorHandoffRecord): {
  surfaceInstanceRef: string;
  projection: SurfaceProjection;
} {
  const surfaceInstanceRef = operatorHandoffSurfaceInstanceRef(record);
  const projectionId = `surface:operator-handoff:${record.handoff_id}`;
  const sourceEventRefs = [
    normalSourceEventRef({
      kind: "operator_handoff",
      ref: record.handoff_id,
      event_type: "operator_handoff_required",
      occurred_at: record.created_at,
      replay_key: `operator-handoff:${record.handoff_id}`,
    }),
  ];
  const runtimeGraphRefs = [
    normalRuntimeGraphRef({
      kind: "operator_handoff",
      ref: record.handoff_id,
      role: "target",
    }),
    ...(record.goal_id ? [normalRuntimeGraphRef({
      kind: "goal",
      ref: record.goal_id,
      role: "source",
    })] : []),
    ...(record.run_id ? [normalRuntimeGraphRef({
      kind: "background_run",
      ref: record.run_id,
      role: "source",
    })] : []),
  ];
  const approveBinding = createOperatorHandoffActionBinding({
    record,
    actionKind: "approve",
    projectionId,
    surfaceInstanceRef,
    sourceEventRefs,
    runtimeGraphRefs,
  });
  const rejectBinding = createOperatorHandoffActionBinding({
    record,
    actionKind: "reject",
    projectionId,
    surfaceInstanceRef,
    sourceEventRefs,
    runtimeGraphRefs,
  });
  const prompt = [
    record.title,
    record.recommended_action,
  ].filter(Boolean).join("\n");
  return {
    surfaceInstanceRef,
    projection: createSurfaceProjection({
      projection_id: projectionId,
      surface: "approval",
      view: "normal",
      purpose: "Project an operator handoff as a normal-safe approval surface.",
      redaction_class: "normal_safe",
      projected_at: record.updated_at,
      replay_key: `operator-handoff:${record.handoff_id}`,
      source_event_refs: sourceEventRefs,
      runtime_graph_refs: runtimeGraphRefs,
      panels: [{
        panel_id: "operator_handoff",
        title: record.title,
        body: record.recommended_action,
        tone: "warning",
      }],
      approval_prompt: {
        approval_id: record.handoff_id,
        prompt,
        action: record.next_action.label,
        target_summary: record.title,
        approve_binding_id: approveBinding.binding_id,
        reject_binding_id: rejectBinding.binding_id,
      },
      actions: [
        {
          action_id: `operator-handoff:${record.handoff_id}:approve`,
          kind: "approve",
          label: "Approve",
          style: "primary",
          binding_id: approveBinding.binding_id,
        },
        {
          action_id: `operator-handoff:${record.handoff_id}:reject`,
          kind: "reject",
          label: "Reject",
          style: "danger",
          binding_id: rejectBinding.binding_id,
        },
      ],
      action_bindings: [approveBinding, rejectBinding],
    }),
  };
}

export function projectOperatorHandoffSurfaceEvent(record: RuntimeOperatorHandoffRecord): OperatorHandoffSurfaceEvent {
  const { projection } = projectOperatorHandoffSurface(record);
  return {
    requestId: record.handoff_id,
    handoff_id: record.handoff_id,
    ...(record.goal_id ? { goalId: record.goal_id, goal_id: record.goal_id } : {}),
    title: record.title,
    recommended_action: record.recommended_action,
    status: "open",
    triggers: record.triggers,
    task: operatorHandoffSurfaceTask(record),
    approval_prompt: projection.approval_prompt!,
    surface_projection: projection,
  };
}

export function validateOperatorHandoffSurfaceBinding(
  record: RuntimeOperatorHandoffRecord,
  approved: boolean,
  bindingInput: OperatorHandoffResolutionBinding,
  now = new Date().toISOString(),
): boolean {
  const { projection, surfaceInstanceRef } = projectOperatorHandoffSurface(record);
  const expectedAction = approved ? "approve" : "reject";
  const expectedBindingId = projection.actions.find((action) => action.kind === expectedAction)?.binding_id;
  const inputRef = bindingInput.surfaceActionBindingId ?? bindingInput.surfaceActionBindingToken;
  if (!expectedBindingId || !inputRef) {
    return false;
  }
  const binding = findSurfaceActionBindingByToken(projection.action_bindings, inputRef);
  if (!binding || binding.binding_id !== expectedBindingId) {
    return false;
  }
  const validation = validateSurfaceActionBinding({
    binding,
    surface: "approval",
    surfaceInstanceRef,
    actionKind: expectedAction,
    now,
  });
  return validation.status === "accepted";
}

function createOperatorHandoffActionBinding(input: {
  record: RuntimeOperatorHandoffRecord;
  actionKind: "approve" | "reject";
  projectionId: string;
  surfaceInstanceRef: string;
  sourceEventRefs: ReturnType<typeof normalSourceEventRef>[];
  runtimeGraphRefs: ReturnType<typeof normalRuntimeGraphRef>[];
}): SurfaceActionBinding {
  return createSurfaceActionBinding({
    action_kind: input.actionKind,
    surface: "approval",
    surface_instance_ref: input.surfaceInstanceRef,
    target: {
      kind: "operator_handoff",
      ref: input.record.handoff_id,
      surface_instance_ref: input.surfaceInstanceRef,
    },
    source_projection_id: input.projectionId,
    source_event_refs: input.sourceEventRefs,
    runtime_graph_refs: input.runtimeGraphRefs,
    replay_key: `operator-handoff:${input.record.handoff_id}:${input.actionKind}`,
    redaction_class: "normal_safe",
    created_at: input.record.created_at,
    expires_at: null,
  });
}

function operatorHandoffSurfaceTask(record: RuntimeOperatorHandoffRecord): Task {
  return {
    id: record.handoff_id,
    goal_id: record.goal_id ?? "",
    strategy_id: null,
    target_dimensions: [],
    primary_dimension: "operator_handoff",
    work_description: record.title,
    rationale: "Operator approval is required before this handoff can continue.",
    approach: record.recommended_action,
    success_criteria: [{
      description: "Operator has approved or rejected the handoff.",
      verification_method: "surface action binding approval response",
      is_blocking: true,
    }],
    scope_boundary: {
      in_scope: ["operator_handoff"],
      out_of_scope: [],
      blast_radius: "operator handoff",
    },
    constraints: ["Requires an active SurfaceActionBinding."],
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: 0,
    reversibility: "unknown",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: record.created_at,
  };
}

function operatorHandoffSurfaceInstanceRef(record: RuntimeOperatorHandoffRecord): string {
  return `approval:operator-handoff:${record.handoff_id}`;
}
