import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IngressGateway } from "../gateway/ingress-gateway.js";
import { HttpChannelAdapter } from "../gateway/http-channel-adapter.js";
import type { Envelope } from "../types/envelope.js";
import { createEnvelope } from "../types/envelope.js";

describe("DaemonRunner Gateway integration", () => {
  describe("IngressGateway + HttpChannelAdapter end-to-end", () => {
    it("routes HTTP event through Gateway to writeEvent handler", () => {
      const writeEvent = vi.fn();

      // Simulate the wiring that DaemonRunner.start() does
      const mockEventServer = {
        setEnvelopeHook: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        startFileWatcher: vi.fn(),
        stopFileWatcher: vi.fn(),
        getPort: vi.fn().mockReturnValue(41700),
      };

      let capturedHook: ((data: Record<string, unknown>) => void) | undefined;
      mockEventServer.setEnvelopeHook.mockImplementation((hook: (data: Record<string, unknown>) => void) => {
        capturedHook = hook;
      });

      const gateway = new IngressGateway();
      const httpAdapter = new HttpChannelAdapter(mockEventServer as any);
      gateway.registerAdapter(httpAdapter);

      // Wire the handler (same as DaemonRunner does)
      gateway.onEnvelope((envelope: Envelope) => {
        const payload = envelope.payload as Record<string, unknown>;
        writeEvent(payload);
      });

      // Simulate an incoming HTTP event (what EventServer's handlePostEvents does)
      expect(capturedHook).toBeDefined();
      capturedHook!({
        type: "external",
        source: "test",
        timestamp: new Date().toISOString(),
        data: { key: "value" },
      });

      // Verify the event reached the handler
      expect(writeEvent).toHaveBeenCalledOnce();
      expect(writeEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "external",
          source: "test",
          data: { key: "value" },
        })
      );
    });

    it("starts and stops EventServer through Gateway lifecycle", async () => {
      const mockEventServer = {
        setEnvelopeHook: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        startFileWatcher: vi.fn(),
        stopFileWatcher: vi.fn(),
      };

      const gateway = new IngressGateway();
      const httpAdapter = new HttpChannelAdapter(mockEventServer as any);
      gateway.registerAdapter(httpAdapter);
      gateway.onEnvelope(vi.fn());

      await gateway.start();
      expect(mockEventServer.start).toHaveBeenCalledOnce();
      expect(mockEventServer.startFileWatcher).toHaveBeenCalledOnce();

      await gateway.stop();
      expect(mockEventServer.stopFileWatcher).toHaveBeenCalledOnce();
      expect(mockEventServer.stop).toHaveBeenCalledOnce();
    });

    it("file-watcher events also route through envelopeHook", () => {
      // This tests that processEventFile uses envelopeHook
      // by verifying the hook is called for file-watcher events too
      const handler = vi.fn();

      const mockEventServer = {
        setEnvelopeHook: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        startFileWatcher: vi.fn(),
        stopFileWatcher: vi.fn(),
      };

      let capturedHook: ((data: Record<string, unknown>) => void) | undefined;
      mockEventServer.setEnvelopeHook.mockImplementation((hook: (data: Record<string, unknown>) => void) => {
        capturedHook = hook;
      });

      const gateway = new IngressGateway();
      const httpAdapter = new HttpChannelAdapter(mockEventServer as any);
      gateway.registerAdapter(httpAdapter);
      gateway.onEnvelope(handler);

      // Simulate what processEventFile does when envelopeHook is set
      expect(capturedHook).toBeDefined();
      capturedHook!({
        type: "internal",
        source: "file-watcher",
        timestamp: new Date().toISOString(),
        data: { trigger: "cron" },
      });

      expect(handler).toHaveBeenCalledOnce();
      const envelope = handler.mock.calls[0][0];
      expect(envelope.source).toBe("http");
      expect(envelope.payload).toEqual(
        expect.objectContaining({ type: "internal", source: "file-watcher" })
      );
    });
  });
});
