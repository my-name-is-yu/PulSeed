import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRunner } from "../chat-runner.js";
import { ChatSessionCatalog } from "../chat-session-store.js";
import { ChatSessionDataStore } from "../chat-session-data-store.js";
import { resolveChatStateBaseDir } from "../chat-state-base-dir.js";
import type { ChatRunnerDeps } from "../chat-runner-contracts.js";
import type { SelectedChatRoute } from "../ingress-router.js";
import type { AgentResult } from "../../../orchestrator/execution/adapter-layer.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import { upsertRelationshipProfileItem } from "../../../platform/profile/relationship-profile.js";
import {
  CompanionCognitionService,
  createRelationshipProfileCognitionMemoryPort,
  type CompanionCognitionInput,
} from "../../../runtime/cognition/index.js";
import { PersonalAgentRuntimeStore } from "../../../runtime/personal-agent/index.js";

vi.mock("../../../platform/observation/context-provider.js", () => ({
  resolveGitRoot: (cwd: string) => cwd,
  buildChatContext: (_task: string, cwd: string) => Promise.resolve(`Working directory: ${cwd}`),
}));

const originalPulseedHome = process.env["PULSEED_HOME"];
let testHome: string | null = null;

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-cognition-chat-"));
  process.env["PULSEED_HOME"] = testHome;
});

afterEach(() => {
  if (originalPulseedHome === undefined) {
    delete process.env["PULSEED_HOME"];
  } else {
    process.env["PULSEED_HOME"] = originalPulseedHome;
  }
  if (testHome) {
    fs.rmSync(testHome, { recursive: true, force: true });
    testHome = null;
  }
});

