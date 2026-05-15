import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("pulseed", async () => {
  const channelPolicy = await import("../../../src/runtime/gateway/channel-policy.js");
  return {
    buildChannelPolicyMetadata: channelPolicy.buildChannelPolicyMetadata,
    buildExternalSurfaceDecision: channelPolicy.buildExternalSurfaceDecision,
    evaluateChannelAccess: channelPolicy.evaluateChannelAccess,
    resolveChannelRoute: channelPolicy.resolveChannelRoute,
  };
});

import type { WhatsAppWebhookConfig } from "../src/config.js";
import type { WhatsAppCloudClient } from "../src/whatsapp-client.js";
import { WhatsAppWebhookServer } from "../src/webhook-server.js";
import { createJsonPostRequest, createMockServerResponse } from "../../../tests/helpers/http-mocks.js";

function createPayload(from: string): unknown {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: "msg-1",
                  from,
                  timestamp: "1",
                  type: "text",
                  text: { body: "PulSeed を再起動して" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("WhatsAppWebhookServer", () => {
  const config: WhatsAppWebhookConfig = {
    phone_number_id: "phone-1",
    access_token: "token-1",
    verify_token: "verify-1",
    recipient_id: "15551234567",
    identity_key: "whatsapp:ops",
    runtime_control_allowed_sender_ids: ["15551234567"],
    host: "127.0.0.1",
    port: 8788,
    path: "/webhook",
  };

  let client: Pick<WhatsAppCloudClient, "sendTextMessage">;

  beforeEach(() => {
    client = {
      sendTextMessage: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("marks runtime control approved for configured WhatsApp sender ids", async () => {
    const fetchChatReply = vi.fn().mockResolvedValue("ok");
    const server = new WhatsAppWebhookServer(config, client as WhatsAppCloudClient, fetchChatReply);
    const { res, done } = createMockServerResponse();

    await server.handleRequest(createJsonPostRequest(createPayload("15551234567"), "/webhook"), res);
    await done;

    await vi.waitFor(() => {
      expect(fetchChatReply).toHaveBeenCalledWith(
        expect.objectContaining({
          sender_id: "15551234567",
          externalSurface: expect.objectContaining({
            runtime_control_policy: expect.objectContaining({ approval_mode: "preapproved" }),
          }),
          metadata: expect.objectContaining({ runtime_control_approved: true }),
        })
      );
    });
  });

  it("does not approve runtime control for unconfigured WhatsApp sender ids", async () => {
    const fetchChatReply = vi.fn().mockResolvedValue("ok");
    const server = new WhatsAppWebhookServer(config, client as WhatsAppCloudClient, fetchChatReply);
    const { res, done } = createMockServerResponse();

    await server.handleRequest(createJsonPostRequest(createPayload("15550000000"), "/webhook"), res);
    await done;

    await vi.waitFor(() => {
      expect(fetchChatReply).toHaveBeenCalledWith(
        expect.objectContaining({
          sender_id: "15550000000",
          metadata: expect.not.objectContaining({ runtime_control_approved: true }),
        })
      );
    });
  });
});
