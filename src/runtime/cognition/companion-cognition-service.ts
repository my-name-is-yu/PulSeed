import {
  createCognitionReplayRecord,
} from "./audit-sink.js";
import {
  AuthorityHandoffSchema,
  CandidateActionSchema,
  CompanionCognitionInputSchema,
  CompanionCognitionOutputSchema,
  CognitionCorrelationRefsSchema,
  CommitmentAttentionHandoffSchema,
  MemoryUseAuditSchema,
  ModelContextPolicySchema,
  ResponsePlanSchema,
  IntentionSelectionSchema,
  deliveryKindRank,
  type AuthorityHandoff,
  type CandidateAction,
  type CognitionMemoryResult,
  type CognitionCorrelationRefs,
  type CommitmentAttentionHandoff,
  type CompanionCognitionInput,
  type CompanionCognitionOutput,
  type IntentionSelection,
  type MemoryUseAudit,
  type ModelContextPolicy,
  type ParsedCompanionCognitionInput,
  type ResponsePlan,
} from "./contracts.js";
import type { CognitionAuditSink, CognitionMemoryPort } from "./ports.js";
import { createEmptyCognitionMemoryResult } from "./memory-context.js";
import {
  createRelationshipStateProjectionV2,
  relationshipCharacterPolicyProjectionRef,
  relationshipTurnRefForCognitionInput,
} from "./relationship-state-projection.js";
import { assembleSituationModel } from "./situation.js";
import {
  createReflectionHintForWriteback,
  createTurnEpisodeWritebackProposal,
} from "./writeback.js";

export interface CompanionCognitionServiceDeps {
  memoryPort?: CognitionMemoryPort;
  auditSink?: CognitionAuditSink;
  now?: () => Date;
}
export type CompanionCognitionKernelDeps = CompanionCognitionServiceDeps;

export class CompanionCognitionKernel {
  constructor(private readonly deps: CompanionCognitionKernelDeps = {}) {}

  async evaluateTurn(input: CompanionCognitionInput): Promise<CompanionCognitionOutput> {
    return this.evaluate({
      ...input,
      caller_path: "chat_user_turn",
      memory_context_request: {
        ...input.memory_context_request,
        caller_path: "chat_user_turn",
      },
    });
  }

  async evaluateIntervention(input: CompanionCognitionInput): Promise<CompanionCognitionOutput> {
    return this.evaluate({
      ...input,
      caller_path: "resident_proactive_check",
      memory_context_request: {
        ...input.memory_context_request,
        caller_path: "resident_proactive_check",
      },
    });
  }

  async evaluateTaskContext(input: CompanionCognitionInput): Promise<CompanionCognitionOutput> {
    return this.evaluate({
      ...input,
      caller_path: "long_running_task_turn",
      memory_context_request: {
        ...input.memory_context_request,
        caller_path: "long_running_task_turn",
      },
    });
  }

  async evaluateScheduleWake(input: CompanionCognitionInput): Promise<CompanionCognitionOutput> {
    return this.evaluate({
      ...input,
      caller_path: "schedule_wake",
      memory_context_request: {
        ...input.memory_context_request,
        caller_path: "schedule_wake",
      },
    });
  }

  async evaluateRuntimeControlResponse(input: CompanionCognitionInput): Promise<CompanionCognitionOutput> {
    return this.evaluate({
      ...input,
      caller_path: "runtime_control_response",
      memory_context_request: {
        ...input.memory_context_request,
        caller_path: "runtime_control_response",
      },
    });
  }

  async evaluateMemoryTruthOperation(input: CompanionCognitionInput): Promise<CompanionCognitionOutput> {
    return this.evaluate({
      ...input,
      caller_path: "memory_truth_operation",
      memory_context_request: {
        ...input.memory_context_request,
        caller_path: "memory_truth_operation",
      },
    });
  }

