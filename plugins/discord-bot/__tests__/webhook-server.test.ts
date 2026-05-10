import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("pulseed", async () => {
  const gateway = await import("../../../src/runtime/gateway/index.js");
  return {
    DISCORD_GATEWAY_DISPLAY_CONTRACT: gateway.DISCORD_GATEWAY_DISPLAY_CONTRACT,
    NonTuiDisplayProjector: gateway.NonTuiDisplayProjector,
    createGatewayDisplayPolicy: gateway.createGatewayDisplayPolicy,
  };
});

import { DiscordWebhookServer } from "../src/webhook-server.js";
import type { DiscordBotConfig } from "../src/config.js";
import type { DiscordAPI } from "../src/discord-api.js";
import { createJsonPostRequest, createMockServerResponse } from "../../../tests/helpers/http-mocks.js";

describe("DiscordWebhookServer", () => {
  const config: DiscordBotConfig = {
    application_id: "app-1",
    bot_token: "Bot token",
    channel_id: "channel-1",
    identity_key: "discord:ops",
    runtime_control_allowed_sender_ids: ["user-1"],
    command_name: "pulseed",
    host: "127.0.0.1",
    port: 8787,
    ephemeral: false,
  };

  let api: Pick<DiscordAPI, "sendInteractionFollowUp">;

  beforeEach(() => {
    api = {
      sendInteractionFollowUp: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("marks runtime control approved for configured Discord sender ids", async () => {
    const fetchChatReply = vi.fn().mockResolvedValue("ok");
    const server = new DiscordWebhookServer(config, api as DiscordAPI, fetchChatReply);
    const { res, done } = createMockServerResponse();

    await server.handleRequest(
      createJsonPostRequest({
        id: "interaction-1",
        type: 2,
        token: "token-1",
        application_id: "app-1",
        channel_id: "channel-1",
        member: { user: { id: "user-1" } },
        data: { name: "pulseed", options: [{ name: "message", value: "PulSeed を再起動して" }] },
      }),
      res
    );
    await done;

    await vi.waitFor(() => {
      expect(fetchChatReply).toHaveBeenCalledWith(
        expect.objectContaining({
          sender_id: "user-1",
          metadata: expect.objectContaining({ runtime_control_approved: true }),
        })
      );
    });
  });

  it("does not approve runtime control for unconfigured Discord sender ids", async () => {
    const fetchChatReply = vi.fn().mockResolvedValue("ok");
    const server = new DiscordWebhookServer(config, api as DiscordAPI, fetchChatReply);
    const { res, done } = createMockServerResponse();

    await server.handleRequest(
      createJsonPostRequest({
        id: "interaction-2",
        type: 2,
        token: "token-2",
        application_id: "app-1",
        channel_id: "channel-1",
        member: { user: { id: "user-2" } },
        data: { name: "pulseed", options: [{ name: "message", value: "PulSeed を再起動して" }] },
      }),
      res
    );
    await done;

    await vi.waitFor(() => {
      expect(fetchChatReply).toHaveBeenCalledWith(
        expect.objectContaining({
          sender_id: "user-2",
          metadata: expect.not.objectContaining({ runtime_control_approved: true }),
        })
      );
    });
  });

  it("sends typed public progress as Discord follow-up progress without raw activity text", async () => {
    const fetchChatReply = vi.fn().mockImplementation(async (input) => {
      await input.onEvent?.({ type: "activity", kind: "lifecycle", message: "Received. Starting work..." });
      await input.onEvent?.({ type: "activity", kind: "commentary", message: "Thinking about it" });
      await input.onEvent?.({
        type: "tool_start",
        runId: "run-1",
        turnId: "turn-1",
        createdAt: "2026-05-10T00:00:00.000Z",
        toolCallId: "tool-1",
        toolName: "shell",
        args: { command: "grep - ChatEvent" },
        activityCategory: "search",
      });
      await input.onEvent?.({
        type: "tool_end",
        runId: "run-1",
        turnId: "turn-1",
        createdAt: "2026-05-10T00:00:01.000Z",
        toolCallId: "tool-1",
        toolName: "shell",
        success: true,
        summary: "raw command output",
        durationMs: 10,
        activityCategory: "search",
      });
      return "final reply";
    });
    const server = new DiscordWebhookServer(config, api as DiscordAPI, fetchChatReply);
    const { res, done } = createMockServerResponse();

    await server.handleRequest(
      createJsonPostRequest({
        id: "interaction-3",
        type: 2,
        token: "token-3",
        application_id: "app-1",
        channel_id: "channel-1",
        member: { user: { id: "user-2" } },
        data: { name: "pulseed", options: [{ name: "message", value: "check events" }] },
      }),
      res
    );
    await done;

    await vi.waitFor(() => {
      expect(api.sendInteractionFollowUp).toHaveBeenCalledTimes(2);
    });
    expect(api.sendInteractionFollowUp).toHaveBeenNthCalledWith(
      1,
      "app-1",
      "token-3",
      "Checking the workspace search so I can find the relevant evidence before answering."
    );
    expect(api.sendInteractionFollowUp).not.toHaveBeenCalledWith(
      "app-1",
      "token-3",
      expect.stringContaining("grep - ChatEvent")
    );
    expect(api.sendInteractionFollowUp).not.toHaveBeenCalledWith(
      "app-1",
      "token-3",
      expect.stringContaining("raw command output")
    );
    expect(api.sendInteractionFollowUp).toHaveBeenNthCalledWith(2, "app-1", "token-3", "final reply");
  });

  it("still sends approval-required progress after the first single-status heartbeat", async () => {
    const fetchChatReply = vi.fn().mockImplementation(async (input) => {
      await input.onEvent?.({
        type: "tool_start",
        runId: "run-1",
        turnId: "turn-1",
        createdAt: "2026-05-10T00:00:00.000Z",
        toolCallId: "tool-1",
        toolName: "shell",
        args: { command: "grep - ChatEvent" },
        activityCategory: "search",
      });
      await input.onEvent?.({
        type: "tool_update",
        runId: "run-1",
        turnId: "turn-1",
        createdAt: "2026-05-10T00:00:01.000Z",
        toolCallId: "tool-2",
        toolName: "shell",
        status: "awaiting_approval",
        message: "run a write command",
      });
      return "final reply";
    });
    const server = new DiscordWebhookServer(config, api as DiscordAPI, fetchChatReply);
    const { res, done } = createMockServerResponse();

    await server.handleRequest(
      createJsonPostRequest({
        id: "interaction-4",
        type: 2,
        token: "token-4",
        application_id: "app-1",
        channel_id: "channel-1",
        member: { user: { id: "user-2" } },
        data: { name: "pulseed", options: [{ name: "message", value: "check events" }] },
      }),
      res
    );
    await done;

    await vi.waitFor(() => {
      expect(api.sendInteractionFollowUp).toHaveBeenCalledTimes(3);
    });
    expect(api.sendInteractionFollowUp).toHaveBeenNthCalledWith(
      1,
      "app-1",
      "token-4",
      "Checking the workspace search so I can find the relevant evidence before answering."
    );
    expect(api.sendInteractionFollowUp).toHaveBeenNthCalledWith(
      2,
      "app-1",
      "token-4",
      "Approval is needed for a tool action: run a write command."
    );
    expect(api.sendInteractionFollowUp).toHaveBeenNthCalledWith(3, "app-1", "token-4", "final reply");
  });
});
