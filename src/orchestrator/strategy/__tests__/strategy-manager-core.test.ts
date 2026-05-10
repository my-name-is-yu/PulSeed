import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { z } from "zod";
import { StateManager } from "../../../base/state/state-manager.js";
import { StrategyManager } from "../strategy-manager.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import type { Strategy } from "../../../base/types/strategy.js";
import type { DecisionRecord } from "../../../base/types/knowledge.js";
import {
  applyDecisionHeuristicsToCandidates,
  selectTemplateCandidatesWithTrace,
} from "../../../platform/dream/dream-activation.js";
import { saveDreamConfig } from "../../../platform/dream/dream-config.js";
import { DreamDecisionHeuristicStore } from "../../../runtime/store/dream-decision-heuristic-store.js";
import { StrategyTemplateStateStore } from "../strategy-template-state-store.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";

// ─── Fixtures ───

const CANDIDATE_RESPONSE_ONE = `\`\`\`json
[
  {
    "hypothesis": "Increase daily writing output by dedicating the first 2 hours of each day to writing",
    "expected_effect": [
      { "dimension": "word_count", "direction": "increase", "magnitude": "medium" }
    ],
    "resource_estimate": {
      "sessions": 10,
      "duration": { "value": 14, "unit": "days" },
      "llm_calls": null
    },
    "allocation": 0.8
  }
]
\`\`\``;

const CANDIDATE_RESPONSE_TWO = `\`\`\`json
[
  {
    "hypothesis": "Use the Pomodoro technique for focused research sessions",
    "expected_effect": [
      { "dimension": "research_depth", "direction": "increase", "magnitude": "large" }
    ],
    "resource_estimate": {
      "sessions": 5,
      "duration": { "value": 7, "unit": "days" },
      "llm_calls": 2
    },
    "allocation": 0.6
  },
  {
    "hypothesis": "Create a structured outline before each writing session",
    "expected_effect": [
      { "dimension": "word_count", "direction": "increase", "magnitude": "small" }
    ],
    "resource_estimate": {
      "sessions": 3,
      "duration": { "value": 3, "unit": "days" },
      "llm_calls": null
    },
    "allocation": 0.4
  }
]
\`\`\``;

function makeStrategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    id: "strategy-1",
    goal_id: "goal-1",
    primary_dimension: "word_count",
    target_dimensions: ["word_count"],
    hypothesis: "Test strategy",
    expected_effect: [],
    resource_estimate: { sessions: 1, duration: { value: 1, unit: "days" }, llm_calls: null },
    state: "candidate",
    allocation: 0,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    gap_snapshot_at_start: null,
    tasks_generated: [],
    effectiveness_score: null,
    consecutive_stall_count: 0,
    source_template_id: null,
    cross_goal_context: null,
    rollback_target_id: null,
    max_pivot_count: 2,
    pivot_count: 0,
    toolset_locked: false,
    allowed_tools: [],
    required_tools: [],
    ...overrides,
  };
}

function makeDecisionRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "decision-1",
    goal_id: "goal-1",
    goal_type: "kaggle",
    strategy_id: "strategy-old",
    hypothesis: "historical diagnostic text",
    decision: "pivot",
    context: {
      gap_value: 0.4,
      stall_count: 2,
      cycle_count: 5,
      trust_score: 0,
    },
    outcome: "failure",
    timestamp: "2026-05-04T00:00:00.000Z",
    what_worked: [],
    what_failed: [],
    suggested_next: [],
    ...overrides,
  };
}

function makeDecisionHistoryManager(records: DecisionRecord[]): TestableStrategyManager {
  return new TestableStrategyManager(
    stateManager,
    createMockLLMClient([]),
    {
      queryDecisions: vi.fn().mockResolvedValue(records),
    } as never
  );
}

const STRATEGY_TEMPLATES_ACTIVATION = {
  verifiedPlannerHintsOnly: false,
  semanticWorkingMemory: false,
  crossGoalLessons: false,
  semanticContext: false,
  autoAcquireKnowledge: false,
  learnedPatternHints: false,
  playbookHints: false,
  workflowHints: false,
  strategyTemplates: true,
  decisionHeuristics: false,
  graphTraversal: false,
} as const;

async function saveStrategyTemplates(
  baseDir: string,
  templates: Parameters<StrategyTemplateStateStore["saveMany"]>[0]
): Promise<void> {
  await new StrategyTemplateStateStore(baseDir).saveMany(templates);
}