  private async evaluate(rawInput: CompanionCognitionInput): Promise<CompanionCognitionOutput> {
    const input: ParsedCompanionCognitionInput = CompanionCognitionInputSchema.parse(rawInput);
    const memoryResult = await this.resolveMemory(input);
    const firstEventRef = input.event_refs[0]!;
    const situationModel = assembleSituationModel({ cognitionInput: input, memoryResult });
    const relationshipState = createRelationshipStateProjectionV2({
      projectionId: `${input.cognition_id}:relationship`,
      turnRef: relationshipTurnRefForCognitionInput(input),
      memoryResult,
      callerPath: input.caller_path,
      ...characterPolicyRefFor(input),
      overreachRisk: input.caller_path === "resident_proactive_check" ? "medium" : "unknown",
    });
    const responsePlan = responsePlanFor(input);
    const modelContextPolicy = modelContextPolicyFor(input);
    const selectedIntention = intentionFor(input);
    const candidateAction = candidateActionFor(input, responsePlan, selectedIntention);
    const commitmentHandoff = commitmentHandoffFor(input);
    const memoryUseAudit = memoryUseAuditFor(input, memoryResult);
    const authorityHandoff = authorityHandoffFor(input, candidateAction);
    const correlationRefs = correlationRefsFor(input);
    const writeback = createTurnEpisodeWritebackProposal({
      proposalId: `${input.cognition_id}:writeback:episode`,
      sourceEventRef: firstEventRef,
    });
    const reflectionHint = createReflectionHintForWriteback({
      hintId: `${input.cognition_id}:reflection:episode`,
      sourceEventRef: firstEventRef,
    });
    const output = CompanionCognitionOutputSchema.parse({
      cognition_id: input.cognition_id,
      caller_path: input.caller_path,
      situation_model: situationModel,
      relationship_state: relationshipState,
      selected_intention: selectedIntention,
      candidate_action: candidateAction,
      commitment_handoff: commitmentHandoff,
      response_plan: responsePlan,
      ...(modelContextPolicy ? { model_context_policy: modelContextPolicy } : {}),
      memory_use_audit: memoryUseAudit,
      authority_handoff: authorityHandoff,
      tool_candidates: input.proposed_tool_candidates,
      authorization_requests: input.authorization_requests,
      memory_writeback: [writeback],
      reflection_hints: [reflectionHint],
      correlation_refs: correlationRefs,
      audit_refs: [
        ...memoryResult.audit_refs.map((ref) => ref.ref),
        `${input.cognition_id}:audit`,
      ],
      uncertainty: uncertaintiesFor(input, memoryResult),
      ...(input.surface_target === "operator_debug" || input.surface_target === "internal_audit"
        ? {
            debug_trace: {
              surface_target: input.surface_target,
              event_ref_count: input.event_refs.length,
              memory_included_count: memoryResult.included.length,
              memory_withheld_count: memoryResult.withheld.length,
            },
          }
        : {}),
    });
    assertNoProactiveUpgrade(input, output);
    await this.recordAudit(input, output);
    return output;
  }

  private async resolveMemory(input: ParsedCompanionCognitionInput): Promise<CognitionMemoryResult> {
    if (input.memory_result) return input.memory_result;
    if (this.deps.memoryPort) {
      return this.deps.memoryPort.retrieveMemory(input.memory_context_request);
    }
    return createEmptyCognitionMemoryResult({
      requestId: input.memory_context_request.request_id,
      auditRefs: [],
    });
  }

  private async recordAudit(input: ParsedCompanionCognitionInput, output: CompanionCognitionOutput): Promise<void> {
    if (!this.deps.auditSink) return;
    const now = this.deps.now?.() ?? new Date();
    await this.deps.auditSink.recordCognition(createCognitionReplayRecord({
      recordId: `${input.cognition_id}:replay`,
      createdAt: now.toISOString(),
      input,
      output,
    }));
  }
}

export class CompanionCognitionService extends CompanionCognitionKernel {}

