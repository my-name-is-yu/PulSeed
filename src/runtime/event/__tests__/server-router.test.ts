import type * as http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { EventServerRouter } from "../server-router.js";

function makeRequest(method: string, url = "/daemon/status"): http.IncomingMessage {
  return { method, url } as http.IncomingMessage;
}

function makeResponse(): http.ServerResponse & {
  body: string;
  statusCode: number;
} {
  const response = {
    body: "",
    headers: {} as Record<string, string>,
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
      return this;
    },
    end(body?: string) {
      this.body = body ?? "";
      this.writableEnded = true;
      return this;
    },
  };
  return response as unknown as http.ServerResponse & { body: string; statusCode: number };
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function makeRouter(overrides: Partial<ConstructorParameters<typeof EventServerRouter>[0]> = {}): EventServerRouter {
  return new EventServerRouter({
    slackEventsPath: "/slack/events",
    isSlackConfigured: () => false,
    authorizeRequest: () => true,
    handlePostSlackEvents: vi.fn(async () => {}),
    handlePostEvents: vi.fn(async () => {}),
    handlePostTriggers: vi.fn(async () => {}),
    handleGetGoals: vi.fn(async () => {}),
    handleGetSnapshot: vi.fn(async () => {}),
    handleGetGoalById: vi.fn(async () => {}),
    handleStream: vi.fn(async () => {}),
    readDaemonStateRaw: vi.fn(async () => null),
    handlePostDaemonRuntimeControl: vi.fn(async () => {}),
    handlePostScheduleRunNow: vi.fn(async () => {}),
    handleGoalAction: vi.fn(async () => {}),
    readHealthStatus: () => ({ status: "ok" }),
    ...overrides,
  });
}

describe("EventServerRouter", () => {
  it("returns a JSON 500 response when an async route handler rejects before sending headers", async () => {
    const router = makeRouter({
      readDaemonStateRaw: vi.fn(async () => {
        throw new Error("state store unavailable");
      }),
    });
    const response = makeResponse();

    router.route(makeRequest("GET"), response);
    await flushPromises();

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toMatchObject({
      error: "Internal server error",
      details: expect.stringContaining("state store unavailable"),
    });
  });

  it("does not overwrite a response already sent by a rejecting handler", async () => {
    const router = makeRouter({
      handleGetSnapshot: vi.fn(async (res) => {
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: true }));
        throw new Error("late failure");
      }),
    });
    const response = makeResponse();

    router.route(makeRequest("GET", "/snapshot"), response);
    await flushPromises();

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toEqual({ accepted: true });
  });
});
