import { createHash } from "node:crypto";
import { z } from "zod/v3";
import {
  MicroProbePlanSchema,
  MicroProbeReadSetEntrySchema,
  MicroProbeRecordSchema,
  type MicroProbePlan,
  type MicroProbeReadSetEntry,
  type MicroProbeRecord,
} from "./micro-probe.js";
import { LearningTrustEnvelopeSchema, type LearningTrustEnvelope } from "./learning-trust.js";

export const MicroProbeSnapshotReadResultSchema = z.object({
  readRef: MicroProbeReadSetEntrySchema,
  payloadHash: z.string().min(1),
  available: z.boolean().default(true),
  correctionFilterDecision: z.enum(["current", "suppressed"]).default("current"),
}).strict();
export type MicroProbeSnapshotReadResultInput = z.input<typeof MicroProbeSnapshotReadResultSchema>;
export type MicroProbeSnapshotReadResult = z.infer<typeof MicroProbeSnapshotReadResultSchema>;

export interface RunNoOutwardEffectMicroProbeInput {
  plan: MicroProbePlan;
  readResults: readonly MicroProbeSnapshotReadResultInput[];
  trust: LearningTrustEnvelope;
  now?: string;
  supportEvidenceRefs?: readonly string[];
  contradictionEvidenceRefs?: readonly string[];
  supportEventRefs?: readonly string[];
  supportRuntimeGraphRefs?: readonly string[];
}

export function runNoOutwardEffectMicroProbe(input: RunNoOutwardEffectMicroProbeInput): MicroProbeRecord {
  const plan = MicroProbePlanSchema.parse(input.plan);
  const trust = LearningTrustEnvelopeSchema.parse(input.trust);
  const readResults = input.readResults.map((result) => MicroProbeSnapshotReadResultSchema.parse(result));
  const readSetFingerprint = stableHash(plan.readSet);
  const replayFingerprint = stableHash(readResults.map((result) => ({
    key: readSetKey(result.readRef),
    payloadHash: result.payloadHash,
    available: result.available,
    correctionFilterDecision: result.correctionFilterDecision,
  })));
  const missingRead = plan.readSet.some((readRef) =>
    !readResults.some((result) => readSetKey(result.readRef) === readSetKey(readRef) && result.available)
  );
  const replayDrift = readResults.some((result) => result.payloadHash !== result.readRef.snapshotPayloadHash);
  const correctionSuppressed = readResults.some((result) => result.correctionFilterDecision === "suppressed");
  const contradictionEvidenceRefs = [...(input.contradictionEvidenceRefs ?? [])];
  const supportEvidenceRefs = [...(input.supportEvidenceRefs ?? [])];
  const independentSupportRefs = supportEvidenceRefs.filter((ref) => !plan.sourceEvidenceRefs.includes(ref));
  const outcome: MicroProbeRecord["outcome"] = missingRead || replayDrift || correctionSuppressed
    ? "blocked"
    : contradictionEvidenceRefs.length > 0
      ? "falsified"
      : independentSupportRefs.length > 0
        ? "supported"
        : "inconclusive";

  return MicroProbeRecordSchema.parse({
    id: `micro-probe-record:${stableHash({
      planId: plan.id,
      replayFingerprint,
      supportEvidenceRefs,
      contradictionEvidenceRefs,
    })}`,
    planId: plan.id,
    ranAt: input.now ?? new Date().toISOString(),
    outcome,
    supportEvidenceRefs: outcome === "supported" ? independentSupportRefs : [],
    contradictionEvidenceRefs,
    supportEventRefs: [...(input.supportEventRefs ?? [])],
    supportRuntimeGraphRefs: [...(input.supportRuntimeGraphRefs ?? [])],
    usedIndependentSupport: outcome === "supported",
    replayFingerprint,
    correctionFilterDecision: correctionSuppressed ? "suppressed" : "current",
    readSetFingerprint,
    trust,
  });
}

function readSetKey(readRef: MicroProbeReadSetEntry): string {
  return [
    readRef.port,
    readRef.sourceKind,
    readRef.ref,
    readRef.snapshotId,
    readRef.versionOrSequence,
    readRef.highWatermark,
  ].join(":");
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex").slice(0, 16);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortJson((value as Record<string, unknown>)[key]);
  }
  return out;
}