const DECISION_HEURISTICS_ACTIVATION = {
  ...STRATEGY_TEMPLATES_ACTIVATION,
  strategyTemplates: false,
  decisionHeuristics: true,
} as const;

const VERIFIED_HINTS_ONLY_HEURISTICS_ACTIVATION = {
  ...DECISION_HEURISTICS_ACTIVATION,
  verifiedPlannerHintsOnly: true,
} as const;

class TestableStrategyManager extends StrategyManager {
  rankByDecisionHistory(candidates: Strategy[], goalType: string): Promise<Strategy[]> {
    return this._rankCandidatesByDecisionHistory(candidates, goalType);
  }
}

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
});

describe("decision history lineage ranking", () => {
  it("downranks a paraphrased candidate from a failed typed lineage", async () => {
    const failedLineageCandidate = makeStrategy({
      id: "candidate-threshold",
      hypothesis: "Explore a narrower cutoff calibration sweep around the plateau",
      exploration: {
        schema_version: "strategy-exploration-v1",
        phase: "divergent_stall_recovery",
        role: "adjacent_exploration",
        strategy_family: "threshold_sweep",
        novelty_score: 0.55,
        similarity_to_recent_failures: 0,
        expected_cost: "medium",
        relationship_to_lineage: "neighbor",
        smoke: { status: "not_run", reason: "Smoke before full run." },
        speculative: true,
        evidence_authority: "speculative_hypothesis",
      },
    });
    const unrelatedCandidate = makeStrategy({
      id: "candidate-audit",
      hypothesis: "Audit validation fold distribution before more tuning",
      exploration: {
        schema_version: "strategy-exploration-v1",
        phase: "divergent_stall_recovery",
        role: "divergent_exploration",
        strategy_family: "fold_distribution_audit",
        novelty_score: 0.82,
        similarity_to_recent_failures: 0,
        expected_cost: "low",
        relationship_to_lineage: "different_assumption",
        smoke: { status: "not_run", reason: "Smoke before full run." },
        speculative: true,
        evidence_authority: "speculative_hypothesis",
      },
    });
    const manager = makeDecisionHistoryManager([
      makeDecisionRecord({ id: "d1", lineage: { strategy_family: "threshold_sweep", failed_lineage_fingerprints: [], lineage_evidence_refs: [] } }),
      makeDecisionRecord({ id: "d2", lineage: { strategy_family: "threshold_sweep", failed_lineage_fingerprints: [], lineage_evidence_refs: [] } }),
      makeDecisionRecord({ id: "d3", decision: "proceed", outcome: "success", lineage: { strategy_family: "fold_distribution_audit", failed_lineage_fingerprints: [], lineage_evidence_refs: [] } }),
    ]);

    const ranked = await manager.rankByDecisionHistory([failedLineageCandidate, unrelatedCandidate], "kaggle");

    expect(ranked.map((strategy) => strategy.id)).toEqual(["candidate-audit", "candidate-threshold"]);
  });

  it("does not penalize unrelated candidates that only overlap hypothesis tokens", async () => {
    const failedText = "Tune threshold calibration around current model";
    const overlappingButTypedDifferent = makeStrategy({
      id: "candidate-overlap",
      hypothesis: "Calibrate reporting threshold for documentation coverage",
      exploration: {
        schema_version: "strategy-exploration-v1",
        phase: "normal",
        role: "exploitation",
        strategy_family: "documentation_quality",
        novelty_score: 0.4,
        similarity_to_recent_failures: 0,
        expected_cost: "low",
        relationship_to_lineage: "current_best",
        smoke: { status: "not_run", reason: "No smoke required." },
        speculative: true,
        evidence_authority: "speculative_hypothesis",
      },
    });
    const manager = makeDecisionHistoryManager([
      makeDecisionRecord({ id: "d1", hypothesis: failedText, lineage: { strategy_family: "model_threshold_sweep", failed_lineage_fingerprints: [], lineage_evidence_refs: [] } }),
      makeDecisionRecord({ id: "d2", hypothesis: failedText, lineage: { strategy_family: "model_threshold_sweep", failed_lineage_fingerprints: [], lineage_evidence_refs: [] } }),
      makeDecisionRecord({ id: "d3", hypothesis: failedText, lineage: { strategy_family: "model_threshold_sweep", failed_lineage_fingerprints: [], lineage_evidence_refs: [] } }),
    ]);

    const ranked = await manager.rankByDecisionHistory([overlappingButTypedDifferent], "coding");

    expect(ranked[0]?.id).toBe("candidate-overlap");
  });

  it("preserves existing order when fewer than three decision records exist", async () => {
    const first = makeStrategy({ id: "candidate-first", hypothesis: "First candidate" });
    const second = makeStrategy({ id: "candidate-second", hypothesis: "Second candidate" });
    const manager = makeDecisionHistoryManager([
      makeDecisionRecord({ id: "d1", lineage: { strategy_family: "candidate-second-family", failed_lineage_fingerprints: [], lineage_evidence_refs: [] } }),
      makeDecisionRecord({ id: "d2", lineage: { strategy_family: "candidate-second-family", failed_lineage_fingerprints: [], lineage_evidence_refs: [] } }),
    ]);

    const ranked = await manager.rankByDecisionHistory([first, second], "general");

    expect(ranked.map((strategy) => strategy.id)).toEqual(["candidate-first", "candidate-second"]);
  });
});

