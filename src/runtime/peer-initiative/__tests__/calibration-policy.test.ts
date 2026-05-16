import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { ProactiveInterventionStore } from "../../store/proactive-intervention-store.js";
import {
  DEFAULT_RESIDENT_ACTIVATION_POLICY_ID,
  ProactivePolicyStateStore,
} from "../../store/index.js";
import {
  PeerFeedbackProjectionSchema,
  applyPeerInitiativeCalibrationPolicy,
  peerFeedbackProjectionToProactivePolicyEvent,
} from "../index.js";

const NOW = "2026-05-16T00:00:00.000Z";

describe("peer initiative calibration policy application", () => {
  it("turns peer feedback projections into policy reducer events without granting authority", () => {
    const event = peerFeedbackProjectionToProactivePolicyEvent(PeerFeedbackProjectionSchema.parse({
      projection_id: "peer-feedback:wrong-read",
      candidate_id: "candidate:raw-hidden",
      kind: "care_presence",
      structured_outcome: "wrong_read",
      source_surface: "telegram",
      projected_at: NOW,
    }));

    expect(event).toMatchObject({
      kind: "feedback",
      feedback_ref: { kind: "peer_feedback_projection", ref: "peer-feedback:wrong-read" },
      feedback_kind: "correction",
      recorded_at: NOW,
    });
  });

  it("applies proactive and peer feedback into persisted threshold state idempotently", async () => {
    const tmpDir = makeTempDir("pulseed-peer-calibration-policy-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const proactiveStore = new ProactiveInterventionStore(runtimeRoot, { controlBaseDir: tmpDir });
      await proactiveStore.appendIntervention({
        activity: {
          intervention_id: "intervention:accepted",
          kind: "observation",
          trigger: "proactive_tick",
          summary: "Accepted.",
          recorded_at: NOW,
        },
      });
      await proactiveStore.appendFeedback({
        interventionId: "intervention:accepted",
        outcome: "accepted",
        recordedAt: "2026-05-16T00:01:00.000Z",
      });
      const policyStore = new ProactivePolicyStateStore(runtimeRoot, { controlBaseDir: tmpDir });
      const peerFeedbackProjections = [
        PeerFeedbackProjectionSchema.parse({
          projection_id: "peer-feedback:not-now",
          candidate_id: "candidate:not-now",
          kind: "care_presence",
          structured_outcome: "not_now",
          source_surface: "telegram",
          projected_at: "2026-05-16T00:02:00.000Z",
        }),
        PeerFeedbackProjectionSchema.parse({
          projection_id: "peer-feedback:wrong-read",
          candidate_id: "candidate:wrong-read",
          kind: "care_presence",
          structured_outcome: "wrong_read",
          source_surface: "telegram",
          projected_at: "2026-05-16T00:03:00.000Z",
        }),
      ];

      const first = await applyPeerInitiativeCalibrationPolicy({
        policyStore,
        generatedAt: "2026-05-16T00:04:00.000Z",
        proactiveEvents: await proactiveStore.list(500),
        peerFeedbackProjections,
      });
      const second = await applyPeerInitiativeCalibrationPolicy({
        policyStore,
        generatedAt: "2026-05-16T00:05:00.000Z",
        proactiveEvents: await proactiveStore.list(500),
        peerFeedbackProjections,
      });
      const stored = await policyStore.load(DEFAULT_RESIDENT_ACTIVATION_POLICY_ID);

      expect(first).toMatchObject({
        mutation_performed: true,
        source_counts: {
          proactive_feedback_event_count: 1,
          peer_feedback_projection_count: 2,
          calibration_event_count: 3,
        },
        policy_state_result: {
          applied_event_count: 3,
          after_max_delivery_kind: "digest",
        },
        accepted_feedback_escalation_performed: false,
        authority_escalation_performed: false,
        relationship_profile_write_performed: false,
        raw_refs_visible: false,
      });
      expect(second).toMatchObject({
        mutation_performed: false,
        policy_state_result: {
          applied_event_count: 0,
          skipped_existing_event_count: 3,
          after_max_delivery_kind: "digest",
        },
      });
      expect(stored).toMatchObject({
        max_delivery_kind: "digest",
        runtime_authority: false,
      });
      expect(JSON.stringify(first)).not.toContain("candidate:wrong-read");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });
});
