import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ZodSchema } from "zod";
import { StateManager } from "../../base/state/state-manager.js";
import { buildLLMClient } from "../../base/llm/provider-factory.js";
import { loadProviderConfig } from "../../base/llm/provider-config.js";
import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamHandlers,
} from "../../base/llm/llm-client.js";
import type { IAdapter, AgentResult, AgentTask } from "../../orchestrator/execution/adapter-layer.js";
import { CrossPlatformChatSessionManager } from "../../interface/chat/cross-platform-session.js";
import type { ChatEvent } from "../../interface/chat/chat-events.js";
import { ToolRegistry } from "../../tools/registry.js";
import { dispatchGatewayChatInput } from "./chat-session-dispatch.js";
import {
  clearRegisteredGatewayChatSessionPort,
  registerGatewayChatSessionPort,
} from "./chat-session-port.js";
import {
  TELEGRAM_GATEWAY_DISPLAY_CONTRACT,
  createGatewayDisplayPolicy,
} from "./channel-display-policy.js";
import {
  TELEGRAM_SEEDY_PRESENCE_CONTRACT,
  resolveGatewayChannelPresenceContract,
} from "./channel-presence-policy.js";
import {
  NonTuiDisplayProjector,
  type NonTuiDisplayMessageRef,
  type NonTuiDisplayTransport,
} from "./non-tui-display-projector.js";
import {
  SeedyPresenceProjector,
  createSeedyPresenceTransportFromNonTuiDisplay,
} from "./seedy-presence-projector.js";

const RUNS = 3;
const THRESHOLD_MS = 2_000;

interface SmokeRecord {
  run: number;
  input: string;
  inbound_admitted_at: string;
  first_model_request_started_at: string | null;
  first_assistant_delta_received_at: string | null;
  first_telegram_send_or_edit_attempted_at: string | null;
  first_telegram_visible_text_confirmed_or_api_returned_at: string | null;
  first_telegram_visible_text_confirmed_or_api_returned_ms: number | null;
  first_visible_transport_text: {
    kind: string;
    content_summary: string;
  } | null;
  result_summary: string | null;
}

class TimingLLMClient implements ILLMClient {
  firstModelRequestAt: Date | null = null;
  firstModelRequestAtMs: number | null = null;

  constructor(private readonly inner: ILLMClient) {}

  supportsToolCalling(): boolean {
    return this.inner.supportsToolCalling?.() ?? true;
  }

  usesExternalAgentRuntime(): boolean {
    return this.inner.usesExternalAgentRuntime?.() ?? false;
  }

  async sendMessage(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse> {
    this.markFirstRequest();
    return this.inner.sendMessage(messages, options);
  }

  async sendMessageStream(
    messages: LLMMessage[],
    options: LLMRequestOptions | undefined,
    handlers: LLMStreamHandlers,
  ): Promise<LLMResponse> {
    this.markFirstRequest();
    if (this.inner.sendMessageStream) {
      return this.inner.sendMessageStream(messages, options, handlers);
    }
    const response = await this.inner.sendMessage(messages, options);
    if (response.content) handlers.onTextDelta?.(response.content);
    return response;
  }

  parseJSON<T>(content: string, schema: ZodSchema<T>): T {
    return this.inner.parseJSON(content, schema);
  }

  private markFirstRequest(): void {
    if (this.firstModelRequestAtMs !== null) return;
    this.firstModelRequestAtMs = Date.now();
    this.firstModelRequestAt = new Date(this.firstModelRequestAtMs);
  }
}

class NullAdapter implements IAdapter {
  readonly adapterType = "null";

