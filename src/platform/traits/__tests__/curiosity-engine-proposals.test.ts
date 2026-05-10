import { describe, it, expect, vi, beforeEach } from "vitest";
import { CuriosityEngine } from "../curiosity-engine.js";
import type { CuriosityEngineDeps } from "../curiosity-engine.js";
import type { CuriosityProposal, CuriosityTrigger } from "../../../base/types/curiosity.js";
import type { StallState } from "../../../base/types/stall.js";
import { makeGoal } from "../../../../tests/helpers/fixtures.js";
import { generateProposals as generateProposalsImpl } from "../curiosity-proposals.js";

// ─── Helper Factories ───

function makeStallState(overrides: Partial<StallState> = {}): StallState {
  return {
    goal_id: "goal-1",
    dimension_escalation: {},
    global_escalation: 0,
    decay_factors: {},
    recovery_loops: {},
    ...overrides,
  };
}

const DEFAULT_RESOURCE_BUDGET = {
  active_user_goals_max_percent: 20,
  waiting_user_goals_max_percent: 50,
};

const DEFAULT_CONFIG = {
  enabled: true,
  max_active_proposals: 3,
  proposal_expiry_hours: 12,
  rejection_cooldown_hours: 168,
  unproductive_loop_limit: 3,
  periodic_exploration_hours: 72,
  resource_budget: DEFAULT_RESOURCE_BUDGET,
  unexpected_observation_threshold: 2.0,
};

function createMockDeps(overrides: Partial<CuriosityEngineDeps> = {}): CuriosityEngineDeps {
  const stateManager = {
    loadGoal: vi.fn().mockResolvedValue(null),
    saveGoal: vi.fn().mockResolvedValue(undefined),
    getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-test"),
  } as any;

  const curiosityStateStore = {
    load: vi.fn().mockResolvedValue(null),
    saveSync: vi.fn((state: any) => state),
  };

  const llmClient = {
    sendMessage: vi.fn().mockResolvedValue({ content: "[]" }),
    parseJSON: vi.fn().mockReturnValue([]),
  } as any;

  const ethicsGate = {
    check: vi.fn().mockResolvedValue({ verdict: "pass" }),
  } as any;

  const stallDetector = {
    getStallState: vi.fn().mockResolvedValue(makeStallState()),
  } as any;

  const driveSystem = {
    schedule: vi.fn(),
  } as any;

  const { config: configOverride, ...restOverrides } = overrides;
  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...(configOverride ?? {}),
    resource_budget: {
      ...DEFAULT_RESOURCE_BUDGET,
      ...((configOverride as any)?.resource_budget ?? {}),
    },
  };

  return {
    stateManager,
    curiosityStateStore,
    llmClient,
    ethicsGate,
    stallDetector,
    driveSystem,
    config: mergedConfig,
    ...restOverrides,
  };
}

// ─── generateProposals ───

