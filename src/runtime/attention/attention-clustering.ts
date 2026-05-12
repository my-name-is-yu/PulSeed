import {
  AttentionClusterSchema,
  type AttentionCluster,
  type AttentionMergeEvent,
  type AttentionScope,
  type AttentionSignalRef,
  type SourceDiversitySummary,
  type UrgeCandidate,
} from "../types/companion-autonomy.js";
import {
  ref,
  refKey,
  sourceRefKey,
  stableId,
  uniqueBy,
  uniqueRefs,
  uniqueSourceRefs,
} from "./attention-refs.js";
import {
  decideScopeCompatibility,
  deriveClusterScope,
} from "./attention-scope.js";
import {
  decideAttentionSimilarity,
  type AttentionSimilarityDecision,
  type SemanticFingerprintResult,
} from "./attention-semantic.js";

export interface MergeUrgesIntoClustersInput {
  urges: readonly UrgeCandidate[];
  existingClusters?: readonly AttentionCluster[];
  now: string;
  maxNewClustersPerCycle?: number;
}

export interface MergeUrgesIntoClustersResult {
  clusters: AttentionCluster[];
  mergeEvents: AttentionMergeEvent[];
  unmergedUrgeRefs: string[];
}

export function mergeUrgesIntoClusters(input: MergeUrgesIntoClustersInput): MergeUrgesIntoClustersResult {
  const clusters = input.existingClusters?.map((cluster) => AttentionClusterSchema.parse(cluster)) ?? [];
  const mergeEvents: AttentionMergeEvent[] = [];
  const unmergedUrgeRefs: string[] = [];
  const maxNewClusters = input.maxNewClustersPerCycle ?? 5;
  let newClusterCount = 0;

  for (const urge of input.urges) {
    const parsedUrge = urge;
    const match = findMergeTarget(parsedUrge, clusters);
    if (match?.decision.outcome === "same_concern") {
      const merged = mergeUrgeIntoCluster({
        cluster: match.cluster,
        urge: parsedUrge,
        decision: match.decision,
        now: input.now,
      });
      const index = clusters.findIndex((cluster) => cluster.id === match.cluster.id);
      clusters[index] = merged.cluster;
      mergeEvents.push(merged.event);
      continue;
    }

    if (newClusterCount >= maxNewClusters) {
      unmergedUrgeRefs.push(parsedUrge.urge_id);
      continue;
    }

    clusters.push(createAttentionClusterFromUrge(parsedUrge, input.now));
    newClusterCount += 1;
  }

  return { clusters, mergeEvents, unmergedUrgeRefs };
}

export function createAttentionClusterFromUrge(urge: UrgeCandidate, now: string): AttentionCluster {
  const sourceDiversity = sourceDiversityForUrges([urge]);
  const fingerprint = storedFingerprintForUrge(urge);
  const id = `attention-cluster:${stableId([
    refKey(urge.target),
    urge.semanticFingerprint ?? urge.urge_id,
    urge.scope.policyEpoch,
    urge.scope.surfaceRef ?? "surface:none",
  ].join("|"))}`;

  return AttentionClusterSchema.parse({
    id,
    scope: urge.scope,
    theme: {
      label: urge.subject,
      structuredRefs: urge.structuredRefs,
      semanticFingerprint: urge.semanticFingerprint,
      semanticProviderId: urge.semanticProviderId,
      semanticProviderVersion: urge.semanticProviderVersion,
      themeHints: fingerprint?.themeHints ?? [],
    },
    memberUrgeRefs: [ref("urge_candidate", urge.urge_id)],
    signalRefs: urge.signalRefs.length > 0 ? urge.signalRefs : urge.evidence_refs,
    similarityBasis: {
      outcome: urge.semanticFingerprint ? "semantic" : urge.structuredRefs.length > 0 ? "structured_ref" : "manual_seed",
      confidence: urge.confidence,
      reasons: ["cluster seeded from one scoped urge"],
    },
    aggregateStrength: saturatingStrength([urge]),
    aggregateConfidence: urge.confidence,
    uncertainty: urge.uncertainty,
    sourceDiversity,
    maturation: urge.maturation,
    lifecycle: lifecycleForSeedUrge(urge),
    conflicts: urge.conflictMarkers,
    splitCandidates: [],
    mergeHistory: [],
    forgetAfter: urge.maturation.expires_at ?? null,
    lastRegroundedAt: urge.stalenessSnapshot.state === "fresh" ? now : null,
    createdAt: now,
    updatedAt: now,
  });
}

