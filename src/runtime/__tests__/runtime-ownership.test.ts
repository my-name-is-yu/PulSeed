import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { RuntimeOwnershipCoordinator } from "../daemon/runtime-ownership.js";
import { ApprovalStore } from "../store/approval-store.js";
import { RuntimeHealthStore } from "../store/health-store.js";
import { SupervisorStateStore } from "../store/index.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";

describe("RuntimeOwnershipCoordinator", () => {
  let tmpDir: string;
  let store: RuntimeHealthStore;

  beforeEach(async () => {
    tmpDir = makeTempDir("runtime-ownership-");
    store = new RuntimeHealthStore(tmpDir);
    await store.ensureReady();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  async function writeSupervisorState(goalIds: string[], updatedAt = Date.now()): Promise<void> {
    await new SupervisorStateStore(tmpDir, { controlBaseDir: tmpDir }).save({
      workers: goalIds.map((goalId, index) => ({
        workerId: `worker-${index + 1}`,
        goalId,
        startedAt: updatedAt - 1_000,
        iterations: 1,
      })),
      crashCounts: {},
      suspendedGoals: [],
      updatedAt,
    });
  }

  async function writeLatestTaskLedger(
    goalId: string,
    taskId: string,
    summary: Record<string, unknown>
  ): Promise<void> {
    await fsp.mkdir(path.join(tmpDir, "tasks", goalId, "ledger"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "tasks", goalId, "ledger", `${taskId}.json`),
      JSON.stringify({
        task_id: taskId,
        goal_id: goalId,
        events: [],
        summary: {
          task_id: taskId,
          goal_id: goalId,
          ...summary,
        },
      })
    );
  }

  it("preserves an observed command failure across heartbeats until a fresh recovery signal arrives", async () => {
    const coordinator = new RuntimeOwnershipCoordinator({
      baseDir: tmpDir,
      runtimeRoot: tmpDir,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
      approvalStore: null,
      outboxStore: null,
      runtimeHealthStore: store,
      leaderLockManager: null,
      onLeadershipLost: vi.fn(),
    });

    await coordinator.saveRuntimeHealthSnapshot("execution_ownership_durable", {
      gateway: "ok",
      queue: "ok",
      leases: "ok",
      approval: "ok",
      outbox: "ok",
      supervisor: "ok",
    });
    await coordinator.observeCommandAcceptance("failed", "dispatcher failed");
    await (coordinator as unknown as { writeRuntimeHeartbeat: () => Promise<void> }).writeRuntimeHeartbeat();

    const health = await store.loadDaemonHealth();
    expect(health?.kpi?.command_acceptance.status).toBe("failed");
    expect(health?.kpi?.command_acceptance.reason).toBe("dispatcher failed");
  });

  it("produces long-running health from daemon runtime evidence", async () => {
    await fsp.mkdir(path.join(tmpDir, "logs"), { recursive: true });
    await fsp.writeFile(path.join(tmpDir, "logs", "coreloop.log"), "iteration completed\n");
    await fsp.mkdir(path.join(tmpDir, "artifacts", "run-a"), { recursive: true });
    await fsp.writeFile(
      path.join(tmpDir, "artifacts", "run-a", "result.json"),
      JSON.stringify({
        schema_version: "long-running-result-v1",
        objective: "improve benchmark",
        status: "running",
        evidence: [{ kind: "metric", label: "score", value: 0.71 }],
        artifacts: [],
        failures: [],
        next_action: { type: "continue", summary: "continue" },
        source: { kind: "test" },
        created_at: new Date().toISOString(),
      })
    );
    await fsp.writeFile(path.join(tmpDir, "artifacts", "run-a", "summary.md"), "# summary\n");
    await fsp.writeFile(
      path.join(tmpDir, "artifacts", "run-a", "next-action.json"),
      JSON.stringify({ schema_version: "long-running-next-action-v1" })
    );
    await writeSupervisorState(["goal-1"]);
    const coordinator = new RuntimeOwnershipCoordinator({
      baseDir: tmpDir,
      runtimeRoot: tmpDir,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
      approvalStore: null,
      outboxStore: null,
      runtimeHealthStore: store,
      leaderLockManager: null,
      onLeadershipLost: vi.fn(),
    });

    await coordinator.saveRuntimeHealthSnapshot("daemon_health_snapshot", {
      gateway: "ok",
      queue: "ok",
      leases: "ok",
      approval: "ok",
      outbox: "ok",
      supervisor: "ok",
    });

    const snapshot = await store.loadSnapshot();
    expect(snapshot?.long_running?.summary).toBe("alive_and_progressing");
    expect(snapshot?.long_running?.signals.child_activity).toMatchObject({
      status: "active",
      active_count: 1,
    });
    expect(snapshot?.long_running?.signals.metric_progress).toMatchObject({
      status: "unknown",
      metric_name: "score",
      current_value: 0.71,
    });
    expect(snapshot?.long_running?.signals.artifact_freshness.path).toBeDefined();
  });

  it("treats lower values as improvement for minimize metrics", async () => {
    await fsp.mkdir(path.join(tmpDir, "artifacts", "run-a"), { recursive: true });
    const coordinator = new RuntimeOwnershipCoordinator({
      baseDir: tmpDir,
      runtimeRoot: tmpDir,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
      approvalStore: null,
      outboxStore: null,
      runtimeHealthStore: store,
      leaderLockManager: null,
      onLeadershipLost: vi.fn(),
    });
    const writeLoss = async (value: number) => {
      await fsp.writeFile(
        path.join(tmpDir, "artifacts", "run-a", "result.json"),
        JSON.stringify({
          schema_version: "long-running-result-v1",
          objective: "reduce validation loss",
          status: "running",
          evidence: [{ kind: "metric", label: "rmse", value, direction: "minimize", summary: "direction=maximize" }],
          artifacts: [],
          failures: [],
          next_action: { type: "continue", summary: "continue" },
          source: { kind: "test" },
          created_at: new Date().toISOString(),
        })
      );
    };
    const save = () => coordinator.saveRuntimeHealthSnapshot("daemon_health_snapshot", {
      gateway: "ok",
      queue: "ok",
      leases: "ok",
      approval: "ok",
      outbox: "ok",
      supervisor: "ok",
    });

    await writeLoss(0.5);
    await save();
    await writeLoss(0.4);
    await save();

    const snapshot = await store.loadSnapshot();
    expect(snapshot?.long_running?.signals.metric_progress).toMatchObject({
      status: "improved",
      metric_name: "rmse",
      direction: "minimize",
      previous_value: 0.5,
      current_value: 0.4,
    });
  });

  it("does not infer metric direction from summary text when typed direction is missing", async () => {
    await fsp.mkdir(path.join(tmpDir, "artifacts", "run-a"), { recursive: true });
    const coordinator = new RuntimeOwnershipCoordinator({
      baseDir: tmpDir,
      runtimeRoot: tmpDir,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
      approvalStore: null,
      outboxStore: null,
      runtimeHealthStore: store,
      leaderLockManager: null,
      onLeadershipLost: vi.fn(),
    });
    const writeLoss = async (value: number) => {
      await fsp.writeFile(
        path.join(tmpDir, "artifacts", "run-a", "result.json"),
        JSON.stringify({
          schema_version: "long-running-result-v1",
          objective: "reduce validation loss",
          status: "running",
          evidence: [{ kind: "metric", label: "rmse", value, summary: "direction=minimize" }],
          artifacts: [],
          failures: [],
          next_action: { type: "continue", summary: "continue" },
          source: { kind: "test" },
          created_at: new Date().toISOString(),
        })
      );
    };
    const save = () => coordinator.saveRuntimeHealthSnapshot("daemon_health_snapshot", {
      gateway: "ok",
      queue: "ok",
      leases: "ok",
      approval: "ok",
      outbox: "ok",
      supervisor: "ok",
    });

    await writeLoss(0.5);
    await save();
    await writeLoss(0.4);
    await save();

    const snapshot = await store.loadSnapshot();
    expect(snapshot?.long_running?.signals.metric_progress).toMatchObject({
      status: "unknown",
      metric_name: "rmse",
      previous_value: 0.5,
      current_value: 0.4,
    });
    expect(snapshot?.long_running?.signals.metric_progress).not.toHaveProperty("direction");
  });

  it("produces approval-wait long-running health from pending approvals", async () => {
    const approvalStore = new ApprovalStore(tmpDir);
    await approvalStore.ensureReady();
    await approvalStore.savePending({
      approval_id: "approval-1",
      request_envelope_id: "message-1",
      correlation_id: "correlation-1",
      state: "pending",
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
      payload: { reason: "operator approval required" },
    });
    const coordinator = new RuntimeOwnershipCoordinator({
      baseDir: tmpDir,
      runtimeRoot: tmpDir,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
      approvalStore,
      outboxStore: null,
      runtimeHealthStore: store,
      leaderLockManager: null,
      onLeadershipLost: vi.fn(),
    });

    await coordinator.saveRuntimeHealthSnapshot("daemon_health_snapshot", {
      gateway: "ok",
      queue: "ok",
      leases: "ok",
      approval: "ok",
      outbox: "ok",
      supervisor: "ok",
    });

    const snapshot = await store.loadSnapshot();
    expect(snapshot?.long_running?.summary).toBe("alive_but_waiting");
    expect(snapshot?.long_running?.signals.blocker).toMatchObject({
      status: "approval_wait",
      reason: "1 pending approval",
    });
  });

  it("produces approval-wait long-running health from active-goal pending approvals", async () => {
    await writeSupervisorState(["goal-active"]);
    const approvalStore = new ApprovalStore(tmpDir);
    await approvalStore.ensureReady();
    await approvalStore.savePending({
      approval_id: "approval-active-goal",
      goal_id: "goal-active",
      request_envelope_id: "message-1",
      correlation_id: "correlation-1",
      state: "pending",
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
      origin: {
        channel: "telegram",
        conversation_id: "conversation-active",
        user_id: "user-1",
        session_id: "session-active",
      },
      payload: { reason: "active goal approval required" },
    });
    const coordinator = new RuntimeOwnershipCoordinator({
      baseDir: tmpDir,
      runtimeRoot: tmpDir,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
      approvalStore,
      outboxStore: null,
      runtimeHealthStore: store,
      leaderLockManager: null,
      onLeadershipLost: vi.fn(),
    });

    await coordinator.saveRuntimeHealthSnapshot("daemon_health_snapshot", {
      gateway: "ok",
      queue: "ok",
      leases: "ok",
      approval: "ok",
      outbox: "ok",
      supervisor: "ok",
    });

    const snapshot = await store.loadSnapshot();
    expect(snapshot?.long_running?.summary).toBe("alive_but_waiting");
    expect(snapshot?.long_running?.signals.blocker).toMatchObject({
      status: "approval_wait",
      reason: "1 active-goal pending approval",
      active_goal_ids: ["goal-active"],
      pending_approval_count: 1,
      goal_scoped_pending_approval_count: 1,
      unrelated_pending_approval_count: 0,
    });
  });

  it("keeps unrelated chat approvals from masking an active goal task blocker", async () => {
    const now = Date.now();
    await writeSupervisorState(["goal-active"], now);
    await writeLatestTaskLedger("goal-active", "task-policy-blocked", {
      latest_event_type: "failed",
      latest_event_at: new Date(now - 1_000).toISOString(),
      task_status: "blocked",
      stopped_reason: "policy_blocked",
      latencies: {},
    });
    const approvalStore = new ApprovalStore(tmpDir);
    await approvalStore.ensureReady();
    await approvalStore.savePending({
      approval_id: "approval-chat-side-channel",
      goal_id: "goal-chat-side-channel",
      request_envelope_id: "message-chat",
      correlation_id: "correlation-chat",
      state: "pending",
      created_at: now,
      expires_at: now + 60_000,
      origin: {
        channel: "telegram",
        conversation_id: "conversation-chat",
        user_id: "user-chat",
        session_id: "session-chat",
      },
      payload: { reason: "chat-side approval required" },
    });
    const coordinator = new RuntimeOwnershipCoordinator({
      baseDir: tmpDir,
      runtimeRoot: tmpDir,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
      approvalStore,
      outboxStore: null,
      runtimeHealthStore: store,
      leaderLockManager: null,
      onLeadershipLost: vi.fn(),
    });

    await coordinator.saveRuntimeHealthSnapshot("daemon_health_snapshot", {
      gateway: "ok",
      queue: "ok",
      leases: "ok",
      approval: "ok",
      outbox: "ok",
      supervisor: "ok",
    });

    const blocker = (await store.loadSnapshot())?.long_running?.signals.blocker;
    expect(blocker).toMatchObject({
      status: "blocked",
      active_goal_ids: ["goal-active"],
      pending_approval_count: 1,
      goal_scoped_pending_approval_count: 0,
      unrelated_pending_approval_count: 1,
    });
    expect(blocker?.reason).toContain("policy-blocked");
    expect(blocker?.status).not.toBe("approval_wait");
  });
});
