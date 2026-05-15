import { createHash } from "node:crypto";
import type {
  CognitionEventRef,
  CognitionMemorySource,
  CognitionRef,
  CognitionWithheldMemorySource,
  CompanionCognitionInput,
  CompanionCognitionOutput,
  SituationModel,
} from "../cognition/contracts.js";
import type {
  CapabilityRegistryDecisionKind,
  InitiativeEvent,
  InterventionDecisionKind,
  InterventionTargetEffect,
  PersonalAgentCallerPath,
  PersonalAgentDecisionTrace,
  PersonalAgentSourceKind,
  RelationshipMemoryAudit,
  RuntimeGraphEdgeKind,
  RuntimeGraphNodeKind,
  RuntimeGraphRef,
  TaskCandidateTargetKind,
} from "./contracts.js";
import {
  PersonalAgentDecisionTraceSchema,
  cognitionRefsToRuntimeRefs,
  situationModelRefs,
} from "./contracts.js";

export interface PersonalAgentTraceSourceInput {
  sourceKind: PersonalAgentSourceKind;
  sourceId: string;
  emittedAt?: string;
  sourceEpoch?: string;
  highWatermark?: string;
  replayKey?: string;
  summary: string;
  sourceRef?: RuntimeGraphRef;
}

export interface BuildPersonalAgentDecisionTraceInput {
  callerPath: PersonalAgentCallerPath;
  source: PersonalAgentTraceSourceInput;
  target: {
    kind: TaskCandidateTargetKind;
    ref: RuntimeGraphRef;
    effect: InterventionTargetEffect;
    summary: string;
  };
  decision: InterventionDecisionKind;
  decisionReason: string;
  capabilityDecision?: CapabilityRegistryDecisionKind;
  capabilityRefs?: RuntimeGraphRef[];
  policyRef?: RuntimeGraphRef;
  permissionRequired?: boolean;
  currentRefs?: RuntimeGraphRef[];
  cognitionSituation?: SituationModel;
  memoryRefs?: RuntimeGraphRef[];
  withheldMemoryRefs?: RuntimeGraphRef[];
  staleRefs?: RuntimeGraphRef[];
  uncertaintyRefs?: RuntimeGraphRef[];
  conflictRefs?: RuntimeGraphRef[];
  auditRefs?: RuntimeGraphRef[];
  memoryAuditInputs?: RelationshipMemoryAuditInput[];
  outcomeEvent?: {
    type: "action_outcome" | "reflection_recorded" | "memory_updated" | "runtime_resumed";
    summary: string;
    targetRef?: RuntimeGraphRef;
  };
}

interface RelationshipMemoryAuditInput {
  memoryRef: RuntimeGraphRef;
  action: RelationshipMemoryAudit["action"];
  allowedUses?: string[];
  forbiddenUses?: string[];
  uncertainty?: RelationshipMemoryAudit["uncertainty"];
  correctionState?: RelationshipMemoryAudit["correction_state"];
  invalidated?: boolean;
  lifecycle?: string;
  sensitivity?: string;
  sourceKind?: string;
  relationshipRole?: string;
  confidence?: number | null;
  surfaceProjectionRef?: string;
  withheldReason?: string;
  conflictRefs?: RuntimeGraphRef[];
  provenanceRefs?: RuntimeGraphRef[];
  reason?: string;
}

export function stableTraceId(seed: string, prefix = "personal-agent"): string {
  return `${prefix}:${stableId(seed)}`;
}

