import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { upsertRelationshipProfileItem } from "../../../platform/profile/relationship-profile.js";
import { CoreCompanionMemoryProjectionSchema } from "../../decision/core-companion-memory-projection.js";
import { CompanionCognitionService } from "../companion-cognition-service.js";
import {
  cognitionMemoryResultFromCoreProjection,
  createRelationshipProfileCognitionMemoryPort,
} from "../memory-context.js";
import { CognitionMemoryRequestSchema, type CompanionCognitionInput } from "../contracts.js";

const NOW = "2026-05-14T00:00:00.000Z";

describe("cognition memory context", () => {
  it("converts governed core memory projections without turning withheld memory into model-visible content", async () => {
    const projection = CoreCompanionMemoryProjectionSchema.parse({
      schema_version: "core-companion-memory-projection/v1",
      projection_id: "core-memory:cognition-memory-test",
      created_at: NOW,
      caller_path: "chat_gateway_model_loop",
      source_refs: [{
        kind: "surface_projection",
        ref: "surface:cognition-memory-test",
      }],
      surface_ref: "surface:cognition-memory-test",
      requested_use: "runtime_grounding",
      included_entries: [{
        entry_id: "core-memory-entry:current",
        lane: "relationship",
        source_ref: memorySource("memory:current"),
        content: {
          state: "available",
          excerpt: "Use the current corrected preference.",
        },
        use_policy: {
          remembered: true,
          usable: true,
          speakable: false,
          actionable: false,
          inhibition_only: false,
          planning_only: true,
          forbidden: false,
          memory_is_runtime_authority: false,
          required_confirmation: "none",
          requested_use: "runtime_grounding",
          allowed_use_classes: ["runtime_grounding", "surface_projection"],
          blocked_use_classes: ["side_effect_authorization"],
        },
        source_projection_ref: "surface:cognition-memory-test",
        audit_refs: ["audit:memory:current"],
      }],
      restricted_entries: [{
        entry_id: "core-memory-restricted:sensitive",
        source_ref: memorySource("memory:sensitive", { sensitivity: "sensitive" }),
        requested_use: "runtime_grounding",
        restriction_reasons: ["sensitive"],
        content: {
          state: "withheld",
          redaction_ref: "redaction:memory:sensitive",
          reason_refs: ["policy:sensitive"],
        },
        use_policy: {
          remembered: true,
          usable: false,
          speakable: false,
          actionable: false,
          inhibition_only: false,
          planning_only: false,
          forbidden: true,
          memory_is_runtime_authority: false,
          required_confirmation: "none",
          requested_use: "runtime_grounding",
          allowed_use_classes: [],
          blocked_use_classes: ["runtime_grounding"],
        },
        source_projection_ref: "surface:cognition-memory-test",
        audit_refs: ["audit:memory:sensitive"],
      }],
      ordinary_surface_policy: {},
      summary: {
        included_count: 1,
        restricted_count: 1,
        remembered_count: 2,
        usable_count: 1,
        speakable_count: 0,
        actionable_count: 0,
        inhibition_only_count: 0,
        planning_only_count: 1,
        forbidden_count: 1,
      },
    });

    const result = cognitionMemoryResultFromCoreProjection({
      requestId: "memory-request:chat:1",
      projection,
      requestedUse: "runtime_grounding",
    });

    expect(result).toMatchObject({
      model_visible_without_cloud_gate: false,
      included: [{
        memory_ref: {
          ref: "memory:current",
          source_store: "profile",
        },
        lifecycle: "active",
        correction_state: "current",
        excerpt: "Use the current corrected preference.",
      }],
      withheld: [{
        memory_ref: {
          ref: "memory:sensitive",
        },
        withheld_reason: "sensitive",
        sensitivity: "sensitive",
      }],
    });
    expect(JSON.stringify(result.withheld)).not.toContain("sensitive-secret");

    const cognition = await new CompanionCognitionService({
      memoryPort: {
        retrieveMemory: async () => result,
      },
    }).evaluateTurn(chatInput({ memory_result: undefined }));
    expect(cognition.relationship_state.relationship_refs).toHaveLength(1);
    expect(cognition.relationship_state.withheld_memory_refs).toHaveLength(1);
    expect(cognition.uncertainty.map((item) => item.kind)).toContain("missing_surface");
  });

  it("retrieves governed relationship profile memory for live cognition caller requests", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-cognition-memory-port-"));
    try {
      await upsertRelationshipProfileItem(baseDir, {
        stableKey: "operator.status_style",
        kind: "preference",
        value: "Prefer concise implementation status updates.",
        source: "cli_update",
        allowedScopes: ["memory_retrieval"],
        sensitivity: "private",
        now: NOW,
      });

      const memoryPort = createRelationshipProfileCognitionMemoryPort({
        baseDir,
        now: () => new Date(NOW),
      });
      const result = await memoryPort.retrieveMemory(
        CognitionMemoryRequestSchema.parse(chatInput().memory_context_request),
      );

      expect(result.included).toHaveLength(1);
      expect(result.included[0]).toMatchObject({
        source_kind: "semantic",
        excerpt: "Prefer concise implementation status updates.",
        allowed_uses: ["runtime_grounding"],
        memory_ref: {
          source_store: "profile",
          source_event_type: "preference",
        },
      });

      const cognition = await new CompanionCognitionService({ memoryPort }).evaluateTurn(chatInput());
      expect(cognition.relationship_state.relationship_refs).toHaveLength(1);
      expect(cognition.audit_refs).toContain("core-memory:memory-request:chat:1");
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("regenerates the next-turn Surface projection after a user correction supersedes the prior profile memory", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-cognition-memory-correction-"));
    try {
      await upsertRelationshipProfileItem(baseDir, {
        stableKey: "operator.reply_style",
        kind: "preference",
        value: "Prefer expansive gateway replies.",
        source: "cli_update",
        allowedScopes: ["memory_retrieval"],
        sensitivity: "private",
        now: NOW,
      });
      const memoryPort = createRelationshipProfileCognitionMemoryPort({
        baseDir,
        now: () => new Date(NOW),
      });
      const firstTurn = await memoryPort.retrieveMemory(
        CognitionMemoryRequestSchema.parse(chatInput({
          memory_context_request: {
            ...chatInput().memory_context_request,
            request_id: "memory-request:chat:first",
          },
        }).memory_context_request),
      );

      await upsertRelationshipProfileItem(baseDir, {
        stableKey: "operator.reply_style",
        kind: "preference",
        value: "Prefer concise gateway replies.",
        source: "user_correction",
        allowedScopes: ["memory_retrieval"],
        sensitivity: "private",
        now: "2026-05-14T00:01:00.000Z",
      });

      const nextTurn = await memoryPort.retrieveMemory(
        CognitionMemoryRequestSchema.parse(chatInput({
          memory_context_request: {
            ...chatInput().memory_context_request,
            request_id: "memory-request:chat:next",
            query_ref: {
              ...chatInput().memory_context_request.query_ref,
              ref: "chat:event:2",
              source_epoch: "turn:2",
            },
          },
        }).memory_context_request),
      );

      expect(firstTurn.included.map((source) => source.excerpt)).toEqual(["Prefer expansive gateway replies."]);
      expect(nextTurn.included.map((source) => source.excerpt)).toEqual(["Prefer concise gateway replies."]);
      expect(JSON.stringify(nextTurn)).not.toContain("Prefer expansive gateway replies.");
      expect(nextTurn.included[0]?.surface_projection_ref).toContain("chat_3Aevent_3A2");

      const cognition = await new CompanionCognitionService({ memoryPort }).evaluateTurn(chatInput({
        cognition_id: "cognition:chat:memory-correction-next",
        memory_context_request: {
          ...chatInput().memory_context_request,
          request_id: "memory-request:chat:correction-next",
          query_ref: {
            ...chatInput().memory_context_request.query_ref,
            ref: "chat:event:3",
            source_epoch: "turn:3",
          },
        },
      }));
      expect(cognition.relationship_state.included).toEqual([expect.objectContaining({
        role: "preference",
        allowed_surface_use: "tone_adaptation",
      })]);
      expect(cognition.relationship_state.relationship_refs.map((source) => source.excerpt)).toEqual([
        "Prefer concise gateway replies.",
      ]);
      expect(JSON.stringify(cognition.relationship_state)).not.toContain("Prefer expansive gateway replies.");
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("classifies governed knowledge facts as semantic cognition memory", () => {
    const projection = CoreCompanionMemoryProjectionSchema.parse({
      schema_version: "core-companion-memory-projection/v1",
      projection_id: "core-memory:knowledge-fact-test",
      created_at: NOW,
      caller_path: "task_agent_loop",
      source_refs: [{
        kind: "surface_projection",
        ref: "surface:knowledge-fact-test",
      }],
      surface_ref: "surface:knowledge-fact-test",
      requested_use: "goal_planning",
      included_entries: [{
        entry_id: "core-memory-entry:knowledge",
        lane: "knowledge",
        source_ref: memorySource("knowledge:fact:1", {
          ownerKind: "knowledge",
          role: "knowledge",
          recordKind: "knowledge_fact",
        }),
        content: {
          state: "available",
          excerpt: "The local architecture prefers typed contracts.",
        },
        use_policy: {
          remembered: true,
          usable: true,
          speakable: false,
          actionable: false,
          inhibition_only: false,
          planning_only: true,
          forbidden: false,
          memory_is_runtime_authority: false,
          required_confirmation: "none",
          requested_use: "goal_planning",
          allowed_use_classes: ["goal_planning", "surface_projection"],
          blocked_use_classes: ["side_effect_authorization"],
        },
        source_projection_ref: "surface:knowledge-fact-test",
        audit_refs: ["audit:knowledge:fact:1"],
      }],
      restricted_entries: [],
      ordinary_surface_policy: {},
      summary: {
        included_count: 1,
        restricted_count: 0,
        remembered_count: 1,
        usable_count: 1,
        speakable_count: 0,
        actionable_count: 0,
        inhibition_only_count: 0,
        planning_only_count: 1,
        forbidden_count: 0,
      },
    });

    const result = cognitionMemoryResultFromCoreProjection({
      requestId: "memory-request:task:knowledge",
      projection,
      requestedUse: "goal_planning",
    });

    expect(result.included[0]).toMatchObject({
      source_kind: "semantic",
      memory_ref: {
        source_store: "knowledge",
        source_event_type: "knowledge_fact",
      },
    });
  });
});

function chatInput(overrides: Partial<CompanionCognitionInput> = {}): CompanionCognitionInput {
  const ref = {
    ref: "chat:event:1",
    source_store: "chat_history" as const,
    source_event_type: "user_input",
    schema_version: 1,
    source_epoch: "turn:1",
    redaction_policy: "metadata_only" as const,
  };
  return {
    cognition_id: "cognition:chat:memory-test",
    caller_path: "chat_user_turn",
    event_refs: [ref],
    working_context: {
      input_ref: ref,
      route_ref: { kind: "chat_route", ref: "gateway_model_loop" },
      hidden_prompt_content_materialized: false,
    },
    session_context: {
      session_ref: { kind: "chat_session", ref: "session:1" },
      turn_ref: { kind: "chat_turn", ref: "turn:1" },
      route_kind: "gateway_model_loop",
      runtime_control_allowed: true,
      approval_mode: "interactive",
      quieting_active: false,
      stale_reply_target_refs: [],
    },
    memory_context_request: {
      request_id: "memory-request:chat:1",
      requested_uses: ["runtime_grounding"],
      caller_path: "chat_user_turn",
      query_ref: ref,
      surface_projection_required: true,
      side_effect_authorization_allowed: false,
      include_sensitive_content: false,
    },
    surface_target: "internal_audit",
    ...overrides,
  };
}

function memorySource(memoryId: string, overrides: Record<string, unknown> = {}) {
  const sensitivity = typeof overrides["sensitivity"] === "string" ? overrides["sensitivity"] : "private";
  const ownerKind = typeof overrides["ownerKind"] === "string" ? overrides["ownerKind"] : "relationship_profile";
  const role = typeof overrides["role"] === "string" ? overrides["role"] : "relationship";
  const recordKind = typeof overrides["recordKind"] === "string" ? overrides["recordKind"] : "preference";
  return {
    memory_id: memoryId,
    owning_store_ref: {
      kind: ownerKind,
      store_ref: "relationship-profile:cognition-test",
      record_ref: memoryId,
    },
    role,
    record_kind: recordKind,
    domain_fields: {
      target: "cognition memory test",
      preference: memoryId === "memory:sensitive" ? "sensitive-secret" : "current preference",
      confidence: 0.9,
      scope: "PulSeed",
      allowed_uses: ["runtime_grounding"],
      review_condition: "current only",
    },
    allowed_uses: ["runtime_grounding", "surface_projection"],
    not_allowed_uses: ["side_effect_authorization"],
    lifecycle: "active",
    correction_state: "current",
    superseded_by_memory_id: null,
    sensitivity,
    content_state: "materialized",
    dependency_ref: {
      kind: "memory_record",
      ref: memoryId,
      owning_store_ref: {
        kind: ownerKind,
        store_ref: "relationship-profile:cognition-test",
        record_ref: memoryId,
      },
      content_state: "materialized",
      lifecycle: "active",
      correction_state: "current",
      superseded_by_memory_id: null,
    },
  };
}