export function clusterSimilarityInput(cluster: AttentionCluster) {
  return {
    ref: { kind: "attention_cluster" as const, id: cluster.id },
    scope: cluster.scope,
    semanticFingerprint: storedFingerprintForCluster(cluster),
    structuredRefs: cluster.theme.structuredRefs,
    signalRefs: cluster.signalRefs,
  };
}

function findMergeTarget(
  urge: UrgeCandidate,
  clusters: readonly AttentionCluster[],
): { cluster: AttentionCluster; decision: AttentionSimilarityDecision; derivedScope: AttentionScope } | null {
  for (const cluster of clusters) {
    const scopeDecision = decideScopeCompatibility(cluster.scope, urge.scope);
    const decision = decideAttentionSimilarity({
      left: clusterSimilarityInput(cluster),
      right: {
        ref: { kind: "urge_candidate", id: urge.urge_id },
        scope: urge.scope,
        semanticFingerprint: storedFingerprintForUrge(urge),
        structuredRefs: urge.structuredRefs,
        signalRefs: urge.signalRefs,
      },
      scopeDecision,
    });
    if (scopeDecision.outcome === "compatible" && decision.outcome === "same_concern") {
      return { cluster, decision, derivedScope: scopeDecision.derivedScope };
    }
  }
  return null;
}

function mergeUrgeIntoCluster(input: {
  cluster: AttentionCluster;
  urge: UrgeCandidate;
  decision: Extract<AttentionSimilarityDecision, { outcome: "same_concern" }>;
  now: string;
}): { cluster: AttentionCluster; event: AttentionMergeEvent } {
  const memberUrges = uniqueRefs([
    ...input.cluster.memberUrgeRefs,
    ref("urge_candidate", input.urge.urge_id),
  ]);
  const allSignalRefs = [
    ...input.cluster.signalRefs,
    ...(input.urge.signalRefs.length > 0 ? input.urge.signalRefs : input.urge.evidence_refs),
  ];
  const signalRefs = uniqueSourceRefs(allSignalRefs);
  const scopeDecision = deriveClusterScope([input.cluster.scope, input.urge.scope]);
  const derivedScope = scopeDecision.outcome === "compatible" ? scopeDecision.derivedScope : input.cluster.scope;
  const event: AttentionMergeEvent = {
    event_id: `attention-merge:${stableId(`${input.cluster.id}:${input.urge.urge_id}:${input.now}`)}`,
    mergedAt: input.now,
    urgeRef: ref("urge_candidate", input.urge.urge_id),
    previousClusterRef: ref("attention_cluster", input.cluster.id),
    basis: {
      outcome: input.decision.basis,
      confidence: input.decision.confidence,
      reasons: input.decision.reasons,
    },
    reasons: input.decision.reasons,
  };

  return {
    event,
    cluster: AttentionClusterSchema.parse({
      ...input.cluster,
      scope: derivedScope,
      memberUrgeRefs: memberUrges,
      signalRefs,
      similarityBasis: event.basis,
      aggregateStrength: saturatingStrengthForValues([
        input.cluster.aggregateStrength,
        input.urge.strength,
      ], signalRefs.length),
      aggregateConfidence: Math.max(input.cluster.aggregateConfidence, input.urge.confidence),
      uncertainty: Math.min(input.cluster.uncertainty, input.urge.uncertainty),
      sourceDiversity: sourceDiversityForSourceRefs(allSignalRefs),
      maturation: strongerMaturation(input.cluster.maturation, input.urge.maturation, input.now),
      lifecycle: lifecycleAfterMerge(input.cluster, input.urge),
      conflicts: uniqueBy([...input.cluster.conflicts, ...input.urge.conflictMarkers], (conflict) => conflict.conflict_id),
      mergeHistory: [...input.cluster.mergeHistory, event],
      updatedAt: input.now,
    }),
  };
}

function lifecycleForSeedUrge(urge: UrgeCandidate): AttentionCluster["lifecycle"] {
  if (urge.stalenessSnapshot.state === "needs_regrounding" || urge.scope.policyEpoch === "unknown") return "needs_regrounding";
  if (urge.conflictMarkers.length > 0) return "split_pending";
  if (urge.maturation.state === "mature" || urge.maturation.state === "prepared") return "mature";
  if (urge.maturation.state === "suppressed") return "suppressed";
  if (urge.maturation.state === "expired") return "forgotten";
  return "forming";
}

