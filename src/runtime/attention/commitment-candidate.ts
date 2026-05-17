import { z } from "zod/v3";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import {
  AttentionPriorityEvidenceSchema,
  AttentionSensitivitySchema,
  AttentionScopeSchema,
  type AttentionPriority,
  type AttentionPriorityEvidence,
  type AttentionPriorityEvidenceComponent,
  type AttentionScope,
  type AttentionSensitivity,
  type CompanionAutonomyRef,
  type CompanionAutonomySourceRef,
  type UrgeCandidate,
} from "../types/companion-autonomy.js";
import {
  assembleSignalContext,
  createUrgeCandidate,
} from "./attention-metabolism.js";
import { createAttentionInput, type AttentionInput } from "./attention-input.js";
import { ref, sourceRef, stableId } from "./attention-refs.js";

export const CommitmentCareLifecycleSchema = z.enum([
  "candidate",
  "shadow_held",
  "ask_confirmation",
  "watching",
  "active_care",
  "quieted",
  "snoozed",
  "resolved",
  "rejected",
  "tombstoned",
  "stale",
]);
export type CommitmentCareLifecycle = z.infer<typeof CommitmentCareLifecycleSchema>;

export const CommitmentOwnerSchema = z.enum(["user", "pulseed", "unknown"]);
export type CommitmentOwner = z.infer<typeof CommitmentOwnerSchema>;

export const CommitmentAllowedMemoryUseSchema = z.enum([
  "attention_only",
  "runtime_graph_provenance",
  "relationship_memory_proposal",
  "none",
]);
export type CommitmentAllowedMemoryUse = z.infer<typeof CommitmentAllowedMemoryUseSchema>;

export const CommitmentNudgePolicySchema = z.enum([
  "allowed",
  "digest_only",
  "ask_first",
  "disabled",
]);
export type CommitmentNudgePolicy = z.infer<typeof CommitmentNudgePolicySchema>;

export const CommitmentWatchVectorSchema = z.enum([
  "progress",
  "blocker",
  "deadline",
  "mood_load",
  "related_conversation",
  "completion_correction",
  "capability_fit",
]);
export type CommitmentWatchVector = z.infer<typeof CommitmentWatchVectorSchema>;

export const CommitmentLifecycleControlSchema = z.enum([
  "dismiss",
  "snooze",
  "not_relevant",
  "already_done",
  "stop_reminders_like_this",
  "correct_memory_source",
  "show_why",
]);
export type CommitmentLifecycleControl = z.infer<typeof CommitmentLifecycleControlSchema>;

export const CommitmentCandidateSchema = z.object({
  schema_version: z.literal("commitment-candidate-v1").default("commitment-candidate-v1"),
  commitment_id: z.string().min(1),
  source_ref: z.object({
    kind: z.literal("user_activity"),
    id: z.string().min(1),
  }).strict(),
  target_ref: z.object({
    kind: z.literal("commitment"),
    id: z.string().min(1),
  }).strict(),
  replay_key: z.string().min(1),
  source_epoch: z.string().min(1),
  source_high_watermark: z.string().min(1),
  policy_epoch: z.string().min(1),
  materialization_id: z.string().min(1).nullable().default(null),
  materialization_state: CommitmentCareLifecycleSchema,
  summary: z.string().min(1),
  due: z.object({
    window_start: z.string().datetime().nullable().default(null),
    window_end: z.string().datetime().nullable().default(null),
    uncertainty: z.enum(["none", "low", "medium", "high", "unknown"]),
    reason: z.string().min(1),
  }).strict(),
  owner: CommitmentOwnerSchema,
  confidence: z.number().min(0).max(1),
  sensitivity: AttentionSensitivitySchema,
  allowed_memory_use: CommitmentAllowedMemoryUseSchema,
  nudge_policy: CommitmentNudgePolicySchema,
  suppression_refs: z.array(z.string().min(1)).default([]),
  feedback_refs: z.array(z.string().min(1)).default([]),
  watch_vector: z.array(CommitmentWatchVectorSchema).min(1),
  priority_evidence: AttentionPriorityEvidenceSchema,
  scope: AttentionScopeSchema,
  next_revisit_at: z.string().datetime().nullable().default(null),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  audit_refs: z.array(z.object({
    kind: z.string().min(1),
    id: z.string().min(1),
  }).strict()).default([]),
}).strict();
export type CommitmentCandidate = z.infer<typeof CommitmentCandidateSchema>;

