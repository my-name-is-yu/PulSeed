import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createReflectionInputFromCognitionReplay,
  createCognitionReplayRecord,
  type MemoryWritebackProposal,
} from "../../runtime/cognition/index.js";
import {
  CognitionWritebackQueueEntrySchema,
  FileCognitionWritebackQueueStore,
  createCognitionWritebackQueueEntry,
  decideCognitionWritebackQueueEntry,
  evaluateCognitionWritebackReflectionInput,
  ownerForWritebackProposal,
} from "../index.js";

const NOW = "2026-05-14T00:00:00.000Z";
let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function eventRef(ref = "chat:event:1") {
  return {
    ref,
    source_store: "chat_history" as const,
    source_event_type: "user_input",
    schema_version: 1,
    source_epoch: "turn:1",
    redaction_policy: "metadata_only" as const,
  };
}

function proposal(input: Partial<MemoryWritebackProposal> = {}): MemoryWritebackProposal {
  return {
    proposal_id: "writeback:episode:1",
    proposal_kind: "episode",
    source_event_refs: [eventRef()],
    proposed_target: "dream",
    admission_state: "pending_review",
    auto_apply: false,
    source_content_materialized: false,
    ...input,
  };
}

describe("cognition writeback queue", () => {
  it("routes cognition proposals to owners without writing owner memory directly", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "pulseed-cognition-writeback-"));
    const entry = createCognitionWritebackQueueEntry({
      queueEntryId: "queue:writeback:1",
      proposal: proposal(),
      createdAt: NOW,
    });
    const ready = decideCognitionWritebackQueueEntry({
      entry,
      decidedAt: "2026-05-14T00:01:00.000Z",
      decision: {
        kind: "ready_for_owner_review",
        reason: "source refs are current",
      },
    });
    const store = new FileCognitionWritebackQueueStore(tempDir);
    await store.enqueue(ready);

    expect(await store.list()).toMatchObject([{
      owner: "dream",
      state: "ready_for_owner_review",
      review_required: true,
      owner_write_performed: false,
      runtime_authority: false,
    }]);
  });

  it("does not let replay reprocessing erase an owner decision", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "pulseed-cognition-writeback-"));
    const store = new FileCognitionWritebackQueueStore(tempDir);
    const ready = decideCognitionWritebackQueueEntry({
      entry: createCognitionWritebackQueueEntry({
        queueEntryId: "queue:writeback:stable",
        proposal: proposal(),
        createdAt: NOW,
      }),
      decidedAt: "2026-05-14T00:01:00.000Z",
      decision: {
        kind: "ready_for_owner_review",
        reason: "source refs are current",
      },
    });
    await store.enqueue(ready);
    const accepted = decideCognitionWritebackQueueEntry({
      entry: ready,
      decidedAt: "2026-05-14T00:02:00.000Z",
      decision: {
        kind: "accepted_by_owner",
        reason: "dream owner accepted the writeback",
        ownerDecisionRef: { kind: "dream_decision", ref: "dream:accepted:1" },
      },
    });
    await store.update(accepted);

    const replayedReady = decideCognitionWritebackQueueEntry({
      entry: createCognitionWritebackQueueEntry({
        queueEntryId: "queue:writeback:stable",
        proposal: proposal(),
        createdAt: "2026-05-14T00:03:00.000Z",
      }),
      decidedAt: "2026-05-14T00:03:00.000Z",
      decision: {
        kind: "ready_for_owner_review",
        reason: "same replay record was consolidated again",
      },
    });
    const returned = await store.enqueue(replayedReady);

    expect(returned).toMatchObject({
      state: "accepted_by_owner",
      owner_decision_ref: { kind: "dream_decision", ref: "dream:accepted:1" },
    });
    expect(await store.list()).toMatchObject([{
      state: "accepted_by_owner",
      owner_decision_ref: { kind: "dream_decision", ref: "dream:accepted:1" },
      audit_events: [
        expect.objectContaining({ kind: "queued" }),
        expect.objectContaining({ kind: "revalidated" }),
        expect.objectContaining({ kind: "accepted_by_owner" }),
      ],
    }]);
  });

  it("blocks deleted or missing sources before owner acceptance", () => {
    const blocked = createCognitionWritebackQueueEntry({
      queueEntryId: "queue:writeback:blocked",
      proposal: proposal(),
      createdAt: NOW,
      sourceState: "deleted_or_tombstoned",
      invalidationRefs: [eventRef("chat:event:deleted")],
    });

    expect(blocked.state).toBe("blocked_source_invalid");
    expect(() => CognitionWritebackQueueEntrySchema.parse({
      ...blocked,
      state: "accepted_by_owner",
      owner_decision_ref: { kind: "profile_decision", ref: "profile:accept" },
    })).toThrow(/must block owner acceptance/);
  });

  it("evaluates replay writeback inputs deterministically from typed proposal fields", () => {
    const record = createCognitionReplayRecord({
      recordId: "replay:writeback:1",
      createdAt: NOW,
      input: {
        cognition_id: "cognition:chat:1",
        caller_path: "chat_user_turn",
        event_refs: [eventRef()],
      },
      output: {
        cognition_id: "cognition:chat:1",
        caller_path: "chat_user_turn",
        situation_model: {
          situation_id: "situation:1",
          summary_ref: eventRef(),
          caller_path: "chat_user_turn",
          tool_trace_refs: [],
          approval_refs: [],
          current_target_refs: [],
          stale_target_refs: [],
          protocol_bypass: false,
          confidence: 0.7,
        },
        relationship_state: {
          projection_id: "relationship:1",
          relationship_refs: [],
          withheld_memory_refs: [],
          conflict_refs: [],
          overreach_risk: "unknown",
          ordinary_surface_debug_visible: false,
        },
        selected_intention: null,
        response_plan: {
          plan_id: "response:1",
          guidance_kind: "continue_route",
          public_summary: "Continue route.",
          surface_target: "internal_audit",
          quieting_applied: false,
          operator_debug_refs: [],
          hidden_policy_state_visible_to_normal_user: false,
        },
        tool_candidates: [],
        authorization_requests: [],
        memory_writeback: [proposal({
          proposal_id: "writeback:profile:1",
          proposal_kind: "relationship_profile_candidate",
          proposed_target: "profile",
        })],
        reflection_hints: [],
        audit_refs: [],
        uncertainty: [],
      },
    });
    const input = createReflectionInputFromCognitionReplay({
      inputId: "reflection:cognition:1",
      record,
    });
    const entries = evaluateCognitionWritebackReflectionInput({
      reflectionInput: input,
      evaluatedAt: NOW,
    });

    expect(entries).toMatchObject([{
      owner: "profile",
      state: "ready_for_owner_review",
      owner_write_performed: false,
    }]);
  });

  it("routes procedural proposals to procedural owner review instead of reflection memory writes", () => {
    expect(ownerForWritebackProposal(proposal({
      proposal_kind: "procedural_skill_candidate",
      proposed_target: "reflection",
    }))).toBe("procedural");
  });
});
