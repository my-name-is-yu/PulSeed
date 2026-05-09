import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DaemonClient,
  isDaemonRunning,
  probeDaemonHealth,
  readDaemonAuthToken,
} from "../daemon-client.js";
import { EventServer } from "../event-server.js";
import { DEFAULT_PORT } from "../port-utils.js";
import { OutboxStore } from "../store/outbox-store.js";
import { RuntimeOperatorHandoffStore } from "../store/operator-handoff-store.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";

function createMockDriveSystem() {
  return {
    writeEvent: async () => undefined,
  };
}

function waitForEvent(
  client: DaemonClient,
  eventName: string,
  timeoutMs = 2000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.off(eventName, onEvent);
      reject(new Error(`Timed out waiting for client event: ${eventName}`));
    }, timeoutMs);

    const onEvent = (data: unknown) => {
      clearTimeout(timeout);
      client.off(eventName, onEvent);
      resolve(data);
    };

    client.on(eventName, onEvent);
  });
}

describe("DaemonClient snapshot + replay", () => {
  let tmpDir: string;
  let server: EventServer;

  beforeEach(() => {
    tmpDir = makeTempDir();
    server = new EventServer(createMockDriveSystem() as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
      outboxStore: new OutboxStore(tmpDir),
    });
  });

  afterEach(async () => {
    if (server.isRunning()) {
      await server.stop();
    }
    cleanupTempDir(tmpDir);
  });

  it("replays events that were missed while disconnected", async () => {
    await server.start();

    const daemonStatePath = path.join(tmpDir, "daemon-state.json");
    fs.writeFileSync(daemonStatePath, JSON.stringify({ status: "running", pid: process.pid }), "utf-8");

    await server.broadcast("daemon_status", { status: "running", loopCount: 1 });

    const client = new DaemonClient({
      host: "127.0.0.1",
      port: server.getPort(),
      reconnectInterval: 50,
      maxReconnectAttempts: 2,
      authToken: server.getAuthToken(),
    });

    try {
      client.connect();
      await waitForEvent(client, "_connected");

      client.disconnect();

      const replayed = waitForEvent(client, "chat_message_received");
      await server.broadcast("chat_message_received", { goalId: "goal-1", message: "missed while offline" });

      client.connect();

      await expect(replayed).resolves.toEqual({
        goalId: "goal-1",
        message: "missed while offline",
      });
    } finally {
      client.disconnect();
    }
  });

  it("replays goal_updated and chat_response events through the SSE client", async () => {
    await server.start();

    const client = new DaemonClient({
      host: "127.0.0.1",
      port: server.getPort(),
      reconnectInterval: 50,
      maxReconnectAttempts: 2,
      authToken: server.getAuthToken(),
    });

    try {
      client.connect();
      await waitForEvent(client, "_connected");

      const goalUpdated = waitForEvent(client, "goal_updated");
      const chatResponse = waitForEvent(client, "chat_response");

      await server.broadcast("goal_updated", { goalId: "goal-1", status: "completed" });
      await server.broadcast("chat_response", { goalId: "goal-1", message: "queued", status: "queued" });

      await expect(goalUpdated).resolves.toEqual({ goalId: "goal-1", status: "completed" });
      await expect(chatResponse).resolves.toEqual({
        goalId: "goal-1",
        message: "queued",
        status: "queued",
      });
    } finally {
      client.disconnect();
    }
  });

  it("does not partially parse malformed SSE event ids into the replay cursor", () => {
    const client = new DaemonClient({
      host: "127.0.0.1",
      port: 41700,
    });

    (client as any).parseSSEMessage('id: 5abc\nevent: goal_updated\ndata: {"goalId":"goal-1"}');

    expect((client as any).lastEventId).toBe("5abc");
    expect((client as any).lastOutboxSeq).toBe(0);

    (client as any).parseSSEMessage('id: 6\nevent: goal_updated\ndata: {"goalId":"goal-1"}');

    expect((client as any).lastOutboxSeq).toBe(6);
  });

  it("emits operator handoffs from snapshot bootstrap", async () => {
    const runtimeRoot = path.join(tmpDir, "runtime");
    await new RuntimeOperatorHandoffStore(runtimeRoot).create({
      handoff_id: "handoff-snapshot",
      goal_id: "goal-1",
      triggers: ["deadline"],
      title: "Deadline handoff",
      summary: "Deadline finalization requires review.",
      current_status: "mode=finalization",
      recommended_action: "Review final artifact.",
      next_action: {
        label: "Review final artifact",
        approval_required: true,
      },
    });
    server = new EventServer(createMockDriveSystem() as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
      runtimeRoot,
      outboxStore: new OutboxStore(tmpDir),
    });
    await server.start();

    const client = new DaemonClient({
      host: "127.0.0.1",
      port: server.getPort(),
      reconnectInterval: 50,
      maxReconnectAttempts: 2,
      authToken: server.getAuthToken(),
    });

    try {
      const handoff = waitForEvent(client, "operator_handoff_required");
      client.connect();
      await expect(handoff).resolves.toEqual(expect.objectContaining({
        handoff_id: "handoff-snapshot",
        goal_id: "goal-1",
      }));
    } finally {
      client.disconnect();
    }
  });

  it("sends runtime control requests as daemon command envelopes", async () => {
    const envelopes: unknown[] = [];
    server.setCommandEnvelopeHook((envelope) => {
      envelopes.push(envelope);
    });
    await server.start();

    const client = new DaemonClient({
      host: "127.0.0.1",
      port: server.getPort(),
      authToken: server.getAuthToken(),
    });

    await expect(client.requestRuntimeControl({
      operationId: "op-restart-1",
      kind: "restart_daemon",
      reason: "PulSeed を再起動して",
    })).resolves.toEqual(expect.objectContaining({ ok: true }));

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      type: "command",
      name: "runtime_control",
      source: "http",
      priority: "critical",
      dedupe_key: "runtime_control:op-restart-1",
      payload: {
        operationId: "op-restart-1",
        kind: "restart_daemon",
        reason: "PulSeed を再起動して",
      },
    });
  });

  it("sends goal start background run metadata as a daemon command envelope", async () => {
    const envelopes: unknown[] = [];
    server.setCommandEnvelopeHook((envelope) => {
      envelopes.push(envelope);
    });
    await server.start();

    const client = new DaemonClient({
      host: "127.0.0.1",
      port: server.getPort(),
      authToken: server.getAuthToken(),
    });

    await expect(client.startGoal("goal-bg", {
      backgroundRun: {
        backgroundRunId: "run:coreloop:goal-bg",
        parentSessionId: "session:conversation:chat-bg",
        notifyPolicy: "done_only",
        replyTargetSource: "pinned_run",
        pinnedReplyTarget: {
          channel: "plugin_gateway",
          target_id: "C123",
          thread_id: "1710000000.000100",
        },
      },
    })).resolves.toEqual({
      ok: true,
      goalId: "goal-bg",
      backgroundRunId: "run:coreloop:goal-bg",
    });

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      type: "command",
      name: "goal_start",
      source: "http",
      goal_id: "goal-bg",
      payload: {
        goalId: "goal-bg",
        backgroundRun: {
          backgroundRunId: "run:coreloop:goal-bg",
          parentSessionId: "session:conversation:chat-bg",
          notifyPolicy: "done_only",
          replyTargetSource: "pinned_run",
          pinnedReplyTarget: {
            channel: "plugin_gateway",
            target_id: "C123",
            thread_id: "1710000000.000100",
          },
        },
      },
    });
  });

  it("sends safe pause and resume requests as distinct daemon command envelopes", async () => {
    const envelopes: unknown[] = [];
    server.setCommandEnvelopeHook((envelope) => {
      envelopes.push(envelope);
    });
    await server.start();

    const client = new DaemonClient({
      host: "127.0.0.1",
      port: server.getPort(),
      authToken: server.getAuthToken(),
    });

    await expect(client.pauseGoal("goal-bg")).resolves.toEqual({ ok: true, goalId: "goal-bg" });
    await expect(client.resumeGoal("goal-bg")).resolves.toEqual({ ok: true, goalId: "goal-bg" });

    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]).toMatchObject({
      type: "command",
      name: "goal_pause",
      goal_id: "goal-bg",
      dedupe_key: "goal_pause:goal-bg",
      payload: { goalId: "goal-bg" },
    });
    expect(envelopes[1]).toMatchObject({
      type: "command",
      name: "goal_resume",
      goal_id: "goal-bg",
      dedupe_key: "goal_resume:goal-bg",
      payload: { goalId: "goal-bg" },
    });
  });

  it("sends schedule run-now requests as daemon command envelopes", async () => {
    const envelopes: unknown[] = [];
    server.setCommandEnvelopeHook((envelope) => {
      envelopes.push(envelope);
    });
    await server.start();

    const client = new DaemonClient({
      host: "127.0.0.1",
      port: server.getPort(),
      authToken: server.getAuthToken(),
    });

    await expect(client.runScheduleNow("sched-1", {
      allowEscalation: true,
    })).resolves.toEqual({ ok: true, scheduleId: "sched-1" });

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      type: "command",
      name: "schedule_run_now",
      source: "http",
      priority: "high",
      payload: {
        scheduleId: "sched-1",
        allowEscalation: true,
      },
    });
  });
});