export const CommitmentCandidateExtractionSchema = z.object({
  outcome: z.enum(["candidate", "none", "unknown", "completion", "correction", "not_relevant"]),
  summary: z.string().min(1).optional(),
  target_commitment_id: z.string().min(1).nullable().default(null),
  due: z.object({
    window_start: z.string().datetime().nullable().default(null),
    window_end: z.string().datetime().nullable().default(null),
    uncertainty: z.enum(["none", "low", "medium", "high", "unknown"]).default("unknown"),
    reason: z.string().min(1).default("classifier did not provide a specific window"),
  }).strict().optional(),
  owner: CommitmentOwnerSchema.default("unknown"),
  confidence: z.number().min(0).max(1).default(0),
  sensitivity: AttentionSensitivitySchema.default("internal"),
  allowed_memory_use: CommitmentAllowedMemoryUseSchema.default("attention_only"),
  nudge_policy: CommitmentNudgePolicySchema.default("ask_first"),
  watch_vector: z.array(CommitmentWatchVectorSchema).default(["related_conversation"]),
  user_state: z.object({
    high_load: z.boolean().default(false),
    tired: z.boolean().default(false),
    overreach_feedback: z.boolean().default(false),
  }).strict().default({}),
  priority_evidence_overrides: z.object({
    urgency: z.number().min(0).max(1).optional(),
    importance: z.number().min(0).max(1).optional(),
    commitment_relevance: z.number().min(0).max(1).optional(),
    emotional_weight: z.number().min(0).max(1).optional(),
    risk_penalty: z.number().min(0).max(1).optional(),
  }).strict().default({}),
  model_or_classifier_version: z.string().min(1).nullable().default(null),
  reason: z.string().min(1).default("structured commitment classifier returned no extra reason"),
}).strict();
export type CommitmentCandidateExtraction = z.infer<typeof CommitmentCandidateExtractionSchema>;

export interface CommitmentCandidateClassifierInput {
  text: string;
  turnId: string;
  sessionId: string;
  routeKind: string;
  startedAt: string;
  policyEpoch: string;
  openCommitments?: Array<{
    commitmentId: string;
    summary: string;
    materializationState: CommitmentCareLifecycle;
    dueWindowStart?: string | null;
    dueWindowEnd?: string | null;
    updatedAt: string;
  }>;
  locale?: string | null;
}

export interface CommitmentCandidateClassifier {
  classify(input: CommitmentCandidateClassifierInput): Promise<CommitmentCandidateExtraction>;
}

export class StructuredCommitmentCandidateClassifier implements CommitmentCandidateClassifier {
  constructor(private readonly llmClient: Pick<ILLMClient, "sendMessage" | "parseJSON">) {}

  async classify(input: CommitmentCandidateClassifierInput): Promise<CommitmentCandidateExtraction> {
    const response = await this.llmClient.sendMessage([
      {
        role: "user",
        content: [
          "Classify the current chat message into a typed unresolved-intention candidate.",
          "Return only JSON matching this contract. Do not infer execution authority, memory writes, reminders, notifications, or tool actions.",
          "Use outcome none or unknown when the message lacks a current grounded user-owned intention, commitment, unresolved decision, completion, or correction.",
          "For completion, correction, or not_relevant, set target_commitment_id only to one of the provided open commitments when the current message explicitly resolves that current commitment. Do not guess or reuse stale previous targets.",
          "",
          `turn_id: ${input.turnId}`,
          `session_id: ${input.sessionId}`,
          `route_kind: ${input.routeKind}`,
          `started_at: ${input.startedAt}`,
          `policy_epoch: ${input.policyEpoch}`,
          `open_commitments: ${JSON.stringify(input.openCommitments ?? [])}`,
          `message: ${input.text}`,
        ].join("\n"),
      },
    ], {
      model_tier: "light",
      temperature: 0,
      max_tokens: 800,
      system: "You are a strict structured semantic boundary for PulSeed attention. Output JSON only.",
    });
    return CommitmentCandidateExtractionSchema.parse(
      this.llmClient.parseJSON(response.content, CommitmentCandidateExtractionSchema)
    );
  }
}

