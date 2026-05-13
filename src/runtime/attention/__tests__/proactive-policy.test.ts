import { describe, expect, it } from "vitest";
import {
  createProactivePolicyState,
  decideProactiveDelivery,
  reduceProactivePolicyState,
} from "../index.js";

describe("proactive policy state", () => {
  it("narrows future proactive delivery after overreach feedback", () => {
    const initial = createProactivePolicyState({
      policyId: "policy:resident",
      now: "2026-05-14T00:00:00.000Z",
      maxDeliveryKind: "suggest",
    });
    const narrowed = reduceProactivePolicyState(initial, {
      kind: "feedback",
      feedback_ref: { kind: "feedback", ref: "feedback:overreach" },
      feedback_kind: "overreach",
      recorded_at: "2026-05-14T00:01:00.000Z",
    });
    const decision = decideProactiveDelivery({
      state: narrowed,
      requestedDeliveryKind: "suggest",
      candidateCreatedAt: "2026-05-14T00:02:00.000Z",
    });

    expect(narrowed).toMatchObject({
      max_delivery_kind: "hold",
      cooldown_refs: [{ kind: "feedback", ref: "feedback:overreach" }],
      runtime_authority: false,
    });
    expect(decision).toMatchObject({
      requested_delivery_kind: "suggest",
      allowed_delivery_kind: "hold",
      reason: "cooldown",
      runtime_authority: false,
    });
  });

  it("does not flush old proactive backlog after quiet mode lifts", () => {
    const initial = createProactivePolicyState({
      policyId: "policy:resident",
      now: "2026-05-14T00:00:00.000Z",
      maxDeliveryKind: "suggest",
    });
    const quiet = reduceProactivePolicyState(initial, {
      kind: "quiet_entered",
      control_ref: { kind: "runtime_control", ref: "quiet:on" },
      recorded_at: "2026-05-14T00:01:00.000Z",
    });
    const active = reduceProactivePolicyState(quiet, {
      kind: "quiet_lifted",
      control_ref: { kind: "runtime_control", ref: "quiet:off" },
      recorded_at: "2026-05-14T00:10:00.000Z",
    });

    expect(decideProactiveDelivery({
      state: active,
      requestedDeliveryKind: "suggest",
      candidateCreatedAt: "2026-05-14T00:05:00.000Z",
    })).toMatchObject({
      allowed_delivery_kind: "hold",
      reason: "no_backlog_flush",
    });
    expect(decideProactiveDelivery({
      state: active,
      requestedDeliveryKind: "suggest",
      candidateCreatedAt: "2026-05-14T00:11:00.000Z",
    })).toMatchObject({
      allowed_delivery_kind: "digest",
      reason: "allowed",
    });
  });

  it("compares quiet-lift no-backlog cutoffs as instants", () => {
    const initial = createProactivePolicyState({
      policyId: "policy:resident",
      now: "2026-05-14T00:00:00.000Z",
      maxDeliveryKind: "suggest",
    });
    const active = reduceProactivePolicyState(initial, {
      kind: "quiet_lifted",
      control_ref: { kind: "runtime_control", ref: "quiet:off" },
      recorded_at: "2026-05-14T00:10:00Z",
    });

    expect(decideProactiveDelivery({
      state: active,
      requestedDeliveryKind: "suggest",
      candidateCreatedAt: "2026-05-14T00:10:00.500Z",
    })).toMatchObject({
      allowed_delivery_kind: "suggest",
      reason: "allowed",
    });
    expect(decideProactiveDelivery({
      state: active,
      requestedDeliveryKind: "suggest",
      candidateCreatedAt: "2026-05-14T00:09:59.999Z",
    })).toMatchObject({
      allowed_delivery_kind: "hold",
      reason: "no_backlog_flush",
    });
  });
});
