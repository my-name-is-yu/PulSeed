import { describe, expect, it } from "vitest";
import {
  assembleCapabilityPlansForAttentionAdmissions,
  assembleSignalContext,
  buildAttentionAdmissionCandidates,
  createAttentionDiagnostics,
  createUrgeCandidate,
  decideAttentionSimilarity,
  decideScopeCompatibility,
  decomposeAgenda,
  DeterministicSemanticFingerprintProvider,
  mergeUrgesIntoClusters,
  projectClustersToAgenda,
  promoteAttentionClusters,
  ref,
  sourceRef,
} from "../index.js";
import {
  applyCorrectionFeedbackToAttention,
  applyOutcomeFeedbackToAttention,
} from "../attention-feedback.js";
import type {
  AttentionScope,
  UrgeCandidate,
} from "../../types/companion-autonomy.js";

const NOW = "2026-05-12T00:00:00.000Z";

function scope(overrides: Partial<AttentionScope> = {}): AttentionScope {
  return {
    userId: "user-1",
    identityId: "identity-1",
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    sessionId: "session-1",
    surfaceClass: "daemon",
    surfaceRef: "surface:daemon",
    permissionScope: "local_only",
    sensitivity: "medium",
    memoryOwner: null,
    policyEpoch: "policy:1",
    ...overrides,
  };
}

function signal(id: string) {
  return assembleSignalContext({
    signal_context_id: `signal:${id}`,
    assembled_at: NOW,
    signals: [
      { source: "runtime_event", ref: ref("runtime_event", `runtime:${id}`) },
      { source: "goal", ref: ref("goal", "goal:concern") },
    ],
    current_goal_refs: [ref("goal", "goal:concern")],
    runtime_state_refs: [ref("runtime_event", `runtime:${id}`)],
  });
}

function urge(input: {
  id: string;
  concern?: string;
  signalId?: string;
  scope?: AttentionScope;
  strength?: number;
  confidence?: number;
  policyEpoch?: string;
}): UrgeCandidate {
  const concern = input.concern ?? "billing follow-up";
  return createUrgeCandidate({
    urge_id: `urge:${input.id}`,
    signal_context: signal(input.signalId ?? input.id),
    origin: "runtime_event",
    target: ref("goal", "goal:concern"),
    feeling: "care",
    subject: `Track ${concern}.`,
    strength: input.strength ?? 0.7,
    confidence: input.confidence ?? 0.8,
    expected_user_benefit: "PulSeed can preserve the concern without acting.",
    scope: input.scope ?? scope(),
    structuredRefs: [{ ref: ref("goal", "goal:concern"), relation: "about", strength: 1 }],
    semanticFingerprint: `fingerprint:${concern}`,
    semanticProviderId: "test-provider",
    semanticProviderVersion: "v1",
    policyEpoch: input.policyEpoch ?? "policy:1",
    maturation_state: "mature",
  });
}