export function createCommitmentCandidate(input: {
  extraction: CommitmentCandidateExtraction;
  scope: AttentionScope;
  turnId: string;
  sessionId: string;
  sourceId: string;
  emittedAt: string;
  policyEpoch: string;
  activeSurfaceRef?: CompanionAutonomyRef | null;
}): CommitmentCandidate | null {
  const extraction = CommitmentCandidateExtractionSchema.parse(input.extraction);
  if (extraction.outcome !== "candidate" || !extraction.summary || extraction.confidence < 0.45) return null;
  const sourceRefValue = ref("user_activity", input.sourceId);
  const commitmentRef = ref("commitment", `chat:${input.sessionId}:${input.turnId}:${stableId(extraction.summary)}`);
  const source = sourceRef(sourceRefValue.kind, sourceRefValue.id);
  const lifecycle = initialCommitmentLifecycle(extraction);
  const priorityEvidence = buildCommitmentPriorityEvidence({
    evidenceId: `priority:${commitmentRef.id}`,
    source,
    target: commitmentRef,
    evaluatedAt: input.emittedAt,
    policyEpoch: input.policyEpoch,
    extraction,
  });
  const replayKey = `attention.commitment.candidate:${input.sessionId}:${input.turnId}:${stableId(extraction.summary)}`;

  return CommitmentCandidateSchema.parse({
    commitment_id: commitmentRef.id,
    source_ref: sourceRefValue,
    target_ref: commitmentRef,
    replay_key: replayKey,
    source_epoch: input.turnId,
    source_high_watermark: input.emittedAt,
    policy_epoch: input.policyEpoch,
    materialization_id: null,
    materialization_state: lifecycle,
    summary: extraction.summary,
    due: extraction.due ?? {
      window_start: null,
      window_end: null,
      uncertainty: "unknown",
      reason: "classifier did not identify a due window",
    },
    owner: extraction.owner,
    confidence: extraction.confidence,
    sensitivity: extraction.sensitivity,
    allowed_memory_use: extraction.allowed_memory_use,
    nudge_policy: extraction.nudge_policy,
    suppression_refs: [],
    feedback_refs: [],
    watch_vector: extraction.watch_vector.length > 0 ? extraction.watch_vector : ["related_conversation"],
    priority_evidence: priorityEvidence,
    scope: input.scope,
    next_revisit_at: extraction.due?.window_start ?? extraction.due?.window_end ?? null,
    created_at: input.emittedAt,
    updated_at: input.emittedAt,
    audit_refs: [
      { kind: "chat_turn", id: input.turnId },
      ...(input.activeSurfaceRef ? [{ kind: input.activeSurfaceRef.kind, id: input.activeSurfaceRef.id }] : []),
    ],
  });
}

export function createCommitmentAttentionInput(input: {
  candidate: CommitmentCandidate;
  emittedAt?: string;
  replayKey?: string;
  payloadClass?: string;
  summary?: string;
}): AttentionInput {
  const emittedAt = input.emittedAt ?? input.candidate.updated_at;
  return createAttentionInput({
    source_kind: "gateway_user_activity",
    source_id: input.candidate.source_ref.id,
    source_epoch: input.candidate.source_epoch,
    high_watermark: input.candidate.source_high_watermark,
    emitted_at: emittedAt,
    payload_class: input.payloadClass ?? "attention.commitment.candidate.shadow",
    summary: input.summary ?? "Chat turn produced a held unresolved-intention attention candidate.",
    signal_ref: ref("user_activity", input.candidate.source_ref.id),
    signal_source: "user_activity",
    replay_key: input.replayKey ?? input.candidate.replay_key,
    effect_policy: {
      wake: true,
      notify: false,
      speak: false,
      act: false,
    },
    current_session_refs: [ref("session", input.candidate.scope.sessionId ?? input.candidate.source_epoch)],
    user_activity_refs: [ref("user_activity", input.candidate.source_ref.id)],
    audit_refs: [
      ref("audit_trace", `attention.commitment.candidate:${input.candidate.commitment_id}`),
    ],
  });
}