export function buildPersonalAgentDecisionTrace(input: BuildPersonalAgentDecisionTraceInput): PersonalAgentDecisionTrace {
  const emittedAt = input.source.emittedAt ?? new Date().toISOString();
  const replayKey = input.source.replayKey
    ?? [
      input.callerPath,
      input.source.sourceKind,
      input.source.sourceId,
      input.source.sourceEpoch ?? "epoch:none",
      input.source.highWatermark ?? emittedAt,
      input.target.kind,
      input.target.ref.kind,
      input.target.ref.ref,
    ].join(":");
  const traceId = stableTraceId(replayKey);
  const sourceRef = input.source.sourceRef ?? {
    kind: input.source.sourceKind,
    ref: input.source.sourceId,
  };
  const frameId = `${traceId}:situation`;
  const sourceEventId = `${traceId}:event:000`;
  const candidateEventId = `${traceId}:event:001`;
  const actionEventId = `${traceId}:event:002`;
  const policyEventId = `${traceId}:event:003`;
  const candidateId = `${traceId}:candidate`;
  const capabilityDecisionId = `${traceId}:capability`;
  const interventionDecisionId = `${traceId}:decision`;
  const transitionState = transitionStateForDecision(input.decision);
  const policyRef = input.policyRef ?? { kind: "intervention_policy", ref: "policy:personal-agent-runtime" };
  const capabilityRefs = input.capabilityRefs ?? [];
  const auditRefs = input.auditRefs ?? [];
  const memoryRefs = input.memoryRefs ?? [];
  const withheldMemoryRefs = input.withheldMemoryRefs ?? [];
  const staleRefs = input.staleRefs ?? [];
  const conflictRefs = input.conflictRefs ?? [];
  const conflictOnlyRefs = refsNotIn(conflictRefs, [...memoryRefs, ...withheldMemoryRefs, ...staleRefs]);
  const memoryAuditInputs = input.memoryAuditInputs;
  const recordsActionRequest = shouldRecordActionRequested(input.decision, input.target.effect);
  const graphProvenanceRefs = [{ kind: "initiative_event", ref: sourceEventId }, ...auditRefs];
  const graphNodes = [
    graphNode(`${traceId}:node:situation`, "situation_frame", { kind: "situation_frame", ref: frameId }, "SituationFrame", emittedAt, graphProvenanceRefs, {
      runtime_graph_role: "decision_trace",
      frame_id: frameId,
      caller_path: input.callerPath,
      source_kind: input.source.sourceKind,
      replay_key: replayKey,
    }),
    graphNode(`${traceId}:node:event:000`, "initiative_event", { kind: "initiative_event", ref: sourceEventId }, "InitiativeEvent", emittedAt, graphProvenanceRefs, {
      runtime_graph_role: "decision_trace",
      event_id: sourceEventId,
      event_type: eventTypeForSource(input.source.sourceKind),
      replay_key: replayKey,
    }),
    graphNode(`${traceId}:node:event:001`, "initiative_event", { kind: "initiative_event", ref: candidateEventId }, "TaskCandidate proposed", emittedAt, graphProvenanceRefs, {
      runtime_graph_role: "decision_trace",
      event_id: candidateEventId,
      event_type: "task_candidate_proposed",
      replay_key: replayKey,
      candidate_id: candidateId,
    }),
    ...(recordsActionRequest
      ? [
          graphNode(`${traceId}:node:event:002`, "initiative_event", { kind: "initiative_event", ref: actionEventId }, "Action requested", emittedAt, graphProvenanceRefs, {
            runtime_graph_role: "decision_trace",
            event_id: actionEventId,
            event_type: "action_requested",
            replay_key: replayKey,
            target_ref: input.target.ref,
          }),
        ]
      : []),
    graphNode(`${traceId}:node:event:003`, "initiative_event", { kind: "initiative_event", ref: policyEventId }, "Policy decision recorded", emittedAt, graphProvenanceRefs, {
      runtime_graph_role: "decision_trace",
      event_id: policyEventId,
      event_type: "policy_decision_recorded",
      replay_key: replayKey,
      decision_id: interventionDecisionId,
    }),
    graphNode(`${traceId}:node:candidate`, "task_candidate", { kind: "task_candidate", ref: candidateId }, "TaskCandidate", emittedAt, graphProvenanceRefs, {
      runtime_graph_role: "decision_trace",
      candidate_id: candidateId,
      target_kind: input.target.kind,
      desired_effect: input.target.effect,
      materialization_state: materializationFor(input.decision),
    }),
    graphNode(`${traceId}:node:capability`, "capability_decision", { kind: "capability_decision", ref: capabilityDecisionId }, "Capability Registry decision", emittedAt, graphProvenanceRefs, {
      runtime_graph_role: "decision_trace",
      decision_id: capabilityDecisionId,
      decision: capabilityDecisionFor(input),
      capability_refs: capabilityRefs,
    }),
    graphNode(`${traceId}:node:decision`, "intervention_decision", { kind: "intervention_decision", ref: interventionDecisionId }, "InterventionPolicy decision", emittedAt, graphProvenanceRefs, {
      runtime_graph_role: "decision_trace",
      decision_id: interventionDecisionId,
      decision: input.decision,
      target_effect: input.target.effect,
      policy_ref: policyRef,
    }),
    graphNode(`${traceId}:node:target`, nodeKindForTarget(input.target.kind), input.target.ref, input.target.summary, emittedAt, graphProvenanceRefs, {
      runtime_graph_role: "decision_trace_target",
      target_kind: input.target.kind,
      target_ref: input.target.ref,
      target_effect: input.target.effect,
      target_summary: input.target.summary,
      replay_key: replayKey,
    }),
    ...memoryRuntimeGraphNodes(traceId, emittedAt, graphProvenanceRefs, memoryAuditInputs ?? []),
  ];
  const graphEdges = [
    graphEdge(`${traceId}:edge:event-situation`, "derived_from", `${traceId}:node:event:000`, `${traceId}:node:situation`, emittedAt, graphProvenanceRefs),
    graphEdge(`${traceId}:edge:candidate-event`, "derived_from", `${traceId}:node:candidate`, `${traceId}:node:event:001`, emittedAt, graphProvenanceRefs),
    graphEdge(`${traceId}:edge:candidate-capability`, "requires_capability", `${traceId}:node:candidate`, `${traceId}:node:capability`, emittedAt, graphProvenanceRefs),
    graphEdge(`${traceId}:edge:decision-candidate`, "decided_by", `${traceId}:node:candidate`, `${traceId}:node:decision`, emittedAt, graphProvenanceRefs),
    graphEdge(`${traceId}:edge:decision-target`, "targets", `${traceId}:node:decision`, `${traceId}:node:target`, emittedAt, graphProvenanceRefs),
    ...(recordsActionRequest
      ? [
          graphEdge(`${traceId}:edge:action-decision`, "decided_by", `${traceId}:node:event:002`, `${traceId}:node:decision`, emittedAt, graphProvenanceRefs),
          graphEdge(`${traceId}:edge:action-target`, "targets", `${traceId}:node:event:002`, `${traceId}:node:target`, emittedAt, graphProvenanceRefs),
        ]
      : []),
  ];

  const initiativeEvents: InitiativeEvent[] = [{
    schema_version: "initiative-event/v1" as const,
    event_id: sourceEventId,
    trace_id: traceId,
    sequence: 0,
    event_type: eventTypeForSource(input.source.sourceKind),
    occurred_at: emittedAt,
    situation_frame_id: frameId,
    source_ref: sourceRef,
    target_ref: input.target.ref,
    summary: input.source.summary,
    idempotency_key: `${replayKey}:event:000`,
    refs: [...input.currentRefs ?? [], input.target.ref],
    audit_refs: auditRefs,
  }, {
    schema_version: "initiative-event/v1" as const,
    event_id: candidateEventId,
    trace_id: traceId,
    sequence: 1,
    event_type: "task_candidate_proposed" as const,
    occurred_at: emittedAt,
    situation_frame_id: frameId,
    source_ref: sourceRef,
    target_ref: { kind: "task_candidate", ref: candidateId },
    summary: input.target.summary,
    idempotency_key: `${replayKey}:event:001`,
    refs: [input.target.ref, ...capabilityRefs],
    audit_refs: auditRefs,
  }];

  if (recordsActionRequest) {
    initiativeEvents.push({
      schema_version: "initiative-event/v1" as const,
      event_id: actionEventId,
      trace_id: traceId,
      sequence: 2,
      event_type: "action_requested" as const,
      occurred_at: emittedAt,
      situation_frame_id: frameId,
      source_ref: { kind: "task_candidate", ref: candidateId },
      target_ref: input.target.ref,
      summary: `Action requested for ${input.target.effect}: ${input.target.summary}`,
      idempotency_key: `${replayKey}:event:002`,
      refs: [input.target.ref, ...capabilityRefs],
      audit_refs: auditRefs,
    });
  }

  initiativeEvents.push({
    schema_version: "initiative-event/v1" as const,
    event_id: policyEventId,
    trace_id: traceId,
    sequence: 3,
    event_type: "policy_decision_recorded" as const,
    occurred_at: emittedAt,
    situation_frame_id: frameId,
    source_ref: { kind: "task_candidate", ref: candidateId },
    target_ref: { kind: "intervention_decision", ref: interventionDecisionId },
    summary: input.decisionReason,
    idempotency_key: `${replayKey}:event:003`,
    refs: [policyRef, ...capabilityRefs],
    audit_refs: auditRefs,
  });

  if (input.outcomeEvent) {
    initiativeEvents.push({
      schema_version: "initiative-event/v1" as const,
      event_id: `${traceId}:event:004`,
      trace_id: traceId,
      sequence: 4,
      event_type: input.outcomeEvent.type,
      occurred_at: emittedAt,
      situation_frame_id: frameId,
      source_ref: { kind: "intervention_decision", ref: interventionDecisionId },
      target_ref: input.outcomeEvent.targetRef ?? input.target.ref,
      summary: input.outcomeEvent.summary,
      idempotency_key: `${replayKey}:event:004`,
      refs: [input.outcomeEvent.targetRef ?? input.target.ref],
      audit_refs: auditRefs,
    });
  }

  return PersonalAgentDecisionTraceSchema.parse({
    schema_version: "personal-agent-decision-trace/v1",
    trace_id: traceId,
    replay_key: replayKey,
    situation_frame: {
      schema_version: "situation-frame/v1",
      frame_id: frameId,
      assembled_at: emittedAt,
      caller_path: input.callerPath,
      source_kind: input.source.sourceKind,
      source_ref: sourceRef,
      replay_key: replayKey,
      summary: input.source.summary,
      ...(input.cognitionSituation ? { cognition_situation: input.cognitionSituation } : {}),
      current_refs: input.currentRefs ?? [],
      memory_refs: memoryRefs,
      withheld_memory_refs: withheldMemoryRefs,
      stale_refs: staleRefs,
      uncertainty_refs: input.uncertaintyRefs ?? [],
      conflict_refs: conflictRefs,
      policy_refs: [policyRef],
      normal_surface_trace_visible: false,
    },
    initiative_events: initiativeEvents,
    attention_transitions: [{
      schema_version: "attention-transition/v1",
      transition_id: `${traceId}:attention:001`,
      trace_id: traceId,
      occurred_at: emittedAt,
      from_state: null,
      to_state: transitionState,
      reason: input.decisionReason,
      situation_frame_id: frameId,
      initiative_event_id: candidateEventId,
      refs: [input.target.ref, ...auditRefs],
    }],
    task_candidates: [{
      schema_version: "task-candidate/v1",
      candidate_id: candidateId,
      trace_id: traceId,
      proposed_at: emittedAt,
      source_event_id: candidateEventId,
      situation_frame_id: frameId,
      target_kind: input.target.kind,
      target_ref: input.target.ref,
      summary: input.target.summary,
      desired_effect: input.target.effect,
      materialization_state: materializationFor(input.decision),
      capability_refs: capabilityRefs,
      policy_refs: [policyRef],
      reason_refs: [sourceRef, ...input.currentRefs ?? []],
      task_created: false,
    }],
    capability_decisions: [{
      schema_version: "capability-registry-decision/v1",
      decision_id: capabilityDecisionId,
      trace_id: traceId,
      candidate_id: candidateId,
      decided_at: emittedAt,
      decision: input.capabilityDecision ?? capabilityDecisionFor(input),
      capability_refs: capabilityRefs,
      reason: capabilityRefs.length > 0
        ? "Capability Registry evaluated required capability refs before policy admission."
        : "No executable capability was required for this candidate.",
      registry_epoch: input.source.sourceEpoch ?? "registry:current",
      audit_refs: auditRefs,
    }],
    intervention_decisions: [{
      schema_version: "intervention-decision/v1",
      decision_id: interventionDecisionId,
      trace_id: traceId,
      candidate_id: candidateId,
      capability_decision_id: capabilityDecisionId,
      decided_at: emittedAt,
      decision: input.decision,
      target_effect: input.target.effect,
      permission_required: input.permissionRequired ?? input.decision === "confirm_required",
      policy_ref: policyRef,
      reason: input.decisionReason,
      audit_refs: auditRefs,
      normal_surface_trace_visible: false,
    }],
    runtime_graph_nodes: graphNodes,
    runtime_graph_edges: graphEdges,
    memory_audits: memoryAuditInputs
      ? memoryAuditsFromInputs(traceId, emittedAt, memoryAuditInputs, auditRefs, conflictRefs)
      : [
          ...memoryAudits(traceId, emittedAt, memoryRefs, "read", "current", false, auditRefs, conflictRefs),
          ...memoryAudits(traceId, emittedAt, withheldMemoryRefs, "withhold", "unknown", false, auditRefs, conflictRefs),
          ...memoryAudits(traceId, emittedAt, staleRefs, "invalidate", "corrected", true, auditRefs, conflictRefs),
          ...memoryAudits(traceId, emittedAt, conflictOnlyRefs, "read", "unknown", false, auditRefs, conflictRefs),
        ],
  });
}

