import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { ProactiveInterventionStore } from "../proactive-intervention-store.js";

describe("ProactiveInterventionStore", () => {
  let runtimeRoot: string;
  let store: ProactiveInterventionStore;

  beforeEach(() => {
    runtimeRoot = makeTempDir("pulseed-proactive-interventions-");
    store = new ProactiveInterventionStore(runtimeRoot);
  });

  afterEach(() => {
    cleanupTempDir(runtimeRoot);
  });

  it("summarizes accepted, ignored, corrected, and overreach feedback", async () => {
    await store.appendIntervention({
      activity: {
        intervention_id: "intervention-accepted",
        kind: "suggestion",
        trigger: "proactive_tick",
        summary: "Suggested a goal.",
        recorded_at: "2026-05-02T00:00:00.000Z",
      },
    });
    await store.appendIntervention({
      activity: {
        intervention_id: "intervention-ignored",
        kind: "sleep",
        trigger: "proactive_tick",
        summary: "Stayed idle.",
        recorded_at: "2026-05-02T00:01:00.000Z",
      },
    });
    await store.appendIntervention({
      activity: {
        intervention_id: "intervention-corrected",
        kind: "observation",
        trigger: "proactive_tick",
        summary: "Queued a check.",
        recorded_at: "2026-05-02T00:02:00.000Z",
      },
    });
    await store.appendIntervention({
      activity: {
        intervention_id: "intervention-overreach",
        kind: "suggestion",
        trigger: "proactive_tick",
        summary: "Suggested at the wrong time.",
        recorded_at: "2026-05-02T00:03:00.000Z",
      },
    });

    await store.appendFeedback({
      interventionId: "intervention-accepted",
      outcome: "accepted",
      recordedAt: "2026-05-02T00:05:00.000Z",
      followThroughSuccess: true,
    });
    await store.appendFeedback({
      interventionId: "intervention-ignored",
      outcome: "ignored",
      recordedAt: "2026-05-02T00:06:00.000Z",
    });
    await store.appendFeedback({
      interventionId: "intervention-corrected",
      outcome: "corrected",
      recordedAt: "2026-05-02T00:07:00.000Z",
      reason: "Wrong goal context.",
    });
    await store.appendFeedback({
      interventionId: "intervention-overreach",
      outcome: "overreach",
      overreachIndicators: ["too_frequent"],
      recordedAt: "2026-05-02T00:08:00.000Z",
    });

    const summary = await store.summarize();
    expect(fs.existsSync(path.join(runtimeRoot, "proactive-interventions", "events.jsonl"))).toBe(false);
    expect(summary.total_interventions).toBe(4);
    expect(summary.accepted_count).toBe(1);
    expect(summary.ignored_count).toBe(1);
    expect(summary.corrected_count).toBe(1);
    expect(summary.overreach_count).toBe(1);
    expect(summary.pending_count).toBe(0);
    expect(summary.by_kind.suggestion).toBe(2);
    expect(summary.policy_adjustment_recommendation).toMatchObject({
      relationship_profile_key: "user.intervention.proactivity",
      suggested_action: "reduce_frequency",
    });
  });
});
