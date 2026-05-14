import { describe, expect, it, vi } from "vitest";
import { defaultExecutionPolicy } from "../../../orchestrator/execution/agent-loop/execution-policy.js";
import {
  buildChatTurnContext,
  renderModelVisibleTurnContext,
  toPublicCharacterPolicyContext,
  toTurnContextSnapshot,
} from "../turn-context.js";
import { createCompanionCharacterPolicyProjection } from "../../../runtime/decision/companion-character-policy-projection.js";
import type { UserInput } from "../user-input.js";

describe("Chat TurnContext", () => {
  it("keeps current runtime target model-visible and leaves stale fallback plus approval functions host-only", () => {
    const approvalFn = vi.fn().mockResolvedValue(true);
    const context = buildChatTurnContext({
      eventContext: { runId: "run-current", turnId: "turn-current" },
      startedAt: new Date("2026-05-06T07:00:00.000Z"),
      timezone: "Asia/Tokyo",
      sessionId: "session-current",
      cwd: "/repo",
      gitRoot: "/repo",
      executionCwd: "/repo",
      nativeAgentLoopStatePath: "chat/agentloop/session-current.state.json",
      selectedRoute: {
        kind: "agent_loop",
        reason: "agent_loop_available",
        replyTargetPolicy: "turn_reply_target",
        eventProjectionPolicy: "turn_only",
        concurrencyPolicy: "session_serial",
      },
      input: "進捗を見て",
      userInput: {
        schema_version: "user-input-v1",
        rawText: "進捗を見て",
        metadata: { token: "secret-metadata" },
        items: [
          { kind: "text", text: "secret-text" },
          {
            kind: "attachment",
            id: "attachment-1",
            name: "debug.log",
            mimeType: "text/plain",
            path: "/private/secret.log",
            url: "https://example.invalid/?token=secret-url",
            metadata: { apiKey: "secret-item-metadata" },
          },
        ],
      } satisfies UserInput,
      compactionSummary: "Archived stale target; retained current target from structured state.",
      compactionRecords: [{
        schema_version: "chat-compaction-record-v1",
        id: "session-current:compaction:0",
        sessionId: "session-current",
        sequence: 0,
        createdAt: "2026-05-06T06:59:00.000Z",
        reason: "manual_command",
        inputMessageCount: 8,
        outputMessageCount: 4,
        removedMessageCount: 4,
        retainedMessageCount: 4,
        summary: "Archived stale target; retained current target from structured state.",
        modelVisibleSummary: "Archived stale target; retained current target from structured state.",
        archivedUserMessages: [],
        archivedAssistantMessages: [],
        retainedMessages: [],
        pendingPermissions: [{
          sequence: 2,
          source: "chat_event",
          status: "requested",
          invalidatedByCompaction: true,
          payload: { state: "requested" },
        }],
        decisions: [],
        activeTargets: [{
          source: "notification_reply_target",
          state: "session",
          payload: { surface: "gateway", platform: "slack", conversation_id: "current-thread" },
        }],
        replacementHistory: {
          removedTurnIndexes: [0, 1, 2, 3],
          retainedOriginalTurnIndexes: [4, 5, 6, 7],
          rewrittenTurnIndexes: [0, 1, 2, 3],
          rolloutJournalSequences: [0, 1, 2],
          turnContextCount: 1,
        },
      }],
      priorTurns: [],
      basePrompt: "Working directory: /repo\n\n進捗を見て",
      prompt: "Working directory: /repo\n\n進捗を見て",
      systemPrompt: "Developer instructions\n\nAGENTS instructions",
      agentLoopSystemPrompt: "Developer instructions\n\nAGENTS instructions\n\nReply in Japanese.",
      runtimeControlContext: {
        approvalMode: "preapproved",
        allowed: true,
        approvalFn,
        replyTarget: {
          surface: "gateway",
          platform: "slack",
          conversation_id: "current-thread",
          message_id: "current-message",
          identity_key: "current-user",
          user_id: "U-current",
        },
      },
      fallbackReplyTarget: {
        surface: "gateway",
        platform: "slack",
        conversation_id: "stale-thread",
        message_id: "stale-message",
        identity_key: "stale-user",
      },
      executionPolicy: defaultExecutionPolicy("/repo"),
      setupDialogue: null,
      runSpecConfirmation: null,
      setupSecretIntake: {
        redactedText: "進捗を見て",
        suppliedSecrets: [{
          id: "setup_secret_1",
          kind: "telegram_bot_token",
          value: "secret-token",
          redaction: "[REDACTED]",
          suppliedAt: "2026-05-06T07:00:00.000Z",
        }],
      },
      activatedTools: new Set(["sessions_read"]),
    });

    expect(context.modelVisible.runtime.replyTarget).toMatchObject({
      conversation_id: "current-thread",
      message_id: "current-message",
    });
    expect(context.modelVisible.runtime.approvalMode).toBe("preapproved");
    expect(context.modelVisible.conversation.compactionRecords).toEqual([
      expect.objectContaining({
        sequence: 0,
        pendingPermissions: [
          expect.objectContaining({ status: "requested", invalidatedByCompaction: true }),
        ],
        activeTargets: [
          expect.objectContaining({ source: "notification_reply_target" }),
        ],
      }),
    ]);
    expect(context.hostOnly.runtime.fallbackReplyTarget).toMatchObject({
      conversation_id: "stale-thread",
    });

    const rendered = renderModelVisibleTurnContext(context.modelVisible);
    expect(rendered).toContain("current-thread");
    expect(rendered).toContain("compaction_records: 1");
    expect(rendered).toContain("pending_permissions:");
    expect(rendered).toContain("invalidatedByCompaction");
    expect(rendered).toContain("active_targets:");
    expect(rendered).toContain("notification_reply_target");
    expect(rendered).toContain("replacement_history:");
    expect(rendered).not.toContain("stale-thread");

    const snapshotJson = JSON.stringify(toTurnContextSnapshot(context));
    expect(snapshotJson).toContain("current-thread");
    expect(snapshotJson).toContain("AGENTS instructions");
    expect(snapshotJson).toContain("進捗を見て");
    expect(snapshotJson).not.toContain("stale-thread");
    expect(snapshotJson).not.toContain("secret-text");
    expect(snapshotJson).not.toContain("secret-token");
    expect(snapshotJson).not.toContain("secret-metadata");
    expect(snapshotJson).not.toContain("secret-item-metadata");
    expect(snapshotJson).not.toContain("secret-url");
    expect(snapshotJson).not.toContain("/private/secret.log");
    expect(snapshotJson).not.toContain("approvalFn");
  });

  it("renders typed character policy without raw config knobs or execution authority", () => {
    const characterPolicy = toPublicCharacterPolicyContext(createCompanionCharacterPolicyProjection({
      projectionId: "character-policy:test-high",
      evaluatedAt: "2026-05-14T00:00:00.000Z",
      characterConfig: {
        caution_level: 5,
        stall_flexibility: 5,
        communication_directness: 5,
        proactivity_level: 5,
      },
    }));
    const context = buildChatTurnContext({
      eventContext: { runId: "run-character", turnId: "turn-character" },
      startedAt: new Date("2026-05-14T00:00:00.000Z"),
      sessionId: "session-character",
      cwd: "/repo",
      gitRoot: "/repo",
      executionCwd: "/repo",
      nativeAgentLoopStatePath: null,
      selectedRoute: {
        kind: "gateway_model_loop",
        reason: "direct_model_tool_loop",
        replyTargetPolicy: "turn_reply_target",
        eventProjectionPolicy: "turn_only",
        concurrencyPolicy: "session_serial",
      },
      input: "hello",
      userInput: {
        schema_version: "user-input-v1",
        items: [{ kind: "text", text: "hello" }],
      } satisfies UserInput,
      priorTurns: [],
      basePrompt: "hello",
      prompt: "hello",
      systemPrompt: "Base instructions",
      agentLoopSystemPrompt: "Base instructions",
      runtimeControlContext: {
        approvalMode: "disallowed",
        allowed: false,
      },
      executionPolicy: defaultExecutionPolicy("/repo"),
      setupDialogue: null,
      runSpecConfirmation: null,
      setupSecretIntake: null,
      activatedTools: new Set(),
      characterPolicy,
    });

    expect(context.modelVisible.characterPolicy).toMatchObject({
      policyRef: {
        kind: "character_config_policy",
        ref: "character-policy:test-high",
        result: "policy_hint_only",
      },
      dialogueStrategy: {
        directness: "direct",
        initiative_posture: "high_detail",
      },
      authority: {
        characterCanRelaxApprovalBoundary: false,
        characterCanGrantAutonomy: false,
      },
    });
    const rendered = renderModelVisibleTurnContext(context.modelVisible);
    expect(rendered).toContain("character_policy_ref: character_config_policy:character-policy:test-high");
    expect(rendered).toContain("character_directness: direct");
    expect(rendered).toContain("character_initiative_posture: high_detail");
    expect(rendered).toContain("character_can_relax_approval_boundary: false");
    expect(rendered).toContain("character_can_grant_autonomy: false");
    expect(rendered).toContain("runtime_control_allowed: false");
    expect(rendered).toContain("approval_mode: disallowed");
    expect(rendered).not.toContain("caution_level");
    expect(rendered).not.toContain("stall_flexibility");
    expect(rendered).not.toContain("communication_directness");
    expect(rendered).not.toContain("proactivity_level");
  });
});