describe("chat caller path cognition integration", () => {
  it("records shadow cognition for production ChatRunner agent-loop turns", async () => {
    const stateManager = makeStateManager();
    await upsertRelationshipProfileItem(stateManager.getBaseDir(), {
      stableKey: "chat.status_style",
      kind: "preference",
      value: "Prefer direct implementation progress updates.",
      source: "cli_update",
      allowedScopes: ["memory_retrieval"],
      sensitivity: "private",
      now: "2026-05-14T00:00:00.000Z",
    });
    await upsertRelationshipProfileItem(stateManager.getBaseDir(), {
      stableKey: "chat.status_boundary",
      kind: "boundary",
      value: "Avoid emotionally escalated status language.",
      source: "cli_update",
      allowedScopes: ["memory_retrieval"],
      sensitivity: "private",
      now: "2026-05-14T00:01:00.000Z",
    });
    const runner = new ChatRunner({
      stateManager,
      adapter: { adapterType: "mock", execute: vi.fn() } as ChatRunnerDeps["adapter"],
      chatAgentLoopRunner: {
        execute: vi.fn().mockResolvedValue(agentResult()),
      } as unknown as ChatRunnerDeps["chatAgentLoopRunner"],
    });

    const result = await runner.execute("普通の相談です", testHome!, 10_000, {
      selectedRoute: agentLoopRoute(),
    });

    expect(result.success).toBe(true);
    const session = await latestSession(stateManager);
    const cognitionRecords = session?.rolloutJournal?.filter((record) => record.kind === "cognition_audit") ?? [];
    expect(cognitionRecords).toHaveLength(1);
    expect(cognitionRecords[0]?.payload).toMatchObject({
      schema_version: "cognition-replay-record/v1",
      caller_path: "chat_user_turn",
      stable_output: {
        relationship_state: {
          relationship_refs: expect.arrayContaining([
            expect.objectContaining({
              memory_ref: expect.objectContaining({
                source_event_type: "preference",
              }),
            }),
          ]),
        },
        response_plan: {
          guidance_kind: "continue_route",
        },
      },
    });
    expect(JSON.stringify(cognitionRecords[0]?.payload)).not.toContain("Prefer direct implementation progress updates.");
    expect(JSON.stringify(cognitionRecords[0]?.payload)).not.toContain("Avoid emotionally escalated status language.");
    const store = new PersonalAgentRuntimeStore(stateManager.getBaseDir(), { controlBaseDir: stateManager.getBaseDir() });
    const planId = (cognitionRecords[0]?.payload as { stable_output?: { response_plan?: { plan_id?: string } } })
      .stable_output?.response_plan?.plan_id;
    expect(planId).toBeDefined();
    const recorded = await store.loadTrace(planId!);
    expect(recorded?.situation_frame?.conflict_refs.length).toBeGreaterThan(0);
    expect(recorded?.memory_audits.some((audit) => audit.conflict_refs.length > 0)).toBe(true);
    expect(recorded?.memory_audits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "read",
        allowed_uses: ["runtime_grounding"],
        lifecycle: "active",
        correction_state: "current",
        invalidated: false,
        source_kind: "semantic",
        relationship_role: expect.stringMatching(/^(preference|boundary)$/),
        confidence: expect.any(Number),
        surface_projection_ref: expect.stringContaining("surface:relationship-profile:chat"),
      }),
    ]));
  });

  it("uses the same cognition contract for gateway model-loop turns", async () => {
    const stateManager = makeStateManager();
    const service = new CompanionCognitionService();
    const evaluateTurn = vi.fn((input: CompanionCognitionInput) => service.evaluateTurn(input));
    const runner = new ChatRunner({
      stateManager,
      adapter: { adapterType: "mock", execute: vi.fn() } as ChatRunnerDeps["adapter"],
      llmClient: makeLlmClient("gateway reply"),
      companionCognitionService: { evaluateTurn },
    });

    const result = await runner.execute("普通の相談です", testHome!, 10_000, {
      selectedRoute: gatewayModelLoopRoute(),
    });

    expect(result.success).toBe(true);
    expect(evaluateTurn).toHaveBeenCalledOnce();
    expect(evaluateTurn.mock.calls[0]?.[0]).toMatchObject({
      caller_path: "chat_user_turn",
      session_context: {
        route_kind: "gateway_model_loop",
      },
      memory_context_request: {
        caller_path: "chat_user_turn",
        side_effect_authorization_allowed: false,
        include_sensitive_content: false,
      },
    });
    const session = await latestSession(stateManager);
    const cognitionRecords = session?.rolloutJournal?.filter((record) => record.kind === "cognition_audit") ?? [];
    expect(cognitionRecords).toHaveLength(1);
  });

  it("fails closed before agent execution when durable personal-agent trace persistence fails", async () => {
    const stateManager = makeStateManager();
    const agentLoopRunner = {
      execute: vi.fn().mockResolvedValue(agentResult()),
    } as unknown as ChatRunnerDeps["chatAgentLoopRunner"];
    const recordTrace = vi.fn().mockRejectedValue(new Error("trace store unavailable"));
    const runner = new ChatRunner({
      stateManager,
      adapter: { adapterType: "mock", execute: vi.fn() } as ChatRunnerDeps["adapter"],
      chatAgentLoopRunner: agentLoopRunner,
      personalAgentRuntime: { recordTrace },
    });

    const result = await runner.execute("普通の相談です", testHome!, 10_000, {
      selectedRoute: agentLoopRoute(),
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("durable SituationFrame");
    expect(recordTrace).toHaveBeenCalledOnce();
    expect(agentLoopRunner?.execute).not.toHaveBeenCalled();
    const session = await latestSession(stateManager);
    const cognitionRecords = session?.rolloutJournal?.filter((record) => record.kind === "cognition_audit") ?? [];
    expect(cognitionRecords[0]?.payload).toMatchObject({
      failure: {
        message: "trace store unavailable",
        retryable: true,
      },
    });
  });

  it("routes gateway reply-target memory through Surface projection on the ChatRunner caller path", async () => {
    const stateManager = makeStateManager();
    await upsertRelationshipProfileItem(stateManager.getBaseDir(), {
      stableKey: "gateway.status_style",
      kind: "preference",
      value: "Prefer terse gateway replies when nothing needs tools.",
      source: "cli_update",
      allowedScopes: ["memory_retrieval"],
      sensitivity: "private",
      now: "2026-05-14T00:00:00.000Z",
    });
    const service = new CompanionCognitionService({
      memoryPort: createRelationshipProfileCognitionMemoryPort({
        baseDir: stateManager.getBaseDir(),
        now: () => new Date("2026-05-14T00:00:00.000Z"),
      }),
    });
    const evaluateTurn = vi.fn((input: CompanionCognitionInput) => service.evaluateTurn(input));
    const runner = new ChatRunner({
      stateManager,
      adapter: { adapterType: "mock", execute: vi.fn() } as ChatRunnerDeps["adapter"],
      llmClient: makeLlmClient("gateway reply"),
      runtimeReplyTarget: {
        surface: "gateway",
        platform: "telegram",
        conversation_id: "chat-42",
        message_id: "message-7",
        deliveryMode: "reply",
      } as ChatRunnerDeps["runtimeReplyTarget"],
      companionCognitionService: { evaluateTurn },
    });

    const result = await runner.execute("普通の相談です", testHome!, 10_000, {
      selectedRoute: gatewayModelLoopRoute(),
    });

    expect(result.success).toBe(true);
    expect(evaluateTurn).toHaveBeenCalledOnce();
    expect(evaluateTurn.mock.calls[0]?.[0]).toMatchObject({
      working_context: {
        route_ref: { kind: "chat_route", ref: "gateway_model_loop" },
        reply_target_ref: {
          kind: "gateway_reply_target",
          ref: "gateway:telegram:chat-42:message-7:reply",
        },
      },
      session_context: {
        route_kind: "gateway_model_loop",
      },
      memory_context_request: {
        surface_projection_required: true,
      },
    });
    const session = await latestSession(stateManager);
    const cognitionRecords = session?.rolloutJournal?.filter((record) => record.kind === "cognition_audit") ?? [];
    const payload = cognitionRecords[0]?.payload;
    expect(payload).toMatchObject({
      stable_output: {
        relationship_state: {
          relationship_refs: [{
            memory_ref: {
              source_store: "profile",
              source_event_type: "preference",
            },
            surface_projection_ref: expect.stringContaining("surface:relationship-profile:chat"),
          }],
        },
      },
    });
    expect(JSON.stringify(payload)).not.toContain("Prefer terse gateway replies when nothing needs tools.");
  });

  it("keeps slash command early returns pre-cognition", async () => {
    const evaluateTurn = vi.fn();
    const runner = new ChatRunner({
      stateManager: makeStateManager(),
      adapter: { adapterType: "mock", execute: vi.fn() } as ChatRunnerDeps["adapter"],
      companionCognitionService: { evaluateTurn },
    });

    const result = await runner.execute("/help", testHome!, 10_000);

    expect(result.success).toBe(true);
    expect(evaluateTurn).not.toHaveBeenCalled();
  });
});