export function commitmentCandidateToUrge(input: {
  candidate: CommitmentCandidate;
  attentionInput?: AttentionInput;
  now: string;
}): UrgeCandidate {
  const attentionInput = input.attentionInput ?? createCommitmentAttentionInput({
    candidate: input.candidate,
    emittedAt: input.now,
  });
  const signalContext = assembleSignalContext({
    signal_context_id: `signal:commitment:${stableId(`${input.candidate.commitment_id}:${input.now}`)}`,
    assembled_at: input.now,
    signals: [
      {
        source: "user_activity",
        ref: ref("user_activity", input.candidate.source_ref.id),
      },
    ],
    current_session_refs: attentionInput.current_session_refs,
    user_activity_refs: attentionInput.user_activity_refs,
    audit_refs: attentionInput.audit_refs,
  });
  const urgency = urgencyForPriorityEvidence(input.candidate.priority_evidence);
  const visibleSuppressed = visibleDeliverySuppressed(input.candidate);

  return createUrgeCandidate({
    urge_id: `urge:commitment:${stableId(`${input.candidate.commitment_id}:${input.candidate.materialization_state}`)}`,
    signal_context: signalContext,
    origin: "user_pattern",
    target: ref("commitment", input.candidate.commitment_id),
    feeling: input.candidate.materialization_state === "stale" ? "staleness_pressure" : "repair_pressure",
    subject: input.candidate.summary,
    strength: priorityStrength(input.candidate.priority_evidence),
    confidence: input.candidate.confidence,
    urgency,
    expected_user_benefit: "PulSeed can keep this unresolved intention in attention without creating a task or reminder directly.",
    user_cost: {
      level: visibleSuppressed ? "medium" : "low",
      reason: visibleSuppressed
        ? "current load, feedback, or nudge policy suppresses visible delivery"
        : "commitment candidate remains internal before admission",
      evidence_refs: [sourceRef("user_activity", input.candidate.source_ref.id)],
    },
    relationship_risk: {
      level: input.candidate.sensitivity === "restricted" ? "high" : "low",
      reason: "relationship risk follows candidate sensitivity and nudge policy",
      evidence_refs: [sourceRef("user_activity", input.candidate.source_ref.id)],
    },
    side_effect_risk: {
      level: "none",
      reason: "commitment guard urge has no execution or memory-write authority",
      evidence_refs: [sourceRef("user_activity", input.candidate.source_ref.id)],
    },
    sensitivity: input.candidate.sensitivity,
    allowed_moves: visibleSuppressed ? ["watch", "hold"] : ["watch", "hold", "prepare"],
    forbidden_moves: visibleSuppressed ? ["ask", "speak", "external_side_effect"] : ["external_side_effect"],
    maturation_state: maturationForCommitment(input.candidate),
    expires_at: input.candidate.materialization_state === "stale" ? input.now : undefined,
    scope: input.candidate.scope,
    signalRefs: [sourceRef("user_activity", input.candidate.source_ref.id)],
    structuredRefs: [
      { ref: ref("commitment", input.candidate.commitment_id), relation: "about", strength: 1 },
      { ref: ref("user_activity", input.candidate.source_ref.id), relation: "caused_by", strength: 1 },
    ],
    evidenceStrength: input.candidate.confidence >= 0.75 ? "strong" : "moderate",
    uncertainty: Number((1 - input.candidate.confidence).toFixed(4)),
    policyEpoch: input.candidate.policy_epoch,
    priority_evidence: input.candidate.priority_evidence,
    modelOrClassifierVersion: "commitment-candidate-contract-v1",
    replayableInputRefs: [ref("commitment", input.candidate.commitment_id)],
    audit_refs: [ref("audit_trace", `attention.commitment.urge:${input.candidate.commitment_id}`)],
  });
}