function lifecycleAfterMerge(cluster: AttentionCluster, urge: UrgeCandidate): AttentionCluster["lifecycle"] {
  if (cluster.conflicts.length > 0 || urge.conflictMarkers.length > 0) return "split_pending";
  if (cluster.lifecycle === "needs_regrounding" || urge.stalenessSnapshot.state === "needs_regrounding") return "needs_regrounding";
  if (cluster.aggregateStrength >= 0.75 || urge.maturation.state === "mature" || urge.maturation.state === "prepared") return "mature";
  return "watching";
}

function strongerMaturation(
  left: AttentionCluster["maturation"],
  right: UrgeCandidate["maturation"],
  now: string,
): AttentionCluster["maturation"] {
  const rank = ["new", "warming", "held", "mature", "prepared", "expressed", "decayed", "suppressed", "rejected_stale", "expired"];
  const stronger = rank.indexOf(right.state) > rank.indexOf(left.state) ? right : left;
  return {
    ...stronger,
    last_reinforced_at: now,
    reinforcement_refs: uniqueSourceRefs([
      ...left.reinforcement_refs,
      ...right.reinforcement_refs,
    ]),
    blocker_refs: uniqueSourceRefs([
      ...left.blocker_refs,
      ...right.blocker_refs,
    ]),
  };
}

function sourceDiversityForUrges(urges: readonly UrgeCandidate[]): SourceDiversitySummary {
  const allRefs = urges.flatMap((urge) => urge.signalRefs.length > 0 ? urge.signalRefs : urge.evidence_refs);
  return sourceDiversityForSourceRefs(allRefs);
}

function sourceDiversityForSourceRefs(allRefs: readonly AttentionSignalRef[]): SourceDiversitySummary {
  const uniqueRefsByKey = uniqueBy(allRefs, sourceRefKey);
  const sourceKinds = uniqueBy(
    uniqueRefsByKey.map((source) => source.ref.kind),
    (value) => value,
  );
  return {
    sourceKinds,
    independentSourceCount: uniqueRefsByKey.length,
    repeatedSourceCount: Math.max(0, allRefs.length - uniqueRefsByKey.length),
  };
}

function saturatingStrength(urges: readonly UrgeCandidate[]): number {
  const uniqueSignalCount = uniqueBy(
    urges.flatMap((urge) => urge.signalRefs.length > 0 ? urge.signalRefs : urge.evidence_refs),
    sourceRefKey,
  ).length;
  return saturatingStrengthForValues(urges.map((urge) => urge.strength), uniqueSignalCount);
}

function saturatingStrengthForValues(values: readonly number[], independentSourceCount: number): number {
  const cappedValues = values.map((value) => Math.min(0.75, Math.max(0, value)));
  const saturation = 1 - cappedValues.reduce((product, value) => product * (1 - value), 1);
  const diversityBoost = Math.min(0.2, Math.max(0, independentSourceCount - 1) * 0.05);
  return Math.min(0.98, Number((saturation + diversityBoost).toFixed(4)));
}

function storedFingerprintForUrge(urge: UrgeCandidate): SemanticFingerprintResult | null {
  if (!urge.semanticFingerprint || !urge.semanticProviderVersion) return null;
  return {
    providerId: urge.semanticProviderId ?? "stored-urge-fingerprint",
    providerVersion: urge.semanticProviderVersion,
    fingerprint: urge.semanticFingerprint,
    themeHints: [],
    confidence: Math.max(0, Math.min(1, 1 - urge.uncertainty)),
    outcome: "known",
    redactionLevel: urge.scope.sensitivity === "high" ? "high_sensitivity_summary" : "summary_only",
    cacheKey: `stored:${urge.semanticProviderId ?? "stored"}:${urge.semanticProviderVersion}:${urge.semanticFingerprint}`,
    createdAt: urge.stalenessSnapshot.observedAt,
  };
}

function storedFingerprintForCluster(cluster: AttentionCluster): SemanticFingerprintResult | null {
  if (!cluster.theme.semanticFingerprint || !cluster.theme.semanticProviderVersion) return null;
  return {
    providerId: cluster.theme.semanticProviderId ?? "stored-urge-fingerprint",
    providerVersion: cluster.theme.semanticProviderVersion,
    fingerprint: cluster.theme.semanticFingerprint,
    themeHints: cluster.theme.themeHints,
    confidence: cluster.aggregateConfidence,
    outcome: "known",
    redactionLevel: cluster.scope.sensitivity === "high" ? "high_sensitivity_summary" : "summary_only",
    cacheKey: `stored:${cluster.theme.semanticProviderId ?? "stored"}:${cluster.theme.semanticProviderVersion}:${cluster.theme.semanticFingerprint}`,
    createdAt: cluster.createdAt,
  };
}
