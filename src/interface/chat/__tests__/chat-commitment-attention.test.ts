import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordChatTurnCommitmentAttention } from "../chat-commitment-attention.js";
import { ChatRunner } from "../chat-runner.js";
import { buildChatTurnContext } from "../turn-context.js";
import { createTextUserInput } from "../user-input.js";
import { StateManager } from "../../../base/state/state-manager.js";
import type { IAdapter } from "../../../orchestrator/execution/adapter-layer.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import { AttentionStateStore } from "../../../runtime/store/attention-state-store.js";
import {
  CommitmentCandidateExtractionSchema,
  type CommitmentCandidateClassifier,
} from "../../../runtime/attention/index.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-commitment-attention-"));
  tmpDirs.push(dir);
  return dir;
}

function classifier(): CommitmentCandidateClassifier {
  return {
    classify: vi.fn().mockResolvedValue(CommitmentCandidateExtractionSchema.parse({
      outcome: "candidate",
      summary: "Fix the pitch deck by tomorrow.",
      due: {
        window_start: "2026-05-18T00:00:00.000Z",
        window_end: "2026-05-18T12:00:00.000Z",
        uncertainty: "medium",
        reason: "user mentioned tomorrow",
      },
      owner: "user",
      confidence: 0.86,
      sensitivity: "internal",
      allowed_memory_use: "attention_only",
      nudge_policy: "ask_first",
      watch_vector: ["deadline", "mood_load", "related_conversation"],
      user_state: {
        high_load: true,
        tired: true,
        overreach_feedback: false,
      },
    })),
  };
}

function classifierForExtraction(input: unknown): CommitmentCandidateClassifier {
  return {
    classify: vi.fn().mockResolvedValue(CommitmentCandidateExtractionSchema.parse(input)),
  };
}

function adapter(): IAdapter {
  return {
    adapterType: "test",
    execute: vi.fn().mockResolvedValue({
      success: true,
      output: "adapter not used",
      error: null,
      exit_code: 0,
      elapsed_ms: 1,
      stopped_reason: "completed",
    }),
  };
}

function llmClient(output = "Gateway answer."): ILLMClient {
  return {
    sendMessage: vi.fn().mockResolvedValue({
      content: output,
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
    }),
    parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))) as never,
  };
}

function turnContext(text: string) {
  const startedAt = new Date("2026-05-17T00:00:00.000Z");
  return buildChatTurnContext({
    eventContext: {
      runId: "run-1",
      turnId: "turn-1",
    },
    startedAt,
    sessionId: "session-1",
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
    input: text,
    userInput: createTextUserInput(text),
    priorTurns: [],
    basePrompt: text,
    prompt: text,
    systemPrompt: "",
    agentLoopSystemPrompt: "",
    runtimeControlContext: {
      allowed: false,
      approvalMode: "disallowed",
      replyTarget: {
        surface: "gateway",
        platform: "telegram",
        conversation_id: "chat-1",
        identity_key: "telegram:user-1",
        user_id: "user-1",
        deliveryMode: "reply",
      },
    },
    executionPolicy: {
      executionProfile: "consumer",
      sandboxMode: "workspace_write",
      approvalPolicy: "on_request",
      networkAccess: false,
      workspaceRoot: "/repo",
      protectedPaths: [],
      trustProjectInstructions: true,
    },
    setupDialogue: null,
    runSpecConfirmation: null,
    setupSecretIntake: null,
    activatedTools: new Set(),
  });
}