describe("attention concern metabolism contracts", () => {
  it("fails closed for unknown scope and refuses incompatible scope merges", () => {
    expect(decideScopeCompatibility(
      scope({ permissionScope: "unknown" }),
      scope(),
    )).toMatchObject({
      outcome: "unknown",
    });

    expect(decideScopeCompatibility(
      scope(),
      scope({ userId: "user-2" }),
    )).toMatchObject({
      outcome: "conflict",
      conflict: expect.objectContaining({ kind: "scope_conflict" }),
    });

    expect(decideScopeCompatibility(
      scope({ permissionScope: "draft_allowed" }),
      scope({ permissionScope: "notify_allowed", sensitivity: "high" }),
    )).toMatchObject({
      outcome: "compatible",
      derivedScope: expect.objectContaining({
        permissionScope: "local_only",
        sensitivity: "high",
      }),
    });
  });

  it("keeps semantic similarity behind a versioned owner decision", async () => {
    const provider = new DeterministicSemanticFingerprintProvider("v1");
    const left = await provider.createFingerprint({
      scope: scope(),
      signalRefs: [sourceRef("runtime_event", "runtime:1")],
      structuredRefs: [{ ref: ref("goal", "goal:concern"), relation: "about", strength: 1 }],
      redactedSummary: "customer renewal risk",
    });
    const right = { ...left, cacheKey: "cache:right" };
    const decision = decideAttentionSimilarity({
      left: {
        ref: { kind: "urge_candidate", id: "left" },
        scope: scope(),
        semanticFingerprint: left,
        structuredRefs: [{ ref: ref("goal", "goal:concern"), relation: "about", strength: 1 }],
        signalRefs: [],
      },
      right: {
        ref: { kind: "urge_candidate", id: "right" },
        scope: scope(),
        semanticFingerprint: right,
        structuredRefs: [{ ref: ref("goal", "goal:concern"), relation: "about", strength: 1 }],
        signalRefs: [],
      },
      scopeDecision: decideScopeCompatibility(scope(), scope()),
    });

    expect(decision).toMatchObject({
      outcome: "same_concern",
      basis: "semantic_and_structured_ref",
    });

    expect(decideAttentionSimilarity({
      left: {
        ref: { kind: "urge_candidate", id: "left" },
        scope: scope(),
        semanticFingerprint: { ...left, confidence: 0.2 },
        structuredRefs: [],
        signalRefs: [],
      },
      right: {
        ref: { kind: "urge_candidate", id: "right" },
        scope: scope(),
        semanticFingerprint: { ...right, providerVersion: "v2" },
        structuredRefs: [],
        signalRefs: [],
      },
      scopeDecision: decideScopeCompatibility(scope(), scope()),
    })).toMatchObject({
      outcome: "unknown",
    });
  });

  it("merges urges into scoped clusters, saturates repeated weak signals, and decomposes bounded children", () => {
    const first = urge({ id: "first", signalId: "same", strength: 0.35, confidence: 0.72 });
    const repeated = urge({ id: "second", signalId: "same", strength: 0.35, confidence: 0.73 });
    const independent = urge({ id: "third", signalId: "independent", strength: 0.68, confidence: 0.86 });

    const merged = mergeUrgesIntoClusters({
      urges: [first, repeated, independent],
      now: NOW,
    });
    const promoted = promoteAttentionClusters({ clusters: merged.clusters, now: NOW });
    const [cluster] = promoted;

    expect(promoted).toHaveLength(1);
    expect(cluster?.memberUrgeRefs.map((member) => member.id)).toEqual([
      "urge:first",
      "urge:second",
      "urge:third",
    ]);
    expect(cluster?.aggregateStrength).toBeLessThan(1);
    expect(cluster?.sourceDiversity.repeatedSourceCount).toBeGreaterThan(0);
    expect(cluster?.lifecycle).toBe("mature");

    const agenda = projectClustersToAgenda({ clusters: promoted, now: NOW });
    const decompositions = decomposeAgenda({ agendaItems: agenda, now: NOW });

    expect(agenda[0]).toMatchObject({
      clusterRef: { kind: "attention_cluster", id: cluster?.id },
      carePosture: "prepare",
      needsRegrounding: false,
    });
    expect(decompositions[0]?.children.length).toBeLessThanOrEqual(3);
    expect(decompositions[0]?.children.map((child) => child.childType)).toEqual([
      "prepare",
      "watch",
    ]);
  });

  it("admits only fresh authorized children through capability planning, never direct action", () => {
    const writeUrge = urge({
      id: "write",
      scope: scope({ permissionScope: "write_allowed" }),
      strength: 0.95,
      confidence: 0.94,
    });
    const clusters = promoteAttentionClusters({
      clusters: mergeUrgesIntoClusters({ urges: [writeUrge], now: NOW }).clusters,
      now: NOW,
    });
    const agenda = projectClustersToAgenda({ clusters, now: NOW });
    const decompositions = decomposeAgenda({ agendaItems: agenda, now: NOW });
    const candidates = buildAttentionAdmissionCandidates({ decompositions, now: NOW });
    const assemblies = assembleCapabilityPlansForAttentionAdmissions({
      candidates,
      assembledAt: NOW,
      goalId: "goal:concern",
    });

    expect(candidates.map((candidate) => candidate.child.childType)).toContain("action_candidate");
    expect(assemblies[0]).toMatchObject({
      status: "planned",
      candidate_plans: [
        expect.objectContaining({
          operation_plan: expect.objectContaining({
            external_action_authority: false,
            expected_user_visible_effect: false,
          }),
        }),
      ],
    });
  });

  it("feeds failure and correction back into existing clusters and diagnostics without leaking high sensitivity refs", () => {
    const highScope = scope({ sensitivity: "high" });
    const clusters = promoteAttentionClusters({
      clusters: mergeUrgesIntoClusters({ urges: [urge({ id: "sensitive", scope: highScope })], now: NOW }).clusters,
      now: NOW,
    });
    const agenda = projectClustersToAgenda({ clusters, now: NOW });
    const decompositions = decomposeAgenda({ agendaItems: agenda, now: NOW });
    const failed = applyOutcomeFeedbackToAttention({
      clusters,
      decompositions,
      feedback: {
        clusterRef: ref("attention_cluster", clusters[0]!.id),
        childId: decompositions[0]!.children[0]!.id,
        outcomeRef: ref("outcome_decision", "outcome:failed"),
        failureClass: "stale_context",
        recordedAt: NOW,
      },
    });
    const corrected = applyCorrectionFeedbackToAttention({
      clusters: failed.clusters,
      decompositions: failed.decompositions,
      correction: {
        correctionRef: ref("correction", "correction:no-proactive"),
        scope: highScope,
        suppressionReason: "user said this concern should not be proactive",
        recordedAt: NOW,
      },
    });
    const diagnostics = createAttentionDiagnostics({
      clusters: corrected.clusters,
      decompositions: corrected.decompositions,
      viewerScope: highScope,
      view: "operator_safe",
      generatedAt: NOW,
    });

    expect(corrected.clusters[0]).toMatchObject({
      lifecycle: "suppressed",
      suppression: expect.objectContaining({
        reason: "user said this concern should not be proactive",
      }),
    });
    expect(diagnostics.concerns[0]).toMatchObject({
      safe_label: "High-sensitivity attention concern",
      refs: [],
      why_silent: expect.arrayContaining(["cluster is suppressed"]),
    });
  });
});