  async execute(_task: AgentTask): Promise<AgentResult> {
    return {
      success: false,
      output: "Adapter fallback is disabled for the direct-chat latency smoke.",
      error: "adapter fallback disabled",
      exit_code: 1,
      elapsed_ms: 0,
      stopped_reason: "error",
    };
  }
}

interface TransportCall {
  kind: "progress_send" | "progress_edit" | "progress_delete" | "final_send" | "final_edit";
  text: string;
  attemptedAt: Date;
  apiReturnedAt: Date;
}

function createRecordingTransport(): NonTuiDisplayTransport & { calls: TransportCall[] } {
  let nextId = 0;
  const calls: TransportCall[] = [];
  const push = (kind: TransportCall["kind"], text: string): NonTuiDisplayMessageRef => {
    const attemptedAt = new Date();
    nextId += 1;
    calls.push({ kind, text, attemptedAt, apiReturnedAt: new Date() });
    return { id: `${kind}-${nextId}` };
  };
  return {
    calls,
    sendProgress: async (text) => push("progress_send", text),
    editProgress: async (_ref, text) => { push("progress_edit", text); },
    deleteProgress: async () => { push("progress_delete", ""); },
    sendFinal: async (text) => push("final_send", text),
    editFinal: async (_ref, text) => { push("final_edit", text); },
  };
}

async function runOne(input: {
  manager: CrossPlatformChatSessionManager;
  llmClient: TimingLLMClient;
  index: number;
  cwd: string;
}): Promise<SmokeRecord> {
  const transport = createRecordingTransport();
  const displayProjector = new NonTuiDisplayProjector({
    display: {
      capabilities: TELEGRAM_GATEWAY_DISPLAY_CONTRACT.capabilities,
      policy: {
        ...createGatewayDisplayPolicy(TELEGRAM_GATEWAY_DISPLAY_CONTRACT.capabilities),
        progressSurface: "editable",
        finalSurface: "edit_stream",
        cleanupPolicy: "collapse",
      },
    },
    transport,
  });
  const presenceProjector = new SeedyPresenceProjector({
    presence: resolveGatewayChannelPresenceContract(TELEGRAM_SEEDY_PRESENCE_CONTRACT),
    transport: createSeedyPresenceTransportFromNonTuiDisplay(transport),
  });

  input.llmClient.firstModelRequestAt = null;
  input.llmClient.firstModelRequestAtMs = null;
  let firstAssistantDeltaAtMs: number | null = null;
  const text = "やあ！";
  const startAt = new Date();
  const result = await dispatchGatewayChatInput({
    text,
    platform: "telegram",
    identity_key: "smoke-local-user",
    conversation_id: "smoke-local-chat",
    sender_id: "smoke-local-user",
    message_id: `smoke-${input.index}`,
    cwd: input.cwd,
    onEvent: async (event) => {
      const chatEvent = event as unknown as ChatEvent;
      if (chatEvent.type === "assistant_delta" && chatEvent.text.trim().length > 0 && firstAssistantDeltaAtMs === null) {
        firstAssistantDeltaAtMs = Date.now();
      }
      await displayProjector.handle(chatEvent);
      await presenceProjector.prepareForEvent(chatEvent);
      await presenceProjector.handle(chatEvent, {
        assistantOutputRendered: displayProjector.deliveredAssistantOutput,
        meaningfulProgressRendered: displayProjector.deliveredProgressOutput,
      });
    },
    metadata: {
      fake_telegram_like_inbound_admission_at: startAt.toISOString(),
    },
  });

  await presenceProjector.stop();
  const firstVisible = transport.calls.find((call) => (
    call.kind === "final_send" || call.kind === "final_edit"
  ));
  return {
    run: input.index,
    input: text,
    inbound_admitted_at: startAt.toISOString(),
    first_model_request_started_at: input.llmClient.firstModelRequestAtMs !== null
      ? new Date(input.llmClient.firstModelRequestAtMs).toISOString()
      : null,
    first_assistant_delta_received_at: firstAssistantDeltaAtMs !== null
      ? new Date(firstAssistantDeltaAtMs).toISOString()
      : null,
    first_telegram_send_or_edit_attempted_at: firstVisible?.attemptedAt.toISOString() ?? null,
    first_telegram_visible_text_confirmed_or_api_returned_at: firstVisible?.apiReturnedAt.toISOString() ?? null,
    first_telegram_visible_text_confirmed_or_api_returned_ms: firstVisible ? firstVisible.apiReturnedAt.getTime() - startAt.getTime() : null,
    first_visible_transport_text: firstVisible
      ? {
          kind: firstVisible.kind,
          content_summary: summarize(firstVisible.text),
        }
      : null,
    result_summary: result ? summarize(result) : null,
  };
}

async function main(): Promise<number> {
  const providerConfigBase = process.env["PULSEED_DIRECT_CHAT_SMOKE_PROVIDER_HOME"]
    ?? path.join(os.homedir(), ".pulseed");
  const providerConfig = await loadProviderConfig({
    baseDir: providerConfigBase,
    saveMigration: false,
  });
  const home = process.env["PULSEED_HOME"] || fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-direct-chat-smoke-"));
  fs.mkdirSync(home, { recursive: true });
  process.env["PULSEED_HOME"] = home;
  const stateManager = new StateManager(home, undefined, { walEnabled: false });
  await stateManager.init();
  const llmClient = new TimingLLMClient(await buildLLMClient(providerConfig));
  const manager = new CrossPlatformChatSessionManager({
    stateManager,
    adapter: new NullAdapter(),
    llmClient,
    registry: new ToolRegistry(),
    runtimeEvidenceGateClient: {
      ...llmClient,
      sendMessage: async () => {
        throw new Error("Runtime evidence gate must not run for ordinary gateway direct chat.");
      },
      sendMessageStream: undefined,
    } as unknown as ILLMClient,
  });
  registerGatewayChatSessionPort(async () => manager);
  try {
    const records: SmokeRecord[] = [];
    for (let index = 1; index <= RUNS; index++) {
      records.push(await runOne({ manager, llmClient, index, cwd: process.cwd() }));
    }
    const failed = records.filter((record) =>
      record.first_telegram_visible_text_confirmed_or_api_returned_ms === null
      || record.first_telegram_visible_text_confirmed_or_api_returned_ms > THRESHOLD_MS
      || record.first_assistant_delta_received_at === null
      || (record.result_summary?.startsWith("Error:") ?? false)
      || (record.first_visible_transport_text?.content_summary.startsWith("Error:") ?? false)
    );
    console.log(JSON.stringify({
      status: failed.length === 0 ? "passed" : "failed",
      threshold_ms: THRESHOLD_MS,
      pulseed_home: home,
      provider_config_home: providerConfigBase,
      telegram_delivery_included: false,
      start_boundary: "fake_telegram_like_inbound_admission_before_dispatchGatewayChatInput",
      runs: records,
    }, null, 2));
    return failed.length === 0 ? 0 : 1;
  } finally {
    clearRegisteredGatewayChatSessionPort();
  }
}

function summarize(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(JSON.stringify({
    status: "error",
    message: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