describe("chat commitment attention bridge", () => {
  it("records from the real ChatRunner gateway caller path without changing response generation", async () => {
    const baseDir = tmpDir();
    const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
    await stateManager.init();
    const store = new AttentionStateStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
    const model = llmClient("Visible gateway response.");
    const runner = new ChatRunner({
      stateManager,
      adapter: adapter(),
      llmClient: model,
      commitmentCandidateClassifier: classifier(),
      attentionStateStore: store,
    });

    const result = await runner.executeIngressMessage({
      ingress_id: "ingress-1",
      received_at: "2026-05-17T00:00:00.000Z",
      channel: "plugin_gateway",
      platform: "telegram",
      identity_key: "telegram:user-1",
      conversation_id: "chat-1",
      message_id: "message-1",
      user_id: "user-1",
      text: "明日までにピッチ資料を直さないと。でも今日はもう疲れた",
      userInput: createTextUserInput("明日までにピッチ資料を直さないと。でも今日はもう疲れた"),
      actor: {
        surface: "gateway",
        platform: "telegram",
        conversation_id: "chat-1",
        identity_key: "telegram:user-1",
        user_id: "user-1",
      },
      runtimeControl: {
        allowed: false,
        approvalMode: "disallowed",
      },
      metadata: { gateway_message: true },
      replyTarget: {
        surface: "gateway",
        platform: "telegram",
        conversation_id: "chat-1",
        identity_key: "telegram:user-1",
        user_id: "user-1",
        deliveryMode: "reply",
      },
    }, "/repo", 30_000, {
      kind: "gateway_model_loop",
      reason: "direct_model_tool_loop",
      replyTargetPolicy: "turn_reply_target",
      eventProjectionPolicy: "turn_only",
      concurrencyPolicy: "session_serial",
    });

    expect(result).toMatchObject({
      success: true,
      output: "Visible gateway response.",
    });
    expect(model.sendMessage).toHaveBeenCalledOnce();
    await expect(store.listCommitmentCandidates({ includeTerminal: true })).resolves.toMatchObject([
      expect.objectContaining({
        summary: "Fix the pitch deck by tomorrow.",
        materialization_state: "shadow_held",
      }),
    ]);
  });

  it("records a held unresolved-intention candidate from the real chat turn context without direct notification authority", async () => {
    const baseDir = tmpDir();
    const store = new AttentionStateStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });

    const result = await recordChatTurnCommitmentAttention({
      turnContext: turnContext("明日までにピッチ資料を直さないと。でも今日はもう疲れた"),
      classifier: classifier(),
      store,
    });

    expect(result.candidate).toMatchObject({
      materialization_state: "shadow_held",
      nudge_policy: "ask_first",
      allowed_memory_use: "attention_only",
    });
    expect(result.attentionInputIntake?.accepted[0]).toMatchObject({
      source: expect.objectContaining({
        source_kind: "gateway_user_activity",
      }),
      effect_policy: {
        wake: true,
        notify: false,
        speak: false,
        act: false,
      },
    });

    const restarted = new AttentionStateStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
    await expect(restarted.listCommitmentCandidates({ includeTerminal: true })).resolves.toMatchObject([
      expect.objectContaining({
        summary: "Fix the pitch deck by tomorrow.",
        materialization_state: "shadow_held",
      }),
    ]);
    await expect(restarted.listAttentionInputs()).resolves.toMatchObject([
      expect.objectContaining({
        payload_class: "attention.commitment.candidate.shadow",
        effect_policy: expect.objectContaining({
          notify: false,
          speak: false,
          act: false,
        }),
      }),
    ]);
  });

  it("applies completion outcomes to the current stored commitment instead of creating a duplicate", async () => {
    const baseDir = tmpDir();
    const store = new AttentionStateStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
    const first = await recordChatTurnCommitmentAttention({
      turnContext: turnContext("明日までにピッチ資料を直さないと"),
      classifier: classifier(),
      store,
    });
    expect(first.candidate?.materialization_state).toBe("shadow_held");

    const completed = await recordChatTurnCommitmentAttention({
      turnContext: turnContext("それはもう終わった"),
      classifier: classifierForExtraction({
        outcome: "completion",
        target_commitment_id: first.candidate!.commitment_id,
        owner: "user",
        confidence: 0.91,
        reason: "current message explicitly marks the stored commitment done",
      }),
      store,
    });

    expect(completed.candidate).toMatchObject({
      commitment_id: first.candidate!.commitment_id,
      materialization_state: "resolved",
    });
    await expect(store.listCommitmentCandidates()).resolves.toHaveLength(0);
    await expect(store.listCommitmentCandidates({ includeTerminal: true })).resolves.toHaveLength(1);
  });

  it("does not reuse a previous commitment target when the current completion has no grounded target", async () => {
    const baseDir = tmpDir();
    const store = new AttentionStateStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
    const first = await recordChatTurnCommitmentAttention({
      turnContext: turnContext("明日までにピッチ資料を直さないと"),
      classifier: classifier(),
      store,
    });
    expect(first.candidate?.materialization_state).toBe("shadow_held");

    const ambiguous = await recordChatTurnCommitmentAttention({
      turnContext: turnContext("終わった"),
      classifier: classifierForExtraction({
        outcome: "completion",
        target_commitment_id: null,
        owner: "user",
        confidence: 0.9,
        reason: "completion wording lacked a current grounded target",
      }),
      store,
    });

    expect(ambiguous.candidate).toBeNull();
    await expect(store.listCommitmentCandidates()).resolves.toMatchObject([
      expect.objectContaining({
        commitment_id: first.candidate!.commitment_id,
        materialization_state: "shadow_held",
      }),
    ]);
  });
});
