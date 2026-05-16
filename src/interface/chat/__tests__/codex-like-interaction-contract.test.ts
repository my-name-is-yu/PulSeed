import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

interface ContractWorkflow {
  id: string;
  language: "en" | "ja";
  surface: string;
  input: {
    operation: "TurnStart" | "TurnSteer";
    items: Array<{ kind: string; text?: string }>;
  };
  displayTranscript: Array<{ role: string; text: string }>;
  structuredState: Record<string, unknown>;
}

interface InteractionContract {
  schema: string;
  principles: string[];
  userInputKinds: string[];
  turnOperations: Array<{ kind: string; when: string; requiredState: string[] }>;
  transcriptEvents: Array<{ type: string; displayText: string; structuredState: string[] }>;
  permissionDecisionDomain: string[];
  permissionMatching: string[];
  contextBoundary: { modelVisible: string[]; hostOnly: string[] };
  workflows: ContractWorkflow[];
}

function loadContract(): InteractionContract {
  const contractPath = path.join(
    process.cwd(),
    "tests/fixtures/codex-like-interaction-contract.golden.json",
  );
  return JSON.parse(fs.readFileSync(contractPath, "utf8")) as InteractionContract;
}

describe("Codex-like interaction contract golden fixture", () => {
  const contract = loadContract();

  it("declares display text and structured host state as separate layers", () => {
    expect(contract.schema).toBe("pulseed.codex_like_interaction_contract.v1");
    expect(contract.principles).toEqual(expect.arrayContaining([
      "display_text_is_user_visible_projection",
      "structured_state_is_host_owned_data",
      "ordinary_freeform_text_is_not_preclassified",
      "model_visible_context_is_separate_from_host_only_state",
    ]));

    for (const event of contract.transcriptEvents) {
      expect(event.displayText.trim().length).toBeGreaterThan(0);
      expect(event.structuredState.length).toBeGreaterThan(0);
    }
    expect(contract.contextBoundary.modelVisible).toContain("safe_runtime_evidence");
    expect(contract.contextBoundary.hostOnly).toEqual(expect.arrayContaining([
      "secret_values",
      "stale_route_caches",
      "internal_audit_records",
    ]));
  });

  it("covers canonical input kinds, turn start, and turn steer", () => {
    expect(contract.userInputKinds).toEqual(expect.arrayContaining([
      "text",
      "image",
      "local_image",
      "mention",
      "skill",
      "tool",
      "attachment",
    ]));

    expect(contract.turnOperations.map((operation) => operation.kind)).toEqual([
      "TurnStart",
      "TurnSteer",
    ]);
    expect(contract.workflows.some((workflow) => workflow.input.operation === "TurnStart")).toBe(true);
    expect(contract.workflows.some((workflow) => workflow.input.operation === "TurnSteer")).toBe(true);
  });

  it("includes the required end-to-end workflows in English and Japanese", () => {
    const workflowIds = contract.workflows.map((workflow) => workflow.id);
    expect(workflowIds).toEqual(expect.arrayContaining([
      "ordinary-chat-en",
      "tool-progress-en",
      "permission-prompt-en",
      "mid-turn-steer-ja",
      "clarification-ja",
      "stale-target-rejection-ja",
      "resume-en",
    ]));

    expect(contract.workflows.some((workflow) => workflow.language === "en")).toBe(true);
    expect(contract.workflows.some((workflow) => workflow.language === "ja")).toBe(true);
  });

  it("maps permission dialogue to a typed pending approval record", () => {
    expect(contract.permissionDecisionDomain).toEqual([
      "approve",
      "reject",
      "clarify",
      "unknown",
    ]);
    expect(contract.permissionMatching).toEqual(expect.arrayContaining([
      "same_channel",
      "same_conversation_or_thread",
      "authorized_sender",
      "current_session_or_turn",
      "pending_unexpired_approval_id",
      "sufficient_decision_confidence",
    ]));

    const workflow = contract.workflows.find((entry) => entry.id === "permission-prompt-en");
    expect(workflow?.displayTranscript[0]?.role).toBe("permission_prompt");
    expect(workflow?.structuredState).toMatchObject({
      approval_id: "approval-123",
      operation: "shell_command",
      expires_at: "2026-05-06T07:30:00.000Z",
      origin: {
        channel: "tui",
        conversation_id: "local",
        user_id: "owner",
      },
      reply_matching: {
        same_channel: true,
        same_conversation_or_thread: true,
        authorized_sender: "owner",
        current_session_or_turn: "turn-7",
        pending_unexpired_approval_id: "approval-123",
        minimum_decision_confidence: 0.7,
      },
      decision_domain: ["approve", "reject", "clarify", "unknown"],
    });
  });

  it("documents stale target rejection and resume without leaking host-only state into display", () => {
    const stale = contract.workflows.find((entry) => entry.id === "stale-target-rejection-ja");
    expect(stale?.structuredState).toMatchObject({
      previous_completed_target_reused: false,
      outcome: "clarification_required",
    });

    const resume = contract.workflows.find((entry) => entry.id === "resume-en");
    expect(resume?.structuredState).toMatchObject({
      stale_route_cache_reused: false,
    });
    expect(JSON.stringify(resume?.displayTranscript)).not.toContain("state_path");
  });
});
