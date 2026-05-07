import { describe, expect, it } from "vitest";
import {
  classifyConversationalPermissionGrantDecision,
} from "../permission-grant-decision.js";
import type { ApprovalRecord } from "../store/runtime-schemas.js";
import type { PendingPermissionGrantProposal } from "../permission-dialogue.js";
import { createSingleMockLLMClient } from "../../../tests/helpers/mock-llm.js";

const approval: ApprovalRecord = {
  approval_id: "approval-grant-1",
  goal_id: "goal-1",
  request_envelope_id: "approval-grant-1",
  correlation_id: "approval-grant-1",
  state: "pending",
  created_at: 10,
  expires_at: 10_000,
  origin: {
    channel: "slack",
    conversation_id: "thread-1",
    user_id: "user-1",
    session_id: "session-1",
    turn_id: "turn-1",
  },
  payload: {
    task: {
      id: "call-1",
      description: "Write local files and run tests.",
      action: "write_file",
    },
  },
};

const proposal: PendingPermissionGrantProposal = {
  schema_version: "permission-grant-proposal-v1",
  capabilities: ["write_workspace", "run_tests"],
  current_request_capabilities: ["write_workspace", "run_tests"],
  excluded_capabilities: ["write_remote", "network_send"],
  default_scope: "run",
  allowed_scopes: ["once", "run", "goal"],
  summary: "Allow local edits and tests for this fix.",
};

describe("classifyConversationalPermissionGrantDecision", () => {
  it("accepts exact protocol commands without model classification", async () => {
    await expect(classifyConversationalPermissionGrantDecision("/approve-run", {
      approval,
      proposal,
      replyOrigin: approval.origin!,
    })).resolves.toMatchObject({ decision: "approve_current_run", confidence: 1 });

    await expect(classifyConversationalPermissionGrantDecision("/approve", {
      approval,
      proposal,
      replyOrigin: approval.origin!,
    })).resolves.toMatchObject({ decision: "approve_once", confidence: 1 });
  });

  it("classifies multilingual paraphrases through the structured model contract", async () => {
    const decision = await classifyConversationalPermissionGrantDecision("この実行中はローカル編集とテストを進めてください", {
      approval,
      proposal,
      replyOrigin: approval.origin!,
      llmClient: createSingleMockLLMClient(JSON.stringify({
        decision: "approve_current_run",
        confidence: 0.94,
        rationale: "The reply allows the proposed local work for the current run.",
      })),
    });

    expect(decision).toMatchObject({ decision: "approve_current_run", confidence: 0.94 });
  });

  it("keeps narrowed capability replies typed without adding unmentioned capabilities", async () => {
    const decision = await classifyConversationalPermissionGrantDecision("Tests are fine, but do not edit files yet.", {
      approval,
      proposal,
      replyOrigin: approval.origin!,
      llmClient: createSingleMockLLMClient(JSON.stringify({
        decision: "narrow_scope",
        confidence: 0.91,
        capabilities: ["run_tests"],
        rationale: "The reply allows tests only.",
      })),
    });

    expect(decision).toMatchObject({
      decision: "narrow_scope",
      capabilities: ["run_tests"],
    });
  });

  it("downgrades low-confidence broad replies to unknown", async () => {
    const decision = await classifyConversationalPermissionGrantDecision("sounds fine", {
      approval,
      proposal,
      replyOrigin: approval.origin!,
      llmClient: createSingleMockLLMClient(JSON.stringify({
        decision: "approve_current_goal",
        confidence: 0.42,
        clarification: "Please explicitly approve or reject the permission proposal.",
      })),
    });

    expect(decision).toMatchObject({
      decision: "unknown",
      confidence: 0,
      clarification: "Please explicitly approve or reject the permission proposal.",
    });
  });

  it("classifies standing/global requests as an extension requiring caller confirmation", async () => {
    const decision = await classifyConversationalPermissionGrantDecision("Always allow this from now on.", {
      approval,
      proposal,
      replyOrigin: approval.origin!,
      llmClient: createSingleMockLLMClient(JSON.stringify({
        decision: "extend_scope",
        requested_scope: "standing",
        confidence: 0.93,
        rationale: "The reply asks for standing permission.",
      })),
    });

    expect(decision).toMatchObject({
      decision: "extend_scope",
      requested_scope: "standing",
    });
  });
});
