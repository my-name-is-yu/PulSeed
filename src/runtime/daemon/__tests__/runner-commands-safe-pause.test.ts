import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { createEnvelope } from "../../types/envelope.js";
import { JournalBackedQueue } from "../../queue/journal-backed-queue.js";
import { GoalLeaseManager } from "../../goal-lease-manager.js";
import { LoopSupervisor } from "../../executor/loop-supervisor.js";
import { DaemonStateStore } from "../../store/daemon-state-store.js";
import { RuntimePostmortemReportStore } from "../../store/postmortem-report.js";
import { RuntimeSafePauseStore } from "../../store/safe-pause-store.js";
import { CommandDispatcher } from "../../command-dispatcher.js";
import {
  checkpointPauseIfRequested,
  handleGoalPauseCommand,
  handleGoalResumeCommand,
  handleGoalStopCommand,
  restoreSafePauseStateFromStore,
} from "../runner-commands.js";
import type { DaemonState } from "../../types/daemon.js";

describe("daemon safe pause commands", () => {
  let tmpDir: string;
  let state: DaemonState;
  let currentGoalIds: string[];
  let journalQueue: JournalBackedQueue;
  let saveDaemonState: ReturnType<typeof vi.fn>;
  let broadcastGoalUpdated: ReturnType<typeof vi.fn>;
  let supervisor: {
    getState: ReturnType<typeof vi.fn>;
    deactivateGoal: ReturnType<typeof vi.fn>;
    activateGoal: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    tmpDir = makeTempDir("safe-pause-command-");
    currentGoalIds = ["goal-1"];
    state = {
      pid: process.pid,
      started_at: new Date().toISOString(),
      last_loop_at: null,
      loop_count: 0,
      active_goals: [...currentGoalIds],
      status: "running",
      runtime_root: tmpDir,
      crash_count: 0,
      last_error: null,
      last_resident_at: null,
      resident_activity: null,
    };
    journalQueue = new JournalBackedQueue({ journalPath: path.join(tmpDir, "queue.json") });
    saveDaemonState = vi.fn(async () => {
      await new DaemonStateStore(tmpDir).save(state);
    });
    broadcastGoalUpdated = vi.fn();
    supervisor = {
      getState: vi.fn(() => ({
        workers: [
          {
            workerId: "worker-1",
            goalId: "goal-1",
            startedAt: Date.now(),
            iterations: 1,
            backgroundRunId: "run-1",
          },
        ],
        crashCounts: {},
        suspendedGoals: [],
        updatedAt: Date.now(),
      })),
      deactivateGoal: vi.fn(),
      activateGoal: vi.fn(),
    };
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  function context() {
    return {
      runtimeRoot: tmpDir,
      stateManager: { getBaseDir: () => tmpDir },
      currentGoalIds,
      state,
      journalQueue,
      supervisor,
      refreshOperationalState: vi.fn(() => {
        state.active_goals = [...currentGoalIds];
        state.status = currentGoalIds.length > 0 ? "running" : "idle";
      }),
      saveDaemonState,
      abortSleep: vi.fn(),
      broadcastGoalUpdated,
    } as never;
  }

  function seedQueuedGoalActivation(goalId = "goal-1"): void {
    journalQueue.accept(createEnvelope({
      type: "event",
      name: "goal_activated",
      source: "test",
      goal_id: goalId,
      payload: { goalId },
      priority: "normal",
    }));
  }

  it("records pause-requested during active execution, then persists a paused checkpoint at the safe boundary", async () => {
    seedQueuedGoalActivation();
    await handleGoalPauseCommand(context(), "goal-1");

    expect(state.safe_pause_goals?.["goal-1"]?.state).toBe("pause_requested");
    expect(currentGoalIds).toEqual(["goal-1"]);
    expect(supervisor.deactivateGoal).toHaveBeenCalledWith("goal-1");
    expect(broadcastGoalUpdated).toHaveBeenCalledWith("goal-1", "pause_requested");

    await checkpointPauseIfRequested(context(), "goal-1");

    const stored = await new RuntimeSafePauseStore(tmpDir).load("goal-1");
    expect(stored?.state).toBe("paused");
    expect(stored?.checkpoint).toMatchObject({
      active_goals: ["goal-1"],
      queued_goal_ids: ["goal-1"],
      current_mode: "running",
      background_run_ids: ["run-1"],
      next_action: "resume goal to continue from the saved queue/evidence/artifact context",
    });
    expect(currentGoalIds).toEqual([]);
    expect(state.safe_pause_goals?.["goal-1"]?.state).toBe("paused");
    expect(await new RuntimePostmortemReportStore(tmpDir).latestFor({ goalId: "goal-1" })).toMatchObject({
      final_status: "paused",
      trigger: "pause",
    });
    expect(await new RuntimePostmortemReportStore(tmpDir).latestFor({ runId: "run-1" })).toMatchObject({
      scope: {
        goal_id: "goal-1",
        run_id: "run-1",
      },
      final_status: "paused",
      trigger: "pause",
    });
    expect(broadcastGoalUpdated).toHaveBeenLastCalledWith("goal-1", "paused");
  });

  it("resumes a paused goal without duplicating the active goal dispatch target", async () => {
    seedQueuedGoalActivation();
    await handleGoalPauseCommand(context(), "goal-1");
    await checkpointPauseIfRequested(context(), "goal-1");

    await handleGoalResumeCommand(context(), "goal-1");
    await handleGoalResumeCommand(context(), "goal-1");

    expect(currentGoalIds).toEqual(["goal-1"]);
    expect(state.safe_pause_goals?.["goal-1"]?.state).toBe("resumed");
    expect(state.safe_pause_goals?.["goal-1"]?.checkpoint).toMatchObject({
      current_mode: "running",
      candidate_evidence_refs: expect.arrayContaining(["control-db://runtime-evidence/goal/goal-1"]),
      artifact_refs: expect.arrayContaining([`${tmpDir}/artifacts`, "background-run:run-1"]),
      next_action: "resume goal to continue from the saved queue/evidence/artifact context",
    });
    expect(supervisor.activateGoal).toHaveBeenLastCalledWith("goal-1", {
      waitResume: expect.objectContaining({
        type: "wait_resume",
        strategyId: "safe-pause-resume",
        waitReason: expect.stringContaining("mode=running"),
      }),
    });
    expect(supervisor.activateGoal).toHaveBeenCalledTimes(1);
    expect(broadcastGoalUpdated).toHaveBeenLastCalledWith("goal-1", "resumed");
  });

  it("resumes only the selected paused goal instead of every checkpoint-active goal", async () => {
    currentGoalIds = [];
    state.active_goals = [];
    await new RuntimeSafePauseStore(tmpDir).markPaused({
      goalId: "goal-1",
      checkpoint: {
        checkpoint_id: "checkpoint-mixed-active-goals",
        checkpointed_at: new Date().toISOString(),
        active_goals: ["goal-1", "goal-2"],
        queued_goal_ids: ["goal-1", "goal-2"],
        current_mode: "running",
        candidate_evidence_refs: ["evidence-ref"],
        artifact_refs: ["artifact-ref"],
        next_action: "resume selected goal",
        supervisor_state_ref: path.join(tmpDir, "supervisor-state.json"),
        background_run_ids: [],
      },
    });

    await handleGoalResumeCommand(context(), "goal-1");

    expect(currentGoalIds).toEqual(["goal-1"]);
    expect(supervisor.activateGoal).toHaveBeenCalledWith("goal-1", expect.anything());
  });

  it("resumes through the real command dispatcher and supervisor queue without duplicate task dispatch", async () => {
    const realQueue = new JournalBackedQueue({ journalPath: path.join(tmpDir, "real-queue.json") });
    const completedGoalIds: string[] = [];
    const supervisorStatePath = path.join(tmpDir, "real-supervisor-state.json");
    const realSupervisor = new LoopSupervisor({
      coreLoopFactory: () => ({
        run: vi.fn(async (goalId: string) => ({
          goalId,
          totalIterations: 1,
          finalStatus: "completed",
          iterations: [],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        })),
      } as never),
      journalQueue: realQueue,
      goalLeaseManager: new GoalLeaseManager(tmpDir),
      driveSystem: {} as never,
      stateManager: {} as never,
      onGoalComplete: (goalId) => {
        completedGoalIds.push(goalId);
      },
    }, {
      concurrency: 1,
      iterationsPerCycle: 1,
      stateFilePath: supervisorStatePath,
      pollIntervalMs: 20,
      claimLeaseMs: 1_000,
      leaseRenewIntervalMs: 100,
    });
    await realSupervisor.start([]);
    const realState: DaemonState = {
      ...state,
      active_goals: [],
      status: "idle",
    };
    const realCurrentGoalIds: string[] = [];
      const realContext = {
        runtimeRoot: tmpDir,
        stateManager: { getBaseDir: () => tmpDir },
        currentGoalIds: realCurrentGoalIds,
      state: realState,
      journalQueue: realQueue,
      supervisor: realSupervisor,
      refreshOperationalState: vi.fn(() => {
        realState.active_goals = [...realCurrentGoalIds];
        realState.status = realCurrentGoalIds.length > 0 ? "running" : "idle";
      }),
      saveDaemonState: vi.fn(),
      abortSleep: vi.fn(),
      broadcastGoalUpdated: vi.fn(),
    } as never;

    try {
      await new RuntimeSafePauseStore(tmpDir).markPaused({
        goalId: "goal-1",
        checkpoint: {
          checkpoint_id: "checkpoint-1",
          checkpointed_at: new Date().toISOString(),
          active_goals: ["goal-1"],
          queued_goal_ids: ["goal-1"],
          current_mode: "exploration",
          candidate_evidence_refs: ["evidence-ref"],
          artifact_refs: ["artifact-ref"],
          next_action: "continue from checkpoint",
          supervisor_state_ref: supervisorStatePath,
          background_run_ids: [],
        },
      });
      realQueue.accept(createEnvelope({
        type: "command",
        name: "goal_resume",
        source: "test",
        goal_id: "goal-1",
        payload: { goalId: "goal-1" },
        priority: "normal",
      }));
      realQueue.accept(createEnvelope({
        type: "command",
        name: "goal_resume",
        source: "test",
        goal_id: "goal-1",
        payload: { goalId: "goal-1" },
        priority: "normal",
      }));
      const dispatcher = new CommandDispatcher({
        journalQueue: realQueue,
        onGoalResume: async (goalId) => handleGoalResumeCommand(realContext, goalId),
      }, {
        pollIntervalMs: 20,
        claimLeaseMs: 1_000,
      });

      await dispatcher.start();
      await new Promise((resolve) => setTimeout(resolve, 120));
      await dispatcher.shutdown();

      expect(completedGoalIds).toEqual(["goal-1"]);
      expect(realCurrentGoalIds).toEqual(["goal-1"]);

      realQueue.accept(createEnvelope({
        type: "command",
        name: "goal_resume",
        source: "test",
        goal_id: "goal-1",
        payload: { goalId: "goal-1" },
        priority: "normal",
      }));
      await dispatcher.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await dispatcher.shutdown();

      expect(completedGoalIds).toEqual(["goal-1"]);
    } finally {
      await realSupervisor.shutdown();
    }
  });

  it("restores paused safe-pause state from the durable store on daemon restart", async () => {
    seedQueuedGoalActivation();
    await new RuntimeSafePauseStore(tmpDir).markPaused({
      goalId: "goal-1",
      checkpoint: {
        checkpoint_id: "checkpoint-restart",
        checkpointed_at: new Date().toISOString(),
        active_goals: ["goal-1"],
        queued_goal_ids: ["goal-1"],
        current_mode: "running",
        candidate_evidence_refs: ["evidence-ref"],
        artifact_refs: ["artifact-ref"],
        next_action: "resume after restart",
        supervisor_state_ref: path.join(tmpDir, "supervisor-state.json"),
        background_run_ids: [],
      },
    });

    await restoreSafePauseStateFromStore(context());

    expect(currentGoalIds).toEqual([]);
    expect(state.active_goals).toEqual([]);
    const queuedActivation = journalQueue
      .snapshot()
      .deadletter
      .map((messageId) => journalQueue.get(messageId))
      .find((record) => record?.envelope.goal_id === "goal-1" && record.envelope.name === "goal_activated");
    expect(queuedActivation?.status).toBe("deadletter");
    expect(queuedActivation?.deadletterReason).toBe("goal is paused by safe-pause checkpoint");
    expect(state.safe_pause_goals?.["goal-1"]).toMatchObject({
      state: "paused",
      checkpoint: {
        current_mode: "running",
        next_action: "resume after restart",
      },
    });
    const persisted = await new DaemonStateStore(tmpDir).load();
    expect(persisted?.safe_pause_goals?.["goal-1"]?.state).toBe("paused");
  });

  it("keeps emergency stop separate from safe pause", async () => {
    await handleGoalStopCommand(context(), "goal-1");

    const stored = await new RuntimeSafePauseStore(tmpDir).load("goal-1");
    expect(stored?.state).toBe("emergency_stopped");
    expect(currentGoalIds).toEqual([]);
    expect(broadcastGoalUpdated).toHaveBeenCalledWith("goal-1", "stopped");
  });
});