describe("CuriosityEngine — generateProposals", async () => {
  function makeTrigger(type: CuriosityTrigger["type"] = "periodic_exploration"): CuriosityTrigger {
    return {
      type,
      detected_at: new Date().toISOString(),
      source_goal_id: null,
      details: "Test trigger",
      severity: 0.3,
    };
  }

  it("generates proposals from LLM response", async () => {
    const deps = createMockDeps();
    (deps.llmClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: JSON.stringify([
        {
          description: "Explore new testing patterns",
          rationale: "Current tests are weak",
          suggested_dimensions: [{ name: "test_coverage", threshold_type: "min", target: 0.8 }],
          scope_domain: "testing",
          detection_method: "llm_heuristic",
        },
      ]),
    });
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Explore new testing patterns",
        rationale: "Current tests are weak",
        suggested_dimensions: [{ name: "test_coverage", threshold_type: "min", target: 0.8 }],
        scope_domain: "testing",
        detection_method: "llm_heuristic",
      },
    ]);

    const engine = new CuriosityEngine(deps);
    const proposals = await engine.generateProposals([makeTrigger()], []);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.proposed_goal.description).toBe("Explore new testing patterns");
  });

  it("uses admitted vector results as embedding transfer evidence through generateProposals", async () => {
    const vectorIndex = {
      add: vi.fn(),
      search: vi.fn().mockResolvedValue([
        {
          id: "dim:goal-source:balanced_accuracy",
          text: "balanced accuracy",
          similarity: 0.86,
          metadata: { goal_id: "goal-source", dimension: "balanced_accuracy", type: "dimension" },
        },
      ]),
    } as any;
    const deps = createMockDeps({ vectorIndex });
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Transfer balanced accuracy audit",
        rationale: "Use the similar source dimension evidence",
        suggested_dimensions: [],
        scope_domain: "classification",
        detection_method: "llm_heuristic",
      },
    ]);
    const engine = new CuriosityEngine(deps);
    const goals = [
      makeGoal({
        id: "goal-target",
        status: "active",
        dimensions: [{ name: "balanced_accuracy", label: "Balanced accuracy", threshold: { type: "min", value: 0.8 }, current_value: 0.4, confidence: 0.2, history: [] } as any],
      }),
    ];

    const proposals = await engine.generateProposals([
      { type: "undefined_problem", detected_at: new Date().toISOString(), source_goal_id: "goal-target", details: "Low confidence", severity: 0.7 },
    ], goals);

    expect(vectorIndex.search).toHaveBeenCalledWith("balanced_accuracy", 5, 0.7);
    expect(proposals[0]!.proposed_goal.detection_method).toBe("embedding_similarity");
    expect(proposals[0]!.proposed_goal.transfer_evidence).toEqual([
      {
        source_goal_id: "goal-source",
        source_dimension: "balanced_accuracy",
        target_goal_id: "goal-target",
        target_dimension: "balanced_accuracy",
        similarity: 0.86,
        evidence_refs: ["dim:goal-source:balanced_accuracy"],
      },
    ]);
    const prompt = (deps.llmClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0][0].content as string;
    expect(prompt).toContain("Semantic Transfer Evidence");
    expect(prompt).toContain("goal-source");
    expect(prompt).toContain("similarity=0.860");
    expect(prompt).toContain("dim:goal-source:balanced_accuracy");
  });

  it("does not assign embedding_similarity when vector search returns no transfer results", async () => {
    const vectorIndex = {
      add: vi.fn(),
      search: vi.fn().mockResolvedValue([]),
    } as any;
    const deps = createMockDeps({ vectorIndex });
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Clarify weak signal",
        rationale: "No semantic transfer evidence was admitted",
        suggested_dimensions: [],
        scope_domain: "classification",
        detection_method: "llm_heuristic",
      },
    ]);
    const engine = new CuriosityEngine(deps);
    const goals = [
      makeGoal({
        id: "goal-target",
        status: "active",
        dimensions: [{ name: "calibration", label: "Calibration", threshold: { type: "min", value: 0.8 }, current_value: 0.4, confidence: 0.2, history: [] } as any],
      }),
    ];

    const proposals = await engine.generateProposals([
      { type: "undefined_problem", detected_at: new Date().toISOString(), source_goal_id: "goal-target", details: "Low confidence", severity: 0.7 },
    ], goals);

    expect(vectorIndex.search).toHaveBeenCalledWith("calibration", 5, 0.7);
    expect(proposals[0]!.proposed_goal.detection_method).toBe("llm_heuristic");
    expect(proposals[0]!.proposed_goal.transfer_evidence).toEqual([]);
  });

  it("downgrades model-provided embedding_similarity when no vector evidence is admitted", async () => {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Claim semantic transfer",
        rationale: "Model claimed vector similarity without evidence",
        suggested_dimensions: [],
        scope_domain: "classification",
        detection_method: "embedding_similarity",
      },
    ]);
    const engine = new CuriosityEngine(deps);

    const proposals = await engine.generateProposals([
      { type: "undefined_problem", detected_at: new Date().toISOString(), source_goal_id: "goal-target", details: "Low confidence", severity: 0.7 },
    ], []);

    expect(proposals[0]!.proposed_goal.detection_method).toBe("llm_heuristic");
    expect(proposals[0]!.proposed_goal.transfer_evidence).toEqual([]);
  });

  it("does not assign embedding_similarity when semantic transfer is unavailable", async () => {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Clarify weak signal",
        rationale: "Vector transfer unavailable",
        suggested_dimensions: [],
        scope_domain: "classification",
        detection_method: "llm_heuristic",
      },
    ]);
    const engine = new CuriosityEngine(deps);
    const goals = [
      makeGoal({
        id: "goal-target",
        status: "active",
        dimensions: [{ name: "calibration", label: "Calibration", threshold: { type: "min", value: 0.8 }, current_value: 0.4, confidence: 0.2, history: [] } as any],
      }),
    ];

    const proposals = await engine.generateProposals([
      { type: "undefined_problem", detected_at: new Date().toISOString(), source_goal_id: "goal-target", details: "Low confidence", severity: 0.7 },
    ], goals);

    expect(proposals[0]!.proposed_goal.detection_method).toBe("llm_heuristic");
    expect(proposals[0]!.proposed_goal.transfer_evidence).toEqual([]);
  });

  it("sends semantic transfer evidence in the concrete proposal prompt even when a gateway dependency exists", async () => {
    const vectorIndex = {
      add: vi.fn(),
      search: vi.fn().mockResolvedValue([
        {
          id: "dim:goal-source:recall",
          text: "recall",
          similarity: 0.91,
          metadata: { goal_id: "goal-source", dimension: "recall", type: "dimension" },
        },
      ]),
    } as any;
    const gateway = {
      execute: vi.fn().mockResolvedValue([]),
      executeWithUsage: vi.fn().mockResolvedValue({ data: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, contextTokens: 0 }),
    } as any;
    const deps = createMockDeps({ vectorIndex });
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Transfer recall diagnostics",
        rationale: "Use evidence refs",
        suggested_dimensions: [],
        scope_domain: "classification",
        detection_method: "llm_heuristic",
      },
    ]);
    const state = {
      proposals: [],
      learning_records: [],
      last_exploration_at: null,
      rejected_proposal_hashes: [],
    };
    const goals = [
      makeGoal({
        id: "goal-target",
        status: "active",
        dimensions: [{ name: "recall", label: "Recall", threshold: { type: "min", value: 0.8 }, current_value: 0.4, confidence: 0.2, history: [] } as any],
      }),
    ];

    const proposals = await generateProposalsImpl(
      [{ type: "undefined_problem", detected_at: new Date().toISOString(), source_goal_id: "goal-target", details: "Low confidence", severity: 0.7 }],
      goals,
      state,
      0,
      {
        llmClient: deps.llmClient,
        ethicsGate: deps.ethicsGate,
        vectorIndex,
        gateway,
        config: deps.config as any,
      }
    );

    expect(gateway.execute).not.toHaveBeenCalled();
    const prompt = (deps.llmClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0][0].content as string;
    expect(prompt).toContain("Semantic Transfer Evidence");
    expect(prompt).toContain("dim:goal-source:recall");
    expect(proposals[0]!.proposed_goal.detection_method).toBe("embedding_similarity");
  });

  it("returns empty array when triggers is empty", async () => {
    const deps = createMockDeps();
    const engine = new CuriosityEngine(deps);
    const proposals = await engine.generateProposals([], []);
    expect(proposals).toHaveLength(0);
  });

  it("returns empty array when curiosity is disabled", async () => {
    const deps = createMockDeps({ config: { enabled: false } });
    const engine = new CuriosityEngine(deps);
    const proposals = await engine.generateProposals([makeTrigger()], []);
    expect(proposals).toHaveLength(0);
  });

  it("filters proposals that fail ethics check", async () => {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Do something unethical",
        rationale: "Bad idea",
        suggested_dimensions: [],
        scope_domain: "bad",
        detection_method: "llm_heuristic",
      },
    ]);
    (deps.ethicsGate.check as ReturnType<typeof vi.fn>).mockResolvedValue({ verdict: "reject" });

    const engine = new CuriosityEngine(deps);
    const proposals = await engine.generateProposals([makeTrigger()], []);
    expect(proposals).toHaveLength(0);
  });

  it("passes proposals that pass ethics check", async () => {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Legitimate exploration",
        rationale: "Good idea",
        suggested_dimensions: [],
        scope_domain: "good",
        detection_method: "llm_heuristic",
      },
    ]);
    (deps.ethicsGate.check as ReturnType<typeof vi.fn>).mockResolvedValue({ verdict: "pass" });

    const engine = new CuriosityEngine(deps);
    const proposals = await engine.generateProposals([makeTrigger()], []);
    expect(proposals).toHaveLength(1);
  });

  it("respects max_active_proposals limit", async () => {
    const deps = createMockDeps({
      config: { max_active_proposals: 1 },
    });
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Proposal A",
        rationale: "Reason A",
        suggested_dimensions: [],
        scope_domain: "domain",
        detection_method: "llm_heuristic",
      },
      {
        description: "Proposal B",
        rationale: "Reason B",
        suggested_dimensions: [],
        scope_domain: "domain",
        detection_method: "llm_heuristic",
      },
    ]);

    const engine = new CuriosityEngine(deps);
    const proposals = await engine.generateProposals([makeTrigger()], []);
    expect(proposals).toHaveLength(1);
  });

  it("skips proposals similar to recently rejected ones (rejection cooldown)", async () => {
    const deps = createMockDeps();
    const description = "Explore caching strategies";
    // Pre-seed rejected state with the hash of our description
    // We'll reject a proposal first, then try to regenerate it
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description,
        rationale: "Same idea",
        suggested_dimensions: [],
        scope_domain: "perf",
        detection_method: "llm_heuristic",
      },
    ]);

    const engine = new CuriosityEngine(deps);

    // First generation — should work
    const firstBatch = await engine.generateProposals([makeTrigger()], []);
    expect(firstBatch).toHaveLength(1);

    // Reject the proposal
    engine.rejectProposal(firstBatch[0]!.id);

    // Second generation with the same description — should be skipped
    const secondBatch = await engine.generateProposals([makeTrigger()], []);
    expect(secondBatch).toHaveLength(0);
  });

  it("handles LLM failure gracefully (returns empty array)", async () => {
    const deps = createMockDeps();
    (deps.llmClient.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("LLM unreachable")
    );

    const engine = new CuriosityEngine(deps);
    const proposals = await engine.generateProposals([makeTrigger()], []);
    expect(proposals).toHaveLength(0);
  });

  it("saves state after generating proposals", async () => {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "New exploration",
        rationale: "Good reason",
        suggested_dimensions: [],
        scope_domain: "test",
        detection_method: "llm_heuristic",
      },
    ]);

    const engine = new CuriosityEngine(deps);
    await engine.generateProposals([makeTrigger()], []);
    expect(deps.curiosityStateStore!.saveSync).toHaveBeenCalled();
  });

  it("sets correct expiry time based on proposal_expiry_hours config", async () => {
    const deps = createMockDeps({ config: { proposal_expiry_hours: 6 } });
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Time-limited proposal",
        rationale: "Reason",
        suggested_dimensions: [],
        scope_domain: "test",
        detection_method: "llm_heuristic",
      },
    ]);

    const before = Date.now();
    const engine = new CuriosityEngine(deps);
    const proposals = await engine.generateProposals([makeTrigger()], []);
    const after = Date.now();

    expect(proposals).toHaveLength(1);
    const expiresAt = new Date(proposals[0]!.expires_at).getTime();
    const expectedMin = before + 6 * 60 * 60 * 1000;
    const expectedMax = after + 6 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresAt).toBeLessThanOrEqual(expectedMax);
  });

  it("sets detection_method from LLM response", async () => {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Observation-driven proposal",
        rationale: "Observed anomaly",
        suggested_dimensions: [],
        scope_domain: "analytics",
        detection_method: "observation_log",
      },
    ]);

    const engine = new CuriosityEngine(deps);
    const proposals = await engine.generateProposals([makeTrigger("unexpected_observation")], []);
    expect(proposals[0]!.proposed_goal.detection_method).toBe("observation_log");
  });

  it("updates last_exploration_at when periodic_exploration trigger is present", async () => {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const engine = new CuriosityEngine(deps);
    const before = Date.now();
    await engine.generateProposals([makeTrigger("periodic_exploration")], []);
    const after = Date.now();

    // shouldExplore should no longer return true for periodic check (last_exploration_at updated)
    // We can verify by confirming saveSync was called (state was saved)
    expect(deps.curiosityStateStore!.saveSync).toHaveBeenCalled();
    const writtenState = (deps.curiosityStateStore!.saveSync as ReturnType<typeof vi.fn>).mock.calls[0]![0] as any;
    const explorationTime = new Date(writtenState.last_exploration_at).getTime();
    expect(explorationTime).toBeGreaterThanOrEqual(before);
    expect(explorationTime).toBeLessThanOrEqual(after);
  });

  it("returns empty when already at max_active_proposals capacity", async () => {
    const deps = createMockDeps({
      config: { max_active_proposals: 1 },
    });
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "First proposal",
        rationale: "Reason",
        suggested_dimensions: [],
        scope_domain: "test",
        detection_method: "llm_heuristic",
      },
    ]);

    const engine = new CuriosityEngine(deps);
    // Generate first batch — fills capacity
    await engine.generateProposals([makeTrigger()], []);
    // Second call should be blocked
    const second = await engine.generateProposals([makeTrigger()], []);
    expect(second).toHaveLength(0);
  });

  it("handles ethics gate failure gracefully (skips proposal)", async () => {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Proposal with ethics check error",
        rationale: "Reason",
        suggested_dimensions: [],
        scope_domain: "test",
        detection_method: "llm_heuristic",
      },
    ]);
    (deps.ethicsGate.check as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("ethics service down")
    );

    const engine = new CuriosityEngine(deps);
    const proposals = await engine.generateProposals([makeTrigger()], []);
    // On ethics failure, proposal is skipped (conservative)
    expect(proposals).toHaveLength(0);
  });
});

