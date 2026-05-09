import { describe, expect, it, vi, beforeEach } from "vitest";
import { createDaemonRuntimeControlExecutor } from "../daemon-runtime-control-executor.js";
import { DaemonClient, isDaemonRunning } from "../../daemon/client.js";
import type { RuntimeControlOperation } from "../../store/index.js";

const { requestRuntimeControlMock, pauseGoalMock, resumeGoalMock, stopGoalMock } = vi.hoisted(() => ({
  requestRuntimeControlMock: vi.fn(),
  pauseGoalMock: vi.fn(),
  resumeGoalMock: vi.fn(),
  stopGoalMock: vi.fn(),
}));

vi.mock("../../daemon/client.js", () => ({
  DaemonClient: vi.fn().mockImplementation(function () {
    return {
      requestRuntimeControl: requestRuntimeControlMock,
      pauseGoal: pauseGoalMock,
      resumeGoal: resumeGoalMock,
      stopGoal: stopGoalMock,
    };
  }),
  isDaemonRunning: vi.fn(),
}));

function makeOperation(kind: RuntimeControlOperation["kind"] = "restart_daemon"): RuntimeControlOperation {
  return {
    operation_id: "op-1",
    kind,
    state: "acknowledged",
    requested_at: "2026-04-13T00:00:00.000Z",
    updated_at: "2026-04-13T00:00:00.000Z",
    requested_by: { surface: "cli" },
    reply_target: { surface: "cli" },
    reason: "PulSeed を再起動して",
    expected_health: {
      daemon_ping: true,
      gateway_acceptance: true,
    },
  };
}

describe("createDaemonRuntimeControlExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestRuntimeControlMock.mockResolvedValue({ ok: true });
    pauseGoalMock.mockResolvedValue({ ok: true });
    resumeGoalMock.mockResolvedValue({ ok: true });
    stopGoalMock.mockResolvedValue({ ok: true });
  });

  it("submits daemon restart requests through the daemon HTTP command surface", async () => {
    vi.mocked(isDaemonRunning).mockResolvedValue({
      running: true,
      port: 41700,
      authToken: "token-1",
    });

    const executor = createDaemonRuntimeControlExecutor({ baseDir: "/tmp/pulseed" });
    await expect(executor(makeOperation(), {
      intent: { kind: "restart_daemon", reason: "PulSeed を再起動して" },
      cwd: "/repo",
    })).resolves.toMatchObject({
      ok: true,
      state: "restarting",
      message: "PulSeed daemon restart request was sent. PulSeed will verify recovery through the watchdog.",
    });

    expect(DaemonClient).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 41700,
      authToken: "token-1",
      baseDir: "/tmp/pulseed",
    });
    expect(requestRuntimeControlMock).toHaveBeenCalledWith({
      operationId: "op-1",
      kind: "restart_daemon",
      reason: "PulSeed を再起動して",
    });
  });

  it("uses English public status text for gateway restart requests", async () => {
    vi.mocked(isDaemonRunning).mockResolvedValue({
      running: true,
      port: 41700,
      authToken: "token-1",
    });

    const executor = createDaemonRuntimeControlExecutor({ baseDir: "/tmp/pulseed" });
    await expect(executor(makeOperation("restart_gateway"), {
      intent: { kind: "restart_gateway", reason: "restart gateway" },
      cwd: "/repo",
    })).resolves.toMatchObject({
      ok: true,
      state: "restarting",
      message: "Gateway restart request was sent to the daemon. PulSeed will verify recovery after the daemon restarts.",
    });
  });

  it("fails without claiming restart when the daemon is not running", async () => {
    vi.mocked(isDaemonRunning).mockResolvedValue({
      running: false,
      port: 41700,
    });

    const executor = createDaemonRuntimeControlExecutor({ baseDir: "/tmp/pulseed" });
    await expect(executor(makeOperation(), {
      intent: { kind: "restart_daemon", reason: "PulSeed を再起動して" },
      cwd: "/repo",
    })).resolves.toMatchObject({
      ok: false,
      state: "failed",
      message: expect.stringContaining("not running"),
    });

    expect(requestRuntimeControlMock).not.toHaveBeenCalled();
  });

  it("does not route self-update through daemon restart", async () => {
    const executor = createDaemonRuntimeControlExecutor({ baseDir: "/tmp/pulseed" });
    await expect(executor(makeOperation("self_update"), {
      intent: { kind: "self_update", reason: "PulSeed 自身を更新して" },
      cwd: "/repo",
    })).resolves.toMatchObject({
      ok: false,
      state: "failed",
    });

    expect(isDaemonRunning).not.toHaveBeenCalled();
    expect(requestRuntimeControlMock).not.toHaveBeenCalled();
  });

  it("submits pause, resume, and cancel through typed daemon goal APIs", async () => {
    vi.mocked(isDaemonRunning).mockResolvedValue({
      running: true,
      port: 41700,
      authToken: "token-1",
    });

    const executor = createDaemonRuntimeControlExecutor({ baseDir: "/tmp/pulseed" });
    const pauseOperation = {
      ...makeOperation("pause_run"),
      target: { run_id: "run:coreloop:abc", goal_id: "goal-1" },
    };
    const resumeOperation = {
      ...makeOperation("resume_run"),
      target: { run_id: "run:coreloop:abc", goal_id: "goal-1" },
    };
    const cancelOperation = {
      ...makeOperation("cancel_run"),
      target: { run_id: "run:coreloop:abc", goal_id: "goal-1" },
    };

    await expect(executor(pauseOperation, {
      intent: { kind: "pause_run", reason: "pause run" },
      cwd: "/repo",
    })).resolves.toMatchObject({ ok: true, state: "running" });
    await expect(executor(resumeOperation, {
      intent: { kind: "resume_run", reason: "resume run" },
      cwd: "/repo",
    })).resolves.toMatchObject({ ok: true, state: "running" });
    await expect(executor(cancelOperation, {
      intent: { kind: "cancel_run", reason: "cancel run" },
      cwd: "/repo",
    })).resolves.toMatchObject({ ok: true, state: "running" });

    expect(pauseGoalMock).toHaveBeenCalledWith("goal-1");
    expect(resumeGoalMock).toHaveBeenCalledWith("goal-1");
    expect(stopGoalMock).toHaveBeenCalledWith("goal-1");
    expect(requestRuntimeControlMock).not.toHaveBeenCalled();
  });
});