describe("isDaemonRunning", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
    delete process.env["PULSEED_DAEMON_TOKEN"];
    vi.restoreAllMocks();
  });

  it("treats idle daemon-state as running when the daemon health check passes", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "daemon-state.json"),
      JSON.stringify({ status: "idle", pid: process.pid }),
      "utf-8"
    );
    vi.spyOn(DaemonClient.prototype, "getHealth").mockResolvedValue({ status: "ok" });

    await expect(isDaemonRunning(tmpDir)).resolves.toEqual({
      running: true,
      port: DEFAULT_PORT,
    });
  });

  it("rejects unsafe daemon-state pids before probing the process table", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "daemon-state.json"),
      JSON.stringify({ status: "running", pid: Number.MAX_SAFE_INTEGER + 1 }),
      "utf-8"
    );
    const killSpy = vi.spyOn(process, "kill");

    await expect(isDaemonRunning(tmpDir)).resolves.toEqual({
      running: false,
      port: DEFAULT_PORT,
    });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("ignores unsafe daemon config ports before probing daemon health", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "daemon-state.json"),
      JSON.stringify({ status: "running", pid: process.pid }),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tmpDir, "daemon.json"),
      JSON.stringify({ event_server_port: Number.MAX_SAFE_INTEGER }),
      "utf-8"
    );
    vi.spyOn(DaemonClient.prototype, "getHealth").mockResolvedValue({ status: "ok" });

    await expect(isDaemonRunning(tmpDir)).resolves.toEqual({
      running: true,
      port: DEFAULT_PORT,
    });
  });

  it("uses the token file port for daemon configs with OS-assigned event server ports", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "daemon-state.json"),
      JSON.stringify({ status: "running", pid: process.pid }),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tmpDir, "daemon.json"),
      JSON.stringify({ event_server_port: 0 }),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tmpDir, "daemon-token.json"),
      JSON.stringify({ token: "dynamic-token", port: 45678 }),
      "utf-8"
    );
    const probedPorts: number[] = [];
    vi.spyOn(DaemonClient.prototype, "getHealth").mockImplementation(async function (this: DaemonClient) {
      probedPorts.push((this as unknown as { config: { port: number } }).config.port);
      return { status: "ok" };
    });

    await expect(isDaemonRunning(tmpDir)).resolves.toEqual({
      running: true,
      port: 45678,
      authToken: "dynamic-token",
    });
    expect(probedPorts).toEqual([45678]);
  });

  it("does not probe port 0 when an OS-assigned daemon config has no resolved token port", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "daemon-state.json"),
      JSON.stringify({ status: "running", pid: process.pid }),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tmpDir, "daemon.json"),
      JSON.stringify({ event_server_port: 0 }),
      "utf-8"
    );
    const healthSpy = vi.spyOn(DaemonClient.prototype, "getHealth").mockResolvedValue({ status: "ok" });

    await expect(isDaemonRunning(tmpDir)).resolves.toEqual({
      running: false,
      port: 0,
    });
    expect(healthSpy).not.toHaveBeenCalled();
  });

  it("prefers the daemon token file over stale process env tokens", () => {
    fs.writeFileSync(
      path.join(tmpDir, "daemon-token.json"),
      JSON.stringify({ token: "fresh-token", port: 41700 }),
      "utf-8"
    );
    process.env["PULSEED_DAEMON_TOKEN"] = "stale-token";

    expect(readDaemonAuthToken(tmpDir, 41700)).toBe("fresh-token");
  });

  it("rejects daemon token files with unsafe numeric metadata", () => {
    fs.writeFileSync(
      path.join(tmpDir, "daemon-token.json"),
      JSON.stringify({ token: "unsafe-token", port: Number.MAX_SAFE_INTEGER + 1 }),
      "utf-8"
    );

    expect(readDaemonAuthToken(tmpDir)).toBeNull();

    fs.writeFileSync(
      path.join(tmpDir, "daemon-token.json"),
      JSON.stringify({ token: "unsafe-token", pid: Number.MAX_SAFE_INTEGER + 1 }),
      "utf-8"
    );

    expect(readDaemonAuthToken(tmpDir)).toBeNull();

    fs.writeFileSync(
      path.join(tmpDir, "daemon-token.json"),
      JSON.stringify({ token: "unsafe-token", created_at: "not-a-date" }),
      "utf-8"
    );

    expect(readDaemonAuthToken(tmpDir)).toBeNull();
  });
});

describe("probeDaemonHealth", () => {
  it("returns health payload and latency when /health responds", async () => {
    vi.spyOn(DaemonClient.prototype, "getHealth").mockResolvedValue({
      status: "ok",
      uptime: 4.2,
    });

    await expect(probeDaemonHealth({ host: "127.0.0.1", port: 41700 })).resolves.toMatchObject({
      ok: true,
      port: 41700,
      health: { status: "ok", uptime: 4.2 },
    });
  });

  it("returns the error message when /health probe fails", async () => {
    vi.spyOn(DaemonClient.prototype, "getHealth").mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(probeDaemonHealth({ host: "127.0.0.1", port: 41700 })).resolves.toMatchObject({
      ok: false,
      port: 41700,
      error: "connect ECONNREFUSED",
    });
  });
});
