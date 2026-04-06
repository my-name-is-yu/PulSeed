import { describe, it, expect, vi } from "vitest";
import { HttpChannelAdapter } from "../http-channel-adapter.js";

function createMockEventServer() {
  let hook: ((data: Record<string, unknown>) => void) | undefined;
  return {
    setEnvelopeHook: vi.fn((h: (data: Record<string, unknown>) => void) => { hook = h; }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    startFileWatcher: vi.fn(),
    stopFileWatcher: vi.fn(),
    getPort: vi.fn().mockReturnValue(41700),
    // simulate incoming event
    simulateEvent(data: Record<string, unknown>) { hook?.(data); },
  };
}

describe("HttpChannelAdapter", () => {
  it("has name 'http'", () => {
    const es = createMockEventServer();
    const adapter = new HttpChannelAdapter(es as any);
    expect(adapter.name).toBe("http");
  });

  it("sets envelope hook on EventServer", () => {
    const es = createMockEventServer();
    new HttpChannelAdapter(es as any);
    expect(es.setEnvelopeHook).toHaveBeenCalledOnce();
  });

  it("starts EventServer and file watcher", async () => {
    const es = createMockEventServer();
    const adapter = new HttpChannelAdapter(es as any);
    await adapter.start();
    expect(es.start).toHaveBeenCalled();
    expect(es.startFileWatcher).toHaveBeenCalled();
  });

  it("stops EventServer and file watcher", async () => {
    const es = createMockEventServer();
    const adapter = new HttpChannelAdapter(es as any);
    await adapter.stop();
    expect(es.stopFileWatcher).toHaveBeenCalled();
    expect(es.stop).toHaveBeenCalled();
  });

  it("converts incoming event to Envelope and emits", () => {
    const es = createMockEventServer();
    const adapter = new HttpChannelAdapter(es as any);
    const handler = vi.fn();
    adapter.onEnvelope(handler);

    es.simulateEvent({ type: "external", source: "test", data: { key: "value" } });

    expect(handler).toHaveBeenCalledOnce();
    const envelope = handler.mock.calls[0][0];
    expect(envelope.id).toBeDefined();
    expect(envelope.type).toBe("event");
    expect(envelope.name).toBe("external");
    expect(envelope.source).toBe("http");
    expect(envelope.priority).toBe("normal");
    expect(envelope.payload).toEqual({ type: "external", source: "test", data: { key: "value" } });
  });

  it("does nothing when no handler registered", () => {
    const es = createMockEventServer();
    new HttpChannelAdapter(es as any);
    // No handler — should not throw
    expect(() => es.simulateEvent({ type: "test" })).not.toThrow();
  });

  it("provides access to underlying EventServer", () => {
    const es = createMockEventServer();
    const adapter = new HttpChannelAdapter(es as any);
    expect(adapter.getEventServer()).toBe(es);
  });
});
