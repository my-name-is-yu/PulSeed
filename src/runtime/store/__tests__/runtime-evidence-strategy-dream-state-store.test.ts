import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../../../base/state/state-manager.js";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { RuntimeEvidenceLedger, type RuntimeEvidenceEntryInput } from "../evidence-ledger.js";
import { importLegacyRuntimeEvidenceStrategyDreamState } from "../runtime-evidence-strategy-dream-state-migration.js";
import { StrategyDreamStateStore } from "../strategy-dream-state-store.js";
import { ProcessSessionStateStore } from "../process-session-state-store.js";
import { openControlDatabase } from "../control-db/index.js";
import { evaluateWaitConditions } from "../../../orchestrator/strategy/portfolio-wait-observation.js";

function writeJson(baseDir: string, relativePath: string, value: unknown): void {
  const target = path.join(baseDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2), "utf-8");
}

function writeJsonl(baseDir: string, relativePath: string, values: unknown[]): void {
  const target = path.join(baseDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf-8");
}

function makeStrategy(overrides: Record<string, unknown> = {}) {
  return {
    id: "strategy-1",
    goal_id: "goal-1",
    target_dimensions: ["quality"],
    primary_dimension: "quality",
    hypothesis: "Typed state improves runtime ownership.",
    expected_effect: [{ dimension: "quality", direction: "increase", magnitude: "medium" }],
    resource_estimate: { sessions: 1, duration: { value: 1, unit: "hours" }, llm_calls: null },
    state: "candidate",
    allocation: 0.5,
    created_at: "2026-05-10T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    gap_snapshot_at_start: null,
    tasks_generated: [],
    effectiveness_score: null,
    consecutive_stall_count: 0,
    ...overrides,
  };
}

function makePortfolio() {
  return {
    goal_id: "goal-1",
    strategies: [makeStrategy()],
    rebalance_interval: { value: 1, unit: "hours" },
    last_rebalanced_at: "2026-05-10T00:00:00.000Z",
  };
}

function makeRuntimeEvidenceEntry(): RuntimeEvidenceEntryInput {
  return {
    id: "evidence-1",
    occurred_at: "2026-05-10T00:00:00.000Z",
    kind: "verification",
    scope: { goal_id: "goal-1", run_id: "run-1", task_id: "task-1" },
    summary: "Focused verification passed",
    outcome: "improved",
    metrics: [],
    evaluators: [],
    research: [],
    dream_checkpoints: [],
    divergent_exploration: [],
    candidates: [],
    artifacts: [],
    raw_refs: [],
  };
}

function makePersistedRuntimeEvidenceEntry() {
  return {
    schema_version: "runtime-evidence-entry-v1",
    ...makeRuntimeEvidenceEntry(),
  };
}

function makeProcessSessionSnapshot(sessionId = "session-1") {
  return {
    session_id: sessionId,
    command: "npm",
    args: ["test"],
    cwd: "/workspace",
    goal_id: "goal-1",
    task_id: "task-1",
    strategy_id: "strategy-1",
    running: false,
    exitCode: 0,
    signal: null,
    startedAt: "2026-05-10T00:00:00.000Z",
    exitedAt: "2026-05-10T00:03:00.000Z",
    bufferedChars: 512,
    metadataPath: `runtime/process-sessions/${sessionId}.json`,
  };
}

function makeIterationLog(iteration = 0) {
  return {
    timestamp: `2026-05-10T00:0${iteration}:00.000Z`,
    goalId: "goal-1",
    iteration,
    sessionId: "session-1",
    gapAggregate: 0.2,
    stallDetected: false,
    elapsedMs: 10,
    completionJudgment: {},
  };
}

describe("runtime evidence, strategy, and dream database ownership", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      cleanupTempDir(dir);
    }
  });

  function tempHome(prefix: string): string {
    const dir = makeTempDir(prefix);
    tempDirs.push(dir);
    return dir;
  }

  it("stores runtime evidence summaries in the control database without normal-path JSONL writes", async () => {
    const baseDir = tempHome("pulseed-runtime-evidence-db-");
    const runtimeRoot = path.join(baseDir, "runtime");
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);

    await ledger.append(makeRuntimeEvidenceEntry());
    const summary = await ledger.summarizeRun("run-1");

    expect(summary.total_entries).toBe(1);
    expect((await ledger.readByGoal("goal-1")).entries.map((entry) => entry.id)).toEqual(["evidence-1"]);
    expect(fs.existsSync(path.join(runtimeRoot, "evidence-ledger", "runs", `${encodeURIComponent("run-1")}.jsonl`))).toBe(false);
  });

  it("routes strategy raw state through StateManager into typed database rows", async () => {
    const baseDir = tempHome("pulseed-strategy-dream-state-");
    const stateManager = new StateManager(baseDir);
    await stateManager.init();

    await stateManager.writeRaw("strategies/goal-1/portfolio.json", makePortfolio());
    await stateManager.writeRaw("strategies/goal-1/wait-meta/strategy-1.json", {
      process_refs: [{ session_id: "session-1" }],
    });

    expect(await stateManager.readRaw("strategies/goal-1/portfolio.json")).toMatchObject({
      goal_id: "goal-1",
      strategies: [{ id: "strategy-1" }],
    });
    expect(await stateManager.readRaw("strategies/goal-1/wait-meta/strategy-1.json")).toMatchObject({
      process_refs: [{ session_id: "session-1" }],
    });
    expect(fs.existsSync(path.join(baseDir, "strategies", "goal-1", "portfolio.json"))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, "strategies", "goal-1", "wait-meta", "strategy-1.json"))).toBe(false);
  });

  it("imports legacy runtime evidence, strategy, and dream files only through the migration boundary", async () => {
    const baseDir = tempHome("pulseed-evidence-strategy-dream-import-");
    const runtimeRoot = path.join(baseDir, "runtime");

    writeJsonl(baseDir, `runtime/evidence-ledger/runs/${encodeURIComponent("run-1")}.jsonl`, [
      makePersistedRuntimeEvidenceEntry(),
    ]);
    writeJson(baseDir, "strategies/goal-1/portfolio.json", makePortfolio());
    writeJson(baseDir, "strategies/goal-1/wait-meta/strategy-1.json", {
      process_refs: [{ session_id: "session-1" }],
    });
    writeJson(baseDir, "runtime/process-sessions/session-1.json", makeProcessSessionSnapshot());
    writeJsonl(baseDir, "goals/goal-1/iteration-logs.jsonl", [
      makeIterationLog(0),
      makeIterationLog(1),
    ]);
    writeJsonl(baseDir, "dream/session-logs.jsonl", [{
      timestamp: "2026-05-10T00:05:00.000Z",
      goalId: "goal-1",
      sessionId: "session-1",
      iterationCount: 2,
      finalGapAggregate: 0.1,
      initialGapAggregate: 0.2,
      totalTokensUsed: 42,
      totalElapsedMs: 20,
      stallCount: 0,
      outcome: "max_iterations",
      strategiesUsed: ["strategy-1"],
    }]);
    writeJsonl(baseDir, "dream/events/goal-1.jsonl", [{
      timestamp: "2026-05-10T00:06:00.000Z",
      eventType: "StallDetected",
      goalId: "goal-1",
      data: { stall_type: "confidence_stall" },
    }]);
    writeJsonl(baseDir, "dream/importance-buffer.jsonl", [{
      id: "importance-1",
      timestamp: "2026-05-10T00:07:00.000Z",
      goalId: "goal-1",
      source: "task",
      importance: 0.8,
      reason: "important task",
      data_ref: "task-1",
      tags: [],
      processed: false,
    }]);
    writeJson(baseDir, "dream/watermarks.json", {
      goals: { "goal-1": { lastProcessedLine: 1 } },
      importanceBuffer: { lastProcessedLine: 1 },
    });
    writeJson(baseDir, "dream/schedule-suggestions.json", {
      generated_at: "2026-05-10T00:08:00.000Z",
      suggestions: [{
        id: "suggestion-1",
        type: "goal_trigger",
        goalId: "goal-1",
        proposal: "0 9 * * *",
        reason: "Manual execution clusters around 09:00 UTC.",
        confidence: 0.8,
        status: "pending",
      }],
    });
    writeJson(baseDir, "dream/playbooks/playbook-1.json", {
      playbook_id: "playbook-1",
      status: "candidate",
      kind: "verified_execution",
      title: "Recover confidence stalls",
      summary: "Pause and re-plan when confidence stalls repeat.",
      source_signature: "task-category:verification",
      applicability: {
        goal_ids: ["goal-1"],
        primary_dimensions: ["quality"],
        task_categories: ["verification"],
        terms: ["confidence"],
      },
      preconditions: ["A confidence stall was observed."],
      recommended_steps: ["Inspect the stall evidence.", "Change the task decomposition."],
      verification_checks: [],
      failure_warnings: ["Do not retry unchanged work."],
      evidence_refs: ["dream/events/goal-1.jsonl#L1"],
      source_task_ids: ["task-1"],
      verification: {
        verdict: "pass",
        confidence: 0.8,
        last_verified_at: "2026-05-10T00:09:00.000Z",
      },
      usage: {
        retrieved_count: 0,
        verified_success_count: 1,
        successful_reuse_count: 0,
        failed_reuse_count: 0,
      },
      governance: {
        created_by: "dream",
        review_state: "pending",
        auto_generated: true,
        user_editable: true,
        auto_mutation: "forbidden",
      },
      created_at: "2026-05-10T00:09:00.000Z",
      updated_at: "2026-05-10T00:09:00.000Z",
    });
    writeJson(baseDir, "dream/activation-artifacts.json", {
      version: "dream-activation-artifacts-v1",
      generated_at: "2026-05-10T00:10:00.000Z",
      artifacts: [{
        artifact_id: "activation-1",
        type: "workflow_hint_pack",
        source: "migration-test",
        scope: { goal_id: "goal-1" },
        summary: "Use known recovery workflows.",
        payload: { workflow_ids: ["workflow-1"] },
        evidence_refs: ["dream/events/goal-1.jsonl#L1"],
        confidence: 0.8,
        valid_from: "2026-05-10T00:10:00.000Z",
        valid_to: null,
      }],
    });
    writeJson(baseDir, "dream/workflows.json", {
      version: "dream-workflows-v1",
      generated_at: "2026-05-10T00:11:00.000Z",
      workflows: [{
        workflow_id: "workflow-1",
        type: "stall_recovery",
        title: "Stall recovery: confidence",
        description: "Recover confidence stalls by changing strategy.",
        applicability: {
          goal_ids: ["goal-1"],
          task_ids: ["task-1"],
          event_types: ["StallDetected"],
          signals: ["confidence_stall"],
          scopes: [{ goal_id: "goal-1", task_id: "task-1" }],
        },
        preconditions: ["A stall was detected."],
        steps: ["Pause retries.", "Inspect evidence.", "Re-plan."],
        failure_modes: ["confidence_stall"],
        recovery_steps: ["Use a different strategy."],
        evidence_refs: ["dream/events/goal-1.jsonl#L1"],
        evidence_count: 1,
        success_count: 0,
        failure_count: 1,
        confidence: 0.7,
        created_at: "2026-05-10T00:11:00.000Z",
        updated_at: "2026-05-10T00:11:00.000Z",
      }],
    });

    const report = await importLegacyRuntimeEvidenceStrategyDreamState(baseDir, { runtimeRoot });

    expect(report).toMatchObject({
      runtimeEvidenceEntries: 1,
      processSessionSnapshots: 1,
      strategyRecords: 2,
      dreamIterationLogs: 2,
      dreamSessionLogs: 1,
      dreamEventLogs: 1,
      dreamImportanceEntries: 1,
      dreamWatermarks: true,
      dreamScheduleSuggestions: 1,
      dreamPlaybooks: 1,
      dreamActivationArtifacts: 1,
      dreamWorkflows: 1,
      blockedSources: [],
    });
    await expect(new RuntimeEvidenceLedger(runtimeRoot).readByRun("run-1")).resolves.toMatchObject({
      entries: [expect.objectContaining({ id: "evidence-1" })],
    });
    const stateStore = new StrategyDreamStateStore(baseDir);
    const processSessionStore = new ProcessSessionStateStore(baseDir);
    await expect(stateStore.loadPortfolio("goal-1")).resolves.toMatchObject({ goal_id: "goal-1" });
    await expect(stateStore.loadWaitMetadata("goal-1", "strategy-1")).resolves.toMatchObject({
      process_refs: [{ session_id: "session-1" }],
    });
    await expect(processSessionStore.loadSnapshot("session-1")).resolves.toMatchObject({
      session_id: "session-1",
      metadataRef: "control-db://process-sessions/session-1",
    });
    await expect(evaluateWaitConditions(
      [{ type: "process_session_exited", session_id: "session-1" }],
      {
        schema_version: 1,
        wait_until: "2026-05-10T00:00:00.000Z",
        conditions: [{ type: "process_session_exited", session_id: "session-1" }],
        resume_plan: { action: "complete_wait" },
        process_refs: [{ session_id: "session-1", metadata_ref: "control-db://process-sessions/session-1" }],
        artifact_refs: [],
        approval_policy: null,
        next_observe_at: null,
        latest_observation: null,
      },
      { nowMs: Date.parse("2026-05-10T00:05:00.000Z"), stateBaseDir: baseDir },
    )).resolves.toMatchObject({
      status: "satisfied",
      evidence: {
        conditions: [expect.objectContaining({
          session_id: "session-1",
          exitCode: 0,
          exitedAt: "2026-05-10T00:03:00.000Z",
        })],
      },
    });
    await expect(stateStore.listIterationLogs("goal-1")).resolves.toHaveLength(2);
    await expect(stateStore.listSessionLogs()).resolves.toHaveLength(1);
    await expect(stateStore.listEventLogs()).resolves.toHaveLength(1);
    await expect(stateStore.listImportanceEntries()).resolves.toHaveLength(1);
    await expect(stateStore.loadScheduleSuggestions()).resolves.toMatchObject({
      suggestions: [expect.objectContaining({ id: "suggestion-1" })],
    });
    await expect(stateStore.loadDreamPlaybooks()).resolves.toEqual([
      expect.objectContaining({ playbook_id: "playbook-1" }),
    ]);
    await expect(stateStore.loadActivationArtifacts()).resolves.toEqual([
      expect.objectContaining({ artifact_id: "activation-1" }),
    ]);
    await expect(stateStore.loadDreamWorkflows()).resolves.toEqual([
      expect.objectContaining({ workflow_id: "workflow-1" }),
    ]);

    const secondReport = await importLegacyRuntimeEvidenceStrategyDreamState(baseDir, { runtimeRoot });
    expect(secondReport).toMatchObject({
      runtimeEvidenceEntries: 0,
      processSessionSnapshots: 0,
      strategyRecords: 0,
      dreamIterationLogs: 0,
      dreamSessionLogs: 0,
      dreamEventLogs: 0,
      dreamImportanceEntries: 0,
      dreamWatermarks: false,
      dreamScheduleSuggestions: 0,
      dreamPlaybooks: 0,
      dreamActivationArtifacts: 0,
      dreamWorkflows: 0,
      blockedSources: [],
    });
    await expect(new RuntimeEvidenceLedger(runtimeRoot).readByRun("run-1")).resolves.toMatchObject({
      entries: [expect.objectContaining({ id: "evidence-1" })],
    });
    await expect(stateStore.listSessionLogs()).resolves.toHaveLength(1);
    await expect(stateStore.listEventLogs()).resolves.toHaveLength(1);

    const db = await openControlDatabase({ baseDir });
    try {
      const imports = db.listLegacyImports().filter((record) => record.migration_name === "runtime-evidence-strategy-dream-state");
      expect(imports.length).toBeGreaterThanOrEqual(6);
      expect(imports.every((record) => record.migration_version === 7)).toBe(true);
      expect(imports.every((record) => record.status === "imported")).toBe(true);
    } finally {
      db.close();
    }
  });
});
