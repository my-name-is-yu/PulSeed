import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { CrossPlatformChatSessionManager } from "../../../interface/chat/cross-platform-session.js";
import type { ChatRunnerDeps } from "../../../interface/chat/chat-runner.js";
import type { AgentResult, IAdapter } from "../../../orchestrator/execution/adapter-layer.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { createSetupRuntimeControlTools } from "../../../tools/runtime/SetupRuntimeControlTools.js";
import type { ITool } from "../../../tools/types.js";
import { RuntimeControlService } from "../../control/runtime-control-service.js";
import { RuntimeControlOperationSchema } from "../../store/runtime-operation-schemas.js";
import { RuntimeOperationStore } from "../../store/runtime-operation-store.js";
import type { Envelope } from "../../types/envelope.js";
import { createEnvelope } from "../../types/envelope.js";
import type { ChannelAdapter, EnvelopeHandler, ReplyChannel } from "../channel-adapter.js";
import { dispatchGatewayChatInput } from "../chat-session-dispatch.js";
import {
  clearRegisteredGatewayChatSessionPort,
  registerGatewayChatSessionPort,
} from "../chat-session-port.js";
import { normalizeExternalSurfaceDecision } from "../channel-policy.js";
import { IngressGateway } from "../ingress-gateway.js";

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

function createMockAdapter(name: string): ChannelAdapter & {
  emitEnvelope: (e: Envelope, reply?: ReplyChannel) => Promise<void>;
} {
  let handler: EnvelopeHandler | null = null;
  return {
    name,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onEnvelope(h: EnvelopeHandler) { handler = h; },
    async emitEnvelope(e: Envelope, reply?: ReplyChannel) {
      await handler?.(e, reply);
    },
  };
}

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