// ─── Approval Flow ───

describe("CuriosityEngine — approval flow", async () => {
  async function engineWithPendingProposal() {
    const deps = createMockDeps();
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Pending proposal for approval test",
        rationale: "Reason",
        suggested_dimensions: [],
        scope_domain: "test",
        detection_method: "llm_heuristic",
      },
    ]);
    const engine = new CuriosityEngine(deps);
    const trigger: CuriosityTrigger = {
      type: "periodic_exploration",
      detected_at: new Date().toISOString(),
      source_goal_id: null,
      details: "Test",
      severity: 0.3,
    };
    const proposals = await engine.generateProposals([trigger], []);
    return { engine, proposal: proposals[0]!, deps };
  }

  it("approveProposal marks status as approved", async () => {
    const { engine, proposal } = await engineWithPendingProposal();
    const approved = engine.approveProposal(proposal.id);
    expect(approved.status).toBe("approved");
  });

  it("approveProposal sets reviewed_at", async () => {
    const { engine, proposal } = await engineWithPendingProposal();
    const before = Date.now();
    const approved = engine.approveProposal(proposal.id);
    const after = Date.now();
    expect(approved.reviewed_at).not.toBeNull();
    const reviewedTime = new Date(approved.reviewed_at!).getTime();
    expect(reviewedTime).toBeGreaterThanOrEqual(before);
    expect(reviewedTime).toBeLessThanOrEqual(after);
  });

  it("rejectProposal marks status as rejected", async () => {
    const { engine, proposal } = await engineWithPendingProposal();
    const rejected = engine.rejectProposal(proposal.id);
    expect(rejected.status).toBe("rejected");
  });

  it("rejectProposal sets reviewed_at", async () => {
    const { engine, proposal } = await engineWithPendingProposal();
    const rejected = engine.rejectProposal(proposal.id);
    expect(rejected.reviewed_at).not.toBeNull();
  });

  it("rejectProposal sets rejection_cooldown_until", async () => {
    const deps = createMockDeps({
      config: { rejection_cooldown_hours: 24 },
    });
    (deps.llmClient.parseJSON as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        description: "Proposal to reject with cooldown",
        rationale: "Reason",
        suggested_dimensions: [],
        scope_domain: "test",
        detection_method: "llm_heuristic",
      },
    ]);
    const engine = new CuriosityEngine(deps);
    const trigger: CuriosityTrigger = {
      type: "periodic_exploration",
      detected_at: new Date().toISOString(),
      source_goal_id: null,
      details: "Test",
      severity: 0.3,
    };
    const proposals = await engine.generateProposals([trigger], []);
    const proposal = proposals[0]!;

    const before = Date.now();
    const rejected = engine.rejectProposal(proposal.id);
    const after = Date.now();

    expect(rejected.rejection_cooldown_until).not.toBeNull();
    const cooldownTime = new Date(rejected.rejection_cooldown_until!).getTime();
    const expectedMin = before + 24 * 60 * 60 * 1000;
    const expectedMax = after + 24 * 60 * 60 * 1000;
    expect(cooldownTime).toBeGreaterThanOrEqual(expectedMin);
    expect(cooldownTime).toBeLessThanOrEqual(expectedMax);
  });

  it("approveProposal throws on non-existent proposal ID", async () => {
    const deps = createMockDeps();
    const engine = new CuriosityEngine(deps);
    expect(() => engine.approveProposal("nonexistent-id")).toThrow(
      /proposal "nonexistent-id" not found/
    );
  });

  it("rejectProposal throws on non-existent proposal ID", async () => {
    const deps = createMockDeps();
    const engine = new CuriosityEngine(deps);
    expect(() => engine.rejectProposal("nonexistent-id")).toThrow(
      /proposal "nonexistent-id" not found/
    );
  });

  it("cannot approve already rejected proposal", async () => {
    const { engine, proposal } = await engineWithPendingProposal();
    engine.rejectProposal(proposal.id);
    expect(() => engine.approveProposal(proposal.id)).toThrow(/not pending/);
  });

  it("cannot reject already approved proposal", async () => {
    const { engine, proposal } = await engineWithPendingProposal();
    engine.approveProposal(proposal.id);
    expect(() => engine.rejectProposal(proposal.id)).toThrow(/not pending/);
  });

  it("saves state after approving", async () => {
    const { engine, proposal, deps } = await engineWithPendingProposal();
    const callCountBefore = (deps.curiosityStateStore!.saveSync as ReturnType<typeof vi.fn>).mock.calls.length;
    engine.approveProposal(proposal.id);
    const callCountAfter = (deps.curiosityStateStore!.saveSync as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callCountAfter).toBeGreaterThan(callCountBefore);
  });

  it("saves state after rejecting", async () => {
    const { engine, proposal, deps } = await engineWithPendingProposal();
    const callCountBefore = (deps.curiosityStateStore!.saveSync as ReturnType<typeof vi.fn>).mock.calls.length;
    engine.rejectProposal(proposal.id);
    const callCountAfter = (deps.curiosityStateStore!.saveSync as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callCountAfter).toBeGreaterThan(callCountBefore);
  });

  it("approved proposal appears in getActiveProposals", async () => {
    const { engine, proposal } = await engineWithPendingProposal();
    engine.approveProposal(proposal.id);
    const active = engine.getActiveProposals();
    expect(active.some((p) => p.id === proposal.id && p.status === "approved")).toBe(true);
  });

  it("rejected proposal does NOT appear in getActiveProposals", async () => {
    const { engine, proposal } = await engineWithPendingProposal();
    engine.rejectProposal(proposal.id);
    const active = engine.getActiveProposals();
    expect(active.some((p) => p.id === proposal.id)).toBe(false);
  });
});
