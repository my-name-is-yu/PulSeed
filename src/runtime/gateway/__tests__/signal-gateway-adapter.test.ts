import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchGatewayChatInput } from "../chat-session-dispatch.js";
import { SignalGatewayAdapter, type SignalGatewayConfig } from "../signal-gateway-adapter.js";

vi.mock("../chat-session-dispatch.js", () => ({
  dispatchGatewayChatInput: vi.fn().mockResolvedValue("Signal reply"),
}));

beforeEach(() => {
  vi.mocked(dispatchGatewayChatInput).mockReset();
  vi.mocked(dispatchGatewayChatInput).mockResolvedValue("Signal reply");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeConfig(): SignalGatewayConfig {
  return {
    bridge_url: "http://localhost:8080",
    account: "+10000000000",
    recipient_id: "+10000000001",
    identity_key: "signal:user",
    allowed_sender_ids: [],
    denied_sender_ids: [],
    allowed_conversation_ids: [],
    denied_conversation_ids: [],
    runtime_control_allowed_sender_ids: [],
    conversation_goal_map: {},
    sender_goal_map: {},
    poll_interval_ms: 5000,
    receive_timeout_ms: 2000,
  };
}

describe("SignalGatewayAdapter", () => {
  it("exposes explicit unsupported typing capability", async () => {
    const adapter = new SignalGatewayAdapter(makeConfig());
    const session = await adapter.typingIndicator.start({
      platform: "signal",
      conversation_id: "+10000000002",
    });

    expect(adapter.typingIndicator.status).toBe("unsupported");
    expect(adapter.typingIndicator.reason).toContain("no configured typing endpoint");
    expect(session.status).toBe("unsupported");
  });

  it("does not include token-only message text in fallback message ids", () => {
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
    const adapter = new SignalGatewayAdapter(makeConfig());
    const normalized = (adapter as unknown as {
      normalizeMessage(message: unknown): { messageId: string } | null;
    }).normalizeMessage({
      sender: "+10000000002",
      timestamp: 123456,
      message: token,
    });

    expect(normalized?.messageId).not.toContain(token);
    expect(normalized?.messageId).toContain("+10000000002:123456:");
  });

  it("uses limited display fallback without progress fanout and delivers final once", async () => {
    const sentBodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/receive/")) {
        return okResponse({
          messages: [{
            id: "signal-1",
            sender: "+10000000002",
            message: "hello",
            timestamp: 123,
          }],
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { message?: string };
      sentBodies.push(body.message ?? "");
      return okResponse({});
    }));
    vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async (input) => {
      await input.onEvent?.({ ...eventBase, type: "activity", kind: "tool", message: "Running noisy tool" });
      await input.onEvent?.({ ...eventBase, type: "assistant_delta", delta: "Hel", text: "Hel" });
      await input.onEvent?.({ ...eventBase, type: "assistant_final", text: "Hello", persisted: true });
      return "fallback should not send";
    });
    const adapter = new SignalGatewayAdapter(makeConfig());

    await (adapter as unknown as { pollOnce(): Promise<void> }).pollOnce();

    expect(sentBodies).toEqual(["Hello"]);
  });

  it("does not send fallback presence for fast final answers", async () => {
    const sentBodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/receive/")) {
        return okResponse({
          messages: [{
            id: "signal-fast",
            sender: "+10000000002",
            message: "hello",
            timestamp: 123,
          }],
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { message?: string };
      sentBodies.push(body.message ?? "");
      return okResponse({});
    }));
    vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async (input) => {
      await input.onEvent?.({ ...eventBase, type: "assistant_final", text: "Fast Signal final", persisted: true });
      return "Fast Signal final";
    });
    const adapter = new SignalGatewayAdapter(makeConfig());

    await (adapter as unknown as { pollOnce(): Promise<void> }).pollOnce();

    expect(sentBodies).toEqual(["Fast Signal final"]);
  });

  it("sends one delayed fallback presence before a slow final answer", async () => {
    vi.useFakeTimers();
    try {
      const sentBodies: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes("/receive/")) {
          return okResponse({
            messages: [{
              id: "signal-slow",
              sender: "+10000000002",
              message: "slow please",
              timestamp: 123,
            }],
          });
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as { message?: string };
        sentBodies.push(body.message ?? "");
        return okResponse({});
      }));
      const dispatchStarted = createDeferred();
      const dispatchCanFinish = createDeferred();
      vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async () => {
        dispatchStarted.resolve();
        await dispatchCanFinish.promise;
        return "Slow Signal final";
      });
      const adapter = new SignalGatewayAdapter(makeConfig());

      const polling = (adapter as unknown as { pollOnce(): Promise<void> }).pollOnce();
      await dispatchStarted.promise;
      await vi.advanceTimersByTimeAsync(4_000);

      expect(sentBodies).toEqual(["I'm checking this."]);

      dispatchCanFinish.resolve();
      await polling;

      expect(sentBodies).toEqual(["I'm checking this.", "Slow Signal final"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

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

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
