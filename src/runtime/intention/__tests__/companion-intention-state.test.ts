import { describe, expect, it } from "vitest";
import {
  CompanionIntentionRecordSchema,
  allowedNextLifecycles,
  createCompanionIntentionRecord,
  transitionCompanionIntention,
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

describe("companion intention state", () => {
  it("models intentions as refs-only commitments without execution or memory authority", () => {
    const record = createCompanionIntentionRecord({
      intentionId: "intention:goal:1",
      lifecycle: "selected",
      sourceRefs: [eventRef()],
      createdAt: NOW,
      goalRef: {
        goal_id: "goal-1",
        goal_ref: { kind: "goal", ref: "goal:1" },
        lifecycle: "active",
        priority: "normal",
      },
      selectedPathRef: { kind: "run", ref: "run:current" },
      runtimeItemRefs: [{ kind: "runtime_item", ref: "runtime:item:1" }],
      executionOwner: "agent_loop",
    });

    expect(record).toMatchObject({
      lifecycle: "selected",
      runtime_authority: false,
      memory_authority: false,
      execution_owner: "agent_loop",
    });
    expect(allowedNextLifecycles("selected")).toContain("awaiting_approval");
  });

  it("forces stale targets into regrounding before reuse", () => {
    const record = createCompanionIntentionRecord({
      intentionId: "intention:stale",
      lifecycle: "selected",
      sourceRefs: [eventRef()],
      createdAt: NOW,
      selectedPathRef: { kind: "run", ref: "run:previous" },
      staleTargetRefs: [{ kind: "run", ref: "run:previous" }],
    });

    expect(record).toMatchObject({
      lifecycle: "requires_regrounding",
      stale_target_refs: [{ kind: "run", ref: "run:previous" }],
      regrounding_reason_refs: [eventRef()],
    });
    expect(() => CompanionIntentionRecordSchema.parse({
      ...record,
      lifecycle: "active",
    })).toThrow(/must require regrounding/);
  });

  it("preserves permission wait refs when selected work waits for approval and later resumes", () => {
    const selected = createCompanionIntentionRecord({
      intentionId: "intention:approval",
      lifecycle: "selected",
      sourceRefs: [eventRef()],
      createdAt: NOW,
      selectedPathRef: { kind: "tool_candidate", ref: "candidate:write" },
      executionOwner: "agent_loop",
    });
    const awaitingApproval = transitionCompanionIntention(selected, {
      transition_id: "transition:awaiting-approval",
      to: "awaiting_approval",
      decided_at: "2026-05-14T00:01:00.000Z",
      reason_refs: [eventRef("approval:event:requested")],
      permission_wait_ref: { kind: "permission_wait_plan", ref: "wait:1" },
    });
    const active = transitionCompanionIntention(awaitingApproval, {
      transition_id: "transition:approval-resumed",
      to: "active",
      decided_at: "2026-05-14T00:02:00.000Z",
      reason_refs: [eventRef("approval:event:resumed")],
      runtime_item_refs: [{ kind: "runtime_item", ref: "runtime:item:approved-write" }],
    });

    expect(awaitingApproval.permission_wait_ref).toEqual({ kind: "permission_wait_plan", ref: "wait:1" });
    expect(active).toMatchObject({
      lifecycle: "active",
      permission_wait_ref: { kind: "permission_wait_plan", ref: "wait:1" },
      runtime_item_refs: [{ kind: "runtime_item", ref: "runtime:item:approved-write" }],
    });
  });
});
