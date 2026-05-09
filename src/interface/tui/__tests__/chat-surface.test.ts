import { afterEach, describe, it, expect, vi } from "vitest";
import { StateManager } from "../../../base/state/state-manager.js";
import type { IAdapter, AgentResult } from "../../../orchestrator/execution/adapter-layer.js";
import type { ChatRunnerDeps } from "../../chat/chat-runner.js";
import type { ChatEvent } from "../../chat/chat-events.js";
import { CrossPlatformChatSessionManager } from "../../chat/cross-platform-session.js";
import { ChatSessionDataStore } from "../../chat/chat-session-data-store.js";
import { createTextUserInput } from "../../chat/user-input.js";
import { SharedManagerTuiChatSurface } from "../chat-surface.js";
import { createMockLLMClient, createSingleMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { ApprovalBroker } from "../../../runtime/approval-broker.js";
import { ApprovalStore } from "../../../runtime/store/approval-store.js";

vi.mock("../../../platform/observation/context-provider.js", () => ({
  resolveGitRoot: (cwd: string) => cwd,
  buildChatContext: (_task: string, cwd: string) => Promise.resolve(`Working directory: ${cwd}`),
}));

const CANNED_RESULT: AgentResult = {
  success: true,
  output: "Task completed successfully.",
  error: null,
  exit_code: 0,
  elapsed_ms: 50,
  stopped_reason: "completed",
};

function makeMockAdapter(result: AgentResult = CANNED_RESULT): IAdapter {
  return {
    adapterType: "mock",
    execute: vi.fn().mockResolvedValue(result),
  } as unknown as IAdapter;
}

function makeMockStateManager(): StateManager {
  return {
    writeRaw: vi.fn().mockResolvedValue(undefined),
    readRaw: vi.fn().mockResolvedValue(null),
  } as unknown as StateManager;
}

function makeDeps(overrides: Partial<ChatRunnerDeps> = {}): ChatRunnerDeps {
  return {
    stateManager: makeMockStateManager(),
    adapter: makeMockAdapter(),
    ...overrides,
  };
}

describe("SharedManagerTuiChatSurface", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      cleanupTempDir(tempDirs.pop()!);
    }
  });

	  it("keeps a stable TUI conversation id when executeIngressMessage omits one", async () => {
    const tmpDir = makeTempDir();
    tempDirs.push(tmpDir);
    const stateManager = new StateManager(tmpDir, undefined, { walEnabled: false });
    await stateManager.init();
    const surface = new SharedManagerTuiChatSurface(makeDeps({ stateManager }));
    surface.startSession("/repo");

    await surface.executeIngressMessage({
      text: "first",
      userInput: createTextUserInput("first"),
      channel: "tui",
      platform: "local_tui",
      actor: { surface: "tui", platform: "local_tui" },
      replyTarget: { surface: "tui", platform: "local_tui", metadata: {} },
      runtimeControl: { allowed: true, approvalMode: "interactive" },
      metadata: {},
    }, "/repo");

    await surface.executeIngressMessage({
      text: "second",
      userInput: createTextUserInput("second"),
      channel: "tui",
      platform: "local_tui",
      actor: { surface: "tui", platform: "local_tui" },
      replyTarget: { surface: "tui", platform: "local_tui", metadata: {} },
      runtimeControl: { allowed: true, approvalMode: "interactive" },
      metadata: {},
    }, "/repo");

    const sessions = await new ChatSessionDataStore(stateManager.getBaseDir()).list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)).toEqual(["first", "second"]);
	  });

	  it("routes runtime-control turns through the injected service", async () => {
	    const adapter = makeMockAdapter();
	    const runtimeControlService = {
	      request: vi.fn().mockResolvedValue({
	        success: true,
	        message: "restart queued",
	        operationId: "op-1",
	        state: "acknowledged",
	      }),
	    };
	    const surface = new SharedManagerTuiChatSurface(makeDeps({
	      adapter,
	      llmClient: createSingleMockLLMClient(JSON.stringify({
	        intent: "restart_daemon",
	        reason: "PulSeed を再起動して",
	      })),
	      runtimeControlService,
	      approvalFn: vi.fn().mockResolvedValue(true),
	    }));
	    surface.startSession("/repo");

	    const result = await surface.execute("PulSeed を再起動して", "/repo");

	    expect(result.success).toBe(true);
	    expect(result.output).toBe("restart queued");
	    expect(adapter.execute).not.toHaveBeenCalled();
	    expect(runtimeControlService.request).toHaveBeenCalledWith(
	      expect.objectContaining({
	        intent: expect.objectContaining({ kind: "restart_daemon" }),
	        replyTarget: expect.objectContaining({
	          surface: "tui",
	          channel: "tui",
	          platform: "local_tui",
	        }),
	      })
	    );
	  });

  it("routes local TUI approval-required turns through conversational approval", async () => {
    const tmpDir = makeTempDir();
    tempDirs.push(tmpDir);
    const store = new ApprovalStore(tmpDir);
    const approvalBroker = new ApprovalBroker({
      store,
      createId: () => "approval-tui-local",
    });
    const events: string[] = [];
    const runtimeControlService = {
      request: vi.fn(async (request: {
        approvalFn?: (description: string) => Promise<boolean>;
      }) => {
        const approved = await request.approvalFn?.("Restart the resident daemon.");
        return {
          success: approved === true,
          message: approved === true ? "restart queued" : "not approved",
          operationId: "op-tui-approval",
          state: approved === true ? "acknowledged" as const : "blocked" as const,
        };
      }),
    };
    const surface = new SharedManagerTuiChatSurface(makeDeps({
      llmClient: createMockLLMClient([
        JSON.stringify({
          intent: "restart_daemon",
          reason: "PulSeed を再起動して",
        }),
        JSON.stringify({
          decision: "approve",
          confidence: 0.94,
          rationale: "The same TUI conversation authorizes the pending restart.",
        }),
      ]),
      runtimeControlService,
      approvalBroker,
    }));
    surface.onEvent = (event) => {
      if (event.type === "activity") {
        events.push(event.message);
      }
    };
    surface.startSession("/repo");

    const resultPromise = surface.execute("PulSeed を再起動して", "/repo");
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && !events.some((message) => message.includes("Approval ID: approval-tui-local"))) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(events.some((message) =>
      message.includes("Approval required.")
      && message.includes("Restart the resident daemon.")
      && message.includes("Approval ID: approval-tui-local")
    )).toBe(true);

    await expect(surface.interruptAndRedirect("承認します。進めてください", "/repo")).resolves.toMatchObject({
      success: true,
      output: "Approval response recorded.",
    });
    await expect(resultPromise).resolves.toMatchObject({
      success: true,
      output: "restart queued",
    });
    await expect(store.loadResolved("approval-tui-local")).resolves.toMatchObject({
      state: "approved",
      response_channel: "local_tui",
      origin: expect.objectContaining({
        channel: "local_tui",
        conversation_id: surface.getConversationId(),
      }),
    });
  });

  it("emits equivalent typed UserInput for TUI and non-TUI ingress", async () => {
    const text = "Please inspect the current workspace.";
    const tuiEvents: ChatEvent[] = [];
    const gatewayEvents: ChatEvent[] = [];
    const surface = new SharedManagerTuiChatSurface(makeDeps());
    surface.onEvent = (event) => {
      tuiEvents.push(event);
    };
    surface.startSession("/repo");
    const manager = new CrossPlatformChatSessionManager(makeDeps());

    await surface.execute(text, "/repo");
    await manager.execute(text, {
      channel: "plugin_gateway",
      platform: "slack",
      conversation_id: "slack-thread-1",
      user_id: "user-1",
      message_id: "msg-1",
      onEvent: (event) => {
        gatewayEvents.push(event);
      },
    });

    const tuiStart = tuiEvents.find((event) => event.type === "lifecycle_start");
    const gatewayStart = gatewayEvents.find((event) => event.type === "lifecycle_start");
    expect(tuiStart?.userInput).toEqual(createTextUserInput(text));
    expect(gatewayStart?.userInput).toEqual(createTextUserInput(text));
    expect(gatewayStart?.userInput).toEqual(tuiStart?.userInput);
  });
	});
