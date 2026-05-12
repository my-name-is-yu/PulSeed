import { uniqueRefs } from "./attention-refs.js";
import type {
  AgentAgendaItemKind,
  AgendaDecomposition,
  AttentionCluster,
  AttentionScope,
  AttentionSensitivity,
  CompanionAutonomyRef,
  OutcomeClass,
  UrgeOrigin,
} from "../types/companion-autonomy.js";
import { AttentionClusterSchema, AgendaDecompositionSchema } from "../types/companion-autonomy.js";

export const AttentionFeedbackKindValues = [
  "accepted",
  "dismissed",
  "correction",
  "overreach",
  "permission_revoked",
  "surface_narrowed",
] as const;
export type AttentionFeedbackKind = typeof AttentionFeedbackKindValues[number];

export type AttentionFeedbackEvent = {
  feedback_ref: CompanionAutonomyRef;
  kind: AttentionFeedbackKind;
  agenda_kind?: AgentAgendaItemKind;
  urge_origin?: UrgeOrigin;
  route?: OutcomeClass;
  surface_ref?: CompanionAutonomyRef;
  permission_ref?: CompanionAutonomyRef;
  sensitivity?: AttentionSensitivity;
};

export type AttentionFeedbackPolicyAdjustment = {
  cooldown_refs: CompanionAutonomyRef[];
  suppressed_agenda_kinds: AgentAgendaItemKind[];
  approval_required_outcomes: OutcomeClass[];
  narrowed_surface_refs: CompanionAutonomyRef[];
  sensitive_urge_origins: UrgeOrigin[];
  permission_update_refs: CompanionAutonomyRef[];
  audit_refs: CompanionAutonomyRef[];
  threshold_effects: Array<"raise_expression_threshold" | "raise_attention_threshold" | "preserve_thresholds">;
};

export type AttentionOutcomeFailureClass =
  | "transient"
  | "permission_denied"
  | "stale_context"
  | "user_rejected"
  | "policy_blocked"
  | "bug_or_unknown";

export type AttentionOutcomeFeedback = {
  clusterRef: CompanionAutonomyRef;
  childId: string;
  outcomeRef: CompanionAutonomyRef;
  failureClass?: AttentionOutcomeFailureClass;
  accepted?: boolean;
  recordedAt: string;
};

export type AttentionCorrectionFeedback = {
  correctionRef: CompanionAutonomyRef;
  scope: AttentionScope;
  targetClusterRefs?: CompanionAutonomyRef[];
  targetChildIds?: string[];
  suppressionReason: string;
  recordedAt: string;
};

export function applyAttentionFeedbackConservatively(
  feedbackEvents: AttentionFeedbackEvent[]
): AttentionFeedbackPolicyAdjustment {
  const cooldownRefs: CompanionAutonomyRef[] = [];
  const suppressedAgendaKinds = new Set<AgentAgendaItemKind>();
  const approvalRequiredOutcomes = new Set<OutcomeClass>();
  const narrowedSurfaceRefs: CompanionAutonomyRef[] = [];
  const sensitiveUrgeOrigins = new Set<UrgeOrigin>();
  const permissionUpdateRefs: CompanionAutonomyRef[] = [];
  const auditRefs: CompanionAutonomyRef[] = [];
  const thresholdEffects = new Set<AttentionFeedbackPolicyAdjustment["threshold_effects"][number]>();
  const dismissalsByAgendaKind = new Map<AgentAgendaItemKind, number>();

  for (const event of feedbackEvents) {
    auditRefs.push(event.feedback_ref);

    switch (event.kind) {
      case "accepted": {
        thresholdEffects.add("preserve_thresholds");
        break;
      }
      case "dismissed":
      case "overreach": {
        cooldownRefs.push(event.feedback_ref);
        thresholdEffects.add("raise_expression_threshold");
        if (event.route) approvalRequiredOutcomes.add(event.route);
        if (event.agenda_kind) {
          dismissalsByAgendaKind.set(event.agenda_kind, (dismissalsByAgendaKind.get(event.agenda_kind) ?? 0) + 1);
        }
        if (event.urge_origin) sensitiveUrgeOrigins.add(event.urge_origin);
        break;
      }
      case "correction": {
        thresholdEffects.add("raise_attention_threshold");
        if (event.route) approvalRequiredOutcomes.add(event.route);
        if (event.urge_origin) sensitiveUrgeOrigins.add(event.urge_origin);
        break;
      }
      case "permission_revoked": {
        if (event.permission_ref) permissionUpdateRefs.push(event.permission_ref);
        if (event.route) approvalRequiredOutcomes.add(event.route);
        thresholdEffects.add("raise_expression_threshold");
        break;
      }
      case "surface_narrowed": {
        if (event.surface_ref) narrowedSurfaceRefs.push(event.surface_ref);
        thresholdEffects.add("raise_attention_threshold");
        break;
      }
    }
  }

  for (const [kind, count] of dismissalsByAgendaKind) {
    if (count >= 2) suppressedAgendaKinds.add(kind);
  }

  if (thresholdEffects.size === 0) thresholdEffects.add("preserve_thresholds");

  return {
    cooldown_refs: uniqueRefs(cooldownRefs),
    suppressed_agenda_kinds: [...suppressedAgendaKinds],
    approval_required_outcomes: [...approvalRequiredOutcomes],
    narrowed_surface_refs: uniqueRefs(narrowedSurfaceRefs),
    sensitive_urge_origins: [...sensitiveUrgeOrigins],
    permission_update_refs: uniqueRefs(permissionUpdateRefs),
    audit_refs: uniqueRefs(auditRefs),
    threshold_effects: [...thresholdEffects],
  };
}

