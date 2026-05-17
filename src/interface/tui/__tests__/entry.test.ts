import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PIDManager, type PIDRuntimeStatus } from "../../../runtime/pid-manager.js";
import * as daemonClient from "../../../runtime/daemon/client.js";
import { DEFAULT_PORT } from "../../../runtime/port-utils.js";
import { attachDoubleCtrlCExit, resolveRunningDaemonConnection } from "../entry.js";

function runningPidStatus(): PIDRuntimeStatus {
  return {
    info: {
      pid: 12345,
      started_at: new Date().toISOString(),
      runtime_started_at: new Date().toISOString(),
      owner_pid: 12345,
      owner_started_at: new Date().toISOString(),
      runtime_pid: 12345,
    },
    running: true,
    runtimePid: 12345,
    ownerPid: 12345,
    alivePids: [12345],
    stalePids: [],
    verifiedPids: [12345],
    unverifiedLegacyPids: [],
  };
}

describe("attachDoubleCtrlCExit", () => {
  it("fires exit on two Ctrl-C bytes even when they arrive in one chunk", () => {
    const input = new EventEmitter();
    const onExit = vi.fn();
    const detach = attachDoubleCtrlCExit(input as Parameters<typeof attachDoubleCtrlCExit>[0], onExit);

    input.emit("data", Buffer.from([0x03, 0x03]));

    expect(onExit).toHaveBeenCalledOnce();
    detach();
  });

  it("resets the first Ctrl-C when unrelated input arrives", () => {
    vi.useFakeTimers();
    const input = new EventEmitter();
    const onExit = vi.fn();
    const detach = attachDoubleCtrlCExit(input as Parameters<typeof attachDoubleCtrlCExit>[0], onExit, 50);
    try {
      input.emit("data", Buffer.from([0x03]));
      input.emit("data", Buffer.from("\u001b[?2026l"));
      input.emit("data", Buffer.from([0x03]));

      expect(onExit).not.toHaveBeenCalled();
      input.emit("data", Buffer.from([0x03]));
      expect(onExit).toHaveBeenCalledOnce();
    } finally {
      detach();
      vi.useRealTimers();
    }
  });
});

describe("resolveRunningDaemonConnection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-tui-entry-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("attaches to a live daemon process once health responds", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "daemon.json"),
      JSON.stringify({ event_server_port: 41888 }),
      "utf-8"
    );

    vi.spyOn(PIDManager.prototype, "inspect").mockResolvedValue(runningPidStatus());
    const probeSpy = vi.spyOn(daemonClient, "probeDaemonHealth").mockResolvedValue({
      ok: true,
      port: 41888,
      latency_ms: 1,
      health: {
        ok: true,
        accepting_commands: true,
        task_execution_ok: true,
        runtime_kpi: null,
      },
    });
    const runningSpy = vi.spyOn(daemonClient, "isDaemonRunning");

    await expect(resolveRunningDaemonConnection(tmpDir)).resolves.toEqual({
      port: 41888,
      authToken: null,
    });
    expect(probeSpy).toHaveBeenCalledWith({ host: "127.0.0.1", port: 41888 });
    expect(runningSpy).not.toHaveBeenCalled();
  });

  it("falls back to the default port for unsafe persisted daemon ports", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "daemon.json"),
      JSON.stringify({ event_server_port: Number.MAX_SAFE_INTEGER + 1 }),
      "utf-8"
    );

    vi.spyOn(PIDManager.prototype, "inspect").mockResolvedValue(runningPidStatus());
    const probeSpy = vi.spyOn(daemonClient, "probeDaemonHealth").mockResolvedValue({
      ok: true,
      port: DEFAULT_PORT,
      latency_ms: 1,
      health: {
        ok: true,
        accepting_commands: true,
        task_execution_ok: true,
        runtime_kpi: null,
      },
    });
    const runningSpy = vi.spyOn(daemonClient, "isDaemonRunning");

    await expect(resolveRunningDaemonConnection(tmpDir)).resolves.toEqual({
      port: DEFAULT_PORT,
      authToken: null,
    });
    expect(probeSpy).toHaveBeenCalledWith({ host: "127.0.0.1", port: DEFAULT_PORT });
    expect(runningSpy).not.toHaveBeenCalled();
  });

  it("falls back to the default port for oversized daemon config", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "daemon.json"),
      JSON.stringify({ event_server_port: 41888, padding: "x".repeat(1024 * 1024) }),
      "utf-8"
    );

    vi.spyOn(PIDManager.prototype, "inspect").mockResolvedValue(runningPidStatus());
    const probeSpy = vi.spyOn(daemonClient, "probeDaemonHealth").mockResolvedValue({
      ok: true,
      port: DEFAULT_PORT,
      latency_ms: 1,
      health: {
        ok: true,
        accepting_commands: true,
        task_execution_ok: true,
        runtime_kpi: null,
      },
    });
    const runningSpy = vi.spyOn(daemonClient, "isDaemonRunning");

    await expect(resolveRunningDaemonConnection(tmpDir)).resolves.toEqual({
      port: DEFAULT_PORT,
      authToken: null,
    });
    expect(probeSpy).toHaveBeenCalledWith({ host: "127.0.0.1", port: DEFAULT_PORT });
    expect(runningSpy).not.toHaveBeenCalled();
  });

  it("falls back when the pid is live but daemon health never comes up", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "daemon.json"),
      JSON.stringify({ event_server_port: 41888 }),
      "utf-8"
    );

    vi.spyOn(PIDManager.prototype, "inspect")
      .mockResolvedValueOnce(runningPidStatus())
      .mockResolvedValueOnce({
        info: {
          pid: 12345,
          started_at: new Date().toISOString(),
          runtime_started_at: new Date().toISOString(),
          owner_pid: 12345,
          owner_started_at: new Date().toISOString(),
          runtime_pid: 12345,
        },
        running: false,
        runtimePid: null,
        ownerPid: null,
        alivePids: [],
        stalePids: [12345],
        verifiedPids: [],
        unverifiedLegacyPids: [],
      });
    vi.spyOn(daemonClient, "probeDaemonHealth").mockResolvedValue({
      ok: false,
      port: 41888,
      latency_ms: 1,
      error: "connection refused",
    });
    const runningSpy = vi.spyOn(daemonClient, "isDaemonRunning").mockResolvedValue({
      running: false,
      port: 41888,
    });

    await expect(resolveRunningDaemonConnection(tmpDir)).resolves.toBeNull();
    expect(runningSpy).toHaveBeenCalledWith(tmpDir);
  });
});
