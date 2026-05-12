import {
  AttentionClusterSchema,
  type AttentionCluster,
  type AttentionMaturation,
  type AttentionSuppression,
} from "../types/companion-autonomy.js";
import { sourceRefKey, uniqueSourceRefs } from "./attention-refs.js";

export interface PromoteAttentionClustersInput {
  clusters: readonly AttentionCluster[];
  now: string;
  quietMode?: boolean;
  suspended?: boolean;
}

export function promoteAttentionClusters(input: PromoteAttentionClustersInput): AttentionCluster[] {
  return input.clusters.map((cluster) => promoteAttentionCluster({
    cluster,
    now: input.now,
    quietMode: input.quietMode ?? false,
    suspended: input.suspended ?? false,
  }));
}

export function promoteAttentionCluster(input: {
  cluster: AttentionCluster;
  now: string;
  quietMode?: boolean;
  suspended?: boolean;
}): AttentionCluster {
  const cluster = AttentionClusterSchema.parse(input.cluster);
  if (input.suspended) {
    return markSuppressed(cluster, input.now, {
      reason: "suspend mode blocks ordinary attention promotion",
      suppressedAt: input.now,
      feedbackRef: null,
    });
  }
  if (cluster.scope.policyEpoch === "unknown" || cluster.lifecycle === "needs_regrounding") {
    return markNeedsRegrounding(cluster, input.now, "cluster requires current policy/scope grounding");
  }
  if (cluster.conflicts.length > 0 || cluster.splitCandidates.length > 0) {
    return AttentionClusterSchema.parse({
      ...cluster,
      lifecycle: "split_pending",
      updatedAt: input.now,
    });
  }
  if (cluster.forgetAfter && Date.parse(cluster.forgetAfter) <= Date.parse(input.now)) {
    return AttentionClusterSchema.parse({
      ...cluster,
      lifecycle: "forgotten",
      updatedAt: input.now,
    });
  }
  if (cluster.aggregateStrength < 0.2 && cluster.aggregateConfidence < 0.4) {
    return AttentionClusterSchema.parse({
      ...cluster,
      lifecycle: "forgotten",
      updatedAt: input.now,
    });
  }
  if (input.quietMode && cluster.aggregateStrength < 0.9) {
    return AttentionClusterSchema.parse({
      ...cluster,
      lifecycle: "watching",
      maturation: holdMaturation(cluster.maturation, input.now),
      updatedAt: input.now,
    });
  }
  if (cluster.aggregateStrength >= 0.72 && cluster.aggregateConfidence >= 0.65 && cluster.uncertainty <= 0.45) {
    return AttentionClusterSchema.parse({
      ...cluster,
      lifecycle: "mature",
      maturation: matureMaturation(cluster.maturation, input.now),
      updatedAt: input.now,
    });
  }
  return AttentionClusterSchema.parse({
    ...cluster,
    lifecycle: cluster.lifecycle === "forming" ? "watching" : cluster.lifecycle,
    updatedAt: input.now,
  });
}

function markNeedsRegrounding(cluster: AttentionCluster, now: string, reason: string): AttentionCluster {
  return AttentionClusterSchema.parse({
    ...cluster,
    lifecycle: "needs_regrounding",
    maturation: {
      ...cluster.maturation,
      state: "held",
      blocker_refs: uniqueSourceRefs(cluster.signalRefs),
      decay_rule: {
        kind: "staleness_decay",
        reason,
      },
    },
    updatedAt: now,
  });
}

function markSuppressed(
  cluster: AttentionCluster,
  now: string,
  suppression: AttentionSuppression,
): AttentionCluster {
  return AttentionClusterSchema.parse({
    ...cluster,
    lifecycle: "suppressed",
    suppression,
    maturation: {
      ...cluster.maturation,
      state: "suppressed",
      blocker_refs: uniqueSourceRefs(cluster.signalRefs),
    },
    updatedAt: now,
  });
}

function holdMaturation(maturation: AttentionMaturation, now: string): AttentionMaturation {
  return {
    ...maturation,
    state: maturation.state === "new" ? "warming" : "held",
    last_reinforced_at: maturation.last_reinforced_at ?? now,
  };
}

function matureMaturation(maturation: AttentionMaturation, now: string): AttentionMaturation {
  return {
    ...maturation,
    state: "mature",
    last_reinforced_at: now,
    reinforcement_refs: uniqueSourceRefs(maturation.reinforcement_refs).sort((left, right) =>
      sourceRefKey(left).localeCompare(sourceRefKey(right))
    ),
  };
}