export function buildPersonalAgentTraceFromCognition(
  input: CompanionCognitionInput,
  output: CompanionCognitionOutput
): PersonalAgentDecisionTrace {
  const situation = output.situation_model;
  const eventRef = input.event_refs[0];
  const isTui = isTuiReplyTarget(situation.reply_target_ref) || isTuiReplyTarget(input.working_context.reply_target_ref);
  const callerPath: PersonalAgentCallerPath = isTui ? "tui_turn" : "chat_gateway_turn";
  const sourceId = eventRef?.ref ?? input.cognition_id;
  const emittedAt = input.working_context.turn_started_at ?? new Date().toISOString();
  const decision = output.response_plan.guidance_kind === "hold" ? "hold" : "allow";
  const targetEffect: InterventionTargetEffect = output.response_plan.guidance_kind === "hold"
    ? "hold_concern"
    : "continue_route";
  const relationshipMemoryRefs = output.relationship_state.relationship_refs.map(cognitionMemoryRuntimeRef);
  const withheldRelationshipMemoryRefs = output.relationship_state.withheld_memory_refs.map(cognitionMemoryRuntimeRef);
  const conflictRefs = cognitionRefsToRuntimeRefs(output.relationship_state.conflict_refs);
  return buildPersonalAgentDecisionTrace({
    callerPath,
    source: {
      sourceKind: isTui ? "tui_message" : "user_message",
      sourceId,
      emittedAt,
      sourceEpoch: eventRef?.source_epoch ?? input.cognition_id,
      highWatermark: eventRef?.high_watermark ?? eventRef?.source_epoch ?? emittedAt,
      replayKey: eventRef ? cognitionEventReplayKey(eventRef) : `${input.cognition_id}:user_input`,
      summary: `User turn entered ${callerPath}.`,
      sourceRef: { kind: eventRef?.source_store ?? "chat_history", ref: sourceId },
    },
    target: {
      kind: "attention_only",
      ref: { kind: "response_plan", ref: output.response_plan.plan_id },
      effect: targetEffect,
      summary: output.response_plan.public_summary,
    },
    decision,
    decisionReason: output.response_plan.public_summary,
    policyRef: { kind: "response_plan", ref: output.response_plan.plan_id },
    currentRefs: situationModelRefs(situation),
    cognitionSituation: situation,
    memoryRefs: relationshipMemoryRefs,
    withheldMemoryRefs: withheldRelationshipMemoryRefs,
    staleRefs: cognitionRefsToRuntimeRefs(situation.stale_target_refs),
    uncertaintyRefs: output.uncertainty.map((uncertainty) => ({
      kind: "uncertainty",
      ref: uncertainty.uncertainty_id,
    })),
    conflictRefs,
    auditRefs: output.audit_refs.map((ref) => ({ kind: "cognition_audit", ref })),
    memoryAuditInputs: [
      ...output.relationship_state.relationship_refs.map((source) =>
        cognitionMemoryAuditInput(source, "read", conflictRefs, output.audit_refs)
      ),
      ...output.relationship_state.withheld_memory_refs.map((source) =>
        cognitionWithheldMemoryAuditInput(source, conflictRefs, output.audit_refs)
      ),
      ...refsNotIn(cognitionRefsToRuntimeRefs(situation.stale_target_refs), [
        ...relationshipMemoryRefs,
        ...withheldRelationshipMemoryRefs,
      ]).map((memoryRef) => ({
        memoryRef,
        action: "invalidate" as const,
        allowedUses: [],
        forbiddenUses: [],
        uncertainty: "unknown" as const,
        correctionState: "corrected" as const,
        invalidated: true,
        lifecycle: "stale",
        conflictRefs,
        provenanceRefs: output.audit_refs.map((ref) => ({ kind: "cognition_audit", ref })),
        reason: "Cognition marked this target ref stale before the decision.",
      })),
    ],
  });
}

