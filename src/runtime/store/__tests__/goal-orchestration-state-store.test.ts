import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { GoalOrchestrationStateStore } from "../goal-orchestration-state-store.js";
import { importLegacyGoalOrchestrationState } from "../goal-orchestration-state-migration.js";
import { openControlDatabase } from "../control-db/index.js";
import type { DependencyGraph } from "../../../base/types/dependency.js";
import type { NegotiationLog } from "../../../base/types/negotiation.js";

describe("GoalOrchestrationStateStore", () => {
  let tmpDir: string;
  let store: GoalOrchestrationStateStore;

  beforeEach(() => {
    tmpDir = makeTempDir();
    store = new GoalOrchestrationStateStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("persists negotiation logs in the control DB without creating the legacy goal file", async () => {
    const log: NegotiationLog = {
      goal_id: "goal-1",
      timestamp: "2026-05-10T00:00:00.000Z",
      is_renegotiation: false,
      renegotiation_trigger: null,
      step2_decomposition: null,
      step3_baseline: null,
      step4_evaluation: null,
      step4_capability_check: null,
      step5_response: null,
    };

    await store.saveNegotiationLog(log.goal_id, log);

    await expect(store.loadNegotiationLog(log.goal_id)).resolves.toMatchObject({
      goal_id: "goal-1",
      timestamp: "2026-05-10T00:00:00.000Z",
    });
    expect(fs.existsSync(path.join(tmpDir, "goals", "goal-1", "negotiation-log.json"))).toBe(false);
  });

  it("persists the dependency graph in the control DB without creating the legacy file", async () => {
    const graph: DependencyGraph = {
      nodes: ["goal-1", "goal-2"],
      edges: [{
        from_goal_id: "goal-1",
        to_goal_id: "goal-2",
        type: "prerequisite",
        status: "active",
        condition: null,
        affected_dimensions: [],
        mitigation: null,
        detection_confidence: 1,
        reasoning: null,
        created_at: "2026-05-10T00:00:00.000Z",
      }],
      updated_at: "2026-05-10T00:00:00.000Z",
    };

    await store.saveDependencyGraph(graph);

    await expect(new GoalOrchestrationStateStore(tmpDir).loadDependencyGraph()).resolves.toMatchObject({
      nodes: ["goal-1", "goal-2"],
      edges: [expect.objectContaining({ from_goal_id: "goal-1", to_goal_id: "goal-2" })],
    });
    expect(fs.existsSync(path.join(tmpDir, "dependency-graph.json"))).toBe(false);
  });

  it("rejects negotiation logs stored under a mismatched goal id", async () => {
    const log: NegotiationLog = {
      goal_id: "goal-log",
      timestamp: "2026-05-10T00:00:00.000Z",
      is_renegotiation: false,
      renegotiation_trigger: null,
      step2_decomposition: null,
      step3_baseline: null,
      step4_evaluation: null,
      step4_capability_check: null,
      step5_response: null,
    };

    await expect(store.saveNegotiationLog("goal-key", log)).rejects.toThrow(/does not match storage key/);
  });

  it("imports legacy negotiation logs and dependency graph through the explicit repair boundary", async () => {
    const log: NegotiationLog = {
      goal_id: "goal-import",
      timestamp: "2026-05-10T00:00:00.000Z",
      is_renegotiation: false,
      renegotiation_trigger: null,
      step2_decomposition: null,
      step3_baseline: null,
      step4_evaluation: null,
      step4_capability_check: null,
      step5_response: null,
    };
    const graph: DependencyGraph = {
      nodes: ["goal-import", "goal-next"],
      edges: [{
        from_goal_id: "goal-import",
        to_goal_id: "goal-next",
        type: "prerequisite",
        status: "active",
        condition: null,
        affected_dimensions: [],
        mitigation: null,
        detection_confidence: 1,
        reasoning: null,
        created_at: "2026-05-10T00:00:00.000Z",
      }],
      updated_at: "2026-05-10T00:00:00.000Z",
    };

    fs.mkdirSync(path.join(tmpDir, "goals", log.goal_id), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "goals", log.goal_id, "negotiation-log.json"), JSON.stringify(log));
    fs.writeFileSync(path.join(tmpDir, "dependency-graph.json"), JSON.stringify(graph));

    await expect(store.loadNegotiationLog(log.goal_id)).resolves.toBeNull();
    await expect(store.loadDependencyGraph()).resolves.toBeNull();

    const report = await importLegacyGoalOrchestrationState(tmpDir);

    expect(report).toMatchObject({
      negotiationLogs: 1,
      dependencyGraphs: 1,
      skippedAlreadyImported: 0,
      retiredExistingTypedState: 0,
      blockedSources: [],
    });
    await expect(new GoalOrchestrationStateStore(tmpDir).loadNegotiationLog(log.goal_id)).resolves.toMatchObject({
      goal_id: "goal-import",
    });
    await expect(new GoalOrchestrationStateStore(tmpDir).loadDependencyGraph()).resolves.toMatchObject({
      nodes: ["goal-import", "goal-next"],
      edges: [expect.objectContaining({ from_goal_id: "goal-import", to_goal_id: "goal-next" })],
    });

    const controlDb = await openControlDatabase({ baseDir: tmpDir });
    try {
      expect(controlDb.listLegacyImports()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source_kind: "goal_negotiation_log",
          source_id: "goal-import",
          migration_name: "goal-orchestration-runtime-state",
          migration_version: 17,
          status: "imported",
        }),
        expect.objectContaining({
          source_kind: "goal_dependency_graph",
          source_id: "current",
          migration_name: "goal-orchestration-runtime-state",
          migration_version: 17,
          status: "imported",
        }),
      ]));
    } finally {
      controlDb.close();
    }
  });

  it("does not let repeated repair import overwrite newer typed orchestration state", async () => {
    const log: NegotiationLog = {
      goal_id: "goal-idempotent",
      timestamp: "2026-05-10T00:00:00.000Z",
      is_renegotiation: false,
      renegotiation_trigger: null,
      step2_decomposition: null,
      step3_baseline: null,
      step4_evaluation: null,
      step4_capability_check: null,
      step5_response: null,
    };
    const legacyGraph: DependencyGraph = {
      nodes: ["goal-idempotent", "legacy-target"],
      edges: [{
        from_goal_id: "goal-idempotent",
        to_goal_id: "legacy-target",
        type: "prerequisite",
        status: "active",
        condition: null,
        affected_dimensions: [],
        mitigation: null,
        detection_confidence: 1,
        reasoning: null,
        created_at: "2026-05-10T00:00:00.000Z",
      }],
      updated_at: "2026-05-10T00:00:00.000Z",
    };

    fs.mkdirSync(path.join(tmpDir, "goals", log.goal_id), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "goals", log.goal_id, "negotiation-log.json"), JSON.stringify(log));
    fs.writeFileSync(path.join(tmpDir, "dependency-graph.json"), JSON.stringify(legacyGraph));

    await importLegacyGoalOrchestrationState(tmpDir);

    const currentLog: NegotiationLog = {
      ...log,
      timestamp: "2026-05-10T01:00:00.000Z",
      is_renegotiation: true,
      renegotiation_trigger: "user_request",
    };
    await store.saveNegotiationLog(log.goal_id, currentLog);
    await store.saveDependencyGraph({
      nodes: ["goal-idempotent", "current-target"],
      edges: [{
        ...legacyGraph.edges[0]!,
        to_goal_id: "current-target",
      }],
      updated_at: "2026-05-10T01:00:00.000Z",
    });

    const secondReport = await importLegacyGoalOrchestrationState(tmpDir);

    expect(secondReport).toMatchObject({
      negotiationLogs: 0,
      dependencyGraphs: 0,
      skippedAlreadyImported: 2,
      retiredExistingTypedState: 0,
      blockedSources: [],
    });
    await expect(new GoalOrchestrationStateStore(tmpDir).loadNegotiationLog(log.goal_id)).resolves.toMatchObject({
      timestamp: "2026-05-10T01:00:00.000Z",
      is_renegotiation: true,
    });
    await expect(new GoalOrchestrationStateStore(tmpDir).loadDependencyGraph()).resolves.toMatchObject({
      nodes: ["goal-idempotent", "current-target"],
      edges: [expect.objectContaining({ to_goal_id: "current-target" })],
    });
  });

  it("retires stale legacy orchestration files when typed state already exists before first repair", async () => {
    const legacyLog: NegotiationLog = {
      goal_id: "goal-existing",
      timestamp: "2026-05-10T00:00:00.000Z",
      is_renegotiation: false,
      renegotiation_trigger: null,
      step2_decomposition: null,
      step3_baseline: null,
      step4_evaluation: null,
      step4_capability_check: null,
      step5_response: null,
    };
    const legacyGraph: DependencyGraph = {
      nodes: ["goal-existing", "legacy-target"],
      edges: [{
        from_goal_id: "goal-existing",
        to_goal_id: "legacy-target",
        type: "prerequisite",
        status: "active",
        condition: null,
        affected_dimensions: [],
        mitigation: null,
        detection_confidence: 1,
        reasoning: null,
        created_at: "2026-05-10T00:00:00.000Z",
      }],
      updated_at: "2026-05-10T00:00:00.000Z",
    };

    fs.mkdirSync(path.join(tmpDir, "goals", legacyLog.goal_id), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "goals", legacyLog.goal_id, "negotiation-log.json"), JSON.stringify(legacyLog));
    fs.writeFileSync(path.join(tmpDir, "dependency-graph.json"), JSON.stringify(legacyGraph));
    await store.saveNegotiationLog(legacyLog.goal_id, {
      ...legacyLog,
      timestamp: "2026-05-10T02:00:00.000Z",
      is_renegotiation: true,
      renegotiation_trigger: "stall",
    });
    await store.saveDependencyGraph({
      nodes: ["goal-existing", "current-target"],
      edges: [{
        ...legacyGraph.edges[0]!,
        to_goal_id: "current-target",
      }],
      updated_at: "2026-05-10T02:00:00.000Z",
    });

    const report = await importLegacyGoalOrchestrationState(tmpDir);

    expect(report).toMatchObject({
      negotiationLogs: 0,
      dependencyGraphs: 0,
      skippedAlreadyImported: 0,
      retiredExistingTypedState: 2,
      blockedSources: [],
    });
    await expect(new GoalOrchestrationStateStore(tmpDir).loadNegotiationLog(legacyLog.goal_id)).resolves.toMatchObject({
      timestamp: "2026-05-10T02:00:00.000Z",
      is_renegotiation: true,
    });
    await expect(new GoalOrchestrationStateStore(tmpDir).loadDependencyGraph()).resolves.toMatchObject({
      nodes: ["goal-existing", "current-target"],
      edges: [expect.objectContaining({ to_goal_id: "current-target" })],
    });

    const controlDb = await openControlDatabase({ baseDir: tmpDir });
    try {
      expect(controlDb.listLegacyImports()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source_kind: "goal_negotiation_log",
          source_id: "goal-existing",
          migration_name: "goal-orchestration-runtime-state",
          status: "retired",
          details: expect.objectContaining({ reason: "typed negotiation log state already exists" }),
        }),
        expect.objectContaining({
          source_kind: "goal_dependency_graph",
          source_id: "current",
          migration_name: "goal-orchestration-runtime-state",
          status: "retired",
          details: expect.objectContaining({ reason: "typed dependency graph state already exists" }),
        }),
      ]));
    } finally {
      controlDb.close();
    }
  });

  it("blocks invalid legacy negotiation logs without normal runtime fallback", async () => {
    fs.mkdirSync(path.join(tmpDir, "goals", "goal-bad"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "goals", "goal-bad", "negotiation-log.json"), JSON.stringify({
      goal_id: "other-goal",
      timestamp: "2026-05-10T00:00:00.000Z",
    }));

    const report = await importLegacyGoalOrchestrationState(tmpDir);

    expect(report.negotiationLogs).toBe(0);
    expect(report.blockedSources).toEqual([
      expect.objectContaining({
        sourceKind: "goal_negotiation_log",
        sourcePath: path.join("goals", "goal-bad", "negotiation-log.json"),
      }),
    ]);
    await expect(new GoalOrchestrationStateStore(tmpDir).loadNegotiationLog("goal-bad")).resolves.toBeNull();
  });
});
