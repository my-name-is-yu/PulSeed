import {
  SituationModelSchema,
  type CognitionMemoryResult,
  type CognitionRef,
  type ParsedCompanionCognitionInput,
  type SituationModel,
} from "./contracts.js";

export function assembleSituationModel(input: {
  cognitionInput: ParsedCompanionCognitionInput;
  memoryResult: CognitionMemoryResult;
}): SituationModel {
  const cognitionInput = input.cognitionInput;
  const attention = cognitionInput.attention_context;
  const runtime = cognitionInput.runtime_context;
  const session = cognitionInput.session_context;
  const goal = cognitionInput.goal_context;
  const missingMemoryRefs: CognitionRef[] = input.memoryResult.withheld.map((source) => ({
    kind: "memory",
    ref: source.memory_ref.ref,
  }));
  const missingPolicyRefs = policyGapsFor(cognitionInput);

  return SituationModelSchema.parse({
    situation_id: `${cognitionInput.cognition_id}:situation`,
    summary_ref: cognitionInput.working_context.input_ref,
    caller_path: cognitionInput.caller_path,
    route_ref: cognitionInput.working_context.route_ref,
    reply_target_ref: cognitionInput.working_context.reply_target_ref,
    session_ref: cognitionInput.working_context.session_ref ?? session?.session_ref,
    runtime_phase_ref: runtime?.phase_ref,
    operation_boundary_ref: attention?.operation_plan_ref
      ? { kind: "operation_plan", ref: attention.operation_plan_ref }
      : undefined,
    operation_boundary_status: attention?.operation_boundary,
    policy_available: missingPolicyRefs.length === 0,
    tool_trace_refs: runtime?.last_tool_trace_refs ?? [],
    approval_refs: runtime?.approval_refs ?? [],
    current_target_refs: [
      ...(session?.session_ref ? [session.session_ref] : []),
      ...(session?.turn_ref ? [session.turn_ref] : []),
      ...(goal?.active_goals.map((activeGoal) => activeGoal.goal_ref) ?? []),
      ...(runtime?.runtime_item_refs ?? []),
      ...(attention?.agenda_ref ? [attention.agenda_ref] : []),
    ],
    stale_target_refs: [
      ...(session?.stale_reply_target_refs ?? []),
      ...(goal?.stale_target_refs ?? []),
    ],
    missing_memory_refs: missingMemoryRefs,
    missing_policy_refs: missingPolicyRefs,
    protocol_bypass: false,
    confidence: confidenceFor({
      staleTargetCount: (session?.stale_reply_target_refs.length ?? 0) + (goal?.stale_target_refs.length ?? 0),
      missingMemoryCount: missingMemoryRefs.length,
      missingPolicyCount: missingPolicyRefs.length,
    }),
  });
}

function policyGapsFor(input: ParsedCompanionCognitionInput): CognitionRef[] {
  const refs: CognitionRef[] = [];
  if (input.session_context && !input.session_context.runtime_control_allowed) {
    refs.push({ kind: "runtime_control_policy", ref: "runtime_control:unavailable" });
  }
  if (input.attention_context?.operation_boundary === "unavailable") {
    refs.push({ kind: "operation_boundary", ref: "operation_boundary:unavailable" });
  }
  if (input.attention_context?.admission_status === "blocked") {
    refs.push({ kind: "attention_admission", ref: input.attention_context.initiative_gate_decision_id });
  }
  return refs;
}

function confidenceFor(input: {
  staleTargetCount: number;
  missingMemoryCount: number;
  missingPolicyCount: number;
}): number {
  const penalty = (input.staleTargetCount * 0.2) + (input.missingMemoryCount * 0.08) + (input.missingPolicyCount * 0.18);
  return Math.max(0.25, Number((0.82 - penalty).toFixed(2)));
}
