import {
  CompanionDecisionEvidenceRefSchema,
  CompanionDecisionFrameSchema,
  CompanionDecisionInputRefSchema,
  CompanionDecisionPolicyRefSchema,
  CompanionDecisionSourceSchema,
  CompanionDecisionTargetRefSchema,
  type CompanionDecisionEvidenceRef,
  type CompanionDecisionFrame,
  type CompanionDecisionInputRef,
  type CompanionDecisionPolicyRef,
  type CompanionDecisionSource,
  type CompanionDecisionTargetRef,
} from "./companion-decision-contract.js";

export interface CompanionCognitionAssemblyInput {
  frameId: string;
  assembledAt?: string;
  source: CompanionDecisionSource;
  trigger: CompanionDecisionInputRef;
  inputRefs?: readonly CompanionDecisionInputRef[];
  evidenceRefs?: readonly CompanionDecisionEvidenceRef[];
  policyRefs?: readonly CompanionDecisionPolicyRef[];
  activeTargetRef?: CompanionDecisionTargetRef | null;
  activeSurfaceRef?: string | null;
  companionStateRef?: string | null;
  groundingBundleRef?: string | null;
  attentionCycleRef?: string | null;
  admissionEvaluationRefs?: readonly string[];
  autonomyDecisionRefs?: readonly string[];
  projectionRefs?: readonly string[];
}

export function assembleCompanionDecisionFrame(
  input: CompanionCognitionAssemblyInput,
): CompanionDecisionFrame {
  const trigger = CompanionDecisionInputRefSchema.parse(input.trigger);
  const inputRefs = dedupeInputRefs([
    trigger,
    ...(input.inputRefs ?? []).map((ref) => CompanionDecisionInputRefSchema.parse(ref)),
  ]);

  return CompanionDecisionFrameSchema.parse({
    schema_version: "companion-decision-frame/v1",
    frame_id: input.frameId,
    assembled_at: input.assembledAt ?? new Date().toISOString(),
    source: CompanionDecisionSourceSchema.parse(input.source),
    input_refs: inputRefs,
    evidence_refs: (input.evidenceRefs ?? []).map((ref) => CompanionDecisionEvidenceRefSchema.parse(ref)),
    policy_refs: (input.policyRefs ?? []).map((ref) => CompanionDecisionPolicyRefSchema.parse(ref)),
    active_target_ref: input.activeTargetRef === undefined
      ? null
      : input.activeTargetRef === null
        ? null
        : CompanionDecisionTargetRefSchema.parse(input.activeTargetRef),
    active_surface_ref: input.activeSurfaceRef ?? null,
    companion_state_ref: input.companionStateRef ?? null,
    grounding_bundle_ref: input.groundingBundleRef ?? null,
    attention_cycle_ref: input.attentionCycleRef ?? null,
    admission_evaluation_refs: [...(input.admissionEvaluationRefs ?? [])],
    autonomy_decision_refs: [...(input.autonomyDecisionRefs ?? [])],
    projection_refs: [...(input.projectionRefs ?? [])],
  });
}

function dedupeInputRefs(refs: CompanionDecisionInputRef[]): CompanionDecisionInputRef[] {
  const seen = new Set<string>();
  const result: CompanionDecisionInputRef[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}\0${ref.ref}\0${ref.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}
