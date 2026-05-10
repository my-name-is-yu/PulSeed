import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import { createHmac } from "node:crypto";
import { dispatchGatewayChatInput } from "../chat-session-dispatch.js";
import { WhatsAppGatewayAdapter, type WhatsAppGatewayConfig } from "../whatsapp-gateway-adapter.js";
import { MAX_HTTP_BODY_SIZE } from "../../http-body.js";

vi.mock("../chat-session-dispatch.js", () => ({
  dispatchGatewayChatInput: vi.fn().mockResolvedValue("WhatsApp reply"),
}));

beforeEach(() => {
  vi.mocked(dispatchGatewayChatInput).mockReset();
  vi.mocked(dispatchGatewayChatInput).mockResolvedValue("WhatsApp reply");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WhatsAppGatewayAdapter", () => {
  it("exposes explicit unsupported typing capability", async () => {
    const adapter = new WhatsAppGatewayAdapter(makeConfig());
    const session = await adapter.typingIndicator.start({
      platform: "whatsapp",
      conversation_id: "15551234567",
    });

    expect(adapter.typingIndicator.status).toBe("unsupported");
    expect(adapter.typingIndicator.reason).toContain("no native typing endpoint");
    expect(session.status).toBe("unsupported");
  });

  it("uses limited display fallback without progress fanout and chunks final output", async () => {
    const sentBodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: { body?: string } };
      sentBodies.push(body.text?.body ?? "");
      return okResponse({});
    }));
    vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async (input) => {
      await input.onEvent?.({ ...eventBase, type: "activity", kind: "tool", message: "Running noisy tool" });
      await input.onEvent?.({
        ...eventBase,
        type: "tool_start",
        toolCallId: "tool-1",
        toolName: "rg",
        args: {},
      });
      await input.onEvent?.({
        ...eventBase,
        type: "assistant_final",
        text: `${"a".repeat(4_096)}b`,
        persisted: true,
      });
      return "fallback should not send";
    });
    const adapter = new WhatsAppGatewayAdapter({
      ...makeConfig(),
      recipient_id: "15551234567",
    });

    await (adapter as unknown as {
      processMessage(message: { id: string; from: string; text: { body: string }; type: string }): Promise<void>;
    }).processMessage({
      id: "wamid-1",
      from: "15557654321",
      type: "text",
      text: { body: "hello" },
    });

    expect(sentBodies).toEqual(["a".repeat(4_096), "b"]);
  });

  it("returns 413 for oversized webhook bodies", async () => {
    const adapter = new WhatsAppGatewayAdapter({ ...makeConfig(), port: 0 });
    await adapter.start();
    try {
      const result = await postRaw(getListeningPort(adapter), "/webhook", "x".repeat(MAX_HTTP_BODY_SIZE + 1));

      expect(result.status).toBe(413);
      expect(JSON.parse(result.body)).toEqual({ error: "payload_too_large" });
      expect(dispatchGatewayChatInput).not.toHaveBeenCalled();
    } finally {
      await adapter.stop();
    }
  });

  it("verifies signed non-ASCII webhook bodies", async () => {
    const appSecret = "secret-1";
    const body = JSON.stringify({
      entry: [{
        changes: [{
          value: {
            messages: [{
              id: "wamid-1",
              from: "15557654321",
              type: "text",
              text: { body: "hello \u3042" },
            }],
          },
        }],
      }],
    });
    const signature = createHmac("sha256", appSecret).update(body).digest("hex");
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({})));
    const adapter = new WhatsAppGatewayAdapter({
      ...makeConfig(),
      app_secret: appSecret,
      port: 0,
    });
    await adapter.start();
    try {
      const result = await postRawChunks(
        getListeningPort(adapter),
        "/webhook",
        splitUtf8Body(body, "\u3042"),
        { "x-hub-signature-256": `sha256=${signature}` }
      );

      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ ok: true });
    } finally {
      await adapter.stop();
    }
  });
});

function makeConfig(): WhatsAppGatewayConfig {
  return {
    phone_number_id: "phone-1",
    access_token: "token-1",
    verify_token: "verify-1",
    recipient_id: "15551234567",
    identity_key: "whatsapp:user",
    allowed_sender_ids: [],
    denied_sender_ids: [],
    runtime_control_allowed_sender_ids: [],
    sender_goal_map: {},
    host: "127.0.0.1",
    port: 8788,
    path: "/webhook",
  };
}

const eventBase = {
  runId: "run-1",
  turnId: "turn-1",
  createdAt: "2026-05-07T00:00:00.000Z",
};

function okResponse(payload: unknown): Response {
  return {
    ok: true,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

function getListeningPort(adapter: WhatsAppGatewayAdapter): number {
  const server = (adapter as unknown as { server: http.Server | null }).server;
  const address = server?.address();
  if (address === null || typeof address !== "object") {
    throw new Error("expected test server to be listening on a TCP port");
  }
  return address.port;
}

function postRaw(port: number, requestPath: string, body: string): Promise<{ status: number; body: string }> {
  return postRawChunks(port, requestPath, [Buffer.from(body, "utf-8")]);
}

function postRawChunks(
  port: number,
  requestPath: string,
  chunks: Buffer[],
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const contentLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
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
