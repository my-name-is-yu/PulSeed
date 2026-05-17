import { describe, expect, it } from "vitest";

import {
  createSurfaceActionBinding,
  createSurfaceProjection,
  normalRuntimeGraphRef,
  normalSourceEventRef,
} from "../../src/runtime/surface-projection-protocol.js";

const NOW = "2026-05-17T00:00:00.000Z";

describe("Surface Projection Protocol replay", () => {
  it("rebuilds deterministic projection and action binding ids from the same source refs", () => {
    const build = () => {
      const sourceEventRefs = [normalSourceEventRef({
        kind: "peer_delivery",
        ref: "peer-delivery:candidate-1:telegram",
        event_type: "gateway.telegram.delivery.recorded",
        occurred_at: NOW,
        replay_key: "peer-delivery:candidate-1:telegram",
      })];
      const runtimeGraphRefs = [normalRuntimeGraphRef({
        kind: "peer_candidate",
        ref: "candidate-1",
        role: "target",
      })];
      const projection = createSurfaceProjection({
        surface: "telegram_peer_delivery",
        view: "normal",
        purpose: "Project a peer initiative delivery.",
        redaction_class: "normal_safe",
        projected_at: NOW,
        replay_key: "peer-delivery:candidate-1:telegram",
        source_event_refs: sourceEventRefs,
        runtime_graph_refs: runtimeGraphRefs,
        panels: [{ panel_id: "body", body: "Keep going." }],
      });
      const binding = createSurfaceActionBinding({
        action_kind: "less_like_this",
        surface: "telegram_peer_delivery",
        surface_instance_ref: "gateway:telegram:home_chat:12345",
        target: {
          kind: "peer_candidate",
          ref: "candidate-1",
          conversation_id: "gateway:telegram:home_chat:12345",
          transport_message_ref: "77",
        },
        source_projection_id: projection.projection_id,
        source_event_refs: sourceEventRefs,
        runtime_graph_refs: runtimeGraphRefs,
        replay_key: "peer-delivery:candidate-1:telegram:less_like_this",
        redaction_class: "normal_safe",
        created_at: NOW,
        expires_at: null,
      });
      return { projection, binding };
    };

    const first = build();
    const replayed = build();

    expect(replayed.projection.projection_id).toBe(first.projection.projection_id);
    expect(replayed.projection.normal_view?.redaction).toMatchObject({
      raw_trace_ids_visible: false,
      raw_evidence_refs_visible: false,
      policy_rationale_visible: false,
      memory_truth_internals_visible: false,
      approval_fingerprints_visible: false,
      operator_refs_visible: false,
    });
    expect(replayed.binding.binding_id).toBe(first.binding.binding_id);
    expect(replayed.binding.replay_key).toBe(first.binding.replay_key);
  });
});