// ─── generateCandidates ───

describe("generateCandidates", () => {
  it("returns validated Strategy[] with state=candidate", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    const candidates = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].state).toBe("candidate");
    expect(candidates[0].goal_id).toBe("goal-1");
    expect(candidates[0].primary_dimension).toBe("word_count");
    expect(candidates[0].target_dimensions).toEqual(["word_count"]);
    expect(candidates[0].hypothesis).toContain("writing");
  });

  it("returns 2 candidates when LLM generates 2", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO]);
    const manager = new StrategyManager(stateManager, mock);

    const candidates = await manager.generateCandidates("goal-1", "research_depth", ["research_depth", "word_count"], {
      currentGap: 0.5,
      pastStrategies: [],
    });

    expect(candidates).toHaveLength(2);
    expect(candidates[0].state).toBe("candidate");
    expect(candidates[1].state).toBe("candidate");
  });

  it("stores candidates in portfolio", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    const portfolio = await manager.getPortfolio("goal-1");
    expect(portfolio).not.toBeNull();
    expect(portfolio!.strategies).toHaveLength(1);
    expect(portfolio!.strategies[0].state).toBe("candidate");
  });

  it("assigns unique IDs to each candidate", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO]);
    const manager = new StrategyManager(stateManager, mock);

    const candidates = await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
      currentGap: 0.5,
      pastStrategies: [],
    });

    expect(candidates[0].id).not.toBe(candidates[1].id);
    expect(typeof candidates[0].id).toBe("string");
  });

  it("sets created_at timestamp as ISO string", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    const before = new Date().toISOString();
    const candidates = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    const after = new Date().toISOString();

    expect(candidates[0].created_at >= before).toBe(true);
    expect(candidates[0].created_at <= after).toBe(true);
  });

  it("includes past strategies in the prompt (does not throw)", async () => {
    const pastStrategy: Strategy = makeStrategy({
      id: "old-strategy-1",
      hypothesis: "Old approach that failed",
      resource_estimate: { sessions: 5, duration: { value: 7, unit: "days" }, llm_calls: null },
      state: "terminated",
      consecutive_stall_count: 1,
    });

    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await expect(
      manager.generateCandidates("goal-1", "word_count", ["word_count"], {
        currentGap: 0.7,
        pastStrategies: [pastStrategy],
      })
    ).resolves.not.toThrow();
  });

  it("prepends a template-backed candidate when strategyTemplates is enabled", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    await saveDreamConfig(
      { activation: STRATEGY_TEMPLATES_ACTIVATION },
      stateManager.getBaseDir()
    );
    await stateManager.saveGoal({
      id: "goal-1",
      title: "Improve research throughput",
      description: "Need a reusable research plan",
      status: "active",
      dimensions: [],
      parent_id: null,
      child_goal_ids: [],
      success_criteria: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any);
    await saveStrategyTemplates(tempDir, [
      {
        template_id: "tmpl-1",
        source_goal_id: "goal-src",
        source_strategy_id: "strat-src",
        hypothesis_pattern: "Start with a structured research checklist",
        domain_tags: ["research"],
        effectiveness_score: 0.9,
        applicable_dimensions: ["research_depth"],
        embedding_id: null,
        created_at: new Date().toISOString(),
      },
    ]);

    const candidates = await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
      currentGap: 0.5,
      pastStrategies: [],
    });

    expect(candidates[0]!.source_template_id).toBe("tmpl-1");
    expect(candidates[0]!.hypothesis).toContain("structured research checklist");
    expect(candidates[0]!.planner_hint_trace).toMatchObject({
      source: "dream_template_typed_applicability",
      source_id: "tmpl-1",
      lexical_overlap_used: false,
      matched_dimensions: ["research_depth"],
    });
  });

  it("does not materialize templates from paraphrased text or stored embedding ids without typed applicability", async () => {
    const matches = selectTemplateCandidatesWithTrace(
      [{
        template_id: "tmpl-text-only",
        source_goal_id: "goal-src",
        source_strategy_id: "strat-src",
        hypothesis_pattern: "Audit classifier plateau behavior",
        domain_tags: ["audit"],
        effectiveness_score: 0.95,
        applicable_dimensions: ["unrelated_dimension"],
        embedding_id: "emb-text-only",
        created_at: new Date().toISOString(),
      }],
      "Audit model plateau for balanced accuracy",
      ["balanced_accuracy"],
      1
    );

    expect(matches).toEqual([]);
  });

  it("keeps advisory hints from overriding typed template materialization", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    await saveDreamConfig(
      {
        activation: {
          ...STRATEGY_TEMPLATES_ACTIVATION,
          learnedPatternHints: true,
        },
      },
      stateManager.getBaseDir()
    );
    await stateManager.saveGoal({
      id: "goal-1",
      title: "Improve balanced accuracy",
      description: "Need a fold audit",
      status: "active",
      dimensions: [],
      parent_id: null,
      child_goal_ids: [],
      success_criteria: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any);
    fs.mkdirSync(`${tempDir}/learning`, { recursive: true });
    fs.writeFileSync(
      `${tempDir}/learning/goal-1_patterns.json`,
      JSON.stringify([{
        pattern_id: "pattern-advisory",
        type: "strategy_selection",
        description: "Prefer text-only threshold tuning",
        source_goal_ids: ["goal-1"],
        applicable_domains: ["kaggle"],
        confidence: 0.99,
        evidence_count: 10,
        created_at: new Date().toISOString(),
        last_applied_at: null,
      }], null, 2)
    );
    await saveStrategyTemplates(tempDir, [
      {
        template_id: "tmpl-audit",
        source_goal_id: "goal-src",
        source_strategy_id: "strat-src",
        hypothesis_pattern: "Run fold distribution audit",
        domain_tags: ["audit"],
        effectiveness_score: 0.8,
        applicable_dimensions: ["balanced_accuracy"],
        embedding_id: null,
        created_at: new Date().toISOString(),
      },
      {
        template_id: "tmpl-text-only",
        source_goal_id: "goal-src",
        source_strategy_id: "strat-src-2",
        hypothesis_pattern: "Prefer text-only threshold tuning",
        domain_tags: ["kaggle"],
        effectiveness_score: 0.99,
        applicable_dimensions: ["other_dimension"],
        embedding_id: null,
        created_at: new Date().toISOString(),
      },
    ]);

    const candidates = await manager.generateCandidates("goal-1", "balanced_accuracy", ["balanced_accuracy"], {
      currentGap: 0.2,
      pastStrategies: [],
    });

    expect(candidates[0]!.source_template_id).toBe("tmpl-audit");
    expect(candidates.some((candidate) => candidate.source_template_id === "tmpl-text-only")).toBe(false);
  });

  it("assigns unique ids to repeated template-backed candidates", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE, CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    await saveDreamConfig(
      { activation: STRATEGY_TEMPLATES_ACTIVATION },
      stateManager.getBaseDir()
    );
    await stateManager.saveGoal({
      id: "goal-1",
      title: "Improve research throughput",
      description: "Need a reusable research plan",
      status: "active",
      dimensions: [],
      parent_id: null,
      child_goal_ids: [],
      success_criteria: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any);
    await saveStrategyTemplates(tempDir, [
      {
        template_id: "tmpl-1",
        source_goal_id: "goal-src",
        source_strategy_id: "strat-src",
        hypothesis_pattern: "Start with a structured research checklist",
        domain_tags: ["research"],
        effectiveness_score: 0.9,
        applicable_dimensions: ["research_depth"],
        embedding_id: null,
        created_at: new Date().toISOString(),
      },
    ]);

    const first = await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
      currentGap: 0.5,
      pastStrategies: [],
    });
    const second = await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
      currentGap: 0.5,
      pastStrategies: [],
    });

    expect(first[0]!.id).not.toBe(second[0]!.id);
  });

  it("ignores legacy substring-only decision heuristics when ranking candidates", async () => {
    const candidates = [
      makeStrategy({
        id: "cand-1",
        primary_dimension: "research_depth",
        target_dimensions: ["research_depth"],
        hypothesis: "Use the Pomodoro technique for focused research sessions",
        allocation: 0.6,
      }),
      makeStrategy({
        id: "cand-2",
        primary_dimension: "research_depth",
        target_dimensions: ["research_depth"],
        hypothesis: "Create a structured outline before each writing session",
        allocation: 0.4,
      }),
    ] satisfies Strategy[];

    const reordered = applyDecisionHeuristicsToCandidates(
      candidates,
      [
        {
          id: "heur-1",
          prefer_strategy_hypothesis_includes: "outline",
          score_delta: 0.4,
          reason: "outline-first has worked before",
        },
        {
          id: "heur-2",
          avoid_strategy_hypothesis_includes: "pomodoro",
          score_delta: 0.2,
          reason: "avoid previous dead end",
        },
      ],
      {
        stallCount: 0,
        activeStrategyId: null,
      }
    );

    expect(reordered.map((candidate) => candidate.id)).toEqual(["cand-1", "cand-2"]);
  });

  it("applies typed decision heuristic selectors without relying on hypothesis text", async () => {
    const candidates = [
      makeStrategy({
        id: "cand-threshold",
        hypothesis: "Tune the current classifier threshold again with finer granularity",
        exploration: {
          schema_version: "strategy-exploration-v1",
          phase: "divergent_stall_recovery",
          role: "adjacent_exploration",
          strategy_family: "threshold_sweep",
          novelty_score: 0.45,
          similarity_to_recent_failures: 0.9,
          expected_cost: "medium",
          relationship_to_lineage: "failed_lineage",
          smoke: { status: "not_run", reason: "Smoke first." },
          speculative: true,
          evidence_authority: "speculative_hypothesis",
          lineage_assessment: {
            schema_version: "strategy-lineage-assessment-v1",
            confidence: 0.9,
            relationship_to_lineage: "failed_lineage",
            novelty_basis: "typed_lineage_evidence",
            matched_failed_lineage_fingerprints: ["threshold_sweep|balanced_accuracy"],
            matched_strategy_ids: [],
            evidence_refs: ["evidence-failed-1"],
            metric_trend: "stalled",
            summary: "Typed failed lineage.",
          },
        },
      }),
      makeStrategy({
        id: "cand-audit",
        hypothesis: "Audit fold distribution before another model refinement",
        exploration: {
          schema_version: "strategy-exploration-v1",
          phase: "divergent_stall_recovery",
          role: "divergent_exploration",
          strategy_family: "fold_distribution_audit",
          novelty_score: 0.82,
          similarity_to_recent_failures: 0,
          expected_cost: "low",
          relationship_to_lineage: "different_assumption",
          smoke: { status: "promote", reason: "Smoke passed.", evidence_ref: "evidence-smoke-1" },
          speculative: true,
          evidence_authority: "speculative_hypothesis",
          lineage_assessment: {
            schema_version: "strategy-lineage-assessment-v1",
            confidence: 0.82,
            relationship_to_lineage: "different_assumption",
            novelty_basis: "smoke_evidence",
            matched_failed_lineage_fingerprints: [],
            matched_strategy_ids: [],
            evidence_refs: ["evidence-smoke-1"],
            metric_trend: "stalled",
            summary: "Typed promoted smoke lineage.",
          },
        },
      }),
    ] satisfies Strategy[];

    const reordered = applyDecisionHeuristicsToCandidates(
      candidates,
      [
        {
          id: "heur-prefer-audit",
          prefer_candidate_selector: {
            strategy_family: "fold_distribution_audit",
            exploration_role: "divergent_exploration",
            smoke_status: "promote",
            metric_trend: "stalled",
          },
          score_delta: 0.4,
          reason: "prefer promoted divergent smoke result",
        },
        {
          id: "heur-avoid-failed",
          avoid_candidate_selector: {
            failed_lineage_fingerprint: "threshold_sweep|balanced_accuracy",
          },
          score_delta: 0.2,
          reason: "avoid repeated failed lineage",
        },
      ],
      {
        stallCount: 0,
        activeStrategyId: null,
      }
    );

    expect(reordered.map((candidate) => candidate.id)).toEqual(["cand-audit", "cand-threshold"]);
  });

  it("applies typed decision heuristics through generateCandidates when unverified hints are allowed", async () => {
    const response = `\`\`\`json
[
  {
    "hypothesis": "Slightly adjust the current classifier threshold",
    "expected_effect": [
      { "dimension": "balanced_accuracy", "direction": "increase", "magnitude": "small" }
    ],
    "resource_estimate": {
      "sessions": 2,
      "duration": { "value": 3, "unit": "hours" },
      "llm_calls": 1
    },
    "allocation": 0.3,
    "exploration": {
      "schema_version": "strategy-exploration-v1",
      "phase": "divergent_stall_recovery",
      "role": "adjacent_exploration",
      "strategy_family": "threshold_sweep",
      "novelty_score": 0.45,
      "similarity_to_recent_failures": 0.9,
      "expected_cost": "medium",
      "relationship_to_lineage": "failed_lineage",
      "smoke": { "status": "not_run", "reason": "Smoke first." },
      "speculative": true,
      "evidence_authority": "speculative_hypothesis",
      "lineage_assessment": {
        "schema_version": "strategy-lineage-assessment-v1",
        "confidence": 0.9,
        "relationship_to_lineage": "failed_lineage",
        "novelty_basis": "typed_lineage_evidence",
        "matched_failed_lineage_fingerprints": ["threshold_sweep|balanced_accuracy"],
        "matched_strategy_ids": [],
        "evidence_refs": ["evidence-failed-1"],
        "metric_trend": "stalled",
        "summary": "Typed failed lineage."
      }
    }
  },
  {
    "hypothesis": "Audit validation fold distribution before more model refinement",
    "expected_effect": [
      { "dimension": "balanced_accuracy", "direction": "increase", "magnitude": "medium" }
    ],
    "resource_estimate": {
      "sessions": 1,
      "duration": { "value": 45, "unit": "minutes" },
      "llm_calls": 1
    },
    "allocation": 0.3,
    "exploration": {
      "schema_version": "strategy-exploration-v1",
      "phase": "divergent_stall_recovery",
      "role": "divergent_exploration",
      "strategy_family": "fold_distribution_audit",
      "novelty_score": 0.82,
      "similarity_to_recent_failures": 0,
      "expected_cost": "low",
      "relationship_to_lineage": "different_assumption",
      "smoke": { "status": "promote", "reason": "Smoke passed.", "evidence_ref": "evidence-smoke-1" },
      "speculative": true,
      "evidence_authority": "speculative_hypothesis",
      "lineage_assessment": {
        "schema_version": "strategy-lineage-assessment-v1",
        "confidence": 0.82,
        "relationship_to_lineage": "different_assumption",
        "novelty_basis": "smoke_evidence",
        "matched_failed_lineage_fingerprints": [],
        "matched_strategy_ids": [],
        "evidence_refs": ["evidence-smoke-1"],
        "metric_trend": "stalled",
        "summary": "Typed promoted smoke lineage."
      }
    }
  }
]
\`\`\``;
    const manager = new StrategyManager(stateManager, createMockLLMClient([response]));
    await saveDreamConfig(
      { activation: DECISION_HEURISTICS_ACTIVATION },
      stateManager.getBaseDir()
    );
    await new DreamDecisionHeuristicStore({ controlBaseDir: tempDir }).saveDecisionHeuristics([{
      id: "heur-prefer-audit",
      prefer_candidate_selector: {
        strategy_family: "fold_distribution_audit",
        exploration_role: "divergent_exploration",
        smoke_status: "promote",
      },
      score_delta: 0.5,
      reason: "prefer promoted fold audit",
    }]);

    const candidates = await manager.generateCandidates("goal-1", "balanced_accuracy", ["balanced_accuracy"], {
      currentGap: 0.2,
      pastStrategies: [],
    });

    expect(candidates.map((candidate) => candidate.exploration?.strategy_family)).toEqual([
      "fold_distribution_audit",
      "threshold_sweep",
    ]);
  });

  it("blocks unverified decision heuristics through generateCandidates when verifiedPlannerHintsOnly is enabled", async () => {
    const response = `\`\`\`json
[
  {
    "hypothesis": "Audit validation fold distribution before more model refinement",
    "expected_effect": [
      { "dimension": "balanced_accuracy", "direction": "increase", "magnitude": "medium" }
    ],
    "resource_estimate": {
      "sessions": 1,
      "duration": { "value": 45, "unit": "minutes" },
      "llm_calls": 1
    },
    "allocation": 0.3,
    "exploration": {
      "schema_version": "strategy-exploration-v1",
      "phase": "divergent_stall_recovery",
      "role": "divergent_exploration",
      "strategy_family": "fold_distribution_audit",
      "novelty_score": 0.82,
      "similarity_to_recent_failures": 0,
      "expected_cost": "low",
      "relationship_to_lineage": "different_assumption",
      "smoke": { "status": "promote", "reason": "Smoke passed." },
      "speculative": true,
      "evidence_authority": "speculative_hypothesis"
    }
  },
  {
    "hypothesis": "Slightly adjust the current classifier threshold",
    "expected_effect": [
      { "dimension": "balanced_accuracy", "direction": "increase", "magnitude": "small" }
    ],
    "resource_estimate": {
      "sessions": 2,
      "duration": { "value": 3, "unit": "hours" },
      "llm_calls": 1
    },
    "allocation": 0.3,
    "exploration": {
      "schema_version": "strategy-exploration-v1",
      "phase": "divergent_stall_recovery",
      "role": "adjacent_exploration",
      "strategy_family": "threshold_sweep",
      "novelty_score": 0.45,
      "similarity_to_recent_failures": 0.9,
      "expected_cost": "medium",
      "relationship_to_lineage": "failed_lineage",
      "smoke": { "status": "not_run", "reason": "Smoke first." },
      "speculative": true,
      "evidence_authority": "speculative_hypothesis"
    }
  }
]
\`\`\``;
    const manager = new StrategyManager(stateManager, createMockLLMClient([response]));
    await saveDreamConfig(
      { activation: VERIFIED_HINTS_ONLY_HEURISTICS_ACTIVATION },
      stateManager.getBaseDir()
    );
    await new DreamDecisionHeuristicStore({ controlBaseDir: tempDir }).saveDecisionHeuristics([{
      id: "heur-prefer-threshold",
      prefer_candidate_selector: { strategy_family: "threshold_sweep" },
      score_delta: 0.5,
      reason: "would prefer threshold if unverified hints were allowed",
    }]);

    const candidates = await manager.generateCandidates("goal-1", "balanced_accuracy", ["balanced_accuracy"], {
      currentGap: 0.2,
      pastStrategies: [],
    });

    expect(candidates.map((candidate) => candidate.exploration?.strategy_family)).toEqual([
      "fold_distribution_audit",
      "threshold_sweep",
    ]);
  });
});