function eventTypeForSource(sourceKind: PersonalAgentSourceKind) {
  switch (sourceKind) {
    case "schedule_wake":
      return "scheduler_wake" as const;
    case "resident_observation":
      return "resident_observation" as const;
    case "memory_operation":
      return "memory_updated" as const;
    case "reflection_cycle":
      return "reflection_recorded" as const;
    case "task_execution":
      return "action_requested" as const;
    case "restart_recovery":
      return "runtime_resumed" as const;
    case "external_signal":
      return "signal_received" as const;
    case "user_message":
    case "tui_message":
    case "explicit_command":
      return "user_follow_up" as const;
    default:
      return "signal_received" as const;
  }
}

function transitionStateForDecision(decision: InterventionDecisionKind) {
  if (decision === "allow") return "admitted" as const;
  if (decision === "block") return "blocked" as const;
  if (decision === "suppress") return "suppressed" as const;
  return "held" as const;
}

function materializationFor(decision: InterventionDecisionKind) {
  if (decision === "allow") return "materialized" as const;
  if (decision === "block") return "blocked" as const;
  if (decision === "suppress") return "suppressed" as const;
  return "held" as const;
}

function shouldRecordActionRequested(
  decision: InterventionDecisionKind,
  effect: InterventionTargetEffect,
): boolean {
  if (decision !== "allow" && decision !== "confirm_required") return false;
  return effect !== "hold_concern" && effect !== "none";
}

