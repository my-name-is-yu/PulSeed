import { describe, it, expect, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { LoopSupervisor } from "../executor/loop-supervisor.js";
import { JournalBackedQueue } from "../queue/journal-backed-queue.js";
import { createEnvelope } from "../types/envelope.js";
import type { LoopResult } from "../../orchestrator/loop/durable-loop.js";
import { GoalLeaseManager } from "../goal-lease-manager.js";
import { StateManager } from "../../base/state/state-manager.js";
import { makeGoal } from "../../../tests/helpers/fixtures.js";
import { BackgroundRunLedger } from "../store/background-run-store.js";
import { openControlDatabase, SupervisorStateStore } from "../store/index.js";
import type { BackgroundRun } from "../session-registry/types.js";
import { isDaemonShutdownAbortSignal } from "../../base/utils/abort-reason.js";

function makeLoopResult(o: Partial<LoopResult> = {}): LoopResult {
  return { goalId: "g", totalIterations: 1, finalStatus: "completed", iterations: [],
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), ...o };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 20
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

async function pollForJsonMatch<T>(
  filePath: string,
  predicate: (value: T) => boolean,
  timeoutMs = 2_000,
  intervalMs = 20
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await readSupervisorStatePath(filePath) as T | null;
      if (value !== null) {
        if (predicate(value)) {
          return value;
        }
      }
    } catch {
      // Retry until stable.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for matching JSON in file: ${filePath}`);
}

async function readSupervisorStatePath(filePath: string): Promise<unknown | null> {
  if (path.basename(filePath) !== "supervisor-state.json") {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  }
  const runtimeRoot = path.dirname(filePath);
  const controlBaseDir = path.basename(runtimeRoot) === "runtime" ? path.dirname(runtimeRoot) : runtimeRoot;
  return new SupervisorStateStore(runtimeRoot, { controlBaseDir }).load();
}

async function writeRawSupervisorState(runtimeRoot: string, state: Record<string, unknown>): Promise<void> {
  const database = await openControlDatabase({ baseDir: runtimeRoot });
  try {
    database.transaction((db) => {
      db.prepare(`
        INSERT INTO supervisor_state_snapshots (
          state_id,
          updated_at,
          active_goal_count,
          state_json
        )
        VALUES ('current', ?, 0, json(?))
        ON CONFLICT(state_id) DO UPDATE SET
          updated_at = excluded.updated_at,
          active_goal_count = excluded.active_goal_count,
          state_json = excluded.state_json
      `).run(
        typeof state["updatedAt"] === "number" ? state["updatedAt"] : Date.now(),
        JSON.stringify(state),
      );
    });
  } finally {
    database.close();
  }
}

async function pollForBackgroundRunMatch(
  ledger: BackgroundRunLedger,
  runId: string,
  predicate: (value: BackgroundRun) => boolean,
  timeoutMs = 2_000,
  intervalMs = 20
): Promise<BackgroundRun> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await ledger.load(runId);
    if (value !== null && predicate(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for background run ${runId}`);
}

function makeSupervisor(
  coreLoopImpl?: (...args: any[]) => Promise<LoopResult> | never,
  extra: Record<string, unknown> = {},
  config: Record<string, unknown> = {}
) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sv-durable-"));
  const stateFile = path.join(runtimeRoot, "supervisor-state.json");
  const journalQueue = new JournalBackedQueue({
    journalPath: path.join(runtimeRoot, "queue.json"),
  });
  const goalLeaseManager = new GoalLeaseManager(runtimeRoot, 1_000);
  const mockCoreLoop = { run: vi.fn().mockImplementation(coreLoopImpl ?? (() => Promise.resolve(makeLoopResult()))), stop: vi.fn() };
  const deps = {
    coreLoopFactory: () => mockCoreLoop as any,
    journalQueue,
    goalLeaseManager,
    driveSystem: { shouldActivate: vi.fn(), prioritizeGoals: vi.fn(), startWatcher: vi.fn(), stopWatcher: vi.fn(), writeEvent: vi.fn() } as any,
    stateManager: { getBaseDir: vi.fn().mockReturnValue(runtimeRoot) } as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    onEscalation: vi.fn(),
    ...extra,
  };
  const supervisor = new LoopSupervisor(deps, {
    concurrency: 2,
    pollIntervalMs: 20,
    maxCrashCount: 3,
    crashBackoffBaseMs: 50,
    runtimeRoot,
    claimLeaseMs: 200,
    leaseRenewIntervalMs: 50,
    ...config,
  });
  return {
    supervisor,
    deps,
    stateFile,
    journalQueue,
    goalLeaseManager,
    mockCoreLoop,
    runtimeRoot,
  };
}

describe("LoopSupervisor", () => {
  // ─── 1. start() pushes goal_activated and workers pick them up ───

  it("start() calls coreLoop.run for initial goals", async () => {
    const { supervisor, mockCoreLoop, runtimeRoot } = makeSupervisor();
    try {
      await supervisor.start(["g1"]);
      await new Promise((r) => setTimeout(r, 80));
      await supervisor.shutdown();
      expect(mockCoreLoop.run).toHaveBeenCalledWith("g1", expect.anything());
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("records personal-agent run admission before worker DurableLoop execution", async () => {
    const order: string[] = [];
    const recordTrace = vi.fn().mockImplementation(async () => {
      order.push("trace");
      return {} as never;
    });
    const { supervisor, mockCoreLoop, runtimeRoot } = makeSupervisor(
      async (goalId: string) => {
        order.push("run");
        return makeLoopResult({ goalId });
      },
      { personalAgentRuntime: { recordTrace } },
      { concurrency: 1 }
    );
    try {
      await supervisor.start(["g-admitted"]);
      await waitFor(() => mockCoreLoop.run.mock.calls.some((call: unknown[]) => call[0] === "g-admitted"));
      await supervisor.shutdown();

      expect(order.slice(0, 2)).toEqual(["trace", "run"]);
      expect(recordTrace).toHaveBeenCalledOnce();
      const trace = recordTrace.mock.calls[0]![0] as any;
      expect(trace.situation_frame).toMatchObject({
        caller_path: "task_execution",
        source_kind: "task_execution",
      });
      expect(trace.task_candidates[0]).toMatchObject({
        target_kind: "run",
        desired_effect: "create_run",
      });
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("prefers durableLoopFactory over legacy coreLoopFactory", async () => {
    const durableLoop = {
      run: vi.fn().mockResolvedValue(makeLoopResult({ goalId: "g-durable-factory" })),
      stop: vi.fn(),
    };
    const legacyLoop = {
      run: vi.fn().mockResolvedValue(makeLoopResult({ goalId: "g-legacy-factory" })),
      stop: vi.fn(),
    };
    const { supervisor, runtimeRoot } = makeSupervisor(undefined, {
      durableLoopFactory: () => durableLoop as any,
      coreLoopFactory: () => legacyLoop as any,
    }, { concurrency: 1 });
    try {
      await supervisor.start(["g-durable-factory"]);
      await waitFor(() => durableLoop.run.mock.calls.some((call: unknown[]) => call[0] === "g-durable-factory"));
      await supervisor.shutdown();
      expect(durableLoop.run).toHaveBeenCalledWith("g-durable-factory", expect.anything());
      expect(legacyLoop.run).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  // ─── 2. Goal Exclusivity: coalescing ───

  it("coalesces duplicate goal_activated via requestExtend (re-runs)", async () => {
    let callCount = 0;
    const { supervisor, mockCoreLoop, journalQueue, runtimeRoot } = makeSupervisor((async (goalId: string) => {
      callCount++;
      if (callCount === 1) {
        journalQueue.accept(createEnvelope({ type: "event", name: "goal_activated",
          source: "test", goal_id: "g1", payload: {}, priority: "normal" }));
        await new Promise((r) => setTimeout(r, 30));
      }
      return makeLoopResult({ goalId });
    }) as unknown as () => Promise<LoopResult>);
    try {
      await supervisor.start(["g1"]);
      await new Promise((r) => setTimeout(r, 200));
      await supervisor.shutdown();
      expect(mockCoreLoop.run).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  // ─── 3. Suspended goals are skipped ───

  it("goal is added to suspendedGoals after max crashes reached", async () => {
    // Use a mock coreLoop that crashes exactly maxCrashCount times
    // Then verify the goal appears in getState().suspendedGoals
    const onEscalation = vi.fn();
    let runCallCount = 0;
    const crashingLoop = {
      run: vi.fn().mockImplementation(async () => {
        runCallCount++;
        throw new Error("crash");
      }),
      stop: vi.fn(),
    };
    const { supervisor, runtimeRoot } = makeSupervisor(
      crashingLoop.run as unknown as (...args: any[]) => Promise<LoopResult>,
      {
        coreLoopFactory: () => crashingLoop as any,
        onEscalation,
      },
      { concurrency: 1, pollIntervalMs: 10, maxCrashCount: 1, crashBackoffBaseMs: 9999 }
    );
    try {
      await supervisor.start(["g-susp"]);
      const deadline = Date.now() + 1000;
      while (runCallCount === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((r) => setTimeout(r, 50));
      await supervisor.shutdown();
      expect(onEscalation).toHaveBeenCalledWith("g-susp", 1, "crash");
      expect(supervisor.getState().suspendedGoals).toContain("g-susp");
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  // ─── 4. Crash recovery re-queues under threshold ───

  it("crash under threshold increments crashCount and does not suspend", async () => {
    // Verify that after one crash (under maxCrashCount=3):
    // - crashCounts["g-retry"] === 1
    // - goal is NOT in suspendedGoals
    // - a re-queue envelope is scheduled (eventBus will receive it after backoff)
    const retryLoop = {
      run: vi.fn().mockRejectedValue(new Error("transient")),
      stop: vi.fn(),
    };
    let runCallCount = 0;
    const wrappedRun = vi.fn().mockImplementation(async (...args: unknown[]) => {
      runCallCount++;
      return retryLoop.run(...args);
    });
    const { supervisor, runtimeRoot } = makeSupervisor(
      wrappedRun as unknown as (...args: any[]) => Promise<LoopResult>,
      { coreLoopFactory: () => ({ run: wrappedRun, stop: vi.fn() }) as any },
      { concurrency: 1, pollIntervalMs: 10, maxCrashCount: 3, crashBackoffBaseMs: 9999 }
    );
    try {
      await supervisor.start(["g-retry"]);
      const deadline = Date.now() + 1000;
      while (runCallCount === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((r) => setTimeout(r, 50));
      await supervisor.shutdown();
      const state = supervisor.getState();
      expect(state.crashCounts["g-retry"]).toBe(1);
      expect(state.suspendedGoals).not.toContain("g-retry");
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("resets crash counts after a successful run", async () => {
    let runCount = 0;
    const { supervisor, runtimeRoot } = makeSupervisor(async (goalId: string) => {
      runCount += 1;
      if (runCount === 1) {
        throw new Error("transient");
      }
      return makeLoopResult({ goalId });
    });

    try {
      await supervisor.start(["g-reset"]);
      await waitFor(() => runCount >= 2, 10_000);
      await supervisor.shutdown();

      expect(supervisor.getState().crashCounts["g-reset"]).toBeUndefined();
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  // ─── 5. shutdown() ───

  it("shutdown() resolves after workers complete", async () => {
    const { supervisor, runtimeRoot } = makeSupervisor();
    try {
      await supervisor.start(["g1"]);
      await new Promise((r) => setTimeout(r, 40));
      await expect(supervisor.shutdown()).resolves.toBeUndefined();
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("shutdown() is safe without start()", async () => {
    const { supervisor, runtimeRoot } = makeSupervisor();
    try {
      await expect(supervisor.shutdown()).resolves.toBeUndefined();
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("shutdown() aborts active executions and returns without natural task completion", async () => {
    let naturalCompletion = false;
    let capturedSignal: AbortSignal | undefined;
    const { supervisor, mockCoreLoop, runtimeRoot } = makeSupervisor(
      (async (_goalId: string, options?: { abortSignal?: AbortSignal }) => {
        capturedSignal = options?.abortSignal;
        await new Promise<void>((resolve) => {
          options?.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return makeLoopResult({ goalId: "g-stop", finalStatus: "stopped" });
      }) as unknown as (...args: any[]) => Promise<LoopResult>,
      {},
      { concurrency: 1, pollIntervalMs: 10, activeStopGraceMs: 25 }
    );
    try {
      await supervisor.start(["g-stop"]);
      await waitFor(() => capturedSignal !== undefined);

      const startedAt = Date.now();
      await supervisor.shutdown();
      const elapsedMs = Date.now() - startedAt;

      expect(capturedSignal?.aborted).toBe(true);
      expect(elapsedMs).toBeLessThan(500);
      expect(naturalCompletion).toBe(false);
      expect(mockCoreLoop.run).toHaveBeenCalledWith(
        "g-stop",
        expect.objectContaining({ abortSignal: capturedSignal })
      );
    } finally {
      naturalCompletion = true;
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("shutdown() has a bounded wait even when active execution ignores abort", async () => {
    let started = false;
    let capturedSignal: AbortSignal | undefined;
    const { supervisor, runtimeRoot } = makeSupervisor(
      (async (_goalId: string, options?: { abortSignal?: AbortSignal }) => {
        capturedSignal = options?.abortSignal;
        started = true;
        await new Promise<void>(() => undefined);
        return makeLoopResult({ goalId: "g-hung" });
      }) as unknown as (...args: any[]) => Promise<LoopResult>,
      {},
      { concurrency: 1, pollIntervalMs: 10, activeStopGraceMs: 30 }
    );
    try {
      await supervisor.start(["g-hung"]);
      await waitFor(() => started);

      const startedAt = Date.now();
      await supervisor.shutdown();
      const elapsedMs = Date.now() - startedAt;

      expect(capturedSignal?.aborted).toBe(true);
      expect(elapsedMs).toBeLessThan(500);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("shutdown() relinquishes hung active executions for restart recovery", async () => {
    let started = false;
    let capturedSignal: AbortSignal | undefined;
    const { supervisor, journalQueue, goalLeaseManager, runtimeRoot } = makeSupervisor(
      (async (_goalId: string, options?: { abortSignal?: AbortSignal }) => {
        capturedSignal = options?.abortSignal;
        started = true;
        await new Promise<void>(() => undefined);
        return makeLoopResult({ goalId: "g-restart" });
      }) as unknown as (...args: any[]) => Promise<LoopResult>,
      {},
      { concurrency: 1, pollIntervalMs: 10, activeStopGraceMs: 30 }
    );
    try {
      await supervisor.start(["g-restart"]);
      await waitFor(() => started);

      await supervisor.shutdown();

      expect(capturedSignal?.aborted).toBe(true);
      expect(isDaemonShutdownAbortSignal(capturedSignal)).toBe(true);
      const snapshot = journalQueue.snapshot();
      expect(snapshot.inflight).toEqual({});
      expect(snapshot.pending.normal.length).toBe(1);
      expect(await goalLeaseManager.read("g-restart")).toBeNull();
      expect(supervisor.getState().workers).toEqual([
        expect.objectContaining({ goalId: null }),
      ]);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("shutdown() does not start a new execution after an in-flight poll observes stop", async () => {
    let leaseStarted = false;
    let releaseLease: (() => void) | undefined;
    const { supervisor, mockCoreLoop, runtimeRoot } = makeSupervisor(
      (async () => makeLoopResult({ goalId: "g-race" })) as unknown as (...args: any[]) => Promise<LoopResult>,
      {},
      { concurrency: 1, pollIntervalMs: 10, activeStopGraceMs: 25 }
    );
    (supervisor as unknown as { acquireExecutionLease: (...args: unknown[]) => Promise<boolean> }).acquireExecutionLease =
      vi.fn(async () => {
        leaseStarted = true;
        await new Promise<void>((resolve) => {
          releaseLease = resolve;
        });
        return true;
      });

    try {
      await supervisor.start(["g-race"]);
      await waitFor(() => leaseStarted);

      const shutdownPromise = supervisor.shutdown();
      await new Promise((resolve) => setTimeout(resolve, 20));
      releaseLease?.();
      await shutdownPromise;

      expect(mockCoreLoop.run).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("shutdown() bounds an in-flight poll before returning", async () => {
    let leaseStarted = false;
    const { supervisor, mockCoreLoop, runtimeRoot } = makeSupervisor(
      (async () => makeLoopResult({ goalId: "g-stuck-poll" })) as unknown as (...args: any[]) => Promise<LoopResult>,
      {},
      { concurrency: 1, pollIntervalMs: 10, activeStopGraceMs: 30 }
    );
    (supervisor as unknown as { acquireExecutionLease: (...args: unknown[]) => Promise<boolean> }).acquireExecutionLease =
      vi.fn(async () => {
        leaseStarted = true;
        await new Promise<void>(() => undefined);
        return true;
      });

    try {
      await supervisor.start(["g-stuck-poll"]);
      await waitFor(() => leaseStarted);

      const startedAt = Date.now();
      await supervisor.shutdown();
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(500);
      expect(mockCoreLoop.run).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  // ─── 6. State persistence ───

  it("writes supervisor state to the control database after execution", async () => {
    const { supervisor, stateFile, runtimeRoot } = makeSupervisor();
    try {
      await supervisor.start(["g1"]);
      await new Promise((r) => setTimeout(r, 100));
      await supervisor.shutdown();
      const state = await readSupervisorStatePath(stateFile) as Record<string, unknown>;
      expect(state).toHaveProperty("workers");
      expect(state).toHaveProperty("crashCounts");
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("does not restore suspended goals from a previous supervisor process", async () => {
    const { runtimeRoot, deps } = makeSupervisor();
    await writeRawSupervisorState(
      runtimeRoot,
      {
        workers: [],
        crashCounts: { "g-suspended": 3 },
        suspendedGoals: ["g-suspended"],
        updatedAt: Date.now(),
      }
    );

    const recoveredSupervisor = new LoopSupervisor(deps, {
      concurrency: 1,
      pollIntervalMs: 20,
      maxCrashCount: 3,
      crashBackoffBaseMs: 50,
      runtimeRoot,
      claimLeaseMs: 200,
      leaseRenewIntervalMs: 50,
    });

    try {
      await recoveredSupervisor.start(["g-suspended"]);
      await waitFor(() => deps.coreLoopFactory().run.mock.calls.some((call: unknown[]) => call[0] === "g-suspended"));
      await recoveredSupervisor.shutdown();

      expect(recoveredSupervisor.getState().suspendedGoals).not.toContain("g-suspended");
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("restores only safe integer crash counts from persisted supervisor state", async () => {
    const { runtimeRoot, deps } = makeSupervisor();
    await writeRawSupervisorState(
      runtimeRoot,
      {
        workers: [],
        crashCounts: {
          "g-valid": 2,
          "g-zero": 0,
          "g-string": "2",
          "g-negative": -1,
          "g-decimal": 1.5,
          "g-unsafe": Number.MAX_SAFE_INTEGER + 1,
          "": 1,
        },
        suspendedGoals: [],
        updatedAt: Date.now(),
      }
    );

    const recoveredSupervisor = new LoopSupervisor(deps, {
      concurrency: 1,
      pollIntervalMs: 20,
      maxCrashCount: 3,
      crashBackoffBaseMs: 50,
      runtimeRoot,
      claimLeaseMs: 200,
      leaseRenewIntervalMs: 50,
    });

    try {
      await recoveredSupervisor.start([]);
      await recoveredSupervisor.shutdown();

      expect(recoveredSupervisor.getState().crashCounts).toEqual({
        "g-valid": 2,
        "g-zero": 0,
      });
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("persists active worker state while work is in flight", async () => {
    const { supervisor, stateFile, runtimeRoot } = makeSupervisor(async (goalId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return makeLoopResult({ goalId, totalIterations: 2 });
    });
    try {
      await supervisor.start(["g-live"]);
      const state = await pollForJsonMatch<{ workers: Array<{ goalId: string | null; startedAt: number }> }>(
        stateFile,
        (value) => value.workers.some((worker) => worker.goalId === "g-live" && worker.startedAt > 0)
      );
      expect(state.workers.some((worker) => worker.goalId === "g-live")).toBe(true);
      await supervisor.shutdown();
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  // ─── 7. Concurrency limit ───

  it("runs at most N workers simultaneously", async () => {
    let concurrent = 0; let max = 0;
    const slowAdmissionTrace = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 70));
    });
    const { deps, runtimeRoot } = makeSupervisor(async () => {
      concurrent++; max = Math.max(max, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
      return makeLoopResult();
    }, {
      personalAgentRuntime: { recordTrace: slowAdmissionTrace },
    });
    const sv = new LoopSupervisor(deps, {
      concurrency: 2, pollIntervalMs: 20, maxCrashCount: 3,
      crashBackoffBaseMs: 50, runtimeRoot,
      claimLeaseMs: 200,
      leaseRenewIntervalMs: 50,
    });
    try {
      await sv.start(["g1", "g2", "g3"]);
      await new Promise((r) => setTimeout(r, 260));
      await sv.shutdown();
      expect(slowAdmissionTrace).toHaveBeenCalled();
      expect(max).toBeLessThanOrEqual(2);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  // ─── 8. Non-goal events are re-enqueued, not dropped ───

  it('non-goal events remain pending because the supervisor only claims goal activations', async () => {
    const { supervisor, journalQueue, runtimeRoot } = makeSupervisor();
    try {
      await supervisor.start([]);

      journalQueue.accept(createEnvelope({
        type: 'event',
        name: 'schedule_report_ready',
        source: 'test',
        goal_id: undefined,
        payload: { taskId: 'task-1' },
        priority: 'normal',
      }));

      await new Promise((r) => setTimeout(r, 60));
      await supervisor.shutdown();

      const snapshot = journalQueue.snapshot();
      expect(snapshot.pending.normal).toHaveLength(1);
      expect(snapshot.pending.normal[0]).toBeDefined();
      expect(journalQueue.get(snapshot.pending.normal[0]!)?.envelope.name).toBe('schedule_report_ready');
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('non-goal events do not consume idle worker slots', async () => {
    let goalRunCount = 0;
    const { supervisor, journalQueue, runtimeRoot } = makeSupervisor((async (goalId: string) => {
      goalRunCount++;
      return makeLoopResult({ goalId });
    }) as unknown as () => Promise<LoopResult>);
    try {
      await supervisor.start([]);

      journalQueue.accept(createEnvelope({
        type: 'event',
        name: 'schedule_activated',
        source: 'test',
        goal_id: undefined,
        payload: {},
        priority: 'normal',
      }));
      journalQueue.accept(createEnvelope({
        type: 'event',
        name: 'goal_activated',
        source: 'test',
        goal_id: 'g-mix',
        payload: {},
        priority: 'normal',
      }));

      await waitFor(() => {
        const snapshot = journalQueue.snapshot();
        return (
          goalRunCount >= 1 &&
          snapshot.pending.normal
            .map((messageId) => journalQueue.get(messageId)?.envelope.name)
            .includes("schedule_activated")
        );
      });
      await supervisor.shutdown();

      expect(goalRunCount).toBeGreaterThanOrEqual(1);
      const snapshot = journalQueue.snapshot();
      expect(
        snapshot.pending.normal.map((messageId) => journalQueue.get(messageId)?.envelope.name)
      ).toContain('schedule_activated');
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("claims durable goal activations and completes the queue record", async () => {
    const { supervisor, journalQueue, goalLeaseManager, mockCoreLoop, runtimeRoot } = makeSupervisor(async (goalId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return makeLoopResult({ goalId });
    });

    try {
      await supervisor.start(["g-durable"]);
      await waitFor(() => {
        const snapshot = journalQueue.snapshot();
        return (
          mockCoreLoop.run.mock.calls.some((call: unknown[]) => call[0] === "g-durable") &&
          snapshot.completed.length >= 1 &&
          journalQueue.inflightSize() === 0
        );
      });
      await supervisor.shutdown();

      expect(mockCoreLoop.run).toHaveBeenCalledWith("g-durable", expect.anything());
      expect(journalQueue.snapshot().completed.length).toBeGreaterThanOrEqual(1);
      expect(journalQueue.inflightSize()).toBe(0);
      expect(await goalLeaseManager.read("g-durable")).toBeNull();
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("links DurableLoop background runs to the worker session and marks terminal", async () => {
    const runId = "run:coreloop:bg";
    const { supervisor, deps, runtimeRoot } = makeSupervisor(async (goalId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return makeLoopResult({ goalId, totalIterations: 2 });
    });
    const ledger = new BackgroundRunLedger(runtimeRoot);
    await ledger.ensureReady();
    await ledger.create({
      id: runId,
      kind: "coreloop_run",
      parent_session_id: "session:conversation:chat-bg",
      notify_policy: "silent",
      reply_target_source: "none",
      title: "Background DurableLoop",
      workspace: "/repo",
    });
    (deps as { backgroundRunLedger?: BackgroundRunLedger }).backgroundRunLedger = ledger;

    try {
      await supervisor.start([]);
      supervisor.activateGoal("g-bg", {
        backgroundRun: {
          backgroundRunId: runId,
          parentSessionId: "session:conversation:chat-bg",
        },
      });

      await waitFor(() => supervisor.getState().workers.some((worker) =>
        worker.goalId === "g-bg" &&
        worker.backgroundRunId === runId &&
        worker.parentSessionId === "session:conversation:chat-bg" &&
        worker.sessionId?.startsWith("session:coreloop:")
      ));

      const terminal = await pollForBackgroundRunMatch(ledger, runId, (value) =>
        value.status === "succeeded" &&
        typeof value.child_session_id === "string" &&
        value.child_session_id.startsWith("session:coreloop:")
      );
      await supervisor.shutdown();

      expect(terminal).toMatchObject({
        id: runId,
        parent_session_id: "session:conversation:chat-bg",
        status: "succeeded",
        summary: "DurableLoop completed after 2 iteration(s).",
      });
      expect(terminal.source_refs).toContainEqual(expect.objectContaining({
        kind: "supervisor_state",
        relative_path: "control-db:supervisor_state_snapshots/current",
      }));
    } finally {
      await supervisor.shutdown();
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("marks deadline finalization background runs as successful handoff terminals", async () => {
    const runId = "run:coreloop:bg-finalization";
    const { supervisor, deps, runtimeRoot } = makeSupervisor(async (goalId: string) =>
      makeLoopResult({ goalId, totalIterations: 1, finalStatus: "finalization" })
    );
    const ledger = new BackgroundRunLedger(runtimeRoot);
    await ledger.ensureReady();
    await ledger.create({
      id: runId,
      kind: "coreloop_run",
      parent_session_id: "session:conversation:chat-bg",
      notify_policy: "silent",
      reply_target_source: "none",
      title: "Deadline handoff CoreLoop",
    });
    (deps as { backgroundRunLedger?: BackgroundRunLedger }).backgroundRunLedger = ledger;

    try {
      await supervisor.start([]);
      supervisor.activateGoal("g-finalization", {
        backgroundRun: {
          backgroundRunId: runId,
          parentSessionId: "session:conversation:chat-bg",
        },
      });

      const terminal = await pollForBackgroundRunMatch(ledger, runId, (value) =>
        value.status === "succeeded" &&
        value.summary === "DurableLoop finalization after 1 iteration(s)."
      );
      await supervisor.shutdown();

      expect(terminal.error).toBeNull();
    } finally {
      await supervisor.shutdown();
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("settles coalesced DurableLoop background runs instead of leaving them queued", async () => {
    const initialRunId = "run:coreloop:bg-initial";
    const coalescedRunId = "run:coreloop:bg-coalesced";
    const { supervisor, deps, runtimeRoot } = makeSupervisor(async (goalId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 160));
      return makeLoopResult({ goalId, totalIterations: 2 });
    });
    const ledger = new BackgroundRunLedger(runtimeRoot);
    await ledger.ensureReady();
    for (const runId of [initialRunId, coalescedRunId]) {
      await ledger.create({
        id: runId,
        kind: "coreloop_run",
        parent_session_id: "session:conversation:chat-bg",
        notify_policy: "silent",
        reply_target_source: "none",
        title: runId,
      });
    }
    (deps as { backgroundRunLedger?: BackgroundRunLedger }).backgroundRunLedger = ledger;

    try {
      await supervisor.start([]);
      supervisor.activateGoal("g-bg", {
        backgroundRun: {
          backgroundRunId: initialRunId,
          parentSessionId: "session:conversation:chat-bg",
        },
      });
      await waitFor(() => supervisor.getState().workers.some((worker) =>
        worker.goalId === "g-bg" && worker.backgroundRunId === initialRunId
      ));

      supervisor.activateGoal("g-bg", {
        backgroundRun: {
          backgroundRunId: coalescedRunId,
          parentSessionId: "session:conversation:chat-bg",
        },
      });

      const settled = await pollForBackgroundRunMatch(ledger, coalescedRunId, (value) =>
        value.status === "cancelled" &&
        typeof value.child_session_id === "string" &&
        value.child_session_id.startsWith("session:coreloop:")
      );
      await supervisor.shutdown();

      expect(settled).toMatchObject({
        id: coalescedRunId,
        parent_session_id: "session:conversation:chat-bg",
        status: "cancelled",
      });
      expect(settled.summary).toContain("coalesced into active worker");
    } finally {
      await supervisor.shutdown();
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("coalesces duplicate durable goal activations via requestExtend", async () => {
    let runCount = 0;
    const { supervisor, journalQueue, mockCoreLoop, runtimeRoot } = makeSupervisor(async (goalId: string) => {
      runCount += 1;
      if (runCount === 1) {
        journalQueue.accept(createEnvelope({
          type: "event",
          name: "goal_activated",
          source: "test",
          goal_id: "g-durable",
          payload: {},
          priority: "normal",
        }));
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      return makeLoopResult({ goalId });
    });

    try {
      await supervisor.start(["g-durable"]);
      await waitFor(() => {
        const snapshot = journalQueue.snapshot();
        return mockCoreLoop.run.mock.calls.length >= 2 && snapshot.completed.length >= 2;
      }, 5_000);
      await supervisor.shutdown();

      expect(mockCoreLoop.run).toHaveBeenCalledTimes(2);
      expect(journalQueue.snapshot().completed.length).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("applies crash backoff before retrying durable activations", async () => {
    let runCount = 0;
    const { supervisor, journalQueue, runtimeRoot } = makeSupervisor(
      async () => {
        runCount += 1;
        if (runCount === 1) {
          throw new Error("boom");
        }
        return makeLoopResult({ goalId: "g-backoff" });
      },
      {},
      { crashBackoffBaseMs: 1_000 }
    );

    try {
      await supervisor.start(["g-backoff"]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(runCount).toBe(1);
      const snapshotDuringBackoff = journalQueue.snapshot();
      expect(
        snapshotDuringBackoff.pending.normal.length + Object.keys(snapshotDuringBackoff.inflight).length
      ).toBe(1);

      await waitFor(() => runCount >= 2, 3_000);
      await supervisor.shutdown();

      expect(runCount).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("does not append a duplicate durable activation when startup finds a recovered pending goal", async () => {
    const { supervisor, journalQueue, runtimeRoot } = makeSupervisor();
    journalQueue.accept(createEnvelope({
      type: "event",
      name: "goal_activated",
      source: "recovered",
      goal_id: "g-dedupe",
      payload: {},
      priority: "normal",
      dedupe_key: "goal_activated:g-dedupe",
    }));

    try {
      await supervisor.start(["g-dedupe"]);
      await waitFor(() => {
        const snapshot = journalQueue.snapshot();
        return (
          snapshot.completed.length === 1 &&
          snapshot.pending.normal.length === 0 &&
          Object.keys(snapshot.inflight).length === 0
        );
      });
      await supervisor.shutdown();

      const snapshot = journalQueue.snapshot();
      expect(snapshot.completed).toHaveLength(1);
      expect(snapshot.pending.normal).toHaveLength(0);
      expect(snapshot.inflight).toEqual({});
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("blocks state commits when durable execution ownership becomes stale", async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sv-fence-"));
    const stateDir = path.join(runtimeRoot, "state");
    const stateManager = new StateManager(stateDir);
    await stateManager.init();
    await stateManager.saveGoal(makeGoal({ id: "g-fenced", title: "before" }));

    const journalQueue = new JournalBackedQueue({
      journalPath: path.join(runtimeRoot, "queue.json"),
    });
    const goalLeaseManager = new GoalLeaseManager(runtimeRoot, 40);
    const mockCoreLoop = {
      run: vi.fn().mockImplementation(async (goalId: string) => {
        const goal = await stateManager.loadGoal(goalId);
        await new Promise((resolve) => setTimeout(resolve, 80));
        await stateManager.saveGoal({ ...goal!, title: "after" });
        return makeLoopResult({ goalId });
      }),
      stop: vi.fn(),
    };

    const supervisor = new LoopSupervisor(
      {
        coreLoopFactory: () => mockCoreLoop as any,
        journalQueue,
        goalLeaseManager,
        driveSystem: { shouldActivate: vi.fn(), prioritizeGoals: vi.fn(), startWatcher: vi.fn(), stopWatcher: vi.fn(), writeEvent: vi.fn() } as any,
        stateManager,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      },
      {
        concurrency: 1,
        pollIntervalMs: 10,
        maxCrashCount: 1,
        crashBackoffBaseMs: 9999,
        runtimeRoot,
        claimLeaseMs: 40,
        leaseRenewIntervalMs: 50,
      }
    );

    try {
      await supervisor.start(["g-fenced"]);
      await new Promise((resolve) => setTimeout(resolve, 220));
      await supervisor.shutdown();

      const goal = await stateManager.loadGoal("g-fenced");
      expect(goal?.title).toBe("before");
      expect(journalQueue.inflightSize()).toBe(1);
      expect(mockCoreLoop.run).toHaveBeenCalled();
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it("allows a second supervisor to take over after claim and lease expiry", async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sv-takeover-"));
    const stateDir = path.join(runtimeRoot, "state");
    const stateManagerA = new StateManager(stateDir);
    const stateManagerB = new StateManager(stateDir);
    await stateManagerA.init();
    await stateManagerB.init();
    await stateManagerA.saveGoal(makeGoal({ id: "g-restart", title: "seed" }));

    const journalQueue = new JournalBackedQueue({
      journalPath: path.join(runtimeRoot, "queue.json"),
    });
    const goalLeaseManager = new GoalLeaseManager(runtimeRoot, 40);

    const coreLoopA = {
      run: vi.fn().mockImplementation(async (goalId: string) => {
        const goal = await stateManagerA.loadGoal(goalId);
        await new Promise((resolve) => setTimeout(resolve, 120));
        await stateManagerA.saveGoal({ ...goal!, title: "first-owner" });
        return makeLoopResult({ goalId });
      }),
      stop: vi.fn(),
    };
    const coreLoopB = {
      run: vi.fn().mockImplementation(async (goalId: string) => {
        const goal = await stateManagerB.loadGoal(goalId);
        await new Promise((resolve) => setTimeout(resolve, 10));
        await stateManagerB.saveGoal({ ...goal!, title: "second-owner" });
        return makeLoopResult({ goalId });
      }),
      stop: vi.fn(),
    };

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
    const supervisorA = new LoopSupervisor(
      {
        coreLoopFactory: () => coreLoopA as any,
        journalQueue,
        goalLeaseManager,
        driveSystem: { shouldActivate: vi.fn(), prioritizeGoals: vi.fn(), startWatcher: vi.fn(), stopWatcher: vi.fn(), writeEvent: vi.fn() } as any,
        stateManager: stateManagerA,
        logger,
      },
      {
        concurrency: 1,
        pollIntervalMs: 10,
        maxCrashCount: 3,
        crashBackoffBaseMs: 9999,
        runtimeRoot,
        claimLeaseMs: 40,
        leaseRenewIntervalMs: 1000,
      }
    );
    const supervisorB = new LoopSupervisor(
      {
        coreLoopFactory: () => coreLoopB as any,
        journalQueue,
        goalLeaseManager,
        driveSystem: { shouldActivate: vi.fn(), prioritizeGoals: vi.fn(), startWatcher: vi.fn(), stopWatcher: vi.fn(), writeEvent: vi.fn() } as any,
        stateManager: stateManagerB,
        logger,
      },
      {
        concurrency: 1,
        pollIntervalMs: 10,
        maxCrashCount: 3,
        crashBackoffBaseMs: 9999,
        runtimeRoot,
        claimLeaseMs: 200,
        leaseRenewIntervalMs: 50,
      }
    );

    try {
      await supervisorA.start(["g-restart"]);
      await waitFor(() => coreLoopA.run.mock.calls.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(journalQueue.sweepExpiredClaims().reclaimed).toBe(1);

      await supervisorB.start([]);
      await new Promise((resolve) => setTimeout(resolve, 260));

      await supervisorA.shutdown();
      await supervisorB.shutdown();

      const finalGoal = await stateManagerA.loadGoal("g-restart");
      expect(finalGoal?.title).toBe("second-owner");
      expect(coreLoopA.run).toHaveBeenCalledTimes(1);
      expect(coreLoopB.run).toHaveBeenCalledTimes(1);
      expect(journalQueue.snapshot().completed).toHaveLength(1);
      expect(journalQueue.inflightSize()).toBe(0);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });
});
