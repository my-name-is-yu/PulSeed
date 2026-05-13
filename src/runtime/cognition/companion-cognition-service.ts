import {
  createCognitionReplayRecord,
} from "./audit-sink.js";
import {
  CompanionCognitionInputSchema,
  CompanionCognitionOutputSchema,
  ResponsePlanSchema,
  SituationModelSchema,
  RelationshipStateProjectionSchema,
  IntentionSelectionSchema,
  deliveryKindRank,
  type CognitionMemoryResult,
  type CompanionCognitionInput,
  type CompanionCognitionOutput,
  type IntentionSelection,
  type ParsedCompanionCognitionInput,
  type ResponsePlan,
  type SituationModel,
} from "./contracts.js";
import type { CognitionAuditSink, CognitionMemoryPort } from "./ports.js";
import { createEmptyCognitionMemoryResult } from "./memory-context.js";
import {
  createReflectionHintForWriteback,
  createTurnEpisodeWritebackProposal,
} from "./writeback.js";

export interface CompanionCognitionServiceDeps {
  memoryPort?: CognitionMemoryPort;
  auditSink?: CognitionAuditSink;
  now?: () => Date;
}

export class CompanionCognitionService {
  constructor(private readonly deps: CompanionCognitionServiceDeps = {}) {}

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

  private async evaluate(rawInput: CompanionCognitionInput): Promise<CompanionCognitionOutput> {
    const input: ParsedCompanionCognitionInput = CompanionCognitionInputSchema.parse(rawInput);
    const memoryResult = await this.resolveMemory(input);
    const firstEventRef = input.event_refs[0]!;
    const situationModel = situationModelFor(input);
    const relationshipState = RelationshipStateProjectionSchema.parse({
      projection_id: `${input.cognition_id}:relationship`,
      relationship_refs: memoryResult.included.filter((source) => source.source_kind === "semantic"),
      withheld_memory_refs: memoryResult.withheld,
      conflict_refs: [],
      overreach_risk: input.caller_path === "resident_proactive_check" ? "medium" : "unknown",
      ordinary_surface_debug_visible: false,
    });
    const responsePlan = responsePlanFor(input);
    const selectedIntention = intentionFor(input);
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
      response_plan: responsePlan,
      tool_candidates: input.proposed_tool_candidates,
      authorization_requests: input.authorization_requests,
      memory_writeback: [writeback],
      reflection_hints: [reflectionHint],
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

function situationModelFor(input: ParsedCompanionCognitionInput): SituationModel {
  return SituationModelSchema.parse({
    situation_id: `${input.cognition_id}:situation`,
    summary_ref: input.working_context.input_ref,
    caller_path: input.caller_path,
    current_target_refs: [
      ...(input.session_context?.session_ref ? [input.session_context.session_ref] : []),
      ...(input.goal_context?.active_goals.map((goal) => goal.goal_ref) ?? []),
      ...(input.runtime_context?.runtime_item_refs ?? []),
    ],
    stale_target_refs: [
      ...(input.session_context?.stale_reply_target_refs ?? []),
      ...(input.goal_context?.stale_target_refs ?? []),
    ],
    protocol_bypass: false,
    confidence: input.proposed_tool_candidates.length > 0 ? 0.72 : 0.62,
  });
}

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