function responsePlanFor(input: ParsedCompanionCognitionInput): ResponsePlan {
  if (input.caller_path === "resident_proactive_check") {
    const attention = input.attention_context!;
    const delivery = attention.operation_boundary === "allowed"
      ? maxSuggestDelivery(attention.max_delivery_kind)
      : "hold";
    return ResponsePlanSchema.parse({
      plan_id: `${input.cognition_id}:response`,
      guidance_kind: delivery === "hold" ? "hold" : delivery === "digest" ? "digest" : "suggest",
      public_summary: delivery === "hold"
        ? "Hold this resident intervention unless the upstream gate admits a safer surface."
        : "Surface this resident intervention only as a bounded suggestion or digest item.",
      surface_target: input.surface_target,
      delivery_kind: delivery,
      quieting_applied: delivery === "hold",
      operator_debug_refs: input.surface_target === "normal_user" ? [] : [
        { kind: "initiative_gate_decision", ref: attention.initiative_gate_decision_id },
      ],
      hidden_policy_state_visible_to_normal_user: false,
    });
  }

  if (input.caller_path === "schedule_wake") {
    return ResponsePlanSchema.parse({
      plan_id: `${input.cognition_id}:response`,
      guidance_kind: "hold",
      public_summary: "Keep the scheduled wake behind ScheduleEngine, attention, and authority owners before any visible delivery.",
      surface_target: input.surface_target,
      delivery_kind: "hold",
      quieting_applied: true,
      operator_debug_refs: input.surface_target === "normal_user" ? [] : [
        ...input.working_context.runtime_event_refs,
        ...input.working_context.runtime_graph_refs,
      ],
      hidden_policy_state_visible_to_normal_user: false,
    });
  }

  if (input.caller_path === "runtime_control_response") {
    return ResponsePlanSchema.parse({
      plan_id: `${input.cognition_id}:response`,
      guidance_kind: input.runtime_context?.approval_refs.length ? "request_approval" : "continue_route",
      public_summary: "Route runtime-control response through the existing runtime-control, approval, and Interaction Authority boundaries.",
      surface_target: input.surface_target,
      quieting_applied: false,
      operator_debug_refs: input.surface_target === "normal_user" ? [] : [
        ...(input.runtime_context?.runtime_item_refs ?? []),
        ...(input.runtime_context?.approval_refs ?? []),
      ],
      hidden_policy_state_visible_to_normal_user: false,
    });
  }

  if (input.caller_path === "memory_truth_operation") {
    return ResponsePlanSchema.parse({
      plan_id: `${input.cognition_id}:response`,
      guidance_kind: "hold",
      public_summary: "Treat the memory truth operation as behavioral inhibition evidence until Memory Truth Maintenance and surface projection owners admit future recall.",
      surface_target: input.surface_target,
      quieting_applied: true,
      operator_debug_refs: input.surface_target === "normal_user" ? [] : input.working_context.memory_truth_refs,
      hidden_policy_state_visible_to_normal_user: false,
    });
  }

  const quiet = input.session_context?.quieting_active ?? false;
  return ResponsePlanSchema.parse({
    plan_id: `${input.cognition_id}:response`,
    guidance_kind: quiet ? "hold" : "continue_route",
    public_summary: quiet
      ? "Keep this turn quiet unless the owning surface decides to reply."
      : "Continue the selected route while keeping cognition advisory and auditable.",
    surface_target: input.surface_target,
    quieting_applied: quiet,
    operator_debug_refs: input.surface_target === "normal_user" ? [] : [
      ...(input.session_context?.turn_ref ? [input.session_context.turn_ref] : []),
    ],
    hidden_policy_state_visible_to_normal_user: false,
  });
}

function modelContextPolicyFor(input: ParsedCompanionCognitionInput): ModelContextPolicy | undefined {
  if (input.caller_path !== "chat_user_turn" || input.session_context?.route_kind !== "gateway_model_loop") {
    return undefined;
  }
  return ModelContextPolicySchema.parse({
    policy_id: `${input.cognition_id}:model-context-policy`,
    surface: "gateway_chat",
    reply_shape: "codex_chat_shape",
    local_fact_policy: "tool_required_for_current_state",
    tool_use_policy: "use_available_tools_for_inspection_or_state",
    runtime_control_policy: "provided_authorization_tools_only",
    internal_label_visibility: "suppress_route_and_lifecycle_labels",
    language_policy: {
      mode: "same_as_current_input",
      hint: languageHintFor(input.working_context.current_language_hint),
    },
    hidden_policy_state_visible_to_normal_user: false,
  });
}

function languageHintFor(value: string | undefined): ModelContextPolicy["language_policy"]["hint"] {
  if (value === "ja" || value === "latin" || value === "other") return value;
  return "unknown";
}

function characterPolicyRefFor(
  input: ParsedCompanionCognitionInput,
): { characterPolicyRef: ReturnType<typeof relationshipCharacterPolicyProjectionRef> } | Record<string, never> {
  const ref = input.working_context.relationship_permission_refs.find((candidate) =>
    candidate.kind === "character_config_policy" || candidate.kind === "character_policy_projection"
  );
  return ref ? { characterPolicyRef: relationshipCharacterPolicyProjectionRef(ref) } : {};
}

