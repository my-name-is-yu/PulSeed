import { z } from "zod/v3";
import {
  MemoryCorrectionTargetStateSchema,
  type MemoryCorrectionTargetRef,
  type MemoryCorrectionTargetState,
} from "../../platform/corrections/memory-correction-ledger.js";
import {
  MemoryProvenanceSchema,
  MemoryQuarantineStateSchema,
  MemoryVerificationStatusSchema,
  type MemoryProvenance,
} from "../../platform/corrections/memory-quarantine.js";

export const LearningRiskSignalSchema = z.enum([
  "quarantined",
  "suspicious",
  "contradicted",
  "prompt_injection_like",
  "low_provenance",
  "unverified_external",
  "advisory_only",
]);
export type LearningRiskSignal = z.infer<typeof LearningRiskSignalSchema>;

export const LearningQuarantineStateSchema = z.union([
  MemoryQuarantineStateSchema,
  z.object({
    status: z.literal("clear"),
    active: z.literal(true).default(true),
  }).strict(),
]);
export type LearningQuarantineState = z.infer<typeof LearningQuarantineStateSchema>;

export const LearningTrustEnvelopeSchema = z.object({
  sourceAuthority: z.enum([
    "runtime_evidence",
    "verified_execution",
    "advisory_model",
    "external_untrusted",
    "correction",
  ]),
  verificationStatus: MemoryVerificationStatusSchema,
  quarantineState: LearningQuarantineStateSchema,
  correctionState: MemoryCorrectionTargetStateSchema,
  provenance: z.array(MemoryProvenanceSchema).default([]),
  provenanceRefs: z.array(z.string().min(1)).default([]),
  riskSignals: z.array(LearningRiskSignalSchema).default([]),
  lowestSourceReliability: z.number().min(0).max(1).optional(),
}).strict();
export type LearningTrustEnvelope = z.infer<typeof LearningTrustEnvelopeSchema>;

const FAIL_CLOSED_RISK_SIGNALS = new Set<LearningRiskSignal>([
  "quarantined",
  "suspicious",
  "contradicted",
  "prompt_injection_like",
  "low_provenance",
  "unverified_external",
]);

export function isLearningTrustActivationAllowed(trust: LearningTrustEnvelope): boolean {
  const parsed = LearningTrustEnvelopeSchema.parse(trust);
  if (!parsed.correctionState.active) return false;
  if (parsed.verificationStatus === "contradicted" || parsed.verificationStatus === "suspicious") return false;
  if (parsed.quarantineState.status === "quarantined") return false;
  return !parsed.riskSignals.some((signal) => FAIL_CLOSED_RISK_SIGNALS.has(signal));
}

export function assertLearningTrustActivationAllowed(trust: LearningTrustEnvelope): void {
  if (!isLearningTrustActivationAllowed(trust)) {
    throw new Error("learning trust envelope is not eligible for activation");
  }
}

export function activeLearningCorrectionState(ref: MemoryCorrectionTargetRef): MemoryCorrectionTargetState {
  return MemoryCorrectionTargetStateSchema.parse({
    target_ref: ref,
    status: "active",
    active: true,
  });
}

export function defaultRuntimeEvidenceTrust(input: {
  targetRef: MemoryCorrectionTargetRef;
  provenanceRefs?: readonly string[];
  provenance?: readonly MemoryProvenance[];
  verificationStatus?: LearningTrustEnvelope["verificationStatus"];
  sourceAuthority?: LearningTrustEnvelope["sourceAuthority"];
}): LearningTrustEnvelope {
  return LearningTrustEnvelopeSchema.parse({
    sourceAuthority: input.sourceAuthority ?? "runtime_evidence",
    verificationStatus: input.verificationStatus ?? "verified",
    quarantineState: { status: "clear", active: true },
    correctionState: activeLearningCorrectionState(input.targetRef),
    provenance: [...(input.provenance ?? [])],
    provenanceRefs: [...(input.provenanceRefs ?? [])],
    riskSignals: [],
  });
}

export function learningTrustIssueForActiveStatus(input: {
  trust: LearningTrustEnvelope;
  status: string;
  activeStatuses: readonly string[];
}): string | null {
  if (!input.activeStatuses.includes(input.status)) return null;
  return isLearningTrustActivationAllowed(input.trust)
    ? null
    : `learning object status ${input.status} requires active, non-quarantined, non-contradicted trust`;
}