export type CommitmentReemissionTriggerKind =
  | "revisit_window"
  | "related_conversation"
  | "no_progress"
  | "feedback_cooldown"
  | "completion"
  | "correction";

export function buildCommitmentReemissionInput(input: {
  candidate: CommitmentCandidate;
  triggerKind: CommitmentReemissionTriggerKind;
  now: string;
  windowKey?: string;
  relatedRefs?: CompanionAutonomyRef[];
}): AttentionInput | null {
  if (!canReemitCommitment(input.candidate, input.triggerKind, input.now)) return null;
  const windowKey = input.windowKey ?? input.candidate.next_revisit_at ?? input.now;
  const replayKey = [
    "attention.commitment.reemit",
    input.candidate.source_ref.id,
    input.candidate.target_ref.id,
    input.triggerKind,
    input.candidate.policy_epoch,
    windowKey,
  ].join(":");

  return createAttentionInput({
    source_kind: "runtime_event",
    source_id: `commitment-reemit:${input.candidate.commitment_id}:${input.triggerKind}`,
    source_epoch: input.candidate.source_epoch,
    high_watermark: windowKey,
    emitted_at: input.now,
    payload_class: `attention.commitment.reemit.${input.triggerKind}`,
    summary: "Watched commitment re-entered attention through a typed trigger.",
    signal_ref: ref("runtime_event", `commitment-reemit:${input.candidate.commitment_id}:${input.triggerKind}`),
    signal_source: "runtime_event",
    replay_key: replayKey,
    effect_policy: {
      wake: true,
      notify: false,
      speak: false,
      act: false,
    },
    current_session_refs: [ref("session", input.candidate.scope.sessionId ?? input.candidate.source_epoch)],
    user_activity_refs: [ref("user_activity", input.candidate.source_ref.id)],
    runtime_state_refs: [ref("runtime_event", `commitment-reemit:${input.candidate.commitment_id}:${input.triggerKind}`)],
    audit_refs: [ref("audit_trace", `attention.commitment.reemit:${input.candidate.commitment_id}:${input.triggerKind}`)],
    stale_refs: input.candidate.materialization_state === "stale"
      ? [ref("commitment", input.candidate.commitment_id)]
      : [],
    invalidation_refs: input.triggerKind === "completion" || input.triggerKind === "correction"
      ? [ref("commitment", input.candidate.commitment_id)]
      : [],
  });
}

export function applyCommitmentLifecycleControl(input: {
  candidate: CommitmentCandidate;
  control: CommitmentLifecycleControl;
  now: string;
  feedbackRef?: string | null;
  snoozeUntil?: string | null;
  reason?: string;
}): CommitmentCandidate {
  const candidate = CommitmentCandidateSchema.parse(input.candidate);
  const feedbackRefs = input.feedbackRef ? [...candidate.feedback_refs, input.feedbackRef] : candidate.feedback_refs;
  const common = {
    ...candidate,
    feedback_refs: feedbackRefs,
    updated_at: input.now,
  };
  switch (input.control) {
    case "already_done":
      return CommitmentCandidateSchema.parse({
        ...common,
        materialization_state: "resolved",
        next_revisit_at: null,
      });
    case "not_relevant":
    case "dismiss":
      return CommitmentCandidateSchema.parse({
        ...common,
        materialization_state: input.control === "not_relevant" ? "rejected" : "quieted",
        next_revisit_at: null,
      });
    case "stop_reminders_like_this":
      return CommitmentCandidateSchema.parse({
        ...common,
        materialization_state: "quieted",
        nudge_policy: "disabled",
        suppression_refs: [...candidate.suppression_refs, input.feedbackRef ?? `suppression:${stableId(`${candidate.commitment_id}:${input.now}`)}`],
        next_revisit_at: null,
      });
    case "snooze":
      return CommitmentCandidateSchema.parse({
        ...common,
        materialization_state: "snoozed",
        next_revisit_at: input.snoozeUntil ?? candidate.next_revisit_at ?? input.now,
      });
    case "correct_memory_source":
      return CommitmentCandidateSchema.parse({
        ...common,
        materialization_state: "tombstoned",
        next_revisit_at: null,
        suppression_refs: [...candidate.suppression_refs, input.feedbackRef ?? `tombstone:${stableId(`${candidate.commitment_id}:${input.now}`)}`],
      });
    case "show_why":
      return candidate;
  }
}

