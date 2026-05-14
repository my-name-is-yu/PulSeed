import { describe, expect, it } from "vitest";
import {
  CognitionMemoryReviewCommandSchema,
  memoryOperationInputFromReviewCommand,
  projectCognitionMemoryWritebackForReview,
} from "../index.js";

const sourceRef = {
  ref: "chat:event:1",
  source_store: "chat_history" as const,
  source_event_type: "user_input",
  schema_version: 1,
  source_epoch: "turn:1",
  redaction_policy: "metadata_only" as const,
};

describe("cognition memory review controls", () => {
  it("projects cognition writeback proposals into safe normal-surface review text without raw memory", () => {
    const projection = projectCognitionMemoryWritebackForReview({
      projectionId: "review:writeback:1",
      proposal: {
        proposal_id: "writeback:1",
        proposal_kind: "relationship_profile_candidate",
        source_event_refs: [sourceRef],
        proposed_target: "profile",
        admission_state: "pending_review",
        user_visible_review_text: "Review whether this should become a profile preference.",
        auto_apply: false,
        source_content_materialized: false,
      },
    });

    expect(projection).toMatchObject({
      proposed_target: "profile",
      safe_review_text: "Review whether this should become a profile preference.",
      normal_surface_raw_memory_visible: false,
      raw_prompt_visible: false,
      owner_write_performed: false,
      available_actions: ["review", "reject_proposal"],
    });
    expect(JSON.stringify(projection)).not.toContain("user_input");
  });

  it("turns typed correction controls into user memory operations without executing owner writes itself", () => {
    const command = CognitionMemoryReviewCommandSchema.parse({
      schema_version: "cognition-memory-review-command/v1",
      command_id: "memory-review-command:correct",
      action: "correct",
      target_ref: { kind: "agent_memory", id: "memory-old" },
      reason: "User corrected this profile fact.",
      replacement_value: "The user prefers VS Code.",
      replacement_key: "favorite-editor-current",
      owner_write_performed: false,
    });

    expect(memoryOperationInputFromReviewCommand(command)).toMatchObject({
      operation: "correct",
      targetRef: { kind: "agent_memory", id: "memory-old" },
      replacementValue: "The user prefers VS Code.",
    });
  });

  it("requires proposal refs for proposal-scoped review actions", () => {
    const baseCommand = {
      schema_version: "cognition-memory-review-command/v1" as const,
      command_id: "memory-review-command:proposal",
      reason: "Owner decided on the proposed writeback.",
      owner_write_performed: false,
    };

    expect(CognitionMemoryReviewCommandSchema.parse({
      ...baseCommand,
      action: "review",
      proposal_ref: { kind: "memory_writeback_proposal", ref: "writeback:1" },
    })).toMatchObject({
      action: "review",
      proposal_ref: { kind: "memory_writeback_proposal", ref: "writeback:1" },
    });
    expect(() => CognitionMemoryReviewCommandSchema.parse({
      ...baseCommand,
      action: "review",
    })).toThrow(/writeback proposal ref/);
    expect(() => CognitionMemoryReviewCommandSchema.parse({
      ...baseCommand,
      action: "reject_proposal",
    })).toThrow(/writeback proposal ref/);
  });

  it("keeps destructive delete as an owner-approved request instead of direct deletion", () => {
    const command = CognitionMemoryReviewCommandSchema.parse({
      schema_version: "cognition-memory-review-command/v1",
      command_id: "memory-review-command:delete",
      action: "delete_request",
      proposal_ref: { kind: "memory_writeback_proposal", ref: "writeback:1" },
      target_ref: { kind: "agent_memory", id: "memory-old" },
      reason: "User asked for deletion.",
      destructive_delete_requires_owner_approval: true,
      owner_write_performed: false,
    });

    expect(command.destructive_delete_requires_owner_approval).toBe(true);
    expect(command.owner_write_performed).toBe(false);
    expect(() => CognitionMemoryReviewCommandSchema.parse({
      ...command,
      destructive_delete_requires_owner_approval: false,
    })).toThrow(/expected true/);
    expect(() => memoryOperationInputFromReviewCommand(command)).toThrow(/not a direct user memory operation/);
  });
});
