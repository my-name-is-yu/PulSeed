import { describe, it, expect } from "vitest";
import { EnvelopeSchema, createEnvelope } from "../types/envelope.js";

describe("Envelope", () => {
  describe("EnvelopeSchema", () => {
    it("validates a complete envelope", () => {
      const envelope = {
        id: "test-id",
        type: "event",
        name: "test_event",
        source: "http",
        priority: "normal",
        payload: { foo: "bar" },
        created_at: Date.now(),
      };
      const result = EnvelopeSchema.safeParse(envelope);
      expect(result.success).toBe(true);
    });

    it("validates with optional fields", () => {
      const envelope = {
        id: "test-id",
        type: "command",
        name: "user_command",
        source: "cli",
        goal_id: "goal-123",
        correlation_id: "corr-456",
        dedupe_key: "dedup-789",
        priority: "critical",
        payload: null,
        reply_channel_id: "reply-1",
        created_at: Date.now(),
        ttl_ms: 30000,
        auth: { principal: "user@example.com", roles: ["admin"] },
      };
      const result = EnvelopeSchema.safeParse(envelope);
      expect(result.success).toBe(true);
    });

    it("rejects invalid priority", () => {
      const envelope = {
        id: "test-id",
        type: "event",
        name: "test",
        source: "http",
        priority: "urgent",
        payload: {},
        created_at: Date.now(),
      };
      const result = EnvelopeSchema.safeParse(envelope);
      expect(result.success).toBe(false);
    });

    it("rejects invalid type", () => {
      const envelope = {
        id: "test-id",
        type: "notification",
        name: "test",
        source: "http",
        priority: "normal",
        payload: {},
        created_at: Date.now(),
      };
      const result = EnvelopeSchema.safeParse(envelope);
      expect(result.success).toBe(false);
    });
  });

  describe("createEnvelope", () => {
    it("creates envelope with defaults", () => {
      const envelope = createEnvelope({
        type: "event",
        name: "test_event",
        source: "http",
        payload: { data: "test" },
      });
      expect(envelope.id).toBeDefined();
      expect(envelope.type).toBe("event");
      expect(envelope.name).toBe("test_event");
      expect(envelope.source).toBe("http");
      expect(envelope.priority).toBe("normal");
      expect(envelope.payload).toEqual({ data: "test" });
      expect(envelope.created_at).toBeGreaterThan(0);
    });

    it("creates envelope with custom priority", () => {
      const envelope = createEnvelope({
        type: "command",
        name: "approve",
        source: "cli",
        payload: {},
        priority: "high",
        goal_id: "goal-1",
      });
      expect(envelope.priority).toBe("high");
      expect(envelope.goal_id).toBe("goal-1");
    });

    it("generates unique IDs", () => {
      const e1 = createEnvelope({ type: "event", name: "a", source: "http", payload: {} });
      const e2 = createEnvelope({ type: "event", name: "b", source: "http", payload: {} });
      expect(e1.id).not.toBe(e2.id);
    });
  });
});
