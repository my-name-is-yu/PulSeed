import { describe, expect, it } from "vitest";

import {
  createSurfaceActionBinding,
  createSurfaceProjection,
  normalRuntimeGraphRef,
  normalSourceEventRef,
  operatorSourceEventRef,
  validateSurfaceActionBinding,
} from "../../src/runtime/surface-projection-protocol.js";

const NOW = "2026-05-17T00:00:00.000Z";

describe("Surface Projection Protocol contracts", () => {
  it("keeps operator/debug refs out of normal projections", () => {
    expect(() => createSurfaceProjection({
      surface: "chat",
      view: "normal",
      purpose: "Project chat text.",
      redaction_class: "normal_safe",
      projected_at: NOW,
      replay_key: "chat:normal:operator-ref",
      source_event_refs: [operatorSourceEventRef({
        kind: "runtime_trace",
        ref: "trace:raw",
        event_type: "debug_trace",
      })],
      panels: [{ panel_id: "body", body: "Hello" }],
    })).toThrow(/operator\/debug refs/);
  });

  it("requires operator/debug projections to carry a debug-only view", () => {
    const projection = createSurfaceProjection({
      surface: "cli_status",
      view: "operator_debug",
      purpose: "Project operator status diagnostics.",
      redaction_class: "operator_debug",
      projected_at: NOW,
      replay_key: "cli:operator",
      source_event_refs: [operatorSourceEventRef({
        kind: "runtime_trace",
        ref: "trace:operator",
        event_type: "status_trace",
      })],
      panels: [{ panel_id: "status", body: "Diagnostic status" }],
    });

    expect(projection.normal_view).toBeUndefined();
    expect(projection.operator_debug_view).toMatchObject({
      view: "operator_debug",
      projection_id: projection.projection_id,
      source_event_refs: [
        expect.objectContaining({ visibility: "operator_debug" }),
      ],
    });
  });

  it("binds surface actions to the current target and rejects stale or wrong-target replay", () => {
    const sourceEventRefs = [normalSourceEventRef({
      kind: "peer_delivery",
      ref: "delivery:1",
      event_type: "gateway.telegram.delivery.recorded",
      occurred_at: NOW,
      replay_key: "peer:delivery:1",
    })];
    const runtimeGraphRefs = [normalRuntimeGraphRef({
      kind: "peer_candidate",
      ref: "candidate:1",
      role: "target",
    })];
    const binding = createSurfaceActionBinding({
      action_kind: "less_like_this",
      surface: "telegram_peer_delivery",
      surface_instance_ref: "gateway:telegram:home_chat:12345",
      target: {
        kind: "peer_candidate",
        ref: "candidate:1",
        conversation_id: "gateway:telegram:home_chat:12345",
        transport_message_ref: "77",
      },
      source_projection_id: "surface:peer:1",
      source_event_refs: sourceEventRefs,
      runtime_graph_refs: runtimeGraphRefs,
      replay_key: "peer:delivery:1:less_like_this",
      redaction_class: "normal_safe",
      created_at: NOW,
      expires_at: "2026-05-18T00:00:00.000Z",
    });

    expect(validateSurfaceActionBinding({
      binding,
      surface: "telegram_peer_delivery",
      surfaceInstanceRef: "gateway:telegram:home_chat:12345",
      actionKind: "less_like_this",
      conversationId: "gateway:telegram:home_chat:12345",
      transportMessageRef: "77",
      now: "2026-05-17T01:00:00.000Z",
    })).toMatchObject({ status: "accepted" });

    expect(validateSurfaceActionBinding({
      binding,
      surface: "telegram_peer_delivery",
      surfaceInstanceRef: "gateway:telegram:home_chat:99999",
      actionKind: "less_like_this",
      conversationId: "gateway:telegram:home_chat:99999",
      transportMessageRef: "77",
      now: "2026-05-17T01:00:00.000Z",
    })).toMatchObject({ status: "rejected", reason: "surface_mismatch" });

    expect(validateSurfaceActionBinding({
      binding,
      surface: "telegram_peer_delivery",
      surfaceInstanceRef: "gateway:telegram:home_chat:12345",
      actionKind: "wrong_read",
      conversationId: "gateway:telegram:home_chat:12345",
      transportMessageRef: "77",
      now: "2026-05-17T01:00:00.000Z",
    })).toMatchObject({ status: "rejected", reason: "action_mismatch" });

    expect(validateSurfaceActionBinding({
      binding,
      surface: "telegram_peer_delivery",
      surfaceInstanceRef: "gateway:telegram:home_chat:12345",
      actionKind: "less_like_this",
      conversationId: "gateway:telegram:home_chat:12345",
      transportMessageRef: "78",
      now: "2026-05-17T01:00:00.000Z",
    })).toMatchObject({ status: "rejected", reason: "target_mismatch" });

    expect(validateSurfaceActionBinding({
      binding,
      surface: "telegram_peer_delivery",
      surfaceInstanceRef: "gateway:telegram:home_chat:12345",
      actionKind: "less_like_this",
      conversationId: "gateway:telegram:home_chat:12345",
      transportMessageRef: "77",
      now: "2026-05-18T00:00:01.000Z",
    })).toMatchObject({ status: "rejected", reason: "expired" });
  });
});