export function projectCommitmentWhyNowForNormalSurface(candidate: CommitmentCandidate): string {
  const evidence = candidate.priority_evidence.components;
  const reasons = [
    evidence.urgency.score > 0 ? evidence.urgency.reason : null,
    evidence.commitment_relevance.score > 0 ? evidence.commitment_relevance.reason : null,
    evidence.interruptibility_penalty.score > 0 ? "I would keep this low-pressure because the current context raises interruption cost." : null,
    evidence.recent_nudge_penalty.score > 0 ? "Recent feedback makes this better suited for holding or digest." : null,
  ].filter((reason): reason is string => !!reason);
  return reasons.slice(0, 2).join(" ") || "This is held as a lightweight attention item because it may still matter later.";
}

function buildCommitmentPriorityEvidence(input: {
  evidenceId: string;
  source: CompanionAutonomySourceRef;
  target: CompanionAutonomyRef;
  evaluatedAt: string;
  policyEpoch: string;
  extraction: CommitmentCandidateExtraction;
}): AttentionPriorityEvidence {
  const overrides = input.extraction.priority_evidence_overrides;
  const highLoadPenalty = input.extraction.user_state.high_load || input.extraction.user_state.tired ? 0.75 : 0;
  const recentNudgePenalty = input.extraction.user_state.overreach_feedback ? 0.85 : 0;
  const riskPenalty = overrides.risk_penalty ?? (
    input.extraction.confidence < 0.6 || input.extraction.owner !== "user" ? 0.65 : 0.15
  );
  const components = {
    urgency: component(overrides.urgency ?? urgencyScore(input.extraction), [input.source], urgencyReason(input.extraction)),
    importance: component(overrides.importance ?? 0.45, [input.source], "candidate importance comes from current typed user-turn evidence"),
    commitment_relevance: component(overrides.commitment_relevance ?? 0.78, [input.source], "classifier identified an unresolved intention candidate"),
    emotional_weight: component(overrides.emotional_weight ?? (input.extraction.user_state.tired ? 0.65 : 0.2), [input.source], "typed user-state evidence affects interruption cost"),
    novelty: component(0.7, [input.source], "candidate is new for this source replay key"),
    recency: component(0.9, [input.source], "candidate came from the current chat turn"),
    interruptibility_penalty: component(highLoadPenalty, [input.source], highLoadPenalty > 0 ? "current user load suggests holding visible delivery" : "no typed high-load penalty"),
    recent_nudge_penalty: component(recentNudgePenalty, [input.source], recentNudgePenalty > 0 ? "recent overreach feedback suppresses visible delivery" : "no recent overreach feedback"),
    risk_penalty: component(riskPenalty, [input.source], "risk penalty follows ambiguity, owner, confidence, and sensitivity"),
    confidence: component(input.extraction.confidence, [input.source], "structured classifier confidence"),
  };
  const positive = (
    components.urgency.score
    + components.importance.score
    + components.commitment_relevance.score
    + components.emotional_weight.score
    + components.novelty.score
    + components.recency.score
    + components.confidence.score
  ) / 7;
  const penalty = Math.max(
    components.interruptibility_penalty.score,
    components.recent_nudge_penalty.score,
    components.risk_penalty.score,
  );
  const totalScore = Math.max(0, Math.min(1, Number((positive - penalty * 0.45).toFixed(4))));
  return AttentionPriorityEvidenceSchema.parse({
    evidence_id: input.evidenceId,
    source_ref: input.source,
    target_ref: input.target,
    evaluated_at: input.evaluatedAt,
    policy_epoch: input.policyEpoch,
    components,
    total_score: totalScore,
    rank_bucket: rankBucket(totalScore, penalty),
    audit_refs: [input.target],
  });
}

