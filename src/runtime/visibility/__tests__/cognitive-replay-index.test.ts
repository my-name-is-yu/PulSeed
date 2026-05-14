import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCognitionReplayRecord,
} from "../../cognition/index.js";
import {
  CognitiveReplayIndexEntrySchema,
  CognitiveReplayInspectionViewSchema,
  FileCognitiveReplayIndexStore,
  createCognitiveReplayIndexEntry,
  createCognitiveReplayInspectionView,
  defaultCognitiveReplayOwnerStore,
  refreshCognitiveReplayIndexEntriesForSourceInvalidation,
} from "../index.js";

const NOW = "2026-05-14T00:00:00.000Z";

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

describe("cognitive replay index", () => {
  it("maps cognition replay into owner-neutral refs without making cognition the physical owner", () => {
    const record = createCognitionReplayRecord({
      recordId: "cognition:chat:1:replay",
      createdAt: NOW,
      input: {
        cognition_id: "cognition:chat:1",
        caller_path: "chat_user_turn",
        event_refs: [eventRef()],
      },
      failure: { message: "stable output intentionally absent in index contract test" },
    });

    const entry = createCognitiveReplayIndexEntry({
      indexEntryId: "index:cognition:chat:1",
      record,
    });

    expect(entry).toMatchObject({
      caller_path: "chat_user_turn",
      owner_store: "chat_history",
      cognition_replay_ref: {
        source_store: "cognition_audit",
        redaction_policy: "metadata_only",
      },
      retention_policy: {
        materialized_content: false,
        refs_only: true,
        invalidates_on_source_tombstone: true,
      },
      normal_surface_visible: false,
      operator_inspectable: true,
      cognition_service_is_owner: false,
    });
    expect(defaultCognitiveReplayOwnerStore("resident_proactive_check")).toBe("attention_ledger");
  });

  it("fails closed when source refs are missing or deleted instead of leaving a replay entry valid", () => {
    const record = createCognitionReplayRecord({
      recordId: "cognition:task:1:replay",
      createdAt: NOW,
      input: {
        cognition_id: "cognition:task:1",
        caller_path: "long_running_task_turn",
        event_refs: [eventRef("runtime:event:task")],
      },
      failure: { message: "source later disappeared" },
    });

    const entry = createCognitiveReplayIndexEntry({
      indexEntryId: "index:cognition:task:1",
      record,
      sourceState: "missing_source",
      failClosedReason: "runtime operation source ref is unavailable",
    });

    expect(entry).toMatchObject({
      owner_store: "runtime_operation",
      source_state: "missing_source",
      invalidation_state: "failed_closed",
      redaction_policy: "redacted",
    });
    expect(() => CognitiveReplayIndexEntrySchema.parse({
      ...entry,
      invalidation_state: "valid",
    })).toThrow(/must invalidate or fail closed/);
  });

  it("refreshes affected replay index entries after source invalidation without materializing deleted content", () => {
    const sourceRef = eventRef("chat:event:corrected");
    const otherSourceRef = eventRef("chat:event:other");
    const affectedRecord = createCognitionReplayRecord({
      recordId: "cognition:chat:corrected:replay",
      createdAt: NOW,
      input: {
        cognition_id: "cognition:chat:corrected",
        caller_path: "chat_user_turn",
        event_refs: [sourceRef],
      },
      failure: { message: "stable output intentionally absent in refresh test" },
    });
    const unaffectedRecord = createCognitionReplayRecord({
      recordId: "cognition:chat:other:replay",
      createdAt: NOW,
      input: {
        cognition_id: "cognition:chat:other",
        caller_path: "chat_user_turn",
        event_refs: [otherSourceRef],
      },
      failure: { message: "stable output intentionally absent in refresh test" },
    });
    const affectedEntry = createCognitiveReplayIndexEntry({
      indexEntryId: "index:cognition:chat:corrected",
      record: affectedRecord,
    });
    const unaffectedEntry = createCognitiveReplayIndexEntry({
      indexEntryId: "index:cognition:chat:other",
      record: unaffectedRecord,
    });
    const invalidationRef = {
      ...eventRef("surface-invalidation:profile:corrected"),
      source_store: "profile" as const,
      source_event_type: "memory_correction",
    };

    const refreshed = refreshCognitiveReplayIndexEntriesForSourceInvalidation({
      indexEntries: [affectedEntry, unaffectedEntry],
      invalidatedSourceRefs: [sourceRef],
      invalidationRefs: [invalidationRef],
      sourceState: "deleted_or_tombstoned",
    });

    expect(refreshed[0]).toMatchObject({
      index_entry_id: "index:cognition:chat:corrected",
      source_state: "deleted_or_tombstoned",
      invalidation_state: "invalidated",
      invalidation_refs: [invalidationRef],
      redaction_policy: "redacted",
      normal_surface_visible: false,
      cognition_service_is_owner: false,
    });
    expect(refreshed[1]).toMatchObject({
      index_entry_id: "index:cognition:chat:other",
      source_state: "current",
      invalidation_state: "valid",
      redaction_policy: "metadata_only",
    });
  });

  it("defaults source invalidation refresh with dependencies to non-current redacted state", () => {
    const sourceRef = eventRef("chat:event:default-invalidated");
    const record = createCognitionReplayRecord({
      recordId: "cognition:chat:default-invalidated:replay",
      createdAt: NOW,
      input: {
        cognition_id: "cognition:chat:default-invalidated",
        caller_path: "chat_user_turn",
        event_refs: [sourceRef],
      },
      failure: { message: "stable output intentionally absent in default invalidation test" },
    });
    const entry = createCognitiveReplayIndexEntry({
      indexEntryId: "index:cognition:chat:default-invalidated",
      record,
    });
    const invalidationRef = {
      ...eventRef("surface-invalidation:default"),
      source_store: "profile" as const,
      source_event_type: "memory_correction",
    };

    const [refreshed] = refreshCognitiveReplayIndexEntriesForSourceInvalidation({
      indexEntries: [entry],
      invalidatedSourceRefs: [sourceRef],
      invalidationRefs: [invalidationRef],
    });

    expect(refreshed).toMatchObject({
      source_state: "deleted_or_tombstoned",
      invalidation_state: "invalidated",
      invalidation_refs: [invalidationRef],
      redaction_policy: "redacted",
    });
    expect(() => refreshCognitiveReplayIndexEntriesForSourceInvalidation({
      indexEntries: [entry],
      invalidatedSourceRefs: [sourceRef],
      invalidationRefs: [invalidationRef],
      sourceState: "current",
    })).toThrow(/cannot keep affected replay entries current/);
  });

  it("clears stale fail-closed reason when source invalidation dependency recovers", () => {
    const sourceRef = eventRef("chat:event:recover-invalidation");
    const record = createCognitionReplayRecord({
      recordId: "cognition:chat:recover-invalidation:replay",
      createdAt: NOW,
      input: {
        cognition_id: "cognition:chat:recover-invalidation",
        caller_path: "chat_user_turn",
        event_refs: [sourceRef],
      },
      failure: { message: "stable output intentionally absent in recovery invalidation test" },
    });
    const entry = createCognitiveReplayIndexEntry({
      indexEntryId: "index:cognition:chat:recover-invalidation",
      record,
    });
    const [failedClosed] = refreshCognitiveReplayIndexEntriesForSourceInvalidation({
      indexEntries: [entry],
      invalidatedSourceRefs: [sourceRef],
      failClosedReason: "invalidation dependency missing during first refresh",
    });
    const invalidationRef = {
      ...eventRef("surface-invalidation:recovered"),
      source_store: "profile" as const,
      source_event_type: "memory_correction",
    };

    const [recovered] = refreshCognitiveReplayIndexEntriesForSourceInvalidation({
      indexEntries: [failedClosed],
      invalidatedSourceRefs: [sourceRef],
      invalidationRefs: [invalidationRef],
    });

    expect(failedClosed).toMatchObject({
      invalidation_state: "failed_closed",
      fail_closed_reason: "invalidation dependency missing during first refresh",
    });
    expect(recovered).toMatchObject({
      source_state: "deleted_or_tombstoned",
      invalidation_state: "invalidated",
      invalidation_refs: [invalidationRef],
      redaction_policy: "redacted",
    });
    expect(recovered.fail_closed_reason).toBeUndefined();
    expect(() => CognitiveReplayIndexEntrySchema.parse({
      ...recovered,
      fail_closed_reason: "stale failure metadata",
    })).toThrow(/must be present only while replay invalidation is failed closed/);
  });

  it("fails closed when replay refresh sees an invalid source without an invalidation dependency", () => {
    const sourceRef = eventRef("chat:event:missing-invalidation");
    const record = createCognitionReplayRecord({
      recordId: "cognition:chat:missing-invalidation:replay",
      createdAt: NOW,
      input: {
        cognition_id: "cognition:chat:missing-invalidation",
        caller_path: "chat_user_turn",
        event_refs: [sourceRef],
      },
      failure: { message: "stable output intentionally absent in fail-closed refresh test" },
    });
    const entry = createCognitiveReplayIndexEntry({
      indexEntryId: "index:cognition:chat:missing-invalidation",
      record,
    });

    const [refreshed] = refreshCognitiveReplayIndexEntriesForSourceInvalidation({
      indexEntries: [entry],
      invalidatedSourceRefs: [sourceRef],
    });

    expect(refreshed).toMatchObject({
      source_state: "missing_source",
      invalidation_state: "failed_closed",
      invalidation_refs: [],
      fail_closed_reason: "source invalidation was observed without a complete invalidation dependency",
      redaction_policy: "redacted",
    });
  });

  it("rejects cognition audit as the owner store for caller-path replay entries", () => {
    const record = createCognitionReplayRecord({
      recordId: "cognition:resident:1:replay",
      createdAt: NOW,
      input: {
        cognition_id: "cognition:resident:1",
        caller_path: "resident_proactive_check",
        event_refs: [eventRef("attention:event:1")],
      },
      failure: { message: "resident replay test" },
    });
    const entry = createCognitiveReplayIndexEntry({
      indexEntryId: "index:cognition:resident:1",
      record,
    });

    expect(() => CognitiveReplayIndexEntrySchema.parse({
      ...entry,
      owner_store: "cognition_audit",
      owner_ref: {
        ...entry.owner_ref,
        source_store: "cognition_audit",
      },
    })).toThrow(/not valid for caller path/);
  });

  it("creates redacted inspection views that expose refs only to operator surfaces", () => {
    const event = eventRef();
    const record = createCognitionReplayRecord({
      recordId: "cognition:chat:inspect:replay",
      createdAt: NOW,
      input: {
        cognition_id: "cognition:chat:inspect",
        caller_path: "chat_user_turn",
        event_refs: [event],
      },
      output: {
        cognition_id: "cognition:chat:inspect",
        caller_path: "chat_user_turn",
        situation_model: {
          situation_id: "situation:inspect",
          summary_ref: event,
          caller_path: "chat_user_turn",
          tool_trace_refs: [],
          approval_refs: [],
          current_target_refs: [],
          stale_target_refs: [],
          protocol_bypass: false,
          confidence: 0.7,
        },
        relationship_state: {
          projection_id: "relationship:inspect",
          relationship_refs: [],
          withheld_memory_refs: [],
          conflict_refs: [],
          overreach_risk: "unknown",
          ordinary_surface_debug_visible: false,
        },
        selected_intention: null,
        response_plan: {
          plan_id: "response:inspect",
          guidance_kind: "continue_route",
          public_summary: "Continue route.",
          surface_target: "internal_audit",
          quieting_applied: false,
          operator_debug_refs: [],
          hidden_policy_state_visible_to_normal_user: false,
        },
        tool_candidates: [{
          candidate_id: "candidate:inspect",
          authority_stage: "suggest",
          expected_effect: "Suggest a safe operator review.",
          risk_class: "low",
          required_context_refs: [],
          required_authorization_refs: [],
          can_execute: false,
          may_execute: false,
          observability_refs: [],
          failure_recovery_refs: [],
          failed_trace_requires_repair: false,
          memory_is_authority: false,
          model_text_is_authority: false,
        }],
        authorization_requests: [],
        memory_writeback: [],
        reflection_hints: [],
        audit_refs: [],
        uncertainty: [],
      },
    });
    const entry = createCognitiveReplayIndexEntry({
      indexEntryId: "index:inspect",
      record,
    });
    const operatorView = createCognitiveReplayInspectionView({
      viewId: "view:operator",
      surfaceTarget: "operator_debug",
      indexEntries: [entry],
      replayRecords: [record],
    });
    const normalView = createCognitiveReplayInspectionView({
      viewId: "view:normal",
      surfaceTarget: "normal_user",
      indexEntries: [entry],
      replayRecords: [record],
    });

    expect(operatorView.items[0]).toMatchObject({
      debug_refs_visible: true,
      source_refs: [event],
      response_plan_ref: { kind: "response_plan", ref: "response:inspect" },
      tool_authority_stages: ["suggest"],
      raw_content_visible: false,
    });
    expect(normalView).toMatchObject({
      normal_surface_debug_visible: false,
      raw_memory_visible: false,
      raw_prompt_visible: false,
      items: [{
        debug_refs_visible: false,
        source_refs: [],
      }],
    });
    expect(() => CognitiveReplayInspectionViewSchema.parse({
      ...normalView,
      items: [{ ...normalView.items[0], debug_refs_visible: true }],
    })).toThrow(/normal user replay inspection/);
  });

  it("serializes concurrent index upserts so replay entries are not lost", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-cognitive-replay-index-concurrent-"));
    const store = new FileCognitiveReplayIndexStore(baseDir);
    const entries = Array.from({ length: 16 }, (_, index) => {
      const record = createCognitionReplayRecord({
        recordId: `cognition:task:${index}:attempt:${index}:replay`,
        createdAt: NOW,
        input: {
          cognition_id: `cognition:task:${index}:attempt:${index}`,
          caller_path: "long_running_task_turn",
          event_refs: [eventRef(`runtime:event:${index}`)],
        },
        failure: { message: "stable output intentionally absent in replay index concurrency test" },
      });
      return createCognitiveReplayIndexEntry({
        indexEntryId: `${record.record_id}:index`,
        record,
      });
    });

    await Promise.all(entries.map((entry) => store.upsert(entry)));

    expect((await store.list()).map((entry) => entry.index_entry_id).sort()).toEqual(
      entries.map((entry) => entry.index_entry_id).sort(),
    );
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
});
