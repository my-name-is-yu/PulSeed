import { describe, expect, it } from "vitest";
import {
  MICRO_PROBE_FORBIDDEN_CAPABILITIES,
  MicroProbePlanSchema,
  MicroProbeReadSetEntrySchema,
  defaultRuntimeEvidenceTrust,
  runNoOutwardEffectMicroProbe,
  type MicroProbePlan,
  type MicroProbeReadSetEntry,
} from "../index.js";

describe("micro-probe no-outward-effect runner", () => {
  it("requires immutable replay refs and rejects ambiguous snapshot sources", () => {
    expect(() =>
      MicroProbeReadSetEntrySchema.parse({
        ...readRef(),
        snapshotEventRef: "runtime-event:1",
        snapshotEvidenceRef: "runtime-evidence:1",
      })
    ).toThrow(/exactly one immutable replay source/);
  });

  it("forbids every outward action port by explicit capability name", () => {
    const plan = makePlan();

    expect(plan.forbiddenCapabilities).toEqual(expect.arrayContaining([
      "tool_executor",
      "shell",
      "mcp_gateway_adapter",
      "browser",
      "network",
      "llm_model_client",
      "companion_cognition_evaluate_turn",
      "companion_cognition_evaluate_runtime_control_response",
      "attention_wake_admission_commitment",
      "notification_speech_surface_delivery",
      "agent_memory_write",
      "soil_write",
      "dream_write",
      "profile_write",
      "procedural_memory_write",
      "owner_writeback_write",
    ]));

    expect(() =>
      MicroProbePlanSchema.parse({
        ...plan,
        forbiddenCapabilities: MICRO_PROBE_FORBIDDEN_CAPABILITIES.filter((capability) => capability !== "shell"),
      })
    ).toThrow(/missing forbidden capabilities/);
  });

  it("supports only independent immutable replay evidence and blocks replay drift", () => {
    const plan = makePlan();
    const trust = defaultRuntimeEvidenceTrust({
      targetRef: { kind: "micro_probe_record", id: "record-1" },
      provenanceRefs: ["evidence-source", "evidence-held-out"],
    });

    const supported = runNoOutwardEffectMicroProbe({
      plan,
      trust,
      now: "2026-05-17T00:00:00.000Z",
      readResults: [{ readRef: plan.readSet[0]!, payloadHash: "payload-hash" }],
      supportEvidenceRefs: ["evidence-source", "evidence-held-out"],
      supportEventRefs: ["runtime-event:held-out"],
    });
    expect(supported).toEqual(expect.objectContaining({
      outcome: "supported",
      supportEvidenceRefs: ["evidence-held-out"],
      usedIndependentSupport: true,
      correctionFilterDecision: "current",
    }));

    const drifted = runNoOutwardEffectMicroProbe({
      plan,
      trust,
      now: "2026-05-17T00:00:00.000Z",
      readResults: [{ readRef: plan.readSet[0]!, payloadHash: "different-hash" }],
      supportEvidenceRefs: ["evidence-held-out"],
    });
    expect(drifted).toEqual(expect.objectContaining({
      outcome: "blocked",
      supportEvidenceRefs: [],
      usedIndependentSupport: false,
    }));

    const selfConfirming = runNoOutwardEffectMicroProbe({
      plan,
      trust,
      now: "2026-05-17T00:00:00.000Z",
      readResults: [{ readRef: plan.readSet[0]!, payloadHash: "payload-hash" }],
      supportEvidenceRefs: ["evidence-source"],
    });
    expect(selfConfirming).toEqual(expect.objectContaining({
      outcome: "inconclusive",
      supportEvidenceRefs: [],
      usedIndependentSupport: false,
    }));
  });
});

function makePlan(): MicroProbePlan {
  return MicroProbePlanSchema.parse({
    id: "micro-probe-plan-1",
    goalId: "goal-1",
    loopIndex: 1,
    frameId: "frame-1",
    hypothesisIds: ["hypothesis-1", "hypothesis-2"],
    plannedAt: "2026-05-17T00:00:00.000Z",
    mode: "runtime_event_replay",
    sourceEvidenceRefs: ["evidence-source"],
    sourceEventRefs: ["runtime-event:source"],
    sourceRuntimeGraphRefs: [],
    readSet: [readRef()],
    probeSchemaVersion: "micro-probe/v1",
    expectedSignals: [{
      polarity: "if_true",
      signalId: "signal-held-out",
      signalKind: "independent_runtime_evidence",
      diagnosticLabel: "held-out replay evidence supports the hypothesis",
    }],
  });
}

function readRef(): MicroProbeReadSetEntry {
  return MicroProbeReadSetEntrySchema.parse({
    sourceKind: "runtime_event_projection",
    ref: "runtime-event:source",
    snapshotId: "runtime-event-projection:source",
    runtimeEventProjectionRef: "runtime-event-projection:source",
    portSchemaVersion: "runtime-event-projection/v1",
    versionOrSequence: "runtime-event:source",
    highWatermark: "runtime-event:source",
    inputHash: "input-hash",
    snapshotPayloadHash: "payload-hash",
    redactionClass: "refs_only",
    port: "runtime_event_log_snapshot",
  });
}