function intentionFor(input: ParsedCompanionCognitionInput): IntentionSelection | null {
  const staleRefs = [
    ...(input.session_context?.stale_reply_target_refs ?? []),
    ...(input.goal_context?.stale_target_refs ?? []),
  ];
  if (staleRefs.length > 0) {
    return IntentionSelectionSchema.parse({
      intention_id: `${input.cognition_id}:intention:reground`,
      lifecycle: "requires_regrounding",
      requires_regrounding: true,
      stale_target_refs: staleRefs,
      reason_refs: input.event_refs,
    });
  }
  const activeGoal = input.goal_context?.active_goals.find((goal) => goal.lifecycle === "active");
  if (!activeGoal) return null;
  return IntentionSelectionSchema.parse({
    intention_id: `${input.cognition_id}:intention:${safeId(activeGoal.goal_id)}`,
    goal_ref: activeGoal,
    lifecycle: "selected",
    selected_path_ref: activeGoal.goal_ref,
    requires_regrounding: false,
    stale_target_refs: [],
    reason_refs: input.event_refs,
  });
}

function candidateActionFor(
  input: ParsedCompanionCognitionInput,
  responsePlan: ResponsePlan,
  selectedIntention: IntentionSelection | null,
): CandidateAction {
  const targetRef = input.runtime_context?.operator_handoff_ref
    ?? input.runtime_context?.phase_ref
    ?? input.attention_context?.agenda_ref
    ?? input.session_context?.turn_ref
    ?? selectedIntention?.selected_path_ref;
  const actionKind = candidateActionKindFor(responsePlan);
  return CandidateActionSchema.parse({
    action_id: `${input.cognition_id}:candidate-action`,
    action_kind: actionKind,
    ...(targetRef ? { target_ref: targetRef } : {}),
    reason_refs: [
      ...(targetRef ? [targetRef] : []),
      ...input.working_context.runtime_graph_refs,
      ...input.working_context.authority_state_refs,
      ...input.working_context.memory_truth_refs,
    ],
    side_effect_profile: input.caller_path === "runtime_control_response"
      ? "runtime_mutation"
      : input.caller_path === "schedule_wake"
        ? "notification"
        : "read",
    requires_authority: actionKind === "prepare" || actionKind === "request_authority" || actionKind === "handoff",
    executes_side_effect: false,
  });
}

function candidateActionKindFor(responsePlan: ResponsePlan): CandidateAction["action_kind"] {
  switch (responsePlan.guidance_kind) {
    case "hold":
      return "hold";
    case "digest":
      return "digest";
    case "suggest":
      return "suggest";
    case "request_approval":
      return "request_authority";
    case "continue_route":
    case "answer":
    case "clarify":
      return "continue_route";
    case "refuse":
      return "suppress";
  }
}

function commitmentHandoffFor(input: ParsedCompanionCognitionInput): CommitmentAttentionHandoff {
  const attention = input.attention_context;
  if (!attention) {
    return CommitmentAttentionHandoffSchema.parse({
      handoff_id: `${input.cognition_id}:commitment-handoff:none`,
      state: "not_applicable",
      uses_attention_state_store: true,
      creates_parallel_commitment_store: false,
    });
  }
  return CommitmentAttentionHandoffSchema.parse({
    handoff_id: `${input.cognition_id}:commitment-handoff`,
    state: attention.handoff_state,
    attention_input_ref: attention.attention_input_ref,
    ...(attention.commitment_ref ? { commitment_ref: attention.commitment_ref } : {}),
    ...(attention.operation_plan_ref
      ? { operation_plan_ref: { kind: "operation_plan", ref: attention.operation_plan_ref } }
      : {}),
    ...(attention.store_ref ? { store_ref: attention.store_ref } : {}),
    uses_attention_state_store: true,
    creates_parallel_commitment_store: false,
  });
}

