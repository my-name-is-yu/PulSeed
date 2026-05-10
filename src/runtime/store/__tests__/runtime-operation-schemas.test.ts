import { describe, expect, it } from "vitest";
import { RuntimeControlOperationSchema } from "../runtime-operation-schemas.js";

const baseOperation = {
  operation_id: "operation-1",
  kind: "inspect_run",
  state: "pending",
  requested_at: "2026-05-10T00:00:00.000Z",
  updated_at: "2026-05-10T00:00:00.000Z",
  requested_by: {
    surface: "chat",
  },
  reply_target: {},
  reason: "inspect current run",
  expected_health: {
    daemon_ping: true,
    gateway_acceptance: true,
  },
};

describe("RuntimeControlOperationSchema", () => {
  it("accepts safe positive acknowledgement outbox sequence numbers", () => {
    expect(RuntimeControlOperationSchema.parse({
      ...baseOperation,
      ack_outbox_seq: 1,
    }).ack_outbox_seq).toBe(1);
    expect(RuntimeControlOperationSchema.parse({
      ...baseOperation,
      ack_outbox_seq: Number.MAX_SAFE_INTEGER,
    }).ack_outbox_seq).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["non-integer", 1.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["infinite", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
  ])("rejects %s acknowledgement outbox sequence numbers", (_label, ackOutboxSeq) => {
    expect(RuntimeControlOperationSchema.safeParse({
      ...baseOperation,
      ack_outbox_seq: ackOutboxSeq,
    }).success).toBe(false);
  });
});