function capabilityDecisionFor(input: BuildPersonalAgentDecisionTraceInput): CapabilityRegistryDecisionKind {
  if (input.decision === "block") return "blocked";
  if (input.permissionRequired || input.decision === "confirm_required") return "permission_required";
  return input.capabilityRefs && input.capabilityRefs.length > 0 ? "available" : "not_applicable";
}

function nodeKindForTarget(kind: TaskCandidateTargetKind) {
  if (kind === "goal") return "goal" as const;
  if (kind === "task") return "task" as const;
  if (kind === "run") return "run" as const;
  if (kind === "notification") return "reply_target" as const;
  if (kind === "memory_update") return "memory_record" as const;
  return "initiative_event" as const;
}

function graphNode(
  nodeId: string,
  nodeKind: RuntimeGraphNodeKind,
  ref: RuntimeGraphRef,
  label: string,
  now: string,
  provenanceRefs: RuntimeGraphRef[],
  payload: Record<string, unknown> = {},
) {
  return {
    schema_version: "runtime-graph-node/v1" as const,
    node_id: nodeId,
    node_kind: nodeKind,
    ref,
    label,
    created_at: now,
    updated_at: now,
    provenance_refs: provenanceRefs,
    payload,
  };
}

function graphEdge(
  edgeId: string,
  edgeKind: RuntimeGraphEdgeKind,
  fromNodeId: string,
  toNodeId: string,
  now: string,
  provenanceRefs: RuntimeGraphRef[],
) {
  return {
    schema_version: "runtime-graph-edge/v1" as const,
    edge_id: edgeId,
    edge_kind: edgeKind,
    from_node_id: fromNodeId,
    to_node_id: toNodeId,
    created_at: now,
    provenance_refs: provenanceRefs,
  };
}