function makeRegistryWithTools(tools: ITool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

function makeStreamingLLMClient(responses: Array<{
  content: string;
  stop_reason?: "end_turn" | "tool_calls";
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}>) {
  const sendMessageStream = vi.fn();
  for (const response of responses) {
    sendMessageStream.mockResolvedValueOnce({
      content: response.content,
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: response.stop_reason ?? "end_turn",
      tool_calls: response.tool_calls ?? [],
    });
  }
  return {
    sendMessage: vi.fn().mockRejectedValue(new Error("unexpected non-stream model request")),
    sendMessageStream,
    supportsToolCalling: vi.fn(() => true),
    parseJSON: vi.fn(),
  };
}

describe("IngressGateway runtime-control contract", () => {
  it("persists the current gateway turn reply target and operation through real runtime control", async () => {
    const tmpDir = makeTempDir("pulseed-ingress-runtime-control-contract-");
    try {
      const stateManager = makeMockStateManager();
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const executor = vi.fn().mockImplementation(async (operation) => ({
        ok: true,
        state: "acknowledged",
        message: `${operation.kind} queued`,
      }));
      const runtimeControlService = new RuntimeControlService({
        operationStore,
        executor,
      });
      const llmClient = makeStreamingLLMClient([
        {
          content: "",
          stop_reason: "tool_calls",
          tool_calls: [{
            id: "call-restart-gateway",
            type: "function",
            function: {
              name: "request_runtime_control",
              arguments: JSON.stringify({
                operation: "restart_gateway",
                reason: "gateway を再起動して",
              }),
            },
          }],
        },
        { content: "gateway restart queued" },
        {
          content: "",
          stop_reason: "tool_calls",
          tool_calls: [{
            id: "call-restart-daemon",
            type: "function",
            function: {
              name: "request_runtime_control",
              arguments: JSON.stringify({
                operation: "restart_daemon",
                reason: "PulSeed を再起動して",
              }),
            },
          }],
        },
        { content: "daemon restart queued" },
      ]);
      const adapter = createMockAdapter("test-gateway");
      const gateway = new IngressGateway({
        policies: {
          slack: {
            security: {
              allowedSenderIds: ["owner-user"],
              runtimeControlAllowedSenderIds: ["owner-user"],
            },
          },
          telegram: {
            security: {
              allowedSenderIds: ["owner-user"],
              runtimeControlAllowedSenderIds: ["owner-user"],
            },
          },
        },
      });
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        stateManager,
        llmClient: llmClient as never,
        registry: makeRegistryWithTools(createSetupRuntimeControlTools({
          stateManager,
          runtimeControlService,
        })),
        runtimeControlService,
      }));
      registerGatewayChatSessionPort(async () => manager);

      gateway.registerAdapter(adapter);
      gateway.onEnvelope(async (envelope) => {
        const payload = envelope.payload as Record<string, unknown>;
        const metadata = (envelope as Envelope & { metadata?: Record<string, unknown> }).metadata ?? {};
        const externalSurface = normalizeExternalSurfaceDecision(metadata.external_surface);
        await dispatchGatewayChatInput({
          text: String(payload["text"] ?? ""),
          platform: String(payload["platform"] ?? envelope.source),
          identity_key: String(payload["identity_key"] ?? ""),
          conversation_id: String(payload["conversation_id"] ?? ""),
          sender_id: String(payload["sender_id"] ?? ""),
          message_id: String(payload["message_id"] ?? ""),
          cwd: tmpDir,
          metadata,
          ...(externalSurface ? { externalSurface } : {}),
        });
      });

      await adapter.emitEnvelope(createEnvelope({
        type: "event",
        name: "message",
        source: "slack",
        payload: {
          text: "gateway を再起動して",
          platform: "slack",
          identity_key: "owner",
          conversation_id: "slack-thread-1",
          sender_id: "owner-user",
          message_id: "slack-msg-1",
        },
      }));
      await adapter.emitEnvelope(createEnvelope({
        type: "event",
        name: "message",
        source: "telegram",
        payload: {
          text: "PulSeed を再起動して",
          platform: "telegram",
          identity_key: "owner",
          conversation_id: "telegram-chat-1",
          sender_id: "owner-user",
          message_id: "telegram-msg-1",
        },
      }));

      expect(executor).toHaveBeenCalledTimes(2);
      const operations = await operationStore.listPending();
      expect(operations.map((operation) => RuntimeControlOperationSchema.parse(operation))).toHaveLength(2);

      const gatewayRestart = operations.find((operation) => operation.kind === "restart_gateway");
      const daemonRestart = operations.find((operation) => operation.kind === "restart_daemon");
      expect(gatewayRestart).toMatchObject({
        reason: "gateway を再起動して",
        requested_by: {
          surface: "gateway",
          platform: "slack",
          conversation_id: "slack-thread-1",
          identity_key: "owner",
          user_id: "owner-user",
        },
        reply_target: {
          surface: "gateway",
          channel: "plugin_gateway",
          platform: "slack",
          conversation_id: "slack-thread-1",
          message_id: "slack-msg-1",
          identity_key: "owner",
          user_id: "owner-user",
          metadata: {
            runtime_control_approved: true,
          },
        },
      });
      expect(daemonRestart).toMatchObject({
        reason: "PulSeed を再起動して",
        requested_by: {
          surface: "gateway",
          platform: "telegram",
          conversation_id: "telegram-chat-1",
          identity_key: "owner",
          user_id: "owner-user",
        },
        reply_target: {
          surface: "gateway",
          channel: "plugin_gateway",
          platform: "telegram",
          conversation_id: "telegram-chat-1",
          message_id: "telegram-msg-1",
          identity_key: "owner",
          user_id: "owner-user",
          metadata: {
            runtime_control_approved: true,
          },
        },
      });
      expect(daemonRestart?.reply_target.platform).not.toBe(gatewayRestart?.reply_target.platform);
      expect(daemonRestart?.reply_target.conversation_id).not.toBe(gatewayRestart?.reply_target.conversation_id);
      expect(gatewayRestart?.reply_target.metadata?.external_surface).toMatchObject({
        channel: "slack",
        conversation_scope: {
          sender_id: "owner-user",
          conversation_id: "slack-thread-1",
        },
        reply_target_policy: {
          policy: "current_turn_only",
          available: true,
        },
        notification_route_policy: {
          may_notify: false,
        },
        runtime_control_policy: {
          allowed: true,
          approval_mode: "preapproved",
        },
        autonomy_authority: {
          may_initiate: false,
        },
      });
      expect(daemonRestart?.reply_target.metadata?.external_surface).toMatchObject({
        channel: "telegram",
        conversation_scope: {
          sender_id: "owner-user",
          conversation_id: "telegram-chat-1",
        },
        notification_route_policy: {
          may_notify: false,
        },
        runtime_control_policy: {
          allowed: true,
          approval_mode: "preapproved",
        },
        autonomy_authority: {
          may_initiate: false,
        },
      });
    } finally {
      clearRegisteredGatewayChatSessionPort();
      cleanupTempDir(tmpDir);
    }
  });
});
