import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventServer } from "../event-server.js";
import type { PulSeedEvent } from "../../base/types/drive.js";
import { makeTempDir } from "../../../tests/helpers/temp-dir.js";
import { OutboxStore } from "../store/outbox-store.js";
import { BrowserSessionStore, RuntimeAuthHandoffStore } from "../interactive-automation/index.js";
import { GuardrailStore } from "../guardrails/index.js";
import { StateManager } from "../../base/state/state-manager.js";
import { BackgroundRunLedger } from "../store/background-run-store.js";
import { RuntimeOperatorHandoffStore } from "../store/operator-handoff-store.js";

// ─── Helpers ───

const createMockDriveSystem = (tmpDir: string) => ({
  writeEvent: vi.fn().mockImplementation(async (event: PulSeedEvent) => {
    const eventsDir = path.join(tmpDir, "events");
    fs.mkdirSync(eventsDir, { recursive: true });
    const file = path.join(eventsDir, `test_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(event), "utf-8");
  }),
});

/** Start an EventServer on an OS-assigned port (no TOCTOU race). */
async function startWithRetry(
  driveSystem: ReturnType<typeof createMockDriveSystem>
): Promise<{ server: EventServer; port: number }> {
  const s = new EventServer(driveSystem as never, { port: 0, eventsDir: path.join(tmpDir, "events") });
  await s.start();
  return { server: s, port: s.getPort() };
}

function postEvent(
  port: number,
  body: unknown,
  authToken: string | null | undefined = server?.getAuthToken()
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/events",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...authHeaders(authToken),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function makeRequest(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
  authToken: string | null | undefined = server?.getAuthToken(),
  extraHeaders: http.OutgoingHttpHeaders = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : "";
    const headers: http.OutgoingHttpHeaders = {
      "Content-Type": "application/json",
      ...authHeaders(authToken),
      ...extraHeaders,
    };
    if (data.length > 0) {
      headers["Content-Length"] = Buffer.byteLength(data);
    }
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      }
    );
    req.on("error", reject);
    if (data.length > 0) req.write(data);
    req.end();
  });
}

function collectSseEvents(
  port: number,
  urlPath: string,
  eventType: string,
  expectedCount: number,
  authToken: string | null | undefined = server?.getAuthToken()
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const received: unknown[] = [];
    let settled = false;
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        headers: { Accept: "text/event-stream", ...authHeaders(authToken) },
      },
      (res) => {
        let buffer = "";
        const timeout = setTimeout(() => {
          settled = true;
          req.destroy();
          reject(new Error(`Timed out waiting for ${expectedCount} SSE events: ${eventType}`));
        }, 2000);

        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          const messages = buffer.split("\n\n");
          buffer = messages.pop() ?? "";

          for (const message of messages) {
            let currentEvent = "message";
            let data = "";
            for (const line of message.split("\n")) {
              if (line.startsWith("event: ")) {
                currentEvent = line.slice(7);
              } else if (line.startsWith("data: ")) {
                data += line.slice(6);
              }
            }

            if (currentEvent !== eventType) continue;

            try {
              received.push(JSON.parse(data));
            } catch {
              received.push(data);
            }

            if (received.length >= expectedCount) {
              clearTimeout(timeout);
              settled = true;
              req.destroy();
              resolve(received);
              return;
            }
          }
        });
      }
    );
    req.on("error", (err) => {
      if (!settled) {
        reject(err);
      }
    });
  });
}

function authHeaders(authToken: string | null | undefined): http.OutgoingHttpHeaders {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

const validEvent: PulSeedEvent = {
  type: "external",
  source: "test-source",
  timestamp: new Date().toISOString(),
  data: { key: "value" },
};

// ─── Test setup ───

let tmpDir: string;
let mockDriveSystem: ReturnType<typeof createMockDriveSystem>;
let server: EventServer;
let port: number;

beforeEach(async () => {
  tmpDir = makeTempDir();
  mockDriveSystem = createMockDriveSystem(tmpDir);
  server = new EventServer(mockDriveSystem as never, { port: 0, eventsDir: path.join(tmpDir, "events") });
  // port will be set after start() for tests that need it; for tests that
  // call start() themselves they must read server.getPort() afterward.
  port = 0;
});

afterEach(async () => {
  if (server.isRunning()) {
    await server.stop();
  }
  fs.rmSync(tmpDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
});

// ─── start / stop ───

describe("start / stop", () => {
  it("isRunning() returns false before start", () => {
    expect(server.isRunning()).toBe(false);
  });

  it("isRunning() returns true after start", async () => {
    await server.start();
    expect(server.isRunning()).toBe(true);
  });

  it("isRunning() returns false after stop", async () => {
    await server.start();
    await server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it("stop() is idempotent when server is not started", async () => {
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it("getPort() returns the configured port", () => {
    expect(server.getPort()).toBe(port);
  });

  it("getHost() returns the configured host", () => {
    expect(server.getHost()).toBe("127.0.0.1");
  });

  it("can start and stop multiple times sequentially", async () => {
    await server.start();
    await server.stop();

    const server2 = new EventServer(mockDriveSystem as never, { port: 0, eventsDir: path.join(tmpDir, "events") });
    await server2.start();
    expect(server2.isRunning()).toBe(true);
    await server2.stop();
    expect(server2.isRunning()).toBe(false);
  });

  it("rejects instead of falling back when an explicit port is already in use", async () => {
    const occupied = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("occupied");
    });
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    expect(address).toBeTypeOf("object");
    const occupiedPort = (address as { port: number }).port;

    const explicitServer = new EventServer(
      mockDriveSystem as never,
      { port: occupiedPort, eventsDir: path.join(tmpDir, "explicit-events") }
    );

    await expect(explicitServer.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(explicitServer.isRunning()).toBe(false);

    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  });
});

// ─── POST /events — valid event ───

describe("POST /events — valid event", () => {
  beforeEach(async () => {
    await server.start();
    port = server.getPort();
  });

  it("returns 200 for a valid event", async () => {
    const result = await postEvent(port, validEvent);
    expect(result.status).toBe(200);
  });

  it("response body contains status=accepted", async () => {
    const result = await postEvent(port, validEvent);
    const parsed = JSON.parse(result.body);
    expect(parsed.status).toBe("accepted");
  });

  it("response body contains event_type", async () => {
    const result = await postEvent(port, validEvent);
    const parsed = JSON.parse(result.body);
    expect(parsed.event_type).toBe("external");
  });

  it("calls driveSystem.writeEvent with the parsed event", async () => {
    await postEvent(port, validEvent);
    expect(mockDriveSystem.writeEvent).toHaveBeenCalledOnce();
    const called = mockDriveSystem.writeEvent.mock.calls[0][0] as PulSeedEvent;
    expect(called.type).toBe("external");
    expect(called.source).toBe("test-source");
  });

  it("writes event file to temp events dir", async () => {
    await postEvent(port, validEvent);
    // writeEvent is fire-and-forget in the HTTP handler, so wait briefly
    await new Promise((r) => setTimeout(r, 50));
    const eventsDir = path.join(tmpDir, "events");
    expect(fs.existsSync(eventsDir)).toBe(true);
    const files = fs.readdirSync(eventsDir);
    expect(files.length).toBeGreaterThan(0);
    const content = JSON.parse(
      fs.readFileSync(path.join(eventsDir, files[0]), "utf-8")
    );
    expect(content.type).toBe("external");
  });

  it("accepts internal event type", async () => {
    const internalEvent: PulSeedEvent = {
      type: "internal",
      source: "core-loop",
      timestamp: new Date().toISOString(),
      data: { reason: "stall" },
    };
    const result = await postEvent(port, internalEvent);
    expect(result.status).toBe(200);
    expect(mockDriveSystem.writeEvent).toHaveBeenCalledOnce();
  });

  it("handles multiple events in sequence", async () => {
    for (let i = 0; i < 3; i++) {
      const result = await postEvent(port, {
        ...validEvent,
        data: { index: i },
      });
      expect(result.status).toBe(200);
    }
    expect(mockDriveSystem.writeEvent).toHaveBeenCalledTimes(3);
  });

  it("waits for an async envelopeHook before sending the accepted response", async () => {
    let releaseHook: (() => void) | null = null;
    const hookStarted = vi.fn();
    server.setEnvelopeHook(
      () =>
        new Promise<void>((resolve) => {
          hookStarted();
          releaseHook = resolve;
        })
    );

    let settled = false;
    const request = postEvent(port, validEvent).then((result) => {
      settled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hookStarted).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    expect(releaseHook).not.toBeNull();
    releaseHook!();
    const result = await request;

    expect(result.status).toBe(200);
    expect(settled).toBe(true);
    expect(mockDriveSystem.writeEvent).not.toHaveBeenCalled();
  });
});

// ─── POST /events — invalid data ───

describe("POST /events — invalid data", () => {
  beforeEach(async () => {
    await server.start();
    port = server.getPort();
  });

  it("returns 400 for invalid JSON body", async () => {
    const result = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const data = "not-valid-json{{{";
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/events",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(data),
              Authorization: `Bearer ${server.getAuthToken()}`,
            },
          },
          (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode!, body }));
          }
        );
        req.on("error", reject);
        req.write(data);
        req.end();
      }
    );
    expect(result.status).toBe(400);
  });

  it("returns 400 when event type is missing", async () => {
    const result = await postEvent(port, {
      source: "test",
      timestamp: new Date().toISOString(),
      data: {},
      // type is missing
    });
    expect(result.status).toBe(400);
  });

  it("returns 400 when event type is invalid", async () => {
    const result = await postEvent(port, {
      type: "invalid-type",
      source: "test",
      timestamp: new Date().toISOString(),
      data: {},
    });
    expect(result.status).toBe(400);
  });

  it("returns 400 for empty body", async () => {
    const result = await postEvent(port, {});
    expect(result.status).toBe(400);
  });

  it("error response body contains error field", async () => {
    const result = await postEvent(port, { type: "bad" });
    const parsed = JSON.parse(result.body);
    expect(parsed).toHaveProperty("error");
  });

  it("does not call writeEvent on invalid event", async () => {
    await postEvent(port, { type: "invalid" });
    expect(mockDriveSystem.writeEvent).not.toHaveBeenCalled();
  });
});

// ─── Routing — wrong method or path ───

describe("routing — wrong method or path", () => {
  beforeEach(async () => {
    // Re-acquire port to avoid EADDRINUSE from prior test teardown race
    ({ server, port } = await startWithRetry(mockDriveSystem));
  });

  it("GET /events returns 404", async () => {
    const result = await makeRequest(port, "GET", "/events");
    expect(result.status).toBe(404);
  });

  it("POST /other-path returns 404", async () => {
    const result = await makeRequest(port, "POST", "/other-path", validEvent);
    expect(result.status).toBe(404);
  });

  it("PUT /events returns 404", async () => {
    const result = await makeRequest(port, "PUT", "/events", validEvent);
    expect(result.status).toBe(404);
  });

  it("DELETE /events returns 404", async () => {
    const result = await makeRequest(port, "DELETE", "/events");
    expect(result.status).toBe(404);
  });

  it("404 response body contains error field", async () => {
    const result = await makeRequest(port, "GET", "/events");
    const parsed = JSON.parse(result.body);
    expect(parsed).toHaveProperty("error");
  });

  it("404 responses do not call writeEvent", async () => {
    await makeRequest(port, "GET", "/events");
    await makeRequest(port, "POST", "/wrong", validEvent);
    expect(mockDriveSystem.writeEvent).not.toHaveBeenCalled();
  });
});

describe("daemon HTTP auth guard", () => {
  beforeEach(async () => {
    await server.start();
    port = server.getPort();
  });

  it("writes a per-daemon token file next to the events directory", () => {
    const tokenPath = path.join(tmpDir, "daemon-token.json");
    const tokenFile = JSON.parse(fs.readFileSync(tokenPath, "utf-8")) as {
      token?: string;
      port?: number;
    };

    expect(tokenFile.token).toBe(server.getAuthToken());
    expect(tokenFile.port).toBe(port);
  });

  it("keeps /health available without auth", async () => {
    const result = await makeRequest(port, "GET", "/health", undefined, null);
    expect(result.status).toBe(200);
  });

  it("rejects state-changing POST requests without a bearer token", async () => {
    const result = await postEvent(port, validEvent, null);
    expect(result.status).toBe(401);
    expect(mockDriveSystem.writeEvent).not.toHaveBeenCalled();
  });

  it("rejects browser cross-site requests even with a valid bearer token", async () => {
    const result = await makeRequest(
      port,
      "POST",
      "/goals/g-1/start",
      {},
      server.getAuthToken(),
      {
        Origin: "https://attacker.example",
        "Sec-Fetch-Site": "cross-site",
      }
    );

    expect(result.status).toBe(403);
  });

  it("rejects non-JSON POST requests", async () => {
    const result = await makeRequest(
      port,
      "POST",
      "/goals/g-1/start",
      {},
      server.getAuthToken(),
      { "Content-Type": "text/plain" }
    );

    expect(result.status).toBe(415);
  });

  it("rejects unauthenticated SSE and does not emit wildcard CORS", async () => {
    const result = await new Promise<{ status: number; cors: string | undefined }>((resolve, reject) => {
      const req = http.get(
        {
          hostname: "127.0.0.1",
          port,
          path: "/stream",
          headers: { Accept: "text/event-stream" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({
            status: res.statusCode ?? 0,
            cors: res.headers["access-control-allow-origin"] as string | undefined,
          }));
        }
      );
      req.on("error", reject);
    });

    expect(result.status).toBe(401);
    expect(result.cors).toBeUndefined();
  });
});

describe("goal action commands", () => {
  beforeEach(async () => {
    await server.start();
    port = server.getPort();
  });

  it("waits for command hook accept before returning startGoal success", async () => {
    let releaseHook: (() => void) | null = null;
    const hookStarted = vi.fn();
    server.setCommandEnvelopeHook(
      () =>
        new Promise<void>((resolve) => {
          hookStarted();
          releaseHook = resolve;
        })
    );

    let settled = false;
    const request = makeRequest(port, "POST", "/goals/g-1/start", {}).then((result) => {
      settled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hookStarted).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    expect(releaseHook).not.toBeNull();
    releaseHook!();
    const result = await request;

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true, goalId: "g-1" });
  });

  it("sends chat messages through the command hook as command envelopes", async () => {
    const seen: Array<Record<string, unknown>> = [];
    server.setCommandEnvelopeHook((envelope) => {
      seen.push(envelope as unknown as Record<string, unknown>);
    });

    const result = await makeRequest(port, "POST", "/goals/g-1/chat", {
      message: "hello runtime",
    });

    expect(result.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(
      expect.objectContaining({
        type: "command",
        name: "chat_message",
        source: "http",
        goal_id: "g-1",
        payload: { goalId: "g-1", message: "hello runtime" },
      })
    );
  });

  it("sends schedule run-now requests through the command hook as command envelopes", async () => {
    const seen: Array<Record<string, unknown>> = [];
    server.setCommandEnvelopeHook((envelope) => {
      seen.push(envelope as unknown as Record<string, unknown>);
    });

    const result = await makeRequest(port, "POST", "/schedules/sched-1/run", {
      allowEscalation: true,
    });

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true, scheduleId: "sched-1" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(
      expect.objectContaining({
        type: "command",
        name: "schedule_run_now",
        source: "http",
        priority: "high",
        payload: { scheduleId: "sched-1", allowEscalation: true },
      })
    );
  });

  it("rejects approval responses for unknown requests before command accept", async () => {
    const hook = vi.fn();
    server.setCommandEnvelopeHook(hook);

    const result = await makeRequest(port, "POST", "/goals/g-1/approve", {
      requestId: "missing-request",
      approved: true,
    });

    expect(result.status).toBe(404);
    expect(hook).not.toHaveBeenCalled();
  });

  it("rejects malformed command request bodies before command accept", async () => {
    const cases: Array<{ name: string; path: string; body: unknown }> = [
      {
        name: "goal start background run",
        path: "/goals/g-1/start",
        body: { backgroundRun: { backgroundRunId: "" } },
      },
      {
        name: "approval response",
        path: "/goals/g-1/approve",
        body: { requestId: "approval-1", approved: "true" },
      },
      {
        name: "chat message",
        path: "/goals/g-1/chat",
        body: { message: 42 },
      },
      {
        name: "runtime control",
        path: "/daemon/runtime-control",
        body: { operationId: "op-1", kind: "restart_daemon", reason: 42 },
      },
      {
        name: "schedule run now",
        path: "/schedules/sched-1/run",
        body: { allowEscalation: "true" },
      },
    ];

    for (const testCase of cases) {
      const hook = vi.fn();
      server.setCommandEnvelopeHook(hook);

      const result = await makeRequest(port, "POST", testCase.path, testCase.body);

      expect(result.status, testCase.name).toBe(400);
      expect(hook, testCase.name).not.toHaveBeenCalled();
    }
  });
});

describe("snapshot and outbox replay", () => {
  it("returns snapshot metadata with the latest outbox sequence", async () => {
    const outboxStore = new OutboxStore(tmpDir);
    server = new EventServer(mockDriveSystem as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
      outboxStore,
    });

    await server.start();
    await server.broadcast("goal_start_requested", { goalId: "goal-1" });
    await server.broadcast("chat_message_received", { goalId: "goal-1", message: "hello" });

    const result = await makeRequest(server.getPort(), "GET", "/snapshot");
    expect(result.status).toBe(200);

    const snapshot = JSON.parse(result.body) as {
      daemon: unknown;
      goals: unknown[];
      approvals: unknown[];
      active_workers: unknown[];
      last_outbox_seq: number;
    };
    expect(snapshot.daemon).toBeNull();
    expect(snapshot.goals).toEqual([]);
    expect(snapshot.approvals).toEqual([]);
    expect(snapshot.active_workers).toEqual([]);
    expect(snapshot.last_outbox_seq).toBe(2);
  });

  it("skips non-object persisted daemon and goal snapshot records", async () => {
    fs.writeFileSync(path.join(tmpDir, "daemon-state.json"), JSON.stringify([]), "utf-8");
    fs.mkdirSync(path.join(tmpDir, "goals", "g-array"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "goals", "g-array", "goal.json"), JSON.stringify([]), "utf-8");
    fs.mkdirSync(path.join(tmpDir, "goals", "g-valid"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "goals", "g-valid", "goal.json"), JSON.stringify({
      id: "g-valid",
      title: "Valid goal",
      status: "active",
      loop_status: "idle",
    }), "utf-8");
    fs.writeFileSync(path.join(tmpDir, "goals", "g-valid", "gap-history.json"), JSON.stringify({ latest: "not-an-array" }), "utf-8");

    server = new EventServer(mockDriveSystem as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
    });
    await server.start();

    const snapshotResult = await makeRequest(server.getPort(), "GET", "/snapshot");
    expect(snapshotResult.status).toBe(200);
    const snapshot = JSON.parse(snapshotResult.body) as {
      daemon: unknown;
      goals: Array<{ id: string; title: string }>;
    };
    expect(snapshot.daemon).toBeNull();
    expect(snapshot.goals).toEqual([
      expect.objectContaining({ id: "g-valid", title: "Valid goal" }),
    ]);

    const malformedGoal = await makeRequest(server.getPort(), "GET", "/goals/g-array");
    expect(malformedGoal.status).toBe(404);

    const validGoal = await makeRequest(server.getPort(), "GET", "/goals/g-valid");
    expect(validGoal.status).toBe(200);
    expect(JSON.parse(validGoal.body)).toMatchObject({
      id: "g-valid",
      current_gap: null,
    });
  });

  it("includes active worker summaries in snapshot when a provider is registered", async () => {
    server = new EventServer(mockDriveSystem as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
    });
    server.setActiveWorkersProvider(() => [
      {
        worker_id: "worker-1",
        goal_id: "goal-1",
        started_at: 123,
        iterations: 0,
      },
    ]);

    await server.start();

    const result = await makeRequest(server.getPort(), "GET", "/snapshot");
    expect(result.status).toBe(200);

    const snapshot = JSON.parse(result.body) as { active_workers: unknown[] };
    expect(snapshot.active_workers).toEqual([
      {
        worker_id: "worker-1",
        goal_id: "goal-1",
        started_at: 123,
        iterations: 0,
      },
    ]);
  });

  it("includes runtime session catalog data in daemon snapshot when a state manager is configured", async () => {
    const stateManager = new StateManager(tmpDir, undefined, { walEnabled: false });
    await stateManager.init();
    await stateManager.writeRaw("chat/sessions/chat-runtime.json", {
      id: "chat-runtime",
      cwd: "/repo",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:10:00.000Z",
      title: "Runtime snapshot",
      messages: [],
      agentLoopStatePath: "chat/agentloop/agent-runtime.state.json",
      agentLoopStatus: "running",
      agentLoopResumable: true,
      agentLoopUpdatedAt: "2026-05-01T00:11:00.000Z",
    });
    await stateManager.writeRaw("chat/agentloop/agent-runtime.state.json", {
      sessionId: "agent-runtime",
      traceId: "trace-runtime",
      turnId: "turn-runtime",
      goalId: "goal-runtime",
      cwd: "/repo",
      modelRef: "native:test",
      messages: [],
      modelTurns: 1,
      toolCalls: 0,
      compactions: 0,
      completionValidationAttempts: 0,
      calledTools: [],
      lastToolLoopSignature: null,
      repeatedToolLoopCount: 0,
      finalText: "",
      status: "running",
      updatedAt: "2026-05-01T00:12:00.000Z",
    });
    await new BackgroundRunLedger(path.join(tmpDir, "runtime")).create({
      id: "run:coreloop:ledger-active",
      kind: "coreloop_run",
      notify_policy: "silent",
      status: "running",
      child_session_id: "session:coreloop:ledger-active",
      title: "Ledger active run",
      workspace: "/repo",
      created_at: "2026-05-01T00:05:00.000Z",
      started_at: "2026-05-01T00:05:00.000Z",
      updated_at: "2026-05-01T00:13:00.000Z",
    });

    server = new EventServer(mockDriveSystem as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
      stateManager,
    });
    await server.start();

    const result = await makeRequest(server.getPort(), "GET", "/snapshot");
    expect(result.status).toBe(200);

    const snapshot = JSON.parse(result.body) as {
      runtime_sessions?: {
        schema_version: string;
        sessions: Array<{ id: string; kind: string; status: string }>;
        background_runs: Array<{ id: string; kind: string; status: string }>;
      } | null;
    };
    expect(snapshot.runtime_sessions?.schema_version).toBe("runtime-session-registry-v1");
    expect(snapshot.runtime_sessions?.sessions).toContainEqual(expect.objectContaining({
      id: "session:agent:agent-runtime",
      kind: "agent",
      status: "active",
    }));
    expect(snapshot.runtime_sessions?.background_runs).toContainEqual(expect.objectContaining({
      id: "run:agent:agent-runtime",
      kind: "agent_run",
      status: "running",
    }));
    expect(snapshot.runtime_sessions?.background_runs).toContainEqual(expect.objectContaining({
      id: "run:coreloop:ledger-active",
      kind: "coreloop_run",
      status: "running",
    }));
  });

  it("reads auth handoff sessions from an explicitly configured runtime root", async () => {
    const runtimeRoot = path.join(tmpDir, "custom-runtime");
    await new BrowserSessionStore(runtimeRoot).recordAuthRequired({
      sessionId: "sess-custom",
      providerId: "browser-auth",
      serviceKey: "mail.google.com",
      workspace: "/tmp",
      actorKey: "chat-1",
      failureCode: "auth_required",
      failureMessage: "login required",
    });

    server = new EventServer(mockDriveSystem as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
      runtimeRoot,
    });

    await server.start();

    const result = await makeRequest(server.getPort(), "GET", "/snapshot");
    expect(result.status).toBe(200);

    const snapshot = JSON.parse(result.body) as { auth_sessions?: unknown[] };
    expect(snapshot.auth_sessions).toEqual([
      expect.objectContaining({
        session_id: "sess-custom",
        provider_id: "browser-auth",
        service_key: "mail.google.com",
        state: "auth_required",
      }),
    ]);
  });

  it("includes typed runtime automation snapshot while preserving compatibility fields", async () => {
    const runtimeRoot = path.join(tmpDir, "custom-runtime");
    await new RuntimeAuthHandoffStore(runtimeRoot).createPending({
      providerId: "browser-auth",
      serviceKey: "mail.google.com",
      workspace: "/tmp",
      actorKey: "chat-1",
      browserSessionId: "sess-custom",
      resumableSessionId: "sess-custom",
      failureCode: "auth_required",
      failureMessage: "login required",
      taskSummary: "Open mail",
    });
    await new BrowserSessionStore(runtimeRoot).recordAuthRequired({
      sessionId: "sess-custom",
      providerId: "browser-auth",
      serviceKey: "mail.google.com",
      workspace: "/tmp",
      actorKey: "chat-1",
      failureCode: "auth_required",
      failureMessage: "login required",
    });
    const now = new Date().toISOString();
    await new GuardrailStore(runtimeRoot, { controlBaseDir: tmpDir }).saveBreaker({
      key: "browser-auth:mail.google.com",
      provider_id: "browser-auth",
      service_key: "mail.google.com",
      state: "open",
      failure_count: 2,
      last_failure_code: "rate_limited",
      last_failure_message: "rate limited",
      last_failure_at: now,
      opened_at: now,
      cooldown_until: "2999-01-01T00:00:00.000Z",
      updated_at: now,
    });

    server = new EventServer(mockDriveSystem as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
      runtimeRoot,
      stateManager: { getBaseDir: () => tmpDir } as StateManager,
    });

    await server.start();

    const result = await makeRequest(server.getPort(), "GET", "/snapshot");
    expect(result.status).toBe(200);

    const snapshot = JSON.parse(result.body) as {
      auth_sessions?: unknown[];
      guardrails?: Record<string, unknown>;
      runtime_automation?: Record<string, unknown>;
    };
    expect(snapshot.auth_sessions).toEqual([
      expect.objectContaining({ session_id: "sess-custom" }),
    ]);
    expect(snapshot.guardrails?.open_breakers).toEqual([
      expect.objectContaining({ provider_id: "browser-auth", service_key: "mail.google.com" }),
    ]);
    expect(snapshot.runtime_automation).toEqual(expect.objectContaining({
      schema_version: "runtime-automation-snapshot-v1",
      auth_handoffs: {
        pending: [
          expect.objectContaining({
            provider_id: "browser-auth",
            service_key: "mail.google.com",
            state: "pending_operator",
          }),
        ],
        stale: [],
        recent_terminal: [],
      },
      browser_sessions: {
        authenticated: [],
        stale: [
          expect.objectContaining({
            session_id: "sess-custom",
            state: "auth_required",
          }),
        ],
      },
      guardrails: {
        open_breakers: [
          expect.objectContaining({
            provider_id: "browser-auth",
            service_key: "mail.google.com",
            state: "open",
          }),
        ],
        paused_breakers: [],
        half_open_breakers: [],
      },
      blocked_work: expect.arrayContaining([
        expect.objectContaining({
          kind: "auth_wait",
          provider_id: "browser-auth",
          service_key: "mail.google.com",
        }),
        expect.objectContaining({
          kind: "guardrail_open",
          provider_id: "browser-auth",
          service_key: "mail.google.com",
          reason: "guardrail:open",
        }),
      ]),
    }));
    expect(fs.existsSync(path.join(runtimeRoot, "state", "pulseed-control.sqlite"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "state", "pulseed-control.sqlite"))).toBe(true);
  });

  it("includes open operator handoffs in daemon snapshot", async () => {
    const runtimeRoot = path.join(tmpDir, "custom-runtime");
    await new RuntimeOperatorHandoffStore(runtimeRoot).create({
      handoff_id: "handoff-deadline",
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

    server = new EventServer(mockDriveSystem as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
      runtimeRoot,
    });

    await server.start();

    const result = await makeRequest(server.getPort(), "GET", "/snapshot");
    expect(result.status).toBe(200);

    const snapshot = JSON.parse(result.body) as { operator_handoffs?: unknown[] };
    expect(snapshot.operator_handoffs).toEqual([
      expect.objectContaining({
        handoff_id: "handoff-deadline",
        goal_id: "goal-1",
        status: "open",
        triggers: ["deadline", "finalization"],
      }),
    ]);
  });

  it("replays outbox events after the requested sequence", async () => {
    const outboxStore = new OutboxStore(tmpDir);
    server = new EventServer(mockDriveSystem as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
      outboxStore,
    });

    await server.start();
    await server.broadcast("goal_start_requested", { goalId: "goal-1" });
    await server.broadcast("chat_message_received", { goalId: "goal-1", message: "hello" });

    const events = await collectSseEvents(
      server.getPort(),
      "/stream?after=1",
      "chat_message_received",
      1
    );

    expect(events).toEqual([{ goalId: "goal-1", message: "hello" }]);
  });

  it("does not partially parse malformed replay cursors", async () => {
    const outboxStore = new OutboxStore(tmpDir);
    server = new EventServer(mockDriveSystem as never, {
      port: 0,
      eventsDir: path.join(tmpDir, "events"),
      outboxStore,
    });

    await server.start();
    await server.broadcast("goal_start_requested", { goalId: "goal-1" });
    await server.broadcast("chat_message_received", { goalId: "goal-1", message: "hello" });

    const events = await collectSseEvents(
      server.getPort(),
      "/stream?after=1abc",
      "goal_start_requested",
      1
    );

    expect(events).toEqual([{ goalId: "goal-1" }]);
  });
});