export function applyOutcomeFeedbackToAttention(input: {
  clusters: readonly AttentionCluster[];
  decompositions: readonly AgendaDecomposition[];
  feedback: AttentionOutcomeFeedback;
}): { clusters: AttentionCluster[]; decompositions: AgendaDecomposition[] } {
  const clusterKey = `${input.feedback.clusterRef.kind}:${input.feedback.clusterRef.id}`;
  const clusters = input.clusters.map((cluster) => {
    if (`attention_cluster:${cluster.id}` !== clusterKey) return cluster;
    if (input.feedback.accepted && !input.feedback.failureClass) {
      return AttentionClusterSchema.parse({
        ...cluster,
        aggregateConfidence: Math.min(1, cluster.aggregateConfidence + 0.05),
        uncertainty: Math.max(0, cluster.uncertainty - 0.05),
        updatedAt: input.feedback.recordedAt,
      });
    }
    const suppression = failureSuppression(input.feedback.failureClass);
    return AttentionClusterSchema.parse({
      ...cluster,
      lifecycle: suppression.lifecycle,
      suppression: {
        reason: suppression.reason,
        suppressedAt: input.feedback.recordedAt,
        feedbackRef: input.feedback.outcomeRef,
      },
      maturation: {
        ...cluster.maturation,
        state: suppression.maturationState,
      },
      updatedAt: input.feedback.recordedAt,
    });
  });
  const decompositions = input.decompositions.map((decomposition) =>
    AgendaDecompositionSchema.parse({
      ...decomposition,
      children: decomposition.children.map((child) =>
        child.id === input.feedback.childId
          ? {
              ...child,
              admissionState: input.feedback.failureClass ? "rejected" : "admitted",
              outcomeRef: input.feedback.outcomeRef.id,
              updatedAt: input.feedback.recordedAt,
            }
          : child
      ),
      updatedAt: input.feedback.recordedAt,
    })
  );
  return { clusters, decompositions };
}

export function applyCorrectionFeedbackToAttention(input: {
  clusters: readonly AttentionCluster[];
  decompositions: readonly AgendaDecomposition[];
  correction: AttentionCorrectionFeedback;
}): { clusters: AttentionCluster[]; decompositions: AgendaDecomposition[] } {
  const targetClusterIds = new Set((input.correction.targetClusterRefs ?? []).map((ref) => ref.id));
  const targetChildIds = new Set(input.correction.targetChildIds ?? []);
  const clusters = input.clusters.map((cluster) => {
    if (targetClusterIds.size > 0 && !targetClusterIds.has(cluster.id)) return cluster;
    if (!scopeMatchesCorrection(cluster.scope, input.correction.scope)) return cluster;
    return AttentionClusterSchema.parse({
      ...cluster,
      lifecycle: "suppressed",
      suppression: {
        reason: input.correction.suppressionReason,
        suppressedAt: input.correction.recordedAt,
        feedbackRef: input.correction.correctionRef,
      },
      maturation: {
        ...cluster.maturation,
        state: "suppressed",
      },
      updatedAt: input.correction.recordedAt,
    });
  });
  const decompositions = input.decompositions.map((decomposition) => {
    if (!scopeMatchesCorrection(decomposition.scope, input.correction.scope)) return decomposition;
    return AgendaDecompositionSchema.parse({
      ...decomposition,
      status: "suppressed",
      children: decomposition.children.map((child) =>
        targetChildIds.size === 0 || targetChildIds.has(child.id)
          ? {
              ...child,
              admissionState: child.admissionState === "admitted" ? "admitted" : "rejected",
              outcomeRef: input.correction.correctionRef.id,
              updatedAt: input.correction.recordedAt,
            }
          : child
      ),
      updatedAt: input.correction.recordedAt,
    });
  });
  return { clusters, decompositions };
}

function failureSuppression(failureClass: AttentionOutcomeFailureClass | undefined): {
  lifecycle: AttentionCluster["lifecycle"];
  maturationState: AttentionCluster["maturation"]["state"];
  reason: string;
} {
  switch (failureClass) {
    case "transient":
      return {
        lifecycle: "watching",
        maturationState: "held",
        reason: "transient failure scheduled bounded cooldown before retry",
      };
    case "stale_context":
      return {
        lifecycle: "needs_regrounding",
        maturationState: "held",
        reason: "stale context requires regrounding before retry",
      };
    case "permission_denied":
    case "user_rejected":
    case "policy_blocked":
    case "bug_or_unknown":
    default:
      return {
        lifecycle: "suppressed",
        maturationState: "suppressed",
        reason: "failed outcome suppresses immediate re-admission",
      };
  }
}

function scopeMatchesCorrection(left: AttentionScope, right: AttentionScope): boolean {
  return left.userId === right.userId
    && (right.workspaceId === null || right.workspaceId === undefined || left.workspaceId === right.workspaceId)
    && (right.conversationId === null || right.conversationId === undefined || left.conversationId === right.conversationId)
    && left.policyEpoch === right.policyEpoch;
}
