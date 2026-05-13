import { describe, expect, it } from "vitest";
import {
  createCognitionReplayRecord,
} from "../../cognition/index.js";
import {
  CognitiveReplayIndexEntrySchema,
  createCognitiveReplayIndexEntry,
  defaultCognitiveReplayOwnerStore,
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
});
