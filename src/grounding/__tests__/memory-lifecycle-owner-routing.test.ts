import { describe, expect, it } from "vitest";
import {
  createFeedbackIngestion,
} from "../../runtime/attention/index.js";
import type {
  MemoryWritebackProposal,
} from "../../runtime/cognition/index.js";
import {
  createProceduralMemoryCandidate,
} from "../../platform/dream/procedural-memory.js";
import {
  GovernedMemorySchema,
} from "../../platform/profile/governed-memory.js";
import {
  createCognitionWritebackQueueEntry,
  decideCognitionWritebackQueueEntry,
} from "../../reflection/index.js";
import {
  createMemoryLifecycleEnvelopeFromAttentionFeedbackEffect,
  createMemoryLifecycleEnvelopeFromCognitionReplayIndexEntry,
  createMemoryLifecycleEnvelopeFromGovernedMemory,
  createMemoryLifecycleEnvelopeFromProceduralMemory,
  createMemoryLifecycleEnvelopeFromWritebackQueueEntry,
  createMemoryLifecycleReviewInbox,
  MemoryLifecycleEnvelopeSchema,
  ownerRoutingRuleForProposal,
} from "../memory-lifecycle-owner-routing.js";

const NOW = "2026-05-14T00:00:00.000Z";

describe("memory lifecycle owner routing", () => {
  it("projects governed memory as an accepted owner record with governed lifecycle kept separate", () => {
    const memory = governedMemory();
    const envelope = createMemoryLifecycleEnvelopeFromGovernedMemory({
      memory,
      sourceEventRefs: [eventRef("profile:source:1", "profile", "relationship_profile")],
    });

    expect(envelope).toMatchObject({
      owner_ref: {
        kind: "governed_memory",
        owner_ref: {
          kind: "relationship_profile",
          record_ref: "profile:1",
        },
      },
      governed_shape: {
        record_kind: "preference",
        role: "relationship",
      },
      lifecycle_stage: "projected",
      governed_lifecycle: "active",
      correction_state: "current",
      review_state: "accepted",
    });
  });

  it("routes writeback queue entries to owner review without auto-apply or direct owner writes", () => {
    const proposal = writebackProposal({
      proposal_kind: "relationship_profile_candidate",
      proposed_target: "profile",
    });
    const queued = createCognitionWritebackQueueEntry({
      queueEntryId: "queue:profile:1",
      proposal,
      createdAt: NOW,
    });
    const reviewReady = decideCognitionWritebackQueueEntry({
      entry: queued,
      decision: { kind: "ready_for_owner_review", reason: "source refs are current" },
      decidedAt: NOW,
    });
    const accepted = decideCognitionWritebackQueueEntry({
      entry: reviewReady,
      decision: {
        kind: "accepted_by_owner",
        reason: "profile owner accepted candidate",
        ownerDecisionRef: { kind: "profile_owner_decision", ref: "decision:profile:1" },
      },
      decidedAt: "2026-05-14T00:01:00.000Z",
    });

    expect(ownerRoutingRuleForProposal(proposal)).toMatchObject({
      canonical_owner: "profile",
      owner_review_required: true,
      cognition_is_owner: false,
    });
    const reviewReadyEnvelope = createMemoryLifecycleEnvelopeFromWritebackQueueEntry(reviewReady);
    expect(reviewReadyEnvelope).toMatchObject({
      owner_ref: {
        kind: "writeback_queue",
        owner: "profile",
      },
      lifecycle_stage: "owner_review",
      review_state: "pending_owner_review",
      allowed_uses: ["memory_write_candidate"],
    });
    expect(reviewReadyEnvelope.owner_decision_ref).toBeUndefined();
    expect(createMemoryLifecycleEnvelopeFromWritebackQueueEntry(accepted)).toMatchObject({
      lifecycle_stage: "accepted",
      review_state: "accepted",
      owner_decision_ref: { kind: "profile_owner_decision", ref: "decision:profile:1" },
    });
    expect(accepted).toMatchObject({
      proposal: {
        auto_apply: false,
        source_content_materialized: false,
      },
      owner_write_performed: false,
      runtime_authority: false,
    });
  });

  it("keeps replay, attention feedback, and procedural promotion refs out of GovernedMemoryLifecycle", () => {
    const replayEnvelope = createMemoryLifecycleEnvelopeFromCognitionReplayIndexEntry(replayIndexEntry());
    const feedback = createFeedbackIngestion({
      feedback_id: "feedback:surface-dismissed",
      source: "gateway",
      feedback_kind: "surface_dismissal",
      outcome: "dismissed",
      target: { kind: "surface", id: "telegram-thread" },
      recorded_at: NOW,
      reason: "User dismissed the proactive surface.",
      route: "express_to_user",
    });
    const attentionEffect = feedback.effects.find((effect) => effect.effect_kind === "attention_feedback");
    if (!attentionEffect) throw new Error("expected attention feedback effect");
    const feedbackEnvelope = createMemoryLifecycleEnvelopeFromAttentionFeedbackEffect({
      effect: attentionEffect,
      sourceEventRefs: [eventRef("feedback:surface-dismissed", "attention_ledger", "feedback_ingestion")],
    });
    const procedural = createProceduralMemoryCandidate({
      proceduralMemoryId: "procedural:repair:1",
      kind: "repair_recipe",
      title: "Retry only after verified repair evidence.",
      sourceTraceRefs: [eventRef("runtime:repair:trace", "runtime_operation", "repair_trace")],
      repairEvidenceRefs: [eventRef("runtime:repair:evidence", "runtime_operation", "repair_evidence")],
      confidence: 0.9,
      createdAt: NOW,
    });
    const proceduralEnvelope = createMemoryLifecycleEnvelopeFromProceduralMemory(procedural);

    expect(replayEnvelope).toMatchObject({
      owner_ref: { kind: "cognition_replay" },
      lifecycle_stage: "observed",
      allowed_uses: ["never_use_directly"],
    });
    expect(replayEnvelope.governed_lifecycle).toBeUndefined();
    expect(feedbackEnvelope).toMatchObject({
      owner_ref: {
        kind: "attention_feedback",
        feedback_ref: { kind: "feedback", ref: "feedback:surface-dismissed" },
      },
      lifecycle_stage: "accepted",
      allowed_uses: ["attention_prioritization", "behavioral_inhibition"],
    });
    expect(feedbackEnvelope.governed_lifecycle).toBeUndefined();
    expect(proceduralEnvelope).toMatchObject({
      owner_ref: {
        kind: "procedural_promotion",
        promotion_ref: { kind: "procedural_memory", ref: "procedural:repair:1" },
      },
      lifecycle_stage: "owner_review",
      review_state: "pending_owner_review",
      allowed_uses: ["never_use_directly"],
    });
    expect(proceduralEnvelope.governed_lifecycle).toBeUndefined();
    expect(() => MemoryLifecycleEnvelopeSchema.parse({
      ...replayEnvelope,
      governed_lifecycle: "active",
    })).toThrow(/must not pretend/);
  });

  it("builds one read-only review inbox with owner-specific actions and no raw hidden content", () => {
    const profileEnvelope = createMemoryLifecycleEnvelopeFromWritebackQueueEntry(createCognitionWritebackQueueEntry({
      queueEntryId: "queue:profile:review",
      proposal: writebackProposal({
        proposal_id: "proposal:profile:review",
        proposal_kind: "relationship_profile_candidate",
        proposed_target: "profile",
      }),
      createdAt: NOW,
    }));
    const blockedKnowledgeEnvelope = createMemoryLifecycleEnvelopeFromWritebackQueueEntry(createCognitionWritebackQueueEntry({
      queueEntryId: "queue:knowledge:blocked",
      proposal: writebackProposal({
        proposal_id: "proposal:knowledge:blocked",
        proposal_kind: "soil_record_candidate",
        proposed_target: "knowledge",
      }),
      createdAt: NOW,
      sourceState: "deleted_or_tombstoned",
      invalidationRefs: [eventRef("source:deleted", "knowledge", "memory_deletion")],
    }));
    const proceduralEnvelope = createMemoryLifecycleEnvelopeFromProceduralMemory(createProceduralMemoryCandidate({
      proceduralMemoryId: "procedural:playbook:review",
      kind: "playbook",
      title: "Use only as a planning hint.",
      sourceTraceRefs: [eventRef("runtime:success:trace", "runtime_operation", "successful_run")],
      confidence: 0.8,
      createdAt: NOW,
    }));
    const inbox = createMemoryLifecycleReviewInbox({
      inboxId: "memory-lifecycle-review:test",
      generatedAt: NOW,
      envelopes: [profileEnvelope, blockedKnowledgeEnvelope, proceduralEnvelope],
    });

    expect(inbox).toMatchObject({
      read_only: true,
      mutation_performed: false,
      items: [
        {
          item_kind: "profile_candidate",
          review_state: "pending_user_review",
          allowed_actions: ["accept", "edit", "reject", "suppress", "forget_source"],
          raw_content_visible: false,
          hidden_prompt_visible: false,
          sensitive_content_visible: false,
        },
        {
          item_kind: "correction_invalidation",
          review_state: "blocked_source_invalid",
          allowed_actions: ["request_source_review", "reject"],
          redaction_refs: [{ kind: "redaction", ref: "knowledge:source:deleted" }],
        },
        {
          item_kind: "dream_procedural_candidate",
          review_state: "pending_owner_review",
          allowed_actions: ["promote_as_planning_hint", "reject", "retire_old_hint"],
        },
      ],
    });
  });
});

