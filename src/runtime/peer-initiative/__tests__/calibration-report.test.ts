import { describe, expect, it } from "vitest";
import { ProactiveInterventionSummarySchema } from "../../store/proactive-intervention-store.js";
import {
  PeerFeedbackProjectionSchema,
  createPeerInitiativeCalibrationReport,
  projectPeerInitiativeCurrentCapability,
} from "../index.js";

const NOW = "2026-05-16T00:00:00.000Z";

describe("peer initiative diagnostics", () => {
  it("narrows current capability to the Telegram MVP without raw refs or internals", () => {
    const projection = projectPeerInitiativeCurrentCapability();

    expect(projection.current_capability).toBe("telegram_outbound_peer_initiative_mvp");
    expect(projection.delivery_surfaces).toEqual([
      expect.objectContaining({ surface: "telegram", current_status: "implemented_mvp" }),
      expect.objectContaining({ surface: "discord", current_status: "contract_only_future" }),
      expect.objectContaining({ surface: "whatsapp", current_status: "contract_only_future" }),
      expect.objectContaining({ surface: "slack", current_status: "contract_only_future" }),
      expect.objectContaining({ surface: "gui", current_status: "contract_only_future" }),
    ]);
    expect(projection.raw_refs_visible).toBe(false);
    expect(projection.capability_internals_visible).toBe(false);
  });

  it("aggregates wrong_read feedback as calibration evidence without mutating thresholds or profile state", () => {
    const proactiveSummary = ProactiveInterventionSummarySchema.parse({
      total_interventions: 3,
      pending_count: 0,
      response_count: 3,
      accepted_count: 1,
      ignored_count: 0,
      dismissed_count: 1,
      corrected_count: 0,
      overreach_count: 0,
      response_rate: 1,
      accepted_rate: 1 / 3,
      ignored_rate: 0,
      correction_rate: 0,
      overreach_rate: 0,
      average_time_to_response_ms: 1000,
      by_kind: { observation: 3 },
      by_channel: { daemon: 3 },
      latest_feedback_at: NOW,
      policy_adjustment_recommendation: null,
    });
    const peerFeedbackProjections = [
      PeerFeedbackProjectionSchema.parse({
        projection_id: "peer-feedback:wrong-read",
        candidate_id: "candidate:1",
        kind: "attention_preparation",
        structured_outcome: "wrong_read",
        source_surface: "telegram",
        projected_at: NOW,
      }),
      PeerFeedbackProjectionSchema.parse({
        projection_id: "peer-feedback:more",
        candidate_id: "candidate:2",
        kind: "attention_preparation",
        structured_outcome: "more_like_this",
        source_surface: "telegram",
        projected_at: NOW,
      }),
      PeerFeedbackProjectionSchema.parse({
        projection_id: "peer-feedback:not-now",
        candidate_id: "candidate:3",
        kind: "attention_preparation",
        structured_outcome: "not_now",
        source_surface: "telegram",
        projected_at: NOW,
      }),
    ];

    const report = createPeerInitiativeCalibrationReport({
      generatedAt: NOW,
      proactiveSummary,
      peerFeedbackProjections,
    });

    expect(report).toMatchObject({
      schema_version: "peer-initiative-calibration-report/v1",
      surface_scope: "telegram_mvp",
      read_only: true,
      mutation_performed: false,
      automatic_threshold_change_performed: false,
      relationship_profile_write_performed: false,
      raw_refs_visible: false,
      source_counts: {
        proactive_intervention_feedback_count: 3,
        peer_feedback_projection_count: 3,
      },
      threshold_tuning_evidence: {
        accepted_count: 2,
        dismissed_count: 2,
        corrected_count: 1,
        wrong_read_count: 1,
        more_like_this_count: 1,
        not_now_count: 1,
      },
      recommendation: "review_relationship_reading",
    });
    expect(JSON.stringify(report)).not.toContain("candidate:1");
  });
});