function memoryUseAuditFor(
  input: ParsedCompanionCognitionInput,
  memoryResult: CognitionMemoryResult,
): MemoryUseAudit {
  return MemoryUseAuditSchema.parse({
    audit_id: `${input.cognition_id}:memory-use`,
    request_id: input.memory_context_request.request_id,
    requested_uses: input.memory_context_request.requested_uses,
    included_memory_refs: memoryResult.included.map((source) => ({
      kind: "memory",
      ref: source.memory_ref.ref,
    })),
    withheld_memory_refs: memoryResult.withheld.map((source) => ({
      kind: "memory",
      ref: source.memory_ref.ref,
    })),
    memory_truth_refs: input.working_context.memory_truth_refs,
    owner_boundary: "memory_truth_maintenance",
    raw_memory_read: false,
    resurrects_invalidated_memory: false,
  });
}

function authorityHandoffFor(
  input: ParsedCompanionCognitionInput,
  candidateAction: CandidateAction,
): AuthorityHandoff {
  const boundary = input.caller_path === "runtime_control_response"
    ? "runtime_control"
    : input.proposed_tool_candidates.length > 0
      ? "tool_policy"
      : input.authorization_requests.length > 0 || candidateAction.requires_authority
        ? "interaction_authority"
        : "none";
  return AuthorityHandoffSchema.parse({
    handoff_id: `${input.cognition_id}:authority-handoff`,
    boundary,
    ...(candidateAction.target_ref ? { proposed_decision_ref: candidateAction.target_ref } : {}),
    request_refs: [
      ...input.authorization_requests.map((request) => ({ kind: request.kind, ref: request.request_id })),
      ...input.proposed_tool_candidates.map((candidate) => ({ kind: "tool_candidate", ref: candidate.candidate_id })),
    ],
    authority_state_refs: [
      ...input.working_context.authority_state_refs,
      ...(input.runtime_context?.approval_refs ?? []),
    ],
    kernel_executes_side_effects: false,
    bypasses_stale_target_rejection: false,
  });
}

function correlationRefsFor(input: ParsedCompanionCognitionInput): CognitionCorrelationRefs {
  const firstEvent = input.event_refs[0]!;
  const replayKey = firstEvent.replay_key
    ?? firstEvent.high_watermark
    ?? firstEvent.source_epoch
    ?? input.cognition_id;
  return CognitionCorrelationRefsSchema.parse({
    replay_key: `${input.cognition_id}:${replayKey}`,
    idempotency_key: `${input.cognition_id}:${firstEvent.ref}`,
    event_refs: input.event_refs,
    runtime_graph_refs: input.working_context.runtime_graph_refs,
    runtime_event_refs: input.working_context.runtime_event_refs,
  });
}

function uncertaintiesFor(input: ParsedCompanionCognitionInput, memoryResult: CognitionMemoryResult) {
  return [
    ...memoryResult.withheld.length > 0
      ? [{
          uncertainty_id: `${input.cognition_id}:uncertainty:withheld-memory`,
          kind: "missing_surface" as const,
          severity: "medium" as const,
          reason: "Some memory refs were withheld by Surface/Profile/Soil governance.",
          refs: memoryResult.withheld.map((source) => ({ kind: "memory", ref: source.memory_ref.ref })),
        }]
      : [],
    ...(input.goal_context?.stale_target_refs.length ?? 0) > 0
      ? [{
          uncertainty_id: `${input.cognition_id}:uncertainty:stale-target`,
          kind: "stale_target" as const,
          severity: "high" as const,
          reason: "A previous target ref was present and requires regrounding.",
          refs: input.goal_context!.stale_target_refs,
        }]
      : [],
  ];
}

function maxSuggestDelivery(maxKind: NonNullable<ParsedCompanionCognitionInput["attention_context"]>["max_delivery_kind"]) {
  if (deliveryKindRank(maxKind) <= deliveryKindRank("hold")) return "hold";
  if (deliveryKindRank(maxKind) <= deliveryKindRank("digest")) return "digest";
  return "suggest";
}

function assertNoProactiveUpgrade(input: ParsedCompanionCognitionInput, output: CompanionCognitionOutput): void {
  if (input.caller_path !== "resident_proactive_check") return;
  const maxKind = input.attention_context?.max_delivery_kind;
  const delivery = output.response_plan.delivery_kind;
  if (!maxKind || !delivery) return;
  if (deliveryKindRank(delivery) > deliveryKindRank(maxKind)) {
    throw new Error(`proactive cognition delivery ${delivery} exceeds upstream maximum ${maxKind}`);
  }
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9:_-]/g, "_");
}