function memoryAudits(
  traceId: string,
  now: string,
  refs: RuntimeGraphRef[],
  action: "read" | "write" | "correct" | "invalidate" | "withhold",
  correctionState: "current" | "corrected" | "superseded" | "retracted" | "deleted" | "unknown",
  invalidated: boolean,
  provenanceRefs: RuntimeGraphRef[],
  conflictRefs: RuntimeGraphRef[],
) {
  return refs.map((memoryRef) => ({
    schema_version: "relationship-memory-audit/v1" as const,
    audit_id: `${traceId}:memory:${stableId(`${memoryRef.kind}:${memoryRef.ref}:${action}`)}`,
    trace_id: traceId,
    recorded_at: now,
    memory_ref: memoryRef,
    action,
    allowed_uses: action === "read" ? ["runtime_grounding"] : [],
    forbidden_uses: [],
    uncertainty: action === "withhold" ? "medium" as const : "low" as const,
    correction_state: correctionState,
    invalidated,
    lifecycle: invalidated ? "stale" : "unknown",
    confidence: null,
    conflict_refs: conflictRefs,
    provenance_refs: provenanceRefs,
    reason: invalidated
      ? "Memory ref was corrected, stale, or invalidated before this decision."
      : action === "withhold"
        ? "Memory ref was withheld and cannot silently influence the decision."
      : "Memory ref was allowed for the recorded production decision use.",
  }));
}

