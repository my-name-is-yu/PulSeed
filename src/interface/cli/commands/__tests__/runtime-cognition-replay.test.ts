import { describe, expect, it, vi } from "vitest";
import { StateManager } from "../../../../base/state/state-manager.js";
import {
  FileCognitionAuditSink,
  createCognitionReplayRecord,
  type CognitionSourceStore,
  type MemoryWritebackProposal,
} from "../../../../runtime/cognition/index.js";
import {
  FileCognitiveReplayIndexStore,
  createCognitiveReplayIndexEntry,
} from "../../../../runtime/visibility/index.js";
import {
  FileCognitionWritebackQueueStore,
  createCognitionWritebackQueueEntry,
} from "../../../../reflection/index.js";
import { cleanupTempDir, makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import { cmdRuntime } from "../runtime.js";

const NOW = "2026-05-14T00:00:00.000Z";
const RAW_PROMPT_SECRET = "RAW_PROMPT_SECRET_do_not_render";
const RAW_MEMORY_SECRET = "RAW_MEMORY_SECRET_do_not_render";
const SENSITIVE_REVIEW_SECRET = "SENSITIVE_REVIEW_SECRET_do_not_render";

function eventRef(ref = "chat:event:1", sourceStore: CognitionSourceStore = "chat_history") {
  return {
    ref,
    source_store: sourceStore,
    source_event_type: sourceStore === "profile" ? "relationship_profile" : "user_input",
    schema_version: 1,
    source_epoch: "turn:1",
    redaction_policy: "metadata_only" as const,
  };
}

function writebackProposal(input: Partial<MemoryWritebackProposal> = {}): MemoryWritebackProposal {
  return {
    proposal_id: "writeback:diagnostic:1",
    proposal_kind: "relationship_profile_candidate",
    source_event_refs: [eventRef()],
    proposed_target: "profile",
    admission_state: "pending_review",
    user_visible_review_text: SENSITIVE_REVIEW_SECRET,
    auto_apply: false,
    source_content_materialized: false,
    ...input,
  };
}

async function seedCognitionReplay(baseDir: string): Promise<void> {
  const sourceRef = eventRef();
  const proposal = writebackProposal();
  const record = createCognitionReplayRecord({
    recordId: "cognition:chat:diagnostic:replay",
    createdAt: NOW,
    input: {
      cognition_id: "cognition:chat:diagnostic",
      caller_path: "chat_user_turn",
      event_refs: [sourceRef],
    },
    output: {
      cognition_id: "cognition:chat:diagnostic",
      caller_path: "chat_user_turn",
      situation_model: {
        situation_id: "situation:diagnostic",
        summary_ref: sourceRef,
        caller_path: "chat_user_turn",
        tool_trace_refs: [],
        approval_refs: [],
        current_target_refs: [],
        stale_target_refs: [],
        protocol_bypass: false,
        confidence: 0.7,
      },
      relationship_state: {
        projection_id: "relationship:diagnostic",
        relationship_refs: [{
          memory_ref: eventRef("profile:memory:raw", "profile"),
          source_kind: "episodic",
          allowed_uses: ["user_facing_reference"],
          forbidden_uses: [],
          sensitivity: "private",
          lifecycle: "active",
          correction_state: "current",
          excerpt: RAW_MEMORY_SECRET,
        }],
        withheld_memory_refs: [],
        conflict_refs: [],
        overreach_risk: "unknown",
        ordinary_surface_debug_visible: false,
      },
      selected_intention: null,
      response_plan: {
        plan_id: "response:diagnostic",
        guidance_kind: "continue_route",
        public_summary: RAW_PROMPT_SECRET,
        surface_target: "operator_debug",
        quieting_applied: false,
        operator_debug_refs: [{ kind: "operator_trace", ref: "operator:diagnostic" }],
        hidden_policy_state_visible_to_normal_user: false,
      },
      tool_candidates: [{
        candidate_id: "candidate:diagnostic",
        authority_stage: "suggest",
        expected_effect: "Suggest an operator inspection.",
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
      memory_writeback: [proposal],
      reflection_hints: [],
      audit_refs: [],
      uncertainty: [],
    },
  });

  await new FileCognitionAuditSink(baseDir).recordCognition(record);
  await new FileCognitiveReplayIndexStore(baseDir).upsert(createCognitiveReplayIndexEntry({
    indexEntryId: "index:cognition:diagnostic",
    record,
  }));
  await new FileCognitionWritebackQueueStore(baseDir).enqueue(createCognitionWritebackQueueEntry({
    queueEntryId: "queue:writeback:diagnostic:1",
    proposal,
    createdAt: NOW,
  }));
  await new FileCognitionWritebackQueueStore(baseDir).enqueue(createCognitionWritebackQueueEntry({
    queueEntryId: "queue:writeback:blocked:1",
    proposal: writebackProposal({
      proposal_id: "writeback:diagnostic:blocked",
      source_event_refs: [eventRef("chat:event:blocked")],
    }),
    createdAt: NOW,
    sourceState: "deleted_or_tombstoned",
    invalidationRefs: [eventRef("profile:source:deleted", "profile")],
  }));
}

describe("runtime cognition-replay command", () => {
  it("prints a normal read-only diagnostic without raw prompt, raw memory, or source refs", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-cognition-replay-normal-");
    try {
      await seedCognitionReplay(tmpDir);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const code = await cmdRuntime(new StateManager(tmpDir), ["cognition-replay", "--json"]);
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      logSpy.mockRestore();

      expect(code).toBe(0);
      expect(output).not.toContain(RAW_PROMPT_SECRET);
      expect(output).not.toContain(RAW_MEMORY_SECRET);
      expect(output).not.toContain(SENSITIVE_REVIEW_SECRET);
      expect(output).not.toContain("profile:source:deleted");
      const parsed = JSON.parse(output);
      expect(parsed).toMatchObject({
        schema_version: "runtime-cognition-replay-diagnostic-v1",
        read_only: true,
        mutation_performed: false,
        view: {
          surface_target: "normal_user",
          raw_prompt_visible: false,
          raw_memory_visible: false,
          items: [{
            debug_refs_visible: false,
            source_refs: [],
            response_plan_ref: { kind: "response_plan", ref: "response:diagnostic" },
            writeback_proposal_refs: [{ kind: "memory_writeback_proposal", ref: "writeback:diagnostic:1" }],
          }],
        },
        writeback_queue_refs: [{
          queue_entry_ref: { kind: "cognition_writeback_queue_entry", ref: "queue:writeback:diagnostic:1" },
          proposal_ref: { kind: "memory_writeback_proposal", ref: "writeback:diagnostic:1" },
          source_refs_visible: false,
          source_refs: [],
          owner_write_performed: false,
          runtime_authority: false,
        }],
        memory_lifecycle_review_inbox: {
          read_only: true,
          mutation_performed: false,
          items: expect.arrayContaining([
            expect.objectContaining({
              item_kind: "cognition_replay_ref",
              source_summary_refs: [],
              raw_content_visible: false,
              hidden_prompt_visible: false,
              sensitive_content_visible: false,
            }),
            expect.objectContaining({
              item_kind: "profile_candidate",
              review_state: "pending_user_review",
              source_summary_refs: [],
              redaction_refs: [],
              allowed_actions: ["accept", "edit", "reject", "suppress", "forget_source"],
              raw_content_visible: false,
              hidden_prompt_visible: false,
              sensitive_content_visible: false,
            }),
            expect.objectContaining({
              item_kind: "correction_invalidation",
              review_state: "blocked_source_invalid",
              source_summary_refs: [],
              invalidation_refs: [],
              redaction_refs: [],
            }),
          ]),
        },
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("keeps operator diagnostics refs-only while exposing source refs", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-cognition-replay-operator-");
    try {
      await seedCognitionReplay(tmpDir);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const code = await cmdRuntime(new StateManager(tmpDir), ["cognition-replay", "--view", "operator"]);
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      logSpy.mockRestore();

      expect(code).toBe(0);
      expect(output).toContain("View:           operator_debug");
      expect(output).toContain("chat_history:chat:event:1");
      expect(output).toContain("cognition_writeback_queue_entry:queue:writeback:diagnostic:1");
      expect(output).not.toContain(RAW_PROMPT_SECRET);
      expect(output).not.toContain(RAW_MEMORY_SECRET);
      expect(output).not.toContain(SENSITIVE_REVIEW_SECRET);
      expect(output).toContain("owner write: no");
      expect(output).toContain("authority:   no");
      expect(output).toContain("Review inbox:   3");
      expect(output).toContain("raw content: hidden");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });
});