// ─── activateBestCandidate ───

describe("activateBestCandidate", () => {
  it("activates first candidate and sets state=active", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
      currentGap: 0.5,
      pastStrategies: [],
    });

    const activated = await manager.activateBestCandidate("goal-1");

    expect(activated.state).toBe("active");
    expect(activated.started_at).not.toBeNull();
    expect(typeof activated.started_at).toBe("string");
  });

  it("persists activated strategy in portfolio", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    await manager.activateBestCandidate("goal-1");

    const portfolio = await manager.getPortfolio("goal-1");
    const active = portfolio!.strategies.find((s) => s.state === "active");
    expect(active).toBeDefined();
    expect(active!.started_at).not.toBeNull();
  });

  it("throws when no candidates exist", async () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);

    await expect(manager.activateBestCandidate("goal-1")).rejects.toThrow(
      "no candidates found"
    );
  });

  it("selects the first candidate when multiple exist", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO]);
    const manager = new StrategyManager(stateManager, mock);

    const candidates = await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
      currentGap: 0.5,
      pastStrategies: [],
    });
    const firstCandidateId = candidates[0].id;

    const activated = await manager.activateBestCandidate("goal-1");
    expect(activated.id).toBe(firstCandidateId);
  });

  it("sets started_at as a valid ISO timestamp", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    const before = new Date().toISOString();
    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    const activated = await manager.activateBestCandidate("goal-1");
    const after = new Date().toISOString();

    expect(activated.started_at! >= before).toBe(true);
    expect(activated.started_at! <= after).toBe(true);
  });

  it("routes wait candidates through activateMultiple so canAffordWait is enforced", async () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);
    const wait = await manager.createWaitStrategy("goal-1", {
      hypothesis: "Wait for external signal",
      wait_reason: "Awaiting external signal",
      wait_until: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      measurement_plan: "Check signal after wait",
      fallback_strategy_id: null,
      target_dimensions: ["word_count"],
      primary_dimension: "word_count",
    });
    const canAffordWait = vi.fn().mockReturnValue(false);

    await expect(
      manager.activateBestCandidate("goal-1", {
        getCurrentGap: async () => 0.5,
        canAffordWait,
      })
    ).rejects.toThrow("cannot be activated because the goal cannot afford waiting");

    expect(canAffordWait).toHaveBeenCalledTimes(1);
    const portfolio = await manager.getPortfolio("goal-1");
    const stored = portfolio!.strategies.find((strategy) => strategy.id === wait.id);
    expect(stored?.state).toBe("candidate");
  });
});

