import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSeedyTurnPresence,
  createUserVisibleSeedyTurnPresence,
  type SeedyTurnPresence,
} from "../../../interface/chat/seedy-turn-presence.js";
import type { TypingIndicatorCapability } from "../channel-adapter.js";
import {
  LIMITED_GATEWAY_DISPLAY_CAPABILITIES,
  createGatewayDisplayPolicy,
} from "../channel-display-policy.js";
import {
  SIGNAL_SEEDY_PRESENCE_CONTRACT,
  SLACK_SEEDY_PRESENCE_CONTRACT,
  TELEGRAM_SEEDY_PRESENCE_CONTRACT,
  createSeedyPresenceCapabilities,
  resolveGatewayChannelPresenceContract,
} from "../channel-presence-policy.js";
import {
  SeedyPresenceProjector,
  type SeedyPresenceTransport,
} from "../seedy-presence-projector.js";
import { NonTuiDisplayProjector, type NonTuiDisplayTransport } from "../non-tui-display-projector.js";
import { createRefreshingTypingIndicator } from "../typing-indicator.js";

const base = {
  runId: "run-1",
  turnId: "turn-1",
  createdAt: "2026-05-10T00:00:00.000Z",
};

const timelineBase = {
  id: "timeline-item-1",
  sourceEventId: "timeline-1",
  sessionId: "session-1",
  traceId: "trace-1",
  turnId: "turn-1",
  goalId: "goal-1",
  createdAt: base.createdAt,
  visibility: "user" as const,
};

function presence(
  phase: SeedyTurnPresence["phase"],
  input: Partial<SeedyTurnPresence> = {},
): SeedyTurnPresence {
  return createUserVisibleSeedyTurnPresence({
    turn_id: "turn-1",
    phase,
    started_at: "2026-05-10T00:00:00.000Z",
    updated_at: "2026-05-10T00:00:00.000Z",
    ...input,
  });
}

function createTransport(): SeedyPresenceTransport & { calls: string[] } {
  let nextId = 0;
  const calls: string[] = [];
  return {
    calls,
    sendStatus: vi.fn(async (text: string) => {
      calls.push(`sendStatus:${text}`);
      nextId += 1;
      return { id: `status-${nextId}` };
    }),
    editStatus: vi.fn(async (_ref, text: string) => {
      calls.push(`editStatus:${text}`);
    }),
    deleteStatus: vi.fn(async () => {
      calls.push("deleteStatus");
    }),
    sendFallbackAck: vi.fn(async (text: string) => {
      calls.push(`sendFallbackAck:${text}`);
      nextId += 1;
      return { id: `fallback-${nextId}` };
    }),
  };
}

function createDisplayTransport(): NonTuiDisplayTransport & { calls: string[] } {
  let nextId = 0;
  const calls: string[] = [];
  return {
    calls,
    sendProgress: vi.fn(async (text: string) => {
      calls.push(`sendProgress:${text}`);
      nextId += 1;
      return { id: `progress-${nextId}` };
    }),
    editProgress: vi.fn(async (_ref, text: string) => {
      calls.push(`editProgress:${text}`);
    }),
    deleteProgress: vi.fn(async () => {
      calls.push("deleteProgress");
    }),
    sendFinal: vi.fn(async (text: string) => {
      calls.push(`sendFinal:${text}`);
      nextId += 1;
      return { id: `final-${nextId}` };
    }),
    editFinal: vi.fn(async (_ref, text: string) => {
      calls.push(`editFinal:${text}`);
    }),
  };
}

function createLimitedDisplayProjector(transport: NonTuiDisplayTransport): NonTuiDisplayProjector {
  const capabilities = {
    ...LIMITED_GATEWAY_DISPLAY_CAPABILITIES,
    maxMessageLength: 4_096,
  };
  return new NonTuiDisplayProjector({
    display: {
      capabilities,
      policy: createGatewayDisplayPolicy(capabilities),
    },
    transport,
  });
}