function memoryAuditsFromInputs(
  traceId: string,
  now: string,
  inputs: RelationshipMemoryAuditInput[],
  defaultProvenanceRefs: RuntimeGraphRef[],
  defaultConflictRefs: RuntimeGraphRef[],
): RelationshipMemoryAudit[] {
  return inputs.map((input) => {
    const conflictRefs = input.conflictRefs ?? defaultConflictRefs;
    const provenanceRefs = input.provenanceRefs ?? defaultProvenanceRefs;
    const invalidated = input.invalidated ?? input.action === "invalidate";
    return {
      schema_version: "relationship-memory-audit/v1" as const,
      audit_id: `${traceId}:memory:${stableId(`${input.memoryRef.kind}:${input.memoryRef.ref}:${input.action}`)}`,
      trace_id: traceId,
      recorded_at: now,
      memory_ref: input.memoryRef,
      action: input.action,
      allowed_uses: input.allowedUses ?? [],
      forbidden_uses: input.forbiddenUses ?? [],
      uncertainty: input.uncertainty ?? "unknown",
      correction_state: input.correctionState ?? "unknown",
      invalidated,
      lifecycle: input.lifecycle ?? "unknown",
      ...(input.sensitivity ? { sensitivity: input.sensitivity } : {}),
      ...(input.sourceKind ? { source_kind: input.sourceKind } : {}),
      ...(input.relationshipRole ? { relationship_role: input.relationshipRole } : {}),
      confidence: input.confidence ?? null,
      ...(input.surfaceProjectionRef ? { surface_projection_ref: input.surfaceProjectionRef } : {}),
      ...(input.withheldReason ? { withheld_reason: input.withheldReason } : {}),
      conflict_refs: conflictRefs,
      provenance_refs: provenanceRefs,
      reason: input.reason ?? defaultMemoryAuditReason(input.action, invalidated),
    };
  });
}

function memoryRuntimeGraphNodes(
  traceId: string,
  now: string,
  graphProvenanceRefs: RuntimeGraphRef[],
  inputs: RelationshipMemoryAuditInput[],
) {
  const byRef = new Map<string, RelationshipMemoryAuditInput>();
  for (const input of inputs) {
    byRef.set(`${input.memoryRef.kind}:${input.memoryRef.ref}`, input);
  }
  return [...byRef.values()].map((input) => {
    const nodeKind: RuntimeGraphNodeKind = input.relationshipRole === "promise" ? "commitment" : "memory_record";
    const memoryKey = `${input.memoryRef.kind}:${input.memoryRef.ref}`;
    return graphNode(
      `${traceId}:node:memory:${stableId(memoryKey)}`,
      nodeKind,
      input.memoryRef,
      input.memoryRef.ref,
      now,
      [...graphProvenanceRefs, ...(input.provenanceRefs ?? [])],
      {
        runtime_graph_role: "source_of_truth",
        entity_kind: nodeKind,
        memory_ref: input.memoryRef,
        allowed_uses: input.allowedUses ?? [],
        forbidden_uses: input.forbiddenUses ?? [],
        lifecycle: input.lifecycle ?? "unknown",
        correction_state: input.correctionState ?? "unknown",
        invalidated: input.invalidated ?? input.action === "invalidate",
        uncertainty: input.uncertainty ?? "unknown",
        ...(input.sensitivity ? { sensitivity: input.sensitivity } : {}),
        ...(input.sourceKind ? { source_kind: input.sourceKind } : {}),
        ...(input.relationshipRole ? { relationship_role: input.relationshipRole } : {}),
        ...(input.surfaceProjectionRef ? { surface_projection_ref: input.surfaceProjectionRef } : {}),
        ...(input.withheldReason ? { withheld_reason: input.withheldReason } : {}),
      },
    );
  });
}