// ─── updateState ───

describe("updateState — valid transitions", () => {
  it("candidate → active succeeds", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await expect(manager.updateState(candidate.id, "active")).resolves.not.toThrow();

    const portfolio = await manager.getPortfolio("goal-1");
    const updated = portfolio!.strategies.find((s) => s.id === candidate.id);
    expect(updated!.state).toBe("active");
  });

  it("active → completed succeeds and sets completed_at", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await manager.updateState(candidate.id, "active");
    await manager.updateState(candidate.id, "completed");

    const portfolio = await manager.getPortfolio("goal-1");
    const updated = portfolio!.strategies.find((s) => s.id === candidate.id);
    expect(updated!.state).toBe("completed");
    expect(updated!.completed_at).not.toBeNull();
  });

  it("active → terminated succeeds and archives to history", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await manager.updateState(candidate.id, "active");
    await manager.updateState(candidate.id, "terminated");

    const history = await manager.getStrategyHistory("goal-1");
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(candidate.id);
    expect(history[0].state).toBe("terminated");
    expect(history[0].completed_at).not.toBeNull();
  });

  it("active → evaluating succeeds", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await manager.updateState(candidate.id, "active");
    await manager.updateState(candidate.id, "evaluating");

    const portfolio = await manager.getPortfolio("goal-1");
    const updated = portfolio!.strategies.find((s) => s.id === candidate.id);
    expect(updated!.state).toBe("evaluating");
  });

  it("evaluating → active succeeds", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await manager.updateState(candidate.id, "active");
    await manager.updateState(candidate.id, "evaluating");
    await manager.updateState(candidate.id, "active");

    const portfolio = await manager.getPortfolio("goal-1");
    const updated = portfolio!.strategies.find((s) => s.id === candidate.id);
    expect(updated!.state).toBe("active");
  });

  it("evaluating → terminated succeeds and archives", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await manager.updateState(candidate.id, "active");
    await manager.updateState(candidate.id, "evaluating");
    await manager.updateState(candidate.id, "terminated");

    const history = await manager.getStrategyHistory("goal-1");
    expect(history[0].state).toBe("terminated");
  });

  it("updateState stores effectiveness_score from metadata", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await manager.updateState(candidate.id, "active");
    await manager.updateState(candidate.id, "completed", { effectiveness_score: 0.85 });

    const portfolio = await manager.getPortfolio("goal-1");
    const updated = portfolio!.strategies.find((s) => s.id === candidate.id);
    expect(updated!.effectiveness_score).toBe(0.85);
  });
});

describe("updateState — invalid transitions", () => {
  it("candidate → completed throws", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await expect(manager.updateState(candidate.id, "completed")).rejects.toThrow(
      "invalid transition"
    );
  });

  it("completed → active throws", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await manager.updateState(candidate.id, "active");
    await manager.updateState(candidate.id, "completed");

    await expect(manager.updateState(candidate.id, "active")).rejects.toThrow(
      "invalid transition"
    );
  });

  it("terminated → active throws", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await manager.updateState(candidate.id, "active");
    await manager.updateState(candidate.id, "terminated");

    await expect(manager.updateState(candidate.id, "active")).rejects.toThrow(
      "invalid transition"
    );
  });

  it("throws when strategy not found", async () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);

    await expect(async () => await manager.updateState("non-existent-id", "active")).rejects.toThrow(
      "not found"
    );
  });
});