function component(
  score: number,
  refs: CompanionAutonomySourceRef[],
  reason: string,
): AttentionPriorityEvidenceComponent {
  return {
    score: Math.max(0, Math.min(1, Number(score.toFixed(4)))),
    refs,
    reason,
  };
}

function urgencyScore(extraction: CommitmentCandidateExtraction): number {
  if (extraction.due?.window_start || extraction.due?.window_end) {
    return extraction.due.uncertainty === "high" || extraction.due.uncertainty === "unknown" ? 0.52 : 0.72;
  }
  return 0.18;
}

function urgencyReason(extraction: CommitmentCandidateExtraction): string {
  if (extraction.due?.window_start || extraction.due?.window_end) {
    return `candidate has a revisit window with ${extraction.due.uncertainty} uncertainty`;
  }
  return "candidate has no due window and should not become an urgent reminder";
}

function initialCommitmentLifecycle(extraction: CommitmentCandidateExtraction): CommitmentCareLifecycle {
  if (extraction.user_state.high_load || extraction.user_state.tired || extraction.user_state.overreach_feedback) {
    return "shadow_held";
  }
  if (extraction.nudge_policy === "disabled" || extraction.confidence < 0.6) return "shadow_held";
  if (extraction.nudge_policy === "ask_first") return "ask_confirmation";
  return "watching";
}

function visibleDeliverySuppressed(candidate: CommitmentCandidate): boolean {
  return candidate.materialization_state === "shadow_held"
    || candidate.materialization_state === "quieted"
    || candidate.materialization_state === "snoozed"
    || candidate.nudge_policy === "disabled"
    || candidate.priority_evidence.components.interruptibility_penalty.score >= 0.7
    || candidate.priority_evidence.components.recent_nudge_penalty.score >= 0.7
    || candidate.priority_evidence.components.risk_penalty.score >= 0.75;
}

function priorityStrength(evidence: AttentionPriorityEvidence): number {
  return evidence.total_score ?? evidence.components.commitment_relevance.score;
}

function urgencyForPriorityEvidence(evidence: AttentionPriorityEvidence): AttentionPriority {
  if (evidence.components.risk_penalty.score >= 0.8 || evidence.rank_bucket === "hold") return "low";
  const score = evidence.components.urgency.score;
  if (score >= 0.85) return "critical";
  if (score >= 0.65) return "high";
  if (score >= 0.35) return "normal";
  return "low";
}

function maturationForCommitment(candidate: CommitmentCandidate): "new" | "warming" | "held" | "mature" | "suppressed" | "expired" | "rejected_stale" {
  switch (candidate.materialization_state) {
    case "candidate":
      return "new";
    case "shadow_held":
    case "ask_confirmation":
    case "watching":
    case "snoozed":
      return "held";
    case "active_care":
      return "mature";
    case "quieted":
      return "suppressed";
    case "resolved":
    case "rejected":
    case "tombstoned":
      return "expired";
    case "stale":
      return "rejected_stale";
  }
}

function canReemitCommitment(
  candidate: CommitmentCandidate,
  triggerKind: CommitmentReemissionTriggerKind,
  now: string,
): boolean {
  if (["resolved", "rejected", "tombstoned"].includes(candidate.materialization_state)) return false;
  if (candidate.materialization_state === "quieted" && triggerKind !== "feedback_cooldown") return false;
  if (candidate.materialization_state === "snoozed" && candidate.next_revisit_at && candidate.next_revisit_at > now) return false;
  if (triggerKind === "revisit_window") {
    return Boolean(candidate.next_revisit_at && candidate.next_revisit_at <= now);
  }
  return true;
}

function rankBucket(totalScore: number, penalty: number): AttentionPriorityEvidence["rank_bucket"] {
  if (penalty >= 0.8) return "hold";
  if (totalScore >= 0.7) return "high";
  if (totalScore >= 0.4) return "normal";
  if (totalScore > 0) return "low";
  return "trace_only";
}