describe("SeedyPresenceProjector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not hold native typing during wait-only presence updates", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const typingIndicator = createRefreshingTypingIndicator({
      intervalMs: 1_000,
      refresh,
    });
    const transport = createTransport();
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(TELEGRAM_SEEDY_PRESENCE_CONTRACT),
      transport,
      typingIndicator,
      typingContext: {
        platform: "telegram",
        conversation_id: "chat-1",
      },
    });

    await projector.handle({
      ...base,
      type: "presence_update",
      presence: presence("received"),
    });
    await projector.update(presence("acting", {
      importance: "status",
      last_activity_label: "Checking the workspace",
      expected_next: "progress",
    }));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(refresh).not.toHaveBeenCalled();
    expect(transport.sendStatus).not.toHaveBeenCalled();
  });

  it("starts, refreshes, and stops native presence around final streaming", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const typingIndicator = createRefreshingTypingIndicator({
      intervalMs: 1_000,
      refresh,
    });
    const transport = createTransport();
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(TELEGRAM_SEEDY_PRESENCE_CONTRACT),
      transport,
      typingIndicator,
      typingContext: {
        platform: "telegram",
        conversation_id: "chat-1",
      },
    });

    await projector.prepareForEvent({
      ...base,
      type: "assistant_delta",
      delta: "Hello.",
      text: "Hello.",
    });

    expect(refresh).toHaveBeenCalledOnce();
    expect(transport.sendStatus).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(refresh).toHaveBeenCalledTimes(2);

    await projector.handle({
      ...base,
      type: "assistant_final",
      text: "Hello.",
      persisted: true,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("uses native typing around a rendered commentary/status update without holding it", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const typingIndicator: TypingIndicatorCapability = {
      status: "native",
      start: vi.fn(async () => ({ status: "native" as const, stop })),
    };
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(TELEGRAM_SEEDY_PRESENCE_CONTRACT),
      typingIndicator,
      typingContext: {
        platform: "telegram",
        conversation_id: "chat-1",
      },
    });
    const event = {
      ...base,
      type: "activity" as const,
      kind: "commentary" as const,
      message: "I'll check the project context first.",
      sourceId: "preamble:turn-1",
      presentation: { gatewayProgress: "user" as const },
    };

    await projector.prepareForEvent(event);
    await projector.handle(event, { meaningfulProgressRendered: true });

    expect(typingIndicator.start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("uses native typing only around delayed waiting status delivery", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const typingIndicator: TypingIndicatorCapability = {
      status: "native",
      start: vi.fn(async () => ({ status: "native" as const, stop })),
    };
    const transport = createTransport();
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(TELEGRAM_SEEDY_PRESENCE_CONTRACT),
      transport,
      typingIndicator,
      typingContext: {
        platform: "telegram",
        conversation_id: "chat-1",
      },
    });

    await projector.update(presence("waiting", {
      importance: "status",
      last_activity_label: "Checking the workspace",
      expected_next: "progress",
    }));

    expect(typingIndicator.start).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(transport.sendStatus).toHaveBeenCalledOnce();
    expect(typingIndicator.start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not start duplicate native typing sessions for overlapping output events", async () => {
    let resolveStart: (() => void) | undefined;
    const stop = vi.fn().mockResolvedValue(undefined);
    const typingIndicator: TypingIndicatorCapability = {
      status: "native",
      start: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolveStart = resolve;
        });
        return { status: "native" as const, stop };
      }),
    };
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(TELEGRAM_SEEDY_PRESENCE_CONTRACT),
      typingIndicator,
      typingContext: {
        platform: "telegram",
        conversation_id: "chat-1",
      },
    });

    const first = projector.prepareForEvent({
      ...base,
      type: "assistant_delta",
      delta: "Hello.",
      text: "Hello.",
    });
    const second = projector.prepareForEvent({
      ...base,
      type: "assistant_delta",
      delta: " Next.",
      text: "Hello. Next.",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(typingIndicator.start).toHaveBeenCalledOnce();

    resolveStart?.();
    await Promise.all([first, second]);
    await projector.stop();

    expect(typingIndicator.start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops native typing when final arrives while output typing start is in flight", async () => {
    let resolveStart: (() => void) | undefined;
    const stop = vi.fn().mockResolvedValue(undefined);
    const typingIndicator: TypingIndicatorCapability = {
      status: "native",
      start: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolveStart = resolve;
        });
        return { status: "native" as const, stop };
      }),
    };
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(TELEGRAM_SEEDY_PRESENCE_CONTRACT),
      typingIndicator,
      typingContext: {
        platform: "telegram",
        conversation_id: "chat-1",
      },
    });

    const update = projector.prepareForEvent({
      ...base,
      type: "assistant_final",
      text: "Done",
      persisted: true,
    });
    const final = projector.handle({
      ...base,
      type: "assistant_final",
      text: "Done",
      persisted: true,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(typingIndicator.start).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();

    resolveStart?.();
    await Promise.all([update, final]);

    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not send fallback ack when final output arrives before the threshold", async () => {
    const transport = createTransport();
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(SIGNAL_SEEDY_PRESENCE_CONTRACT),
      transport,
    });

    await projector.update(presence("received"));
    await vi.advanceTimersByTimeAsync(3_999);
    await projector.handle({
      ...base,
      type: "assistant_final",
      text: "Done",
      persisted: true,
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(transport.sendFallbackAck).not.toHaveBeenCalled();
  });

  it("sends fallback ack at most once after the delay threshold", async () => {
    const transport = createTransport();
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(SIGNAL_SEEDY_PRESENCE_CONTRACT),
      transport,
    });

    await projector.update(presence("received"));
    await vi.advanceTimersByTimeAsync(4_000);
    await projector.update(presence("thinking"));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(transport.sendFallbackAck).toHaveBeenCalledOnce();
    expect(transport.calls).toEqual(["sendFallbackAck:I'm checking this."]);
    expect(projector.hasSentFallbackAck).toBe(true);
  });

  it("does not spam fallback acknowledgements for repeated waiting heartbeats on send-only channels", async () => {
    const transport = createTransport();
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(SIGNAL_SEEDY_PRESENCE_CONTRACT),
      transport,
    });

    await projector.update(presence("received"));
    await vi.advanceTimersByTimeAsync(4_000);
    await projector.update(presence("waiting", {
      importance: "status",
      last_activity_at: "2026-05-10T00:00:00.000Z",
      last_activity_label: "Taking action",
      expected_next: "progress",
    }));
    await vi.advanceTimersByTimeAsync(60_000);
    await projector.update(presence("waiting", {
      importance: "status",
      last_activity_at: "2026-05-10T00:00:00.000Z",
      last_activity_label: "Taking action",
      expected_next: "progress",
    }));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(transport.sendFallbackAck).toHaveBeenCalledOnce();
    expect(transport.calls).toEqual(["sendFallbackAck:I'm checking this."]);
  });

  it("projects editable status through one message and deletes it on completion", async () => {
    const transport = createTransport();
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(SLACK_SEEDY_PRESENCE_CONTRACT),
      transport,
    });

    await projector.update(presence("received"));
    await projector.update(presence("thinking"));
    await projector.update(presence("thinking"));
    await vi.advanceTimersByTimeAsync(2_000);
    await projector.update(presence("complete"));

    expect(transport.sendStatus).toHaveBeenCalledOnce();
    expect(transport.editStatus).not.toHaveBeenCalled();
    expect(transport.deleteStatus).toHaveBeenCalledOnce();
    expect(transport.calls).toEqual([
      "sendStatus:I'm thinking through the next step.",
      "deleteStatus",
    ]);
    expect(transport.sendFallbackAck).not.toHaveBeenCalled();
  });

  it("cancels delayed editable status when final arrives before the status threshold", async () => {
    const transport = createTransport();
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(SLACK_SEEDY_PRESENCE_CONTRACT),
      transport,
    });

    await projector.update(presence("received"));
    await vi.advanceTimersByTimeAsync(1_999);
    await projector.handle({
      ...base,
      type: "assistant_final",
      text: "Done",
      persisted: true,
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(transport.sendStatus).not.toHaveBeenCalled();
    expect(transport.deleteStatus).not.toHaveBeenCalled();
  });

  it("serializes overlapping initial editable status sends", async () => {
    let resolveSend: (() => void) | undefined;
    const transport = createTransport();
    vi.mocked(transport.sendStatus).mockImplementationOnce(async (text: string) => {
      transport.calls.push(`sendStatus:${text}`);
      await new Promise<void>((resolve) => {
        resolveSend = resolve;
      });
      return { id: "status-slow" };
    });
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(SLACK_SEEDY_PRESENCE_CONTRACT),
      transport,
    });

    await projector.update(presence("received"));
    await vi.advanceTimersByTimeAsync(2_000);
    const second = projector.update(presence("thinking"));

    expect(transport.sendStatus).toHaveBeenCalledOnce();

    resolveSend?.();
    await second;

    expect(transport.sendStatus).toHaveBeenCalledOnce();
    expect(transport.editStatus).toHaveBeenCalledOnce();
    expect(transport.calls).toEqual([
      "sendStatus:I'm checking this.",
      "editStatus:I'm thinking through the next step.",
    ]);
  });

  it("cleans up editable status when final arrives while initial send is in flight", async () => {
    let resolveSend: (() => void) | undefined;
    const transport = createTransport();
    vi.mocked(transport.sendStatus).mockImplementationOnce(async (text: string) => {
      transport.calls.push(`sendStatus:${text}`);
      await new Promise<void>((resolve) => {
        resolveSend = resolve;
      });
      return { id: "status-slow" };
    });
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(SLACK_SEEDY_PRESENCE_CONTRACT),
      transport,
    });

    const update = projector.update(presence("received"));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(transport.sendStatus).toHaveBeenCalledOnce();
    expect(transport.deleteStatus).not.toHaveBeenCalled();

    const final = projector.handle({
      ...base,
      type: "assistant_final",
      text: "Done",
      persisted: true,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(transport.deleteStatus).not.toHaveBeenCalled();

    resolveSend?.();
    await Promise.all([update, final]);

    expect(transport.deleteStatus).toHaveBeenCalledOnce();
  });

  it("keeps fallback timers when assistant delta was not delivered on send-on-delay channels", async () => {
    const transport = createTransport();
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(SIGNAL_SEEDY_PRESENCE_CONTRACT),
      transport,
    });

    await projector.update(presence("received"));
    await projector.handle({
      ...base,
      type: "assistant_delta",
      delta: "H",
      text: "H",
    });
    await vi.advanceTimersByTimeAsync(4_000);

    expect(transport.sendFallbackAck).toHaveBeenCalledOnce();
  });

  it("uses non-TUI delivery state instead of buffered assistant text for delta cancellation", async () => {
    const presenceTransport = createTransport();
    const displayTransport = createDisplayTransport();
    const displayProjector = createLimitedDisplayProjector(displayTransport);
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(SIGNAL_SEEDY_PRESENCE_CONTRACT),
      transport: presenceTransport,
    });
    const event = {
      ...base,
      type: "assistant_delta" as const,
      delta: "H",
      text: "H",
    };

    await projector.update(presence("received"));
    await displayProjector.handle(event);
    await projector.handle(event, {
      assistantOutputRendered: displayProjector.deliveredAssistantOutput,
    });
    await vi.advanceTimersByTimeAsync(4_000);

    expect(displayProjector.renderedAssistantOutput).toBe(true);
    expect(displayProjector.deliveredAssistantOutput).toBe(false);
    expect(presenceTransport.sendFallbackAck).toHaveBeenCalledOnce();
  });

  it("cancels fallback timers when assistant delta is reported as rendered", async () => {
    const transport = createTransport();
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(SIGNAL_SEEDY_PRESENCE_CONTRACT),
      transport,
    });

    await projector.update(presence("received"));
    await projector.handle({
      ...base,
      type: "assistant_delta",
      delta: "H",
      text: "H",
    }, { assistantOutputRendered: true });
    await vi.advanceTimersByTimeAsync(4_000);

    expect(transport.sendFallbackAck).not.toHaveBeenCalled();
  });

  it("cancels fallback timers when meaningful progress is reported as rendered", async () => {
    const transport = createTransport();
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(SIGNAL_SEEDY_PRESENCE_CONTRACT),
      transport,
    });

    await projector.update(presence("received"));
    await projector.handle({
      ...base,
      type: "operation_progress",
      item: {
        id: "progress-1",
        kind: "checked_status",
        operation: "gateway",
        title: "Checked status",
        createdAt: base.createdAt,
        publicProgress: {
          audience: "user",
          phase: "checking",
          importance: "heartbeat",
          verbosity: "summary",
          subject: "the current step",
        },
      },
    }, { meaningfulProgressRendered: true });
    await vi.advanceTimersByTimeAsync(4_000);

    expect(transport.sendFallbackAck).not.toHaveBeenCalled();
  });

  it("keeps fallback timers when renderable progress was not delivered on send-on-delay channels", async () => {
    const transport = createTransport();
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(SIGNAL_SEEDY_PRESENCE_CONTRACT),
      transport,
    });

    await projector.update(presence("received"));
    await projector.handle({
      ...base,
      type: "operation_progress",
      item: {
        id: "progress-1",
        kind: "checked_status",
        operation: "gateway",
        title: "Checked status",
        createdAt: base.createdAt,
      },
    });
    await vi.advanceTimersByTimeAsync(4_000);

    expect(transport.sendFallbackAck).toHaveBeenCalledOnce();
  });

  it("cancels fallback timers when rendered operation progress without public metadata was delivered", async () => {
    const transport = createTransport();
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(SIGNAL_SEEDY_PRESENCE_CONTRACT),
      transport,
    });

    await projector.update(presence("received"));
    await projector.handle({
      ...base,
      type: "operation_progress",
      item: {
        id: "progress-1",
        kind: "checked_status",
        operation: "gateway",
        title: "Checked status",
        createdAt: base.createdAt,
      },
    }, { meaningfulProgressRendered: true });
    await vi.advanceTimersByTimeAsync(4_000);

    expect(transport.sendFallbackAck).not.toHaveBeenCalled();
  });

  it("does not cancel fallback timers for user-visible timeline events that render no gateway progress", async () => {
    const transport = createTransport();
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(SIGNAL_SEEDY_PRESENCE_CONTRACT),
      transport,
    });

    await projector.update(presence("received"));
    await projector.handle({
      ...base,
      type: "agent_timeline",
      item: {
        ...timelineBase,
        sourceType: "model_request",
        kind: "model_request",
        model: "openai/gpt-5.5",
        toolCount: 54,
      },
    });
    await vi.advanceTimersByTimeAsync(4_000);

    expect(transport.sendFallbackAck).toHaveBeenCalledOnce();
    expect(transport.calls.join("\n")).not.toContain("openai/gpt");
  });

  it("ignores diagnostic presence and never renders diagnostic fields", async () => {
    const transport = createTransport();
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(SLACK_SEEDY_PRESENCE_CONTRACT),
      transport,
    });

    await projector.update(createSeedyTurnPresence({
      turn_id: "turn-1",
      audience: "diagnostic",
      phase: "thinking",
      importance: "status",
      subject: "openai/gpt-5.5",
      reason: "54 tools",
      started_at: base.createdAt,
      updated_at: base.createdAt,
      diagnostic_ref: "model-request:secret",
    }));

    expect(transport.sendStatus).not.toHaveBeenCalled();
    expect(transport.calls.join("\n")).not.toContain("openai/gpt");
    expect(transport.calls.join("\n")).not.toContain("model-request");
  });

  it("swallows native and status transport failures so the chat turn can continue", async () => {
    const onError = vi.fn();
    const typingIndicator: TypingIndicatorCapability = {
      status: "native",
      start: vi.fn().mockRejectedValue(new Error("typing failed")),
    };
    const transport = createTransport();
    vi.mocked(transport.sendStatus).mockRejectedValueOnce(new Error("status failed"));
    const projector = new SeedyPresenceProjector({
      presence: {
        capabilities: createSeedyPresenceCapabilities({
          surfaceKind: "editable_status",
          canShowNativeEphemeral: true,
          canEditStatus: true,
          canDeleteStatus: true,
          canSendFallbackAck: false,
          canRenderBodyMotion: false,
          canRenderAmbientStatus: false,
          canThreadStatus: false,
        }),
      },
      transport,
      typingIndicator,
      typingContext: {
        platform: "custom",
        conversation_id: "conversation-1",
      },
      onError,
    });

    await expect(projector.update(presence("received"))).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onError).toHaveBeenCalledWith(expect.any(Error), "typing_start");
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "status_send");
  });

  it("does not mark fallback ack as sent when fallback transport fails", async () => {
    const onError = vi.fn();
    const transport = createTransport();
    vi.mocked(transport.sendFallbackAck).mockRejectedValueOnce(new Error("fallback failed"));
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(SIGNAL_SEEDY_PRESENCE_CONTRACT),
      transport,
      onError,
    });

    await projector.update(presence("received"));
    await vi.advanceTimersByTimeAsync(4_000);

    expect(onError).toHaveBeenCalledWith(expect.any(Error), "fallback_ack");
    expect(projector.hasSentFallbackAck).toBe(false);

    await projector.update(presence("thinking"));
    await vi.advanceTimersByTimeAsync(4_000);

    expect(transport.sendFallbackAck).toHaveBeenCalledTimes(2);
    expect(projector.hasSentFallbackAck).toBe(true);
  });

  it("does not send duplicate fallback ack while the first fallback send is in flight", async () => {
    let resolveFirstSend: (() => void) | undefined;
    const transport = createTransport();
    vi.mocked(transport.sendFallbackAck).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        resolveFirstSend = resolve;
      });
      return { id: "fallback-slow" };
    });
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(SIGNAL_SEEDY_PRESENCE_CONTRACT),
      transport,
    });

    await projector.update(presence("received"));
    await vi.advanceTimersByTimeAsync(4_000);
    await projector.update(presence("thinking"));
    await vi.advanceTimersByTimeAsync(4_000);

    expect(transport.sendFallbackAck).toHaveBeenCalledOnce();
    expect(projector.hasSentFallbackAck).toBe(false);

    resolveFirstSend?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(projector.hasSentFallbackAck).toBe(true);

    await projector.update(presence("acting"));
    await vi.advanceTimersByTimeAsync(4_000);

    expect(transport.sendFallbackAck).toHaveBeenCalledOnce();
  });

  it("waits for in-flight fallback ack sends before stop resolves", async () => {
    let resolveFallbackAck: (() => void) | undefined;
    const transport = createTransport();
    vi.mocked(transport.sendFallbackAck).mockImplementationOnce(async (text: string) => {
      transport.calls.push(`sendFallbackAck:${text}`);
      await new Promise<void>((resolve) => {
        resolveFallbackAck = resolve;
      });
      return { id: "fallback-slow" };
    });
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(SIGNAL_SEEDY_PRESENCE_CONTRACT),
      transport,
    });

    await projector.update(presence("received"));
    await vi.advanceTimersByTimeAsync(4_000);

    let stopped = false;
    const stop = projector.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(transport.sendFallbackAck).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);
    expect(projector.hasSentFallbackAck).toBe(false);

    resolveFallbackAck?.();
    await stop;

    expect(stopped).toBe(true);
    expect(projector.hasSentFallbackAck).toBe(true);
  });

  it("keeps editable status ref for cleanup retry when delete fails", async () => {
    const onError = vi.fn();
    const transport = createTransport();
    vi.mocked(transport.deleteStatus).mockRejectedValueOnce(new Error("delete failed"));
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(SLACK_SEEDY_PRESENCE_CONTRACT),
      transport,
      onError,
    });

    await projector.update(presence("received"));
    await vi.advanceTimersByTimeAsync(2_000);
    await projector.update(presence("complete"));

    expect(onError).toHaveBeenCalledWith(expect.any(Error), "status_delete");
    expect(transport.deleteStatus).toHaveBeenCalledOnce();

    await projector.stop();

    expect(transport.deleteStatus).toHaveBeenCalledTimes(2);
  });
});
