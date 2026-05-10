import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import { webcrypto } from "node:crypto";
import { dispatchGatewayChatInput } from "../chat-session-dispatch.js";
import { DiscordGatewayAdapter, type DiscordGatewayConfig } from "../discord-gateway-adapter.js";
import { MAX_HTTP_BODY_SIZE } from "../../http-body.js";
import { createUserVisibleSeedyTurnPresence, type SeedyTurnPresencePhase } from "../../../interface/chat/seedy-turn-presence.js";

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
    const renderedText = calls
      .map((call) => JSON.parse(String(call.init?.body ?? "{}")) as { content?: string })
      .map((body) => body.content ?? "");
    expect(renderedText).toContain("Discord reply");
    expect(renderedText).not.toContain("Received.");
  });

  it("acknowledges Discord interactions while shared presence drives typing and final follow-up output", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return okResponse({ id: `message-${calls.length}` });
    }));
    vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async (input) => {
      await input.onEvent?.(presenceEvent("received"));
      await input.onEvent?.(assistantFinalEvent("Done from interaction."));
      return "Done from interaction.";
    });
    const adapter = new DiscordGatewayAdapter({ ...makeConfig(), port: 0 });
    await adapter.start();
    try {
      const result = await postRaw(getListeningPort(adapter), JSON.stringify({
        id: "interaction-1",
        type: 2,
        token: "token-1",
        application_id: "app-1",
        channel_id: "channel-1",
        user: { id: "user-1" },
        data: {
          name: "pulseed",
          options: [{ name: "message", value: "hello" }],
        },
      }));

      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ type: 5 });
      await vi.waitFor(() => {
        expect(dispatchGatewayChatInput).toHaveBeenCalledWith(expect.objectContaining({
          text: "hello",
          platform: "discord",
          conversation_id: "channel-1",
          sender_id: "user-1",
          message_id: "interaction-1",
        }));
      });
      await vi.waitFor(() => {
        const renderedText = calls
          .map((call) => JSON.parse(String(call.init?.body ?? "{}")) as { content?: string })
          .map((body) => body.content ?? "");
        expect(renderedText).toContain("Done from interaction.");
        expect(renderedText).not.toContain("Received.");
      });
      expect(calls).toContainEqual(expect.objectContaining({
        url: "https://discord.com/api/v10/channels/channel-1/typing",
        init: expect.objectContaining({ method: "POST" }),
      }));
    } finally {
      await adapter.stop();
    }
  });

  it("logs and suppresses Discord native typing failures from presence projection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url) === "https://discord.com/api/v10/channels/channel-1/typing") {
          return failedResponse(503, "typing unavailable");
        }
        return okResponse({ id: `message-${calls.length}` });
      }));
      vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async (input) => {
        await input.onEvent?.(presenceEvent("received"));
        await input.onEvent?.(assistantFinalEvent("Typing failed, but the turn completed."));
        return "Typing failed, but the turn completed.";
      });
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

      expect(warn).toHaveBeenCalledWith(
        "DiscordGatewayAdapter: typing indicator failed",
        expect.any(Error)
      );
      const renderedText = calls
        .map((call) => JSON.parse(String(call.init?.body ?? "{}")) as { content?: string })
        .map((body) => body.content ?? "");
      expect(renderedText).toContain("Typing failed, but the turn completed.");
    } finally {
      warn.mockRestore();
    }
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

  it("renders denied tool observations as blocked Discord progress", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return okResponse({ id: `message-${calls.length}` });
    }));
    vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async (input) => {
      await input.onEvent?.(deniedToolObservationEvent());
      await input.onEvent?.({ ...eventBase, type: "assistant_final", text: "Done", persisted: true });
      return "Done";
    });
    const adapter = new DiscordGatewayAdapter(makeConfig());

    await (adapter as unknown as {
      processIncomingMessage(payload: unknown, input: Parameters<typeof dispatchGatewayChatInput>[0]): Promise<void>;
    }).processIncomingMessage(
      { application_id: "app-1", token: "token-1" },
      {
        text: "run release",
        platform: "discord",
        identity_key: "discord:user",
        conversation_id: "channel-1",
        sender_id: "user-1",
        metadata: { channel_id: "channel-1" },
      }
    );

    const renderedText = calls
      .map((call) => JSON.parse(String(call.init?.body ?? "{}")) as { content?: string })
      .map((body) => body.content ?? "")
      .join("\n");
    expect(renderedText).toContain("Blocked on the requested tool action: Operator denied release execution.");
    expect(renderedText).not.toContain("Approval is needed for the requested tool action");
  });

  it("returns 413 for oversized interaction bodies", async () => {
    const adapter = new DiscordGatewayAdapter({ ...makeConfig(), port: 0 });
    await adapter.start();
    try {
      const result = await postRaw(getListeningPort(adapter), "x".repeat(MAX_HTTP_BODY_SIZE + 1));

      expect(result.status).toBe(413);
      expect(JSON.parse(result.body)).toEqual({ error: "payload_too_large" });
      expect(dispatchGatewayChatInput).not.toHaveBeenCalled();
    } finally {
      await adapter.stop();
    }
  });

  it("verifies signed non-ASCII interaction bodies", async () => {
    const body = JSON.stringify({ type: 1, locale: "\u3042" });
    const timestamp = "1710000000";
    type Ed25519KeyPair = {
      publicKey: Parameters<typeof webcrypto.subtle.exportKey>[1];
      privateKey: Parameters<typeof webcrypto.subtle.sign>[1];
    };
    const keyPair = await webcrypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"]
    ) as Ed25519KeyPair;
    const publicKeyHex = Buffer.from(await webcrypto.subtle.exportKey("raw", keyPair.publicKey)).toString("hex");
    const signature = Buffer.from(
      await webcrypto.subtle.sign(
        "Ed25519",
        keyPair.privateKey,
        new TextEncoder().encode(`${timestamp}${body}`)
      )
    ).toString("hex");
    const adapter = new DiscordGatewayAdapter({
      ...makeConfig(),
      port: 0,
      public_key_hex: publicKeyHex,
    });
    await adapter.start();
    try {
      const result = await postRawChunks(
        getListeningPort(adapter),
        splitUtf8Body(body, "\u3042"),
        {
          "x-signature-ed25519": signature,
          "x-signature-timestamp": timestamp,
        }
      );

      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ type: 1 });
    } finally {
      await adapter.stop();
    }
  });
});

