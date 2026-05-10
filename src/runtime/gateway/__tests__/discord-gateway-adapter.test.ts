import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { dispatchGatewayChatInput } from "../chat-session-dispatch.js";
import { DiscordGatewayAdapter, type DiscordGatewayConfig } from "../discord-gateway-adapter.js";

vi.mock("../chat-session-dispatch.js", () => ({
  dispatchGatewayChatInput: vi.fn().mockResolvedValue("Discord reply"),
}));

beforeEach(() => {
  vi.mocked(dispatchGatewayChatInput).mockReset();
  vi.mocked(dispatchGatewayChatInput).mockResolvedValue("Discord reply");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DiscordGatewayAdapter", () => {
  it("triggers native Discord typing while processing a chat turn", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return okResponse({});
    }));
    const adapter = new DiscordGatewayAdapter(makeConfig());

    await (adapter as unknown as {
      processIncomingMessage(payload: unknown, input: Parameters<typeof dispatchGatewayChatInput>[0]): Promise<void>;
    }).processIncomingMessage(
      { application_id: "app-1", token: "token-1" },
      {
        text: "hello",
        platform: "discord",
        identity_key: "discord:user",
        conversation_id: "channel-1",
        sender_id: "user-1",
        metadata: { channel_id: "channel-1" },
      }
    );

    expect(calls).toContainEqual(expect.objectContaining({
      url: "https://discord.com/api/v10/channels/channel-1/typing",
      init: expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bot discord-token" }),
      }),
    }));
    expect(calls.some((call) => call.url.startsWith("https://discord.com/api/v10/webhooks/app-1/token-1"))).toBe(true);
  });

  it("keeps projected follow-up messages ephemeral when configured", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return okResponse({ id: `message-${calls.length}` });
    }));
    vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async (input) => {
      await input.onEvent?.({
        ...eventBase,
        type: "tool_start",
        toolCallId: "tool-1",
        toolName: "search",
        args: {},
        activityCategory: "search",
      });
      await input.onEvent?.({ ...eventBase, type: "assistant_final", text: "Done", persisted: true });
      return "Done";
    });
    const adapter = new DiscordGatewayAdapter({ ...makeConfig(), ephemeral: true });

    await (adapter as unknown as {
      processIncomingMessage(payload: unknown, input: Parameters<typeof dispatchGatewayChatInput>[0]): Promise<void>;
    }).processIncomingMessage(
      { application_id: "app-1", token: "token-1" },
      {
        text: "hello",
        platform: "discord",
        identity_key: "discord:user",
        conversation_id: "channel-1",
        sender_id: "user-1",
        metadata: { channel_id: "channel-1" },
      }
    );

    const followUpBodies = calls
      .filter((call) => call.url.startsWith("https://discord.com/api/v10/webhooks/app-1/token-1?wait=true"))
      .map((call) => JSON.parse(String(call.init?.body ?? "{}")) as { flags?: number });
    expect(followUpBodies).toHaveLength(2);
    expect(followUpBodies.every((body) => body.flags === 64)).toBe(true);
  });
});

const eventBase = {
  runId: "run-1",
  turnId: "turn-1",
  createdAt: "2026-05-07T00:00:00.000Z",
};

function makeConfig(): DiscordGatewayConfig {
  return {
    application_id: "app-1",
    bot_token: "discord-token",
    channel_id: "channel-1",
    identity_key: "discord:user",
    allowed_sender_ids: [],
    denied_sender_ids: [],
    allowed_conversation_ids: [],
    denied_conversation_ids: [],
    runtime_control_allowed_sender_ids: [],
    conversation_goal_map: {},
    sender_goal_map: {},
    command_name: "pulseed",
    host: "127.0.0.1",
    port: 8787,
    ephemeral: false,
  };
}

function okResponse(payload: unknown): Response {
  return {
    ok: true,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}