function eventRef(
  ref: string,
  sourceStore: "profile" | "chat_history" | "knowledge" | "attention_ledger" | "runtime_operation" | "cognition_audit" = "chat_history",
  sourceEventType = "user_input",
) {
  return {
    ref,
    source_store: sourceStore,
    source_event_type: sourceEventType,
    schema_version: 1,
    source_epoch: `${sourceStore}:${ref}:epoch`,
    redaction_policy: "metadata_only" as const,
  };
}

function writebackProposal(overrides: Partial<MemoryWritebackProposal> = {}): MemoryWritebackProposal {
  return {
    proposal_id: "proposal:memory:1",
    proposal_kind: "relationship_profile_candidate" as const,
    source_event_refs: [eventRef("chat:event:1")],
    proposed_target: "profile" as const,
    admission_state: "pending_review" as const,
    user_visible_review_text: "Review this refs-only candidate.",
    auto_apply: false as const,
    source_content_materialized: false as const,
    ...overrides,
  };
}

function governedMemory() {
  return GovernedMemorySchema.parse({
    memory_id: "relationship-profile:profile:1",
    logical_key: "operator.status_style",
    owning_store_ref: {
      kind: "relationship_profile",
      store_ref: "relationship-profile",
      record_ref: "profile:1",
      schema_version: 1,
    },
    role: "relationship",
    record_kind: "preference",
    statement: "Prefer concise implementation status updates.",
    scope: "memory_retrieval",
    domain_fields: {
      target: "implementation updates",
      preference: "concise implementation status updates",
      confidence: 0.9,
      scope: "memory_retrieval",
      allowed_uses: ["runtime_grounding", "surface_projection"],
      review_condition: "user correction supersedes this item",
    },
    source_refs: [{
      kind: "user_instruction",
      ref: "setup:profile",
      observed_at: NOW,
      reliability: 1,
    }],
    content: {
      state: "materialized",
      text: "Prefer concise implementation status updates.",
    },
    epistemic_status: "explicit_user_instruction",
    confidence: 0.9,
    source_reliability: 1,
    sensitivity: "private",
    allowed_uses: ["runtime_grounding", "surface_projection"],
    not_allowed_uses: ["side_effect_authorization"],
    lifecycle: "active",
    correction_state: "current",
    projection_policy: {
      surface_eligible: true,
      requires_permission_gate: true,
      inspection_visibility: "visible",
      stale_behavior: "exclude",
    },
    supersedes_memory_ids: [],
    superseded_by_memory_id: null,
    correction_event_refs: [],
    audit_refs: [],
    created_at: NOW,
    updated_at: NOW,
  });
}

function replayIndexEntry() {
  return {
    schema_version: "cognitive-replay-index-entry/v1" as const,
    index_entry_id: "index:chat:1",
    caller_path: "chat_user_turn" as const,
    owner_store: "chat_history" as const,
    owner_ref: eventRef("chat:event:1"),
    cognition_replay_ref: eventRef("cognition:chat:1:replay", "cognition_audit", "cognition_replay_record"),
    created_at: NOW,
    source_refs: [eventRef("chat:event:1")],
    source_state: "current" as const,
    invalidation_state: "valid" as const,
    invalidation_refs: [],
    retention_policy: {
      materialized_content: false as const,
      refs_only: true as const,
      invalidates_on_source_tombstone: true as const,
    },
    redaction_policy: "metadata_only" as const,
    normal_surface_visible: false as const,
    operator_inspectable: true as const,
    cognition_service_is_owner: false as const,
  };
}
