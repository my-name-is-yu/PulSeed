import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateManager } from "../../../../base/state/state-manager.js";
import {
  PeerFeedbackProjectionSchema,
  PeerInitiativeStore,
  generatePeerInitiativeCandidates,
} from "../../../../runtime/peer-initiative/index.js";
import { ProactiveInterventionStore } from "../../../../runtime/store/proactive-intervention-store.js";
import { cleanupTempDir, makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import { cmdRuntime } from "../runtime.js";

const NOW = "2026-05-16T00:00:00.000Z";

describe("runtime peer initiative diagnostics", () => {
  it("exposes Telegram MVP as the only current peer initiative delivery capability", async () => {
    const tmpDir = makeTempDir("pulseed-peer-initiative-capability-");
    try {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const code = await cmdRuntime(new StateManager(tmpDir), ["peer-initiative-capability", "--json"]);
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      logSpy.mockRestore();

      expect(code).toBe(0);
      const projection = JSON.parse(output) as {
        current_capability: string;
        delivery_surfaces: Array<{ surface: string; current_status: string }>;
        raw_refs_visible: boolean;
        capability_internals_visible: boolean;
      };
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
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("aggregates proactive and Telegram peer feedback into a read-only calibration report", async () => {
    const tmpDir = makeTempDir("pulseed-peer-initiative-calibration-");
    try {
      const stateManager = new StateManager(tmpDir);
      await stateManager.init();
      const runtimeRoot = path.join(tmpDir, "runtime");
      const proactiveStore = new ProactiveInterventionStore(runtimeRoot, { controlBaseDir: tmpDir });
      await proactiveStore.appendIntervention({
        activity: {
          intervention_id: "intervention-accepted",
          kind: "observation",
          trigger: "proactive_tick",
          summary: "Accepted peer initiative.",
          recorded_at: NOW,
        },
      });
      await proactiveStore.appendIntervention({
        activity: {
          intervention_id: "intervention-dismissed",
          kind: "observation",
          trigger: "proactive_tick",
          summary: "Dismissed peer initiative.",
          recorded_at: "2026-05-16T00:01:00.000Z",
        },
      });
      await proactiveStore.appendFeedback({
        interventionId: "intervention-accepted",
        outcome: "accepted",
        recordedAt: "2026-05-16T00:02:00.000Z",
      });
      await proactiveStore.appendFeedback({
        interventionId: "intervention-dismissed",
        outcome: "dismissed",
        recordedAt: "2026-05-16T00:03:00.000Z",
      });
      const peerStore = new PeerInitiativeStore(runtimeRoot, { controlBaseDir: tmpDir });
      const [candidate] = generatePeerInitiativeCandidates({
        details: {
          peer_initiative: {
            kind: "care_presence",
            message: "Small low-pressure check-in.",
            action_plan: { mode: "care_only", permission_required: false },
            worthiness: {
              can_be_valuable_without_reply: true,
              user_cognitive_load: "low",
              reply_pressure: "none",
              care_value: "high",
              attention_fit: "medium",
              concrete_helpfulness: "medium",
              self_serving_risk: "none",
              tutorial_risk: "none",
            },
          },
        },
        attentionSignalRefs: ["attention:calibration:1"],
        policyEpoch: "policy:calibration",
        now: "2026-05-16T00:03:30.000Z",
        surfaceTarget: "telegram",
      });
      expect(candidate).toBeDefined();
      await peerStore.upsertCandidate({ candidate: candidate!, selectedState: "suggested" });
      await peerStore.appendFeedbackProjection(PeerFeedbackProjectionSchema.parse({
        projection_id: "peer-feedback:wrong-read",
        candidate_id: candidate!.candidate_id,
        kind: candidate!.kind,
        structured_outcome: "wrong_read",
        source_surface: "telegram",
        projected_at: "2026-05-16T00:04:00.000Z",
      }));

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const code = await cmdRuntime(stateManager, ["proactive-calibration", "--json"]);
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      logSpy.mockRestore();

      expect(code).toBe(0);
      expect(output).not.toContain(candidate!.candidate_id);
      const report = JSON.parse(output) as {
        read_only: boolean;
        mutation_performed: boolean;
        relationship_profile_write_performed: boolean;
        relationship_review: {
          review_item_count: number;
          pending_wrong_read_count: number;
          raw_refs_visible: boolean;
          relationship_profile_write_performed: boolean;
        };
        threshold_tuning_evidence: {
          accepted_count: number;
          dismissed_count: number;
          corrected_count: number;
          wrong_read_count: number;
        };
        recommendation: string;
      };
      expect(report).toMatchObject({
        read_only: true,
        mutation_performed: false,
        relationship_profile_write_performed: false,
        threshold_tuning_evidence: {
          accepted_count: 1,
          dismissed_count: 1,
          corrected_count: 1,
          wrong_read_count: 1,
        },
        recommendation: "review_relationship_reading",
        relationship_review: {
          review_item_count: 1,
          pending_wrong_read_count: 1,
          raw_refs_visible: false,
          relationship_profile_write_performed: false,
        },
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("can explicitly apply calibration feedback into policy state", async () => {
    const tmpDir = makeTempDir("pulseed-peer-initiative-calibration-apply-");
    try {
      const stateManager = new StateManager(tmpDir);
      await stateManager.init();
      const runtimeRoot = path.join(tmpDir, "runtime");
      const peerStore = new PeerInitiativeStore(runtimeRoot, { controlBaseDir: tmpDir });
      const [candidate] = generatePeerInitiativeCandidates({
        details: {
          peer_initiative: {
            kind: "care_presence",
            message: "Small low-pressure check-in.",
            action_plan: { mode: "care_only", permission_required: false },
            worthiness: {
              can_be_valuable_without_reply: true,
              user_cognitive_load: "low",
              reply_pressure: "none",
              care_value: "high",
              attention_fit: "medium",
              concrete_helpfulness: "medium",
              self_serving_risk: "none",
              tutorial_risk: "none",
            },
          },
        },
        attentionSignalRefs: ["attention:calibration:apply"],
        policyEpoch: "policy:calibration",
        now: NOW,
        surfaceTarget: "telegram",
      });
      expect(candidate).toBeDefined();
      await peerStore.upsertCandidate({ candidate: candidate!, selectedState: "suggested" });
      await peerStore.appendFeedbackProjection(PeerFeedbackProjectionSchema.parse({
        projection_id: "peer-feedback:not-now",
        candidate_id: candidate!.candidate_id,
        kind: candidate!.kind,
        structured_outcome: "not_now",
        source_surface: "telegram",
        projected_at: "2026-05-16T00:04:00.000Z",
      }));

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const code = await cmdRuntime(stateManager, ["proactive-calibration", "--apply-policy", "--json"]);
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      logSpy.mockRestore();

      expect(code).toBe(0);
      expect(output).not.toContain(candidate!.candidate_id);
      const parsed = JSON.parse(output) as {
        report: { read_only: boolean; mutation_performed: boolean };
        policy_application: {
          mutation_performed: boolean;
          policy_state_result: {
            applied_event_count: number;
            after_max_delivery_kind: string;
          };
          authority_escalation_performed: boolean;
          relationship_profile_write_performed: boolean;
          raw_refs_visible: boolean;
        };
      };
      expect(parsed.report).toMatchObject({
        read_only: true,
        mutation_performed: false,
      });
      expect(parsed.policy_application).toMatchObject({
        mutation_performed: true,
        policy_state_result: {
          applied_event_count: 1,
          after_max_delivery_kind: "digest",
        },
        authority_escalation_performed: false,
        relationship_profile_write_performed: false,
        raw_refs_visible: false,
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("creates and accepts an explicit resident activation binding for one-day Telegram dogfood", async () => {
    const tmpDir = makeTempDir("pulseed-resident-activation-cli-");
    try {
      const stateManager = new StateManager(tmpDir);
      await stateManager.init();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const proposeCode = await cmdRuntime(stateManager, [
        "resident-activation",
        "propose",
        "--hours",
        "24",
        "--json",
      ]);
      const proposalOutput = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      logSpy.mockClear();
      const proposal = JSON.parse(proposalOutput) as {
        proposal_id: string;
        requested_max_delivery_kind: string;
        daily_budget: { max_notify: number };
        runtime_authority: boolean;
      };
      const acceptCode = await cmdRuntime(stateManager, [
        "resident-activation",
        "accept",
        proposal.proposal_id,
        "--json",
      ]);
      const bindingOutput = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      logSpy.mockClear();
      const statusCode = await cmdRuntime(stateManager, ["resident-activation", "status", "--json"]);
      const statusOutput = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      logSpy.mockRestore();

      expect(proposeCode).toBe(0);
      expect(acceptCode).toBe(0);
      expect(statusCode).toBe(0);
      const binding = JSON.parse(bindingOutput) as {
        max_delivery_kind: string;
        interruption_budget: { max_notify: number; current_debits: number };
        runtime_authority: boolean;
      };
      const status = JSON.parse(statusOutput) as {
        active: boolean;
        active_binding: { max_delivery_kind: string; budget: { max_notify: number } } | null;
        raw_refs_visible: boolean;
        runtime_authority: boolean;
      };
      expect(proposal).toMatchObject({
        requested_max_delivery_kind: "notify",
        daily_budget: { max_notify: 4 },
        runtime_authority: false,
      });
      expect(binding).toMatchObject({
        max_delivery_kind: "notify",
        interruption_budget: { max_notify: 4, current_debits: 0 },
        runtime_authority: false,
      });
      expect(status).toMatchObject({
        active: true,
        active_binding: {
          max_delivery_kind: "notify",
          budget: { max_notify: 4 },
        },
        raw_refs_visible: false,
        runtime_authority: false,
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });
});