function makeStateManager(): StateManager {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-cognition-state-"));
  return {
    getBaseDir: vi.fn().mockReturnValue(baseDir),
    writeRaw: vi.fn().mockResolvedValue(undefined),
    readRaw: vi.fn().mockResolvedValue(null),
    listTasks: vi.fn().mockResolvedValue([]),
  } as unknown as StateManager;
}

async function latestSession(stateManager: StateManager) {
  const catalog = new ChatSessionCatalog(stateManager);
  const sessions = await catalog.listSessions();
  const first = sessions[0];
  if (!first) return null;
  return new ChatSessionDataStore(resolveChatStateBaseDir(stateManager)).load(first.id);
}

function agentLoopRoute(): SelectedChatRoute {
  return {
    kind: "agent_loop",
    reason: "agent_loop_available",
    replyTargetPolicy: "turn_reply_target",
    eventProjectionPolicy: "turn_only",
    concurrencyPolicy: "session_serial",
  };
}

function gatewayModelLoopRoute(): SelectedChatRoute {
  return {
    kind: "gateway_model_loop",
    reason: "direct_model_tool_loop",
    replyTargetPolicy: "turn_reply_target",
    eventProjectionPolicy: "turn_only",
    concurrencyPolicy: "session_serial",
  };
}

function agentResult(): AgentResult {
  return {
    success: true,
    output: "了解しました。",
    error: null,
    exit_code: 0,
    elapsed_ms: 10,
    stopped_reason: "completed",
  };
}

function makeLlmClient(content: string): ILLMClient {
  return {
    sendMessage: vi.fn().mockResolvedValue({
      content,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
      stop_reason: "end_turn",
    }),
    parseJSON: vi.fn((raw: string) => JSON.parse(raw)),
    supportsToolCalling: () => true,
  } as unknown as ILLMClient;
}
