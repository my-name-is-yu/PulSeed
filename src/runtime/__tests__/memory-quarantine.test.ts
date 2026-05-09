import * as fsp from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../tests/helpers/temp-dir.js";
import { RuntimeEvidenceLedger } from "../store/evidence-ledger.js";
import { RuntimeEvidenceStateStore } from "../store/runtime-evidence-state-store.js";

describe("runtime memory quarantine", () => {
  let runtimeRoot: string;

  beforeEach(() => {
    runtimeRoot = makeTempDir("pulseed-runtime-quarantine-");
  });

  afterEach(async () => {
    await fsp.rm(runtimeRoot, { recursive: true, force: true });
  });

  async function requireSummaryIndex(runId: string) {
    const index = await new RuntimeEvidenceStateStore(runtimeRoot).loadSummaryIndex({ kind: "run", id: runId });
    if (!index) {
      throw new Error(`missing runtime evidence summary index for ${runId}`);
    }
    return index;
  }

  it("excludes quarantined evidence from default runtime summaries", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "evidence-active",
      occurred_at: "2026-05-02T00:00:00.000Z",
      kind: "observation",
      scope: { goal_id: "goal-q", run_id: "run:q" },
      summary: "Verified planning evidence.",
      outcome: "continued",
    });
    await ledger.append({
      id: "evidence-quarantined",
      occurred_at: "2026-05-02T00:01:00.000Z",
      kind: "observation",
      scope: { goal_id: "goal-q", run_id: "run:q" },
      summary: "Suspicious evidence.",
      outcome: "continued",
      quarantine_state: {
        status: "quarantined",
        active: false,
        reason: "Contradicted by later verification evidence.",
        source: "runtime_verification",
        confidence: 0.9,
        inspection_refs: ["verification:later"],
        created_at: "2026-05-02T00:02:00.000Z",
      },
    });

    const summary = await ledger.summarizeRun("run:q");

    expect(summary.recent_entries.map((entry) => entry.id)).toEqual(["evidence-active"]);
    expect((await ledger.readByRun("run:q")).entries.map((entry) => entry.id)).toContain("evidence-quarantined");
  });

  it("invalidates pre-quarantine summary indexes before serving planning context", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "cached-quarantined",
      occurred_at: "2026-05-02T00:00:00.000Z",
      kind: "observation",
      scope: { run_id: "run:cache" },
      summary: "Cached suspicious evidence.",
      outcome: "continued",
      quarantine_state: {
        status: "quarantined",
        active: false,
        reason: "Cached entry must be filtered after policy bump.",
        source: "runtime_verification",
        confidence: 0.9,
        inspection_refs: ["verification:cache"],
        created_at: "2026-05-02T00:01:00.000Z",
      },
    });
    const staleSummary = {
      ...(await ledger.rebuildSummaryIndexForRun("run:cache")),
      context_policy_version: "correction-filtered-planning-context-v1",
      recent_entries: (await ledger.readByRun("run:cache")).entries,
    };
    const staleIndex = await requireSummaryIndex("run:cache");
    await new RuntimeEvidenceStateStore(runtimeRoot).saveSummaryIndex({ kind: "run", id: "run:cache" }, {
      ...staleIndex,
      generated_at: "2026-05-02T00:02:00.000Z",
      summary: staleSummary as unknown as typeof staleIndex.summary,
    });

    const summary = await new RuntimeEvidenceLedger(runtimeRoot).summarizeRun("run:cache");

    expect(summary.context_policy_version).toBe("quarantine-filtered-planning-context-v2");
    expect(summary.recent_entries).toEqual([]);
  });

  it("filters prompt-injection-like Dream memory refs by typed quarantine metadata", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "dream-entry",
      occurred_at: "2026-05-02T00:00:00.000Z",
      kind: "dream_checkpoint",
      scope: { goal_id: "goal-q", run_id: "run:q" },
      dream_checkpoints: [{
        trigger: "iteration",
        summary: "Checkpoint included suspicious and trusted memories.",
        current_goal: "goal-q",
        active_dimensions: [],
        best_evidence_so_far: "evidence-active",
        recent_strategy_families: [],
        exhausted: [],
        promising: [],
        relevant_memories: [
          {
            source_type: "other",
            ref: "web-memory-injection",
            summary: "Captured web instruction.",
            authority: "advisory_only",
            provenance: {
              source_type: "web",
              source_ref: "https://example.invalid",
              raw_refs: ["snapshot:1"],
              reliability: 0.2,
              verification_status: "suspicious",
              risk_signals: ["prompt_injection_like"],
            },
          },
          {
            source_type: "runtime_evidence",
            ref: "trusted-memory",
            summary: "Trusted prior evidence.",
            authority: "advisory_only",
            source_reliability: 0.9,
          },
        ],
        active_hypotheses: [],
        rejected_approaches: [],
        next_strategy_candidates: [],
        guidance: "Continue from trusted evidence.",
        uncertainty: [],
        context_authority: "advisory_only",
        confidence: 0.8,
      }],
      summary: "Dream checkpoint.",
      outcome: "continued",
    });

    const summary = await ledger.summarizeRun("run:q");

    expect(summary.dream_checkpoints).toHaveLength(1);
    expect(summary.dream_checkpoints[0]!.relevant_memories.map((memory) => memory.ref)).toEqual(["trusted-memory"]);
    expect(summary.dream_checkpoints[0]!.planning_context_status).toBe("partially_retracted");
  });
});
