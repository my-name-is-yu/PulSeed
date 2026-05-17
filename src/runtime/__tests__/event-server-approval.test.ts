import * as http from "node:http";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventServer } from "../event-server.js";
import { ApprovalBroker } from "../approval-broker.js";
import { ApprovalStore } from "../store/approval-store.js";
import { RuntimeOperatorHandoffStore } from "../store/operator-handoff-store.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";

function createMockDriveSystem() {
  return {
    writeEvent: async () => undefined,
  };
}

function request(
  port: number,
  method: string,
  urlPath: string,
  body: unknown,
  authToken: string,
  timeoutMs = 10_000
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const data = body === undefined ? "" : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let responseBody = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          settled = true;
          resolve({ status: res.statusCode ?? 0, body: responseBody });
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      if (settled) {
        return;
      }
      settled = true;
      const err = new Error(`Timed out waiting for ${method} ${urlPath}`);
      req.destroy(err);
      reject(err);
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    if (data) {
      req.write(data);
    }
    req.end();
  });
}

function waitForSseEvent(port: number, eventType: string, authToken: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/stream",
        headers: { Accept: "text/event-stream", Authorization: `Bearer ${authToken}` },
      },
      (res) => {
        let buffer = "";
        const timeout = setTimeout(() => {
          settled = true;
          req.destroy();
          reject(new Error(`Timed out waiting for SSE event: ${eventType}`));
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

            if (currentEvent === eventType) {
              clearTimeout(timeout);
              settled = true;
              req.destroy();
              try {
                resolve(JSON.parse(data));
              } catch {
                resolve(data);
              }
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

async function waitForPendingApproval(
  store: ApprovalStore,
  approvalId: string,
  timeoutMs = 1000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await store.loadPending(approvalId)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for pending approval: ${approvalId}`);
}

describe("EventServer durable approval integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("routes approval resolution through ApprovalBroker", async () => {
    const store = new ApprovalStore(tmpDir);
    const broker = new ApprovalBroker({
      store,
      createId: () => "approval-http",
    });
    const server = new EventServer(
      createMockDriveSystem() as never,
      {
        port: 0,
        eventsDir: path.join(tmpDir, "events"),
        approvalBroker: broker,
      }
    );

    try {
      await server.start();
      const approval = server.requestApproval("goal-1", {
        id: "task-http",
        description: "Approve HTTP request",
        action: "merge",
      });
      await waitForPendingApproval(store, "approval-http");

      const result = await request(server.getPort(), "POST", "/goals/goal-1/approve", {
        requestId: "approval-http",
        approved: true,
      }, server.getAuthToken());

      expect(result.status).toBe(200);
      await expect(approval).resolves.toBe(true);

      await expect(store.loadResolved("approval-http")).resolves.toMatchObject({ state: "approved" });
    } finally {
      await server.stop();
    }
  }, 15_000);

  it("resolves durable operator handoffs through the goal approval endpoint", async () => {
    const runtimeRoot = path.join(tmpDir, "runtime");
    const handoffStore = new RuntimeOperatorHandoffStore(runtimeRoot);
    await handoffStore.create({
      handoff_id: "handoff-http",
      goal_id: "goal-1",
      triggers: ["deadline", "finalization"],
      title: "Deadline handoff",
      summary: "Deadline finalization requires review.",
      current_status: "mode=finalization",
      recommended_action: "Approve finalization.",
      next_action: {
        label: "Approve finalization",
        approval_required: true,
      },
    });
    const server = new EventServer(
      createMockDriveSystem() as never,
      {
        port: 0,
        eventsDir: path.join(tmpDir, "events"),
        runtimeRoot,
      }
    );

    try {
      await server.start();
      const result = await request(server.getPort(), "POST", "/goals/goal-1/approve", {
        requestId: "handoff-http",
        approved: true,
      }, server.getAuthToken());

      expect(result.status).toBe(200);
      expect(await handoffStore.listOpen()).toEqual([]);
      expect(await handoffStore.load("handoff-http")).toMatchObject({
        status: "approved",
        resolved_at: expect.any(String),
      });
    } finally {
      await server.stop();
    }
  }, 15_000);

  it("resolves both ApprovalBroker and durable handoff when they share a handoff request id", async () => {
    const runtimeRoot = path.join(tmpDir, "runtime");
    const handoffStore = new RuntimeOperatorHandoffStore(runtimeRoot);
    await handoffStore.create({
      handoff_id: "handoff-shared",
      goal_id: "goal-1",
      triggers: ["external_action"],
      title: "External action handoff",
      summary: "External action requires approval.",
      current_status: "task=pending",
      recommended_action: "Approve external action.",
      approval_request_id: "handoff-shared",
      next_action: {
        label: "Approve external action",
        approval_required: true,
      },
    });
    const broker = new ApprovalBroker({
      store: new ApprovalStore(runtimeRoot),
      createId: () => "unused-approval",
    });
    const server = new EventServer(
      createMockDriveSystem() as never,
      {
        port: 0,
        eventsDir: path.join(tmpDir, "events"),
        runtimeRoot,
        approvalBroker: broker,
      }
    );

    try {
      await server.start();
      const approval = server.requestApproval("goal-1", {
        id: "task-1",
        description: "Approve external action",
        action: "submit",
      }, { requestId: "handoff-shared" });

      const result = await request(server.getPort(), "POST", "/goals/goal-1/approve", {
        requestId: "handoff-shared",
        approved: true,
      }, server.getAuthToken());

      expect(result.status).toBe(200);
      await expect(approval).resolves.toBe(true);
      expect(await handoffStore.listOpen()).toEqual([]);
      expect(await handoffStore.load("handoff-shared")).toMatchObject({
        status: "approved",
        resolved_at: expect.any(String),
      });
    } finally {
      await server.stop();
    }
  }, 15_000);

  it("re-emits restored approvals to reconnecting SSE clients", async () => {
    const store = new ApprovalStore(tmpDir);
    const expiresAt = Date.now() + 60_000;
    await store.savePending({
      approval_id: "approval-sse",
      goal_id: "goal-sse",
      request_envelope_id: "approval-sse",
      correlation_id: "approval-sse",
      state: "pending",
      created_at: Date.now(),
      expires_at: expiresAt,
      payload: {
        task: {
          id: "task-sse",
          description: "Replayed approval",
          action: "resume",
        },
      },
    });

    const broker = new ApprovalBroker({ store });
    const server = new EventServer(
      createMockDriveSystem() as never,
      {
        port: 0,
        eventsDir: path.join(tmpDir, "events"),
        approvalBroker: broker,
      }
    );

    try {
      await server.start();
      const event = await waitForSseEvent(server.getPort(), "approval_required", server.getAuthToken());
      expect(event).toEqual(expect.objectContaining({
        requestId: "approval-sse",
        goalId: "goal-sse",
        task: {
          id: "task-sse",
          description: "Replayed approval",
          action: "resume",
        },
        expiresAt,
        restored: true,
        approval_prompt: expect.objectContaining({
          approval_id: "approval-sse",
          approve_binding_id: expect.stringMatching(/^sab:/),
          reject_binding_id: expect.stringMatching(/^sab:/),
        }),
        surface_projection: expect.objectContaining({
          surface: "approval",
          view: "normal",
          normal_view: expect.objectContaining({
            redaction: expect.objectContaining({
              raw_trace_ids_visible: false,
              operator_refs_visible: false,
            }),
          }),
        }),
      }));
    } finally {
      await server.stop();
    }
  });

  it("hydrates restored approvals for SSE when broker is attached after server start", async () => {
    const store = new ApprovalStore(tmpDir);
    const expiresAt = Date.now() + 60_000;
    await store.savePending({
      approval_id: "approval-late-broker",
      goal_id: "goal-sse",
      request_envelope_id: "approval-late-broker",
      correlation_id: "approval-late-broker",
      state: "pending",
      created_at: Date.now(),
      expires_at: expiresAt,
      payload: {
        task: {
          id: "task-late-broker",
          description: "Replayed after late broker attach",
          action: "resume",
        },
      },
    });

    const broker = new ApprovalBroker({ store });
    const server = new EventServer(
      createMockDriveSystem() as never,
      {
        port: 0,
        eventsDir: path.join(tmpDir, "events"),
      }
    );

    try {
      await server.start();
      server.setApprovalBroker(broker);

      const event = await waitForSseEvent(server.getPort(), "approval_required", server.getAuthToken());
      expect(event).toEqual(expect.objectContaining({
        requestId: "approval-late-broker",
        goalId: "goal-sse",
        task: {
          id: "task-late-broker",
          description: "Replayed after late broker attach",
          action: "resume",
        },
        expiresAt,
        restored: true,
        approval_prompt: expect.objectContaining({
          approval_id: "approval-late-broker",
          approve_binding_id: expect.stringMatching(/^sab:/),
          reject_binding_id: expect.stringMatching(/^sab:/),
        }),
        surface_projection: expect.objectContaining({
          surface: "approval",
          view: "normal",
          normal_view: expect.objectContaining({
            redaction: expect.objectContaining({
              raw_trace_ids_visible: false,
              operator_refs_visible: false,
            }),
          }),
        }),
      }));
    } finally {
      await server.stop();
    }
  });
});