function cognitionMemoryAuditInput(
  source: CognitionMemorySource,
  action: RelationshipMemoryAudit["action"],
  conflictRefs: RuntimeGraphRef[],
  auditRefs: readonly string[],
): RelationshipMemoryAuditInput {
  const invalidated = source.lifecycle !== "active" && source.lifecycle !== "matured"
    || source.correction_state !== "current";
  return {
    memoryRef: cognitionMemoryRuntimeRef(source),
    action: invalidated ? "invalidate" : action,
    allowedUses: [...source.allowed_uses],
    forbiddenUses: [...source.forbidden_uses],
    uncertainty: uncertaintyFromConfidence(source.confidence),
    correctionState: correctionStateFromCognition(source),
    invalidated,
    lifecycle: source.lifecycle,
    sensitivity: source.sensitivity,
    sourceKind: source.source_kind,
    relationshipRole: source.relationship_role,
    confidence: source.confidence ?? null,
    surfaceProjectionRef: source.surface_projection_ref,
    conflictRefs,
    provenanceRefs: cognitionMemoryProvenanceRefs(source, auditRefs),
    reason: invalidated
      ? "Cognition withheld inactive or corrected relationship memory from influencing this decision."
      : "Cognition allowed this relationship memory for the recorded decision use.",
  };
}

function cognitionWithheldMemoryAuditInput(
  source: CognitionWithheldMemorySource,
  conflictRefs: RuntimeGraphRef[],
  auditRefs: readonly string[],
): RelationshipMemoryAuditInput {
  return {
    ...cognitionMemoryAuditInput(source, "withhold", conflictRefs, auditRefs),
    action: "withhold",
    invalidated: ["stale", "superseded", "corrected", "deleted", "quarantined"].includes(source.withheld_reason),
    withheldReason: source.withheld_reason,
    reason: `Cognition withheld this relationship memory because ${source.withheld_reason}.`,
  };
}

function cognitionMemoryRuntimeRef(source: CognitionMemorySource): RuntimeGraphRef {
  return { kind: "memory", ref: source.memory_ref.ref };
}

function cognitionMemoryProvenanceRefs(
  source: CognitionMemorySource,
  auditRefs: readonly string[],
): RuntimeGraphRef[] {
  return [
    { kind: source.memory_ref.source_store, ref: source.memory_ref.ref },
    ...(source.surface_projection_ref ? [{ kind: "surface_projection", ref: source.surface_projection_ref }] : []),
    ...auditRefs.map((ref) => ({ kind: "cognition_audit", ref })),
  ];
}

function correctionStateFromCognition(source: CognitionMemorySource): RelationshipMemoryAudit["correction_state"] {
  if (source.lifecycle === "deleted") return "deleted";
  if (source.correction_state === "current") return "current";
  if (source.correction_state === "corrected") return "corrected";
  if (source.correction_state === "superseded") return "superseded";
  if (source.correction_state === "retracted") return "retracted";
  return "unknown";
}

function uncertaintyFromConfidence(confidence: number | undefined): RelationshipMemoryAudit["uncertainty"] {
  if (confidence === undefined) return "unknown";
  if (confidence >= 0.95) return "none";
  if (confidence >= 0.8) return "low";
  if (confidence >= 0.5) return "medium";
  return "high";
}

function defaultMemoryAuditReason(
  action: RelationshipMemoryAudit["action"],
  invalidated: boolean,
): string {
  if (invalidated) return "Memory ref was corrected, stale, or invalidated before this decision.";
  if (action === "withhold") return "Memory ref was withheld and cannot silently influence the decision.";
  if (action === "write") return "Memory ref was updated by the recorded production decision.";
  if (action === "correct") return "Memory ref correction was recorded with provenance.";
  return "Memory ref was allowed for the recorded production decision use.";
}

function refsNotIn(refs: RuntimeGraphRef[], existingRefs: RuntimeGraphRef[]): RuntimeGraphRef[] {
  const existing = new Set(existingRefs.map((ref) => `${ref.kind}:${ref.ref}`));
  return refs.filter((ref) => !existing.has(`${ref.kind}:${ref.ref}`));
}

function cognitionEventReplayKey(ref: CognitionEventRef): string {
  return [
    ref.source_store,
    ref.source_event_type,
    ref.ref,
    ref.source_epoch ?? "",
    ref.high_watermark ?? "",
    ref.replay_key ?? "",
  ].join(":");
}

function isTuiReplyTarget(ref: CognitionRef | undefined): boolean {
  return ref?.kind === "tui_reply_target";
}

export function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}