const eventBase = {
  runId: "run-1",
  turnId: "turn-1",
  createdAt: "2026-05-07T00:00:00.000Z",
};

function presenceEvent(phase: SeedyTurnPresencePhase) {
  return {
    ...eventBase,
    type: "presence_update" as const,
    presence: createUserVisibleSeedyTurnPresence({
      turn_id: eventBase.turnId,
      phase,
      started_at: eventBase.createdAt,
      updated_at: eventBase.createdAt,
    }),
  };
}

function assistantFinalEvent(text: string) {
  return {
    ...eventBase,
    type: "assistant_final" as const,
    text,
    persisted: true,
  };
}

function deniedToolObservationEvent() {
  return {
    ...eventBase,
    type: "agent_timeline" as const,
    item: {
      id: "agent-timeline:observation-denied-1",
      sourceEventId: "observation-denied-1",
      sourceType: "tool_observation" as const,
      sessionId: "session-1",
      traceId: "trace-1",
      turnId: "agent-turn-1",
      goalId: "goal-1",
      createdAt: eventBase.createdAt,
      visibility: "user" as const,
      kind: "tool_observation" as const,
      callId: "call-2",
      toolName: "shell_command",
      state: "denied" as const,
      success: false,
      outputPreview: "TOOL NOT EXECUTED (approval_denied): Operator denied release execution.",
      durationMs: 3,
      observation: {
        type: "tool_observation" as const,
        callId: "call-2",
        toolName: "shell_command",
        arguments: { command: "npm run release" },
        state: "denied" as const,
        success: false,
        execution: {
          status: "not_executed" as const,
          reason: "approval_denied" as const,
          message: "Operator denied release execution.",
        },
        durationMs: 3,
        output: {
          content: "TOOL NOT EXECUTED (approval_denied): Operator denied release execution.",
        },
      },
    },
  };
}

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

function failedResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({ message: body }),
    text: async () => body,
  } as Response;
}

function getListeningPort(adapter: DiscordGatewayAdapter): number {
  const server = (adapter as unknown as { server: http.Server | null }).server;
  const address = server?.address();
  if (address === null || typeof address !== "object") {
    throw new Error("expected test server to be listening on a TCP port");
  }
  return address.port;
}

function postRaw(port: number, body: string): Promise<{ status: number; body: string }> {
  return postRawChunks(port, [Buffer.from(body, "utf-8")]);
}

function postRawChunks(
  port: number,
  chunks: Buffer[],
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const contentLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/",
        method: "POST",
        headers: {
          "Content-Length": contentLength,
          "Content-Type": "application/json",
          ...headers,
        },
      },
      (res) => {
        let responseBody = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => { responseBody += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: responseBody }));
      }
    );
    req.on("error", reject);
    writeChunks(req, chunks);
  });
}

function writeChunks(req: http.ClientRequest, chunks: Buffer[]): void {
  if (chunks.length === 0) {
    req.end();
    return;
  }
  const [first, ...rest] = chunks;
  req.write(first);
  setImmediate(() => writeChunks(req, rest));
}

function splitUtf8Body(body: string, needle: string): [Buffer, Buffer] {
  const charIndex = body.indexOf(needle);
  if (charIndex === -1) {
    throw new Error("expected body to contain split marker");
  }
  const bytes = Buffer.from(body, "utf-8");
  const splitAt = Buffer.byteLength(body.slice(0, charIndex), "utf-8") + 1;
  return [bytes.subarray(0, splitAt), bytes.subarray(splitAt)];
}
