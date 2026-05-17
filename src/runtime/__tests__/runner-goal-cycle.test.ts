import { describe, it, expect, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runDaemonGoalCycleLoop } from "../daemon/runner-goal-cycle.js";
import type { LoopResult, ProgressEvent } from "../../orchestrator/loop/durable-loop.js";
import { RuntimeOperatorHandoffStore } from "../store/operator-handoff-store.js";

function makeLoopResult(overrides: Partial<LoopResult> = {}): LoopResult {
  return {
    goalId: "goal-1",
    totalIterations: 1,
    finalStatus: "completed",
    iterations: [
      {
        loopIndex: 0,
        goalId: "goal-1",
        gapAggregate: 0.25,
        driveScores: [],
        taskResult: null,
        stallDetected: false,
        stallReport: null,
        pivotOccurred: false,
        completionJudgment: {
          is_complete: true,
          blocking_dimensions: [],
          low_confidence_dimensions: [],
          needs_verification_task: false,
          checked_at: new Date().toISOString(),
        },
        elapsedMs: 10,
        error: null,
      },
    ],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("runDaemonGoalCycleLoop", () => {
  it("broadcasts CoreLoop progress and loop_complete events through the daemon event server", async () => {
    const broadcast = vi.fn();
    const run = vi.fn().mockImplementation(
      async (_goalId: string, options?: { maxIterations?: number; onProgress?: (event: ProgressEvent) => void }) => {
        options?.onProgress?.({
          iteration: 1,
          maxIterations: 1,
          phase: "Observing...",
          gap: 0.5,
        });
        return makeLoopResult();
      }
    );

    let context: Record<string, unknown>;
    context = {
      running: true,
      shuttingDown: false,
      currentGoalIds: ["goal-1"],
      config: { iterations_per_cycle: 1 },
      state: {
        loop_count: 0,
        last_loop_at: null,
        status: "running",
        active_goals: ["goal-1"],
      },
      consecutiveIdleCycles: 0,
      currentLoopIndex: 0,
      coreLoop: { run },
      eventServer: { broadcast },
      stateManager: {
        loadGoal: vi.fn().mockResolvedValue({ status: "active" }),
      },
      logger: { info: vi.fn() },
      refreshOperationalState: vi.fn(),
      collectGoalCycleSnapshot: vi.fn().mockResolvedValue([]),
      determineActiveGoals: vi.fn().mockResolvedValue(["goal-1"]),
      maybeRefreshProviderRuntime: vi.fn().mockResolvedValue(undefined),
      broadcastGoalUpdated: vi.fn().mockResolvedValue(undefined),
      handleLoopError: vi.fn(),
      saveDaemonState: vi.fn().mockResolvedValue(undefined),
      processCronTasks: vi.fn().mockResolvedValue(undefined),
      processScheduleEntries: vi.fn().mockResolvedValue(undefined),
      expireCronTasks: vi.fn().mockResolvedValue(undefined),
      proactiveTick: vi.fn().mockResolvedValue(undefined),
      runRuntimeStoreMaintenance: vi.fn().mockResolvedValue(undefined),
      getNextInterval: vi.fn().mockReturnValue(1),
      getMaxGapScore: vi.fn().mockResolvedValue(0.5),
      calculateAdaptiveInterval: vi.fn().mockReturnValue(1),
      sleep: vi.fn().mockImplementation(async () => {
        context.running = false;
      }),
      handleCriticalError: vi.fn(),
      cleanup: vi.fn().mockResolvedValue(undefined),
    };

    await runDaemonGoalCycleLoop(context);

    expect(run).toHaveBeenCalledWith(
      "goal-1",
      expect.objectContaining({
        maxIterations: null,
        runPolicy: "resident",
        onProgress: expect.any(Function),
      })
    );
    expect(broadcast).toHaveBeenCalledWith(
      "progress",
      expect.objectContaining({
        goalId: "goal-1",
        phase: "Observing...",
        gap: 0.5,
      })
    );
    expect(broadcast).toHaveBeenCalledWith(
      "loop_complete",
      expect.objectContaining({
        goalId: "goal-1",
        iterations: 1,
        gap: 0.25,
        status: "completed",
      })
    );
  });

  it("records a durable goal-run admission trace before daemon CoreLoop execution", async () => {
    const order: string[] = [];
    const recordTrace = vi.fn().mockImplementation(async () => {
      order.push("trace");
      return {} as never;
    });
    const run = vi.fn().mockImplementation(async () => {
      order.push("run");
      return makeLoopResult();
    });

    let context: Record<string, unknown>;
    context = {
      running: true,
      shuttingDown: false,
      currentGoalIds: ["goal-1"],
      config: { iterations_per_cycle: 1 },
      state: {
        loop_count: 7,
        last_loop_at: null,
        status: "running",
        active_goals: ["goal-1"],
      },
      consecutiveIdleCycles: 0,
      currentLoopIndex: 0,
      coreLoop: { run },
      eventServer: null,
      personalAgentRuntime: { recordTrace },
      stateManager: {
        loadGoal: vi.fn().mockResolvedValue({ status: "active" }),
      },
      logger: { info: vi.fn() },
      refreshOperationalState: vi.fn(),
      collectGoalCycleSnapshot: vi.fn().mockResolvedValue([{
        goalId: "goal-1",
        shouldActivate: true,
        schedule: {
          goal_id: "goal-1",
          next_check_at: "2026-05-15T00:00:00.000Z",
          check_interval_hours: 1,
          last_triggered_at: null,
          consecutive_actions: 0,
          cooldown_until: null,
          current_interval_hours: 1,
        },
      }]),
      determineActiveGoals: vi.fn().mockResolvedValue(["goal-1"]),
      maybeRefreshProviderRuntime: vi.fn().mockResolvedValue(undefined),
      broadcastGoalUpdated: vi.fn().mockResolvedValue(undefined),
      handleLoopError: vi.fn(),
      saveDaemonState: vi.fn().mockResolvedValue(undefined),
      processCronTasks: vi.fn().mockResolvedValue(undefined),
      processScheduleEntries: vi.fn().mockResolvedValue(undefined),
      expireCronTasks: vi.fn().mockResolvedValue(undefined),
      proactiveTick: vi.fn().mockResolvedValue(undefined),
      runRuntimeStoreMaintenance: vi.fn().mockResolvedValue(undefined),
      getNextInterval: vi.fn().mockReturnValue(1),
      getMaxGapScore: vi.fn().mockResolvedValue(0.5),
      calculateAdaptiveInterval: vi.fn().mockReturnValue(1),
      sleep: vi.fn().mockImplementation(async () => {
        context.running = false;
      }),
      handleCriticalError: vi.fn(),
      cleanup: vi.fn().mockResolvedValue(undefined),
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T00:00:00.000Z"));
    try {
      await runDaemonGoalCycleLoop(context);
    } finally {
      vi.useRealTimers();
    }

    expect(order.slice(0, 2)).toEqual(["trace", "run"]);
    expect(recordTrace).toHaveBeenCalledOnce();
    const trace = recordTrace.mock.calls[0]![0] as any;
    expect(trace.situation_frame).toMatchObject({
      caller_path: "scheduled_wake",
      source_kind: "schedule_wake",
    });
    expect(trace.task_candidates[0]).toMatchObject({
      target_kind: "run",
      desired_effect: "create_run",
    });
    expect(trace.intervention_decisions[0]).toMatchObject({
      decision: "allow",
      policy_ref: { kind: "intervention_policy", ref: "policy:goal-run-admission-v1" },
    });
  });

  it("broadcasts newly persisted operator handoffs to live daemon subscribers", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-runner-handoff-"));
    try {
      const broadcast = vi.fn();
      const handoffStore = new RuntimeOperatorHandoffStore(path.join(tmpDir, "runtime"));
      const run = vi.fn().mockImplementation(async () => {
        await handoffStore.create({
          handoff_id: "handoff-live",
          goal_id: "goal-1",
          triggers: ["deadline", "finalization"],
          title: "Deadline handoff",
          summary: "Deadline finalization requires review.",
          current_status: "mode=finalization",
          recommended_action: "Review final artifact.",
          next_action: {
            label: "Review final artifact",
            approval_required: true,
          },
        });
        return makeLoopResult({ finalStatus: "finalization" });
      });

      let context: Record<string, unknown>;
      context = {
        running: true,
        shuttingDown: false,
        currentGoalIds: ["goal-1"],
        config: { iterations_per_cycle: 1 },
        state: {
          loop_count: 0,
          last_loop_at: null,
          status: "running",
          active_goals: ["goal-1"],
        },
        consecutiveIdleCycles: 0,
        currentLoopIndex: 0,
        coreLoop: { run },
        eventServer: { broadcast },
        stateManager: {
          getBaseDir: () => tmpDir,
          loadGoal: vi.fn().mockResolvedValue({ status: "active" }),
        },
        logger: { info: vi.fn(), warn: vi.fn() },
        refreshOperationalState: vi.fn(),
        collectGoalCycleSnapshot: vi.fn().mockResolvedValue([]),
        determineActiveGoals: vi.fn().mockResolvedValue(["goal-1"]),
        maybeRefreshProviderRuntime: vi.fn().mockResolvedValue(undefined),
        broadcastGoalUpdated: vi.fn().mockResolvedValue(undefined),
        handleLoopError: vi.fn(),
        saveDaemonState: vi.fn().mockResolvedValue(undefined),
        processCronTasks: vi.fn().mockResolvedValue(undefined),
        processScheduleEntries: vi.fn().mockResolvedValue(undefined),
        expireCronTasks: vi.fn().mockResolvedValue(undefined),
        proactiveTick: vi.fn().mockResolvedValue(undefined),
        runRuntimeStoreMaintenance: vi.fn().mockResolvedValue(undefined),
        getNextInterval: vi.fn().mockReturnValue(1),
        getMaxGapScore: vi.fn().mockResolvedValue(0.5),
        calculateAdaptiveInterval: vi.fn().mockReturnValue(1),
        sleep: vi.fn().mockImplementation(async () => {
          context.running = false;
        }),
        handleCriticalError: vi.fn(),
        cleanup: vi.fn().mockResolvedValue(undefined),
      };

      await runDaemonGoalCycleLoop(context);

      expect(broadcast).toHaveBeenCalledWith(
        "operator_handoff_required",
        expect.objectContaining({
          handoff_id: "handoff-live",
          goal_id: "goal-1",
          status: "open",
          approval_prompt: expect.objectContaining({
            approve_binding_id: expect.stringMatching(/^sab:/),
          }),
          surface_projection: expect.objectContaining({
            surface: "approval",
            view: "normal",
          }),
        })
      );
      const broadcastPayload = broadcast.mock.calls.find(([eventType]) =>
        eventType === "operator_handoff_required"
      )?.[1] as Record<string, unknown> | undefined;
      expect(broadcastPayload).not.toHaveProperty("summary");
      expect(broadcastPayload).not.toHaveProperty("current_status");
      expect(broadcastPayload).not.toHaveProperty("evidence_refs");
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("broadcasts loop_error when the CoreLoop run fails", async () => {
    const broadcast = vi.fn();
    const run = vi.fn().mockRejectedValue(new Error("boom"));

    let context: Record<string, unknown>;
    context = {
      running: true,
      shuttingDown: false,
      currentGoalIds: ["goal-1"],
      config: { iterations_per_cycle: 1 },
      state: {
        loop_count: 0,
        last_loop_at: null,
        status: "running",
        active_goals: ["goal-1"],
      },
      consecutiveIdleCycles: 0,
      currentLoopIndex: 0,
      coreLoop: { run },
      eventServer: { broadcast },
      stateManager: {
        loadGoal: vi.fn().mockResolvedValue({ status: "active" }),
      },
      logger: { info: vi.fn() },
      refreshOperationalState: vi.fn(),
      collectGoalCycleSnapshot: vi.fn().mockResolvedValue([]),
      determineActiveGoals: vi.fn().mockResolvedValue(["goal-1"]),
      maybeRefreshProviderRuntime: vi.fn().mockResolvedValue(undefined),
      broadcastGoalUpdated: vi.fn().mockResolvedValue(undefined),
      handleLoopError: vi.fn(),
      saveDaemonState: vi.fn().mockResolvedValue(undefined),
      processCronTasks: vi.fn().mockResolvedValue(undefined),
      processScheduleEntries: vi.fn().mockResolvedValue(undefined),
      expireCronTasks: vi.fn().mockResolvedValue(undefined),
      proactiveTick: vi.fn().mockResolvedValue(undefined),
      runRuntimeStoreMaintenance: vi.fn().mockResolvedValue(undefined),
      getNextInterval: vi.fn().mockReturnValue(1),
      getMaxGapScore: vi.fn().mockResolvedValue(0.5),
      calculateAdaptiveInterval: vi.fn().mockReturnValue(1),
      sleep: vi.fn().mockImplementation(async () => {
        context.running = false;
      }),
      handleCriticalError: vi.fn(),
      cleanup: vi.fn().mockResolvedValue(undefined),
    };

    await runDaemonGoalCycleLoop(context);

    expect(broadcast).toHaveBeenCalledWith(
      "loop_error",
      expect.objectContaining({
        goalId: "goal-1",
        message: "boom",
        status: "error",
      })
    );
    expect(context.handleLoopError).toHaveBeenCalledWith("goal-1", expect.any(Error));
  });

  it("clamps daemon sleep to the next wait observation deadline", async () => {
    const run = vi.fn().mockResolvedValue(makeLoopResult());

    let context: Record<string, unknown>;
    context = {
      running: true,
      shuttingDown: false,
      currentGoalIds: ["goal-1"],
      config: { iterations_per_cycle: 1 },
      state: {
        loop_count: 0,
        last_loop_at: null,
        status: "running",
        active_goals: ["goal-1"],
      },
      consecutiveIdleCycles: 0,
      currentLoopIndex: 0,
      coreLoop: { run },
      eventServer: null,
      stateManager: {
        loadGoal: vi.fn().mockResolvedValue({ status: "active" }),
      },
      logger: { info: vi.fn() },
      refreshOperationalState: vi.fn(),
      collectGoalCycleSnapshot: vi.fn().mockResolvedValue([]),
      determineActiveGoals: vi.fn().mockResolvedValue(["goal-1"]),
      maybeRefreshProviderRuntime: vi.fn().mockResolvedValue(undefined),
      broadcastGoalUpdated: vi.fn().mockResolvedValue(undefined),
      handleLoopError: vi.fn(),
      saveDaemonState: vi.fn().mockResolvedValue(undefined),
      processCronTasks: vi.fn().mockResolvedValue(undefined),
      processScheduleEntries: vi.fn().mockResolvedValue(undefined),
      expireCronTasks: vi.fn().mockResolvedValue(undefined),
      proactiveTick: vi.fn().mockResolvedValue(undefined),
      runRuntimeStoreMaintenance: vi.fn().mockResolvedValue(undefined),
      getNextInterval: vi.fn().mockReturnValue(300_000),
      getMaxGapScore: vi.fn().mockResolvedValue(0.5),
      calculateAdaptiveInterval: vi.fn().mockReturnValue(300_000),
      resolveWaitDeadlines: vi.fn().mockResolvedValue({
        next_observe_at: "2026-04-24T12:01:00.000Z",
        waiting_goals: [],
      }),
      clampIntervalToWaitDeadline: vi.fn().mockReturnValue(60_000),
      sleep: vi.fn().mockImplementation(async () => {
        context.running = false;
      }),
      handleCriticalError: vi.fn(),
      cleanup: vi.fn().mockResolvedValue(undefined),
    };

    await runDaemonGoalCycleLoop(context);

    expect(context.resolveWaitDeadlines).toHaveBeenCalledWith(["goal-1"]);
    expect(context.clampIntervalToWaitDeadline).toHaveBeenCalledWith(
      300_000,
      expect.objectContaining({ next_observe_at: "2026-04-24T12:01:00.000Z" })
    );
    expect(context.sleep).toHaveBeenCalledWith(60_000);
  });

  it("runs a goal when its wait observation deadline is due even if drive schedule is idle", async () => {
    const run = vi.fn().mockResolvedValue(makeLoopResult());

    let context: Record<string, unknown>;
    context = {
      running: true,
      shuttingDown: false,
      currentGoalIds: ["goal-1"],
      config: { iterations_per_cycle: 1 },
      state: {
        loop_count: 0,
        last_loop_at: null,
        status: "running",
        active_goals: [],
      },
      consecutiveIdleCycles: 0,
      currentLoopIndex: 0,
      coreLoop: { run },
      eventServer: null,
      stateManager: {
        loadGoal: vi.fn().mockResolvedValue({ status: "active" }),
      },
      logger: { info: vi.fn() },
      refreshOperationalState: vi.fn(),
      collectGoalCycleSnapshot: vi.fn().mockResolvedValue([]),
      determineActiveGoals: vi.fn().mockResolvedValue([]),
      maybeRefreshProviderRuntime: vi.fn().mockResolvedValue(undefined),
      broadcastGoalUpdated: vi.fn().mockResolvedValue(undefined),
      handleLoopError: vi.fn(),
      saveDaemonState: vi.fn().mockResolvedValue(undefined),
      processCronTasks: vi.fn().mockResolvedValue(undefined),
      processScheduleEntries: vi.fn().mockResolvedValue(undefined),
      expireCronTasks: vi.fn().mockResolvedValue(undefined),
      proactiveTick: vi.fn().mockResolvedValue(undefined),
      runRuntimeStoreMaintenance: vi.fn().mockResolvedValue(undefined),
      getNextInterval: vi.fn().mockReturnValue(300_000),
      getMaxGapScore: vi.fn().mockResolvedValue(0.5),
      calculateAdaptiveInterval: vi.fn().mockReturnValue(300_000),
      resolveWaitDeadlines: vi.fn().mockResolvedValue({
        next_observe_at: "2026-04-24T12:00:00.000Z",
        waiting_goals: [
          {
            goal_id: "goal-1",
            strategy_id: "wait-1",
            next_observe_at: "2026-04-24T12:00:00.000Z",
            wait_until: "2026-04-24T12:00:00.000Z",
            wait_reason: "deadline due",
          },
        ],
      }),
      clampIntervalToWaitDeadline: vi.fn().mockReturnValue(0),
      sleep: vi.fn().mockImplementation(async () => {
        context.running = false;
      }),
      handleCriticalError: vi.fn(),
      cleanup: vi.fn().mockResolvedValue(undefined),
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T12:00:00.000Z"));
    try {
      await runDaemonGoalCycleLoop(context);
    } finally {
      vi.useRealTimers();
    }

    expect(context.determineActiveGoals).toHaveBeenCalledWith(["goal-1"], []);
    expect(run).toHaveBeenCalledWith("goal-1", expect.any(Object));
    expect(context.maybeRefreshProviderRuntime).toHaveBeenCalledWith(1);
    expect(context.sleep).toHaveBeenCalledWith(0);
  });

  it("broadcasts structured wait status and daemon waiting fields", async () => {
    const broadcast = vi.fn();
    const run = vi.fn().mockResolvedValue(makeLoopResult({
      iterations: [
        {
          ...makeLoopResult().iterations[0]!,
          waitStrategyId: "wait-1",
          waitObserveOnly: true,
          waitExpired: true,
          waitApprovalId: "wait-goal-1-wait-1",
          waitExpiryOutcome: {
            status: "approval_required",
            goal_id: "goal-1",
            strategy_id: "wait-1",
            details: "external submit approval required",
          },
          skipped: true,
          skipReason: "wait_observe_only",
        },
      ],
    }));

    let context: Record<string, unknown>;
    context = {
      running: true,
      shuttingDown: false,
      currentGoalIds: ["goal-1"],
      config: { iterations_per_cycle: 1 },
      state: {
        loop_count: 0,
        last_loop_at: null,
        status: "running",
        active_goals: [],
      },
      consecutiveIdleCycles: 0,
      currentLoopIndex: 0,
      coreLoop: { run },
      eventServer: { broadcast },
      stateManager: {
        loadGoal: vi.fn().mockResolvedValue({ status: "active" }),
      },
      logger: { info: vi.fn() },
      refreshOperationalState: vi.fn(),
      collectGoalCycleSnapshot: vi.fn().mockResolvedValue([]),
      determineActiveGoals: vi.fn().mockResolvedValue([]),
      maybeRefreshProviderRuntime: vi.fn().mockResolvedValue(undefined),
      broadcastGoalUpdated: vi.fn().mockResolvedValue(undefined),
      handleLoopError: vi.fn(),
      saveDaemonState: vi.fn().mockResolvedValue(undefined),
      processCronTasks: vi.fn().mockResolvedValue(undefined),
      processScheduleEntries: vi.fn().mockResolvedValue(undefined),
      expireCronTasks: vi.fn().mockResolvedValue(undefined),
      proactiveTick: vi.fn().mockResolvedValue(undefined),
      runRuntimeStoreMaintenance: vi.fn().mockResolvedValue(undefined),
      getNextInterval: vi.fn().mockReturnValue(300_000),
      getMaxGapScore: vi.fn().mockResolvedValue(0.5),
      calculateAdaptiveInterval: vi.fn().mockReturnValue(300_000),
      resolveWaitDeadlines: vi.fn().mockResolvedValue({
        next_observe_at: "2026-04-24T12:00:00.000Z",
        waiting_goals: [
          {
            goal_id: "goal-1",
            strategy_id: "wait-1",
            next_observe_at: "2026-04-24T12:00:00.000Z",
            wait_until: "2026-04-24T12:00:00.000Z",
            wait_reason: "external submit is paused",
            approval_pending: true,
          },
          {
            goal_id: "goal-2",
            strategy_id: "wait-2",
            next_observe_at: "2026-04-24T13:00:00.000Z",
            wait_until: "2026-04-24T13:00:00.000Z",
            wait_reason: "approval keyword appears in this note but no approval is pending",
            approval_pending: false,
          },
        ],
      }),
      clampIntervalToWaitDeadline: vi.fn().mockReturnValue(0),
      sleep: vi.fn().mockImplementation(async () => {
        context.running = false;
      }),
      handleCriticalError: vi.fn(),
      cleanup: vi.fn().mockResolvedValue(undefined),
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T12:00:00.000Z"));
    try {
      await runDaemonGoalCycleLoop(context);
    } finally {
      vi.useRealTimers();
    }

    expect(broadcast).toHaveBeenCalledWith(
      "wait_status",
      expect.objectContaining({
        goalId: "goal-1",
        strategyId: "wait-1",
        approvalId: "wait-goal-1-wait-1",
        skipReason: "wait_observe_only",
      })
    );
    expect(broadcast).toHaveBeenCalledWith(
      "daemon_status",
      expect.objectContaining({
        waitingGoals: [
          expect.objectContaining({
            goal_id: "goal-1",
            strategy_id: "wait-1",
            approval_pending: true,
          }),
          expect.objectContaining({
            goal_id: "goal-2",
            strategy_id: "wait-2",
            approval_pending: false,
          }),
        ],
        nextObserveAt: "2026-04-24T12:00:00.000Z",
        approvalPendingCount: 1,
      })
    );
  });
});
