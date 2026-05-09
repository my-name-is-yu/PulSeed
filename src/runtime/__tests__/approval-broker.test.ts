import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalBroker } from "../approval-broker.js";
import { ApprovalStore } from "../store/approval-store.js";
import { PermissionWaitPlanStore, type PermissionWaitCanonicalPlan } from "../store/permission-wait-plan-store.js";
import { createRuntimeStorePaths } from "../store/runtime-paths.js";
import type { ApprovalRecord } from "../store/runtime-schemas.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";

async function waitForFile(filePath: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
}

async function waitForBroadcast(
  broadcast: ReturnType<typeof vi.fn>,
  eventType: string,
  requestId: string,
  timeoutMs = 1000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (broadcast.mock.calls.some(([type, payload]) =>
      type === eventType &&
      typeof payload === "object" &&
      payload !== null &&
      "requestId" in payload &&
      payload.requestId === requestId
    )) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for broadcast: ${eventType}:${requestId}`);
}

function makeWaitPlan(): PermissionWaitCanonicalPlan {
  return {
    schema_version: "permission-wait-canonical-plan-v1",
    tool_name: "write-tool",
    input: { value: "ship" },
    cwd: "/repo",
    target: {
      goal_id: "goal-1",
      session_id: "session-1",
      tool_call_id: "call-1",
    },
    permission: {
      permission_level: "write_local",
      is_destructive: false,
      reversibility: "reversible",
    },
    state_epoch: "epoch-1",
    capability_facts: {
      tool_permission_level: "write_local",
      tool_is_read_only: false,
      tool_is_destructive: false,
      tool_tags: [],
      host_decision_status: "needs_permission",
    },
  };
}

describe("ApprovalBroker", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      cleanupTempDir(tmpDir);
      tmpDir = null;
    }
  });

  it("persists pending approvals and resolves live requests", async () => {
    tmpDir = makeTempDir();
    const store = new ApprovalStore(tmpDir);
    const paths = createRuntimeStorePaths(tmpDir);
    const broadcast = vi.fn();
    const broker = new ApprovalBroker({
      store,
      broadcast,
      createId: () => "approval-live",
    });

    const request = broker.requestApproval("goal-1", {
      id: "task-1",
      description: "Review deployment plan",
      action: "deploy",
    });

    await waitForFile(
      paths.approvalPendingPath("approval-live")
    );
    const pending = await store.loadPending("approval-live");
    expect(pending?.state).toBe("pending");
    await waitForBroadcast(broadcast, "approval_required", "approval-live");

    await expect(broker.resolveApproval("approval-live", true, "tui")).resolves.toBe(true);
    await expect(request).resolves.toBe(true);

    expect(await store.loadPending("approval-live")).toBeNull();

    const resolvedPath = paths.approvalResolvedPath("approval-live");
    const resolved = JSON.parse(fs.readFileSync(resolvedPath, "utf-8")) as ApprovalRecord;
    expect(resolved.state).toBe("approved");
    expect(resolved.response_channel).toBe("tui");
    expect(broadcast).toHaveBeenCalledWith(
      "approval_required",
      expect.objectContaining({ requestId: "approval-live", restored: false })
    );
    expect(broadcast).toHaveBeenCalledWith(
      "approval_resolved",
      expect.objectContaining({ requestId: "approval-live", approved: true })
    );
  });

  it("expires pending conversational approval records instead of resolving late replies", async () => {
    tmpDir = makeTempDir();
    const store = new ApprovalStore(tmpDir);
    const broker = new ApprovalBroker({
      store,
      createId: () => "approval-expired",
      defaultTimeoutMs: 5,
      deliverConversationalApproval: async () => ({ delivered: true }),
    });
    const origin = {
      channel: "slack",
      conversation_id: "thread-1",
      user_id: "user-1",
      session_id: "session-1",
      turn_id: "turn-1",
    };

    const request = broker.requestConversationalApproval("goal-1", {
      id: "task-expired",
      description: "Restart daemon",
      action: "restart",
    }, {
      origin,
    });

    await expect(request).resolves.toBe(false);
    await expect(store.loadPending("approval-expired")).resolves.toBeNull();
    await expect(store.loadResolved("approval-expired")).resolves.toMatchObject({
      state: "expired",
    });
    await expect(broker.resolveConversationalApproval("approval-expired", true, origin)).resolves.toBe(false);
  });

  it("resolves requests when approval arrives while pending save is in flight", async () => {
    tmpDir = makeTempDir();

    let markSaveStarted: () => void = () => undefined;
    let releaseSave: () => void = () => undefined;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    class SlowApprovalStore extends ApprovalStore {
      override async savePending(record: ApprovalRecord): Promise<ApprovalRecord> {
        markSaveStarted();
        await saveGate;
        return super.savePending(record);
      }
    }

    const store = new SlowApprovalStore(tmpDir);
    const broadcast = vi.fn();
    const broker = new ApprovalBroker({
      store,
      broadcast,
      createId: () => "approval-race",
    });

    const request = broker.requestApproval("goal-1", {
      id: "task-race",
      description: "Approve while saving",
      action: "race",
    });

    await saveStarted;
    const resolved = broker.resolveApproval("approval-race", true, "http");
    await Promise.resolve();
    expect(broker.getPendingApprovalEvents()).toEqual([]);
    releaseSave();

    await expect(resolved).resolves.toBe(true);
    await expect(request).resolves.toBe(true);
    expect(broadcast).not.toHaveBeenCalledWith(
      "approval_required",
      expect.objectContaining({ requestId: "approval-race" })
    );
    expect(broadcast).toHaveBeenCalledWith(
      "approval_resolved",
      expect.objectContaining({ requestId: "approval-race", approved: true })
    );
  });

  it("restores pending approvals from durable storage", async () => {
    tmpDir = makeTempDir();
    const store = new ApprovalStore(tmpDir);
    const paths = createRuntimeStorePaths(tmpDir);
    const expiresAt = Date.now() + 60_000;
    await store.savePending({
      approval_id: "approval-restored",
      goal_id: "goal-2",
      request_envelope_id: "approval-restored",
      correlation_id: "approval-restored",
      state: "pending",
      created_at: Date.now(),
      expires_at: expiresAt,
      payload: {
        task: {
          id: "task-2",
          description: "Approve restored change",
          action: "apply",
        },
      },
    });

    const broker = new ApprovalBroker({ store });
    await broker.start();

    expect(broker.getPendingApprovalEvents()).toEqual([
      {
        requestId: "approval-restored",
        goalId: "goal-2",
        task: {
          id: "task-2",
          description: "Approve restored change",
          action: "apply",
        },
        expiresAt,
        restored: true,
      },
    ]);

    await expect(broker.resolveApproval("approval-restored", false, "http")).resolves.toBe(true);

    const resolvedPath = paths.approvalResolvedPath("approval-restored");
    const resolved = JSON.parse(fs.readFileSync(resolvedPath, "utf-8")) as ApprovalRecord;
    expect(resolved.state).toBe("denied");
    expect(resolved.response_channel).toBe("http");
  });

  it("does not restore invalid permission task expiry metadata into approval events", async () => {
    tmpDir = makeTempDir();
    const store = new ApprovalStore(tmpDir);
    const expiresAt = 10_000;
    await store.savePending({
      approval_id: "approval-unsafe-permission-expiry",
      goal_id: "goal-unsafe",
      request_envelope_id: "approval-unsafe-permission-expiry",
      correlation_id: "approval-unsafe-permission-expiry",
      state: "pending",
      created_at: 1_000,
      expires_at: expiresAt,
      payload: {
        task: {
          kind: "permission",
          id: "call-unsafe",
          description: "Write a local file",
          action: "write-tool",
          operation_summary: "Write a local file",
          risk_class: "medium",
          target: { session_id: "session-1", tool_id: "write-tool", tool_call_id: "call-unsafe" },
          state_epoch: "epoch-1",
          expires_at: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    });

    const broker = new ApprovalBroker({ store, now: () => 2_000 });
    await broker.start();

    expect(broker.getPendingApprovalEvents()).toEqual([
      {
        requestId: "approval-unsafe-permission-expiry",
        goalId: "goal-unsafe",
        task: {
          kind: "permission",
          id: "call-unsafe",
          description: "Write a local file",
          action: "write-tool",
          operation_summary: "Write a local file",
          risk_class: "medium",
          target: { session_id: "session-1", tool_id: "write-tool", tool_call_id: "call-unsafe" },
          state_epoch: "epoch-1",
        },
        expiresAt,
        restored: true,
      },
    ]);
  });

  it("does not restore invalid generic task expiry metadata into approval events", async () => {
    tmpDir = makeTempDir();
    const store = new ApprovalStore(tmpDir);
    const expiresAt = 10_000;
    await store.savePending({
      approval_id: "approval-unsafe-generic-expiry",
      goal_id: "goal-unsafe",
      request_envelope_id: "approval-unsafe-generic-expiry",
      correlation_id: "approval-unsafe-generic-expiry",
      state: "pending",
      created_at: 1_000,
      expires_at: expiresAt,
      payload: {
        task: {
          id: "task-unsafe",
          description: "Approve a generic task",
          action: "apply",
          expires_at: Number.POSITIVE_INFINITY,
        },
      },
    });

    const broker = new ApprovalBroker({ store, now: () => 2_000 });
    await broker.start();

    expect(broker.getPendingApprovalEvents()).toEqual([
      {
        requestId: "approval-unsafe-generic-expiry",
        goalId: "goal-unsafe",
        task: { id: "", description: "", action: "" },
        expiresAt,
        restored: true,
      },
    ]);
  });

  it("transitions restored permission wait plans when only nested expiry metadata is invalid", async () => {
    tmpDir = makeTempDir();
    const paths = createRuntimeStorePaths(tmpDir);
    const approvalStore = new ApprovalStore(paths);
    const waitPlanStore = new PermissionWaitPlanStore(paths);
    await waitPlanStore.createWaiting({
      wait_plan_id: "wait-unsafe-expiry",
      approval_id: "approval-unsafe-expiry-linked",
      goal_id: "goal-unsafe",
      canonical_plan: makeWaitPlan(),
    });
    await approvalStore.savePending({
      approval_id: "approval-unsafe-expiry-linked",
      goal_id: "goal-unsafe",
      request_envelope_id: "approval-unsafe-expiry-linked",
      correlation_id: "approval-unsafe-expiry-linked",
      state: "pending",
      created_at: 1_000,
      expires_at: 10_000,
      payload: {
        task: {
          kind: "permission",
          id: "call-unsafe-linked",
          description: "Write a local file",
          action: "write-tool",
          operation_summary: "Write a local file",
          risk_class: "medium",
          target: { session_id: "session-1", tool_id: "write-tool", tool_call_id: "call-unsafe-linked" },
          state_epoch: "epoch-1",
          wait_plan_id: "wait-unsafe-expiry",
          expires_at: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    });
    const broker = new ApprovalBroker({
      store: approvalStore,
      permissionWaitPlanStore: waitPlanStore,
      now: () => 2_000,
    });
    await broker.start();

    await expect(broker.resolveApproval("approval-unsafe-expiry-linked", true, "http")).resolves.toBe(true);
    expect(await waitPlanStore.load("wait-unsafe-expiry")).toMatchObject({
      state: "approved",
      audit_events: expect.arrayContaining([
        expect.objectContaining({ state: "approved" }),
      ]),
    });
  });

  it("routes conversational approvals to the originating channel with structured context", async () => {
    tmpDir = makeTempDir();
    const store = new ApprovalStore(tmpDir);
    const delivered = vi.fn(async () => ({ delivered: true }));
    const broadcast = vi.fn();
    const origin = {
      channel: "slack",
      conversation_id: "thread-1",
      user_id: "user-1",
      session_id: "session-1",
      turn_id: "turn-1",
      reply_target: { channel: "C1", thread_ts: "1700.1" },
    };
    const broker = new ApprovalBroker({
      store,
      broadcast,
      deliverConversationalApproval: delivered,
      createId: () => "approval-conversation",
    });

    const request = broker.requestConversationalApproval("goal-1", {
      id: "task-3",
      description: "Deploy production changes",
      action: "deploy",
    }, {
      origin,
    });

    await waitForBroadcast(broadcast, "approval_required", "approval-conversation");
    expect(delivered).toHaveBeenCalledWith({
      record: expect.objectContaining({
        approval_id: "approval-conversation",
        origin,
        payload: {
          task: {
            id: "task-3",
            description: "Deploy production changes",
            action: "deploy",
          },
        },
      }),
      origin,
      prompt: expect.stringContaining("Deploy production changes"),
    });
    expect(broadcast).toHaveBeenCalledWith(
      "approval_required",
      expect.objectContaining({
        requestId: "approval-conversation",
        origin,
        prompt: expect.stringContaining("Approval ID: approval-conversation"),
      })
    );

    await expect(broker.resolveConversationalApproval("approval-conversation", true, origin)).resolves.toBe(true);
    await expect(request).resolves.toBe(true);
    const resolved = await store.loadResolved("approval-conversation");
    expect(resolved).toMatchObject({
      state: "approved",
      response_channel: "slack",
      origin,
    });
  });

  it("does not resolve conversational approvals from stale or mismatched origins", async () => {
    tmpDir = makeTempDir();
    const store = new ApprovalStore(tmpDir);
    const origin = {
      channel: "telegram",
      conversation_id: "chat-1",
      user_id: "user-1",
      session_id: "session-current",
      turn_id: "turn-current",
    };
    const broker = new ApprovalBroker({
      store,
      deliverConversationalApproval: async () => ({ delivered: true }),
      createId: () => "approval-bound",
    });

    const request = broker.requestConversationalApproval("goal-1", {
      id: "task-bound",
      description: "Delete remote artifact",
      action: "delete",
    }, {
      origin,
    });
    await waitForFile(createRuntimeStorePaths(tmpDir).approvalPendingPath("approval-bound"));

    await expect(broker.resolveConversationalApproval("approval-bound", true, {
      ...origin,
      channel: "slack",
    })).resolves.toBe(false);
    await expect(broker.resolveConversationalApproval("approval-bound", true, {
      ...origin,
      user_id: "user-2",
    })).resolves.toBe(false);
    await expect(broker.resolveConversationalApproval("approval-bound", true, {
      ...origin,
      turn_id: "turn-previous",
    })).resolves.toBe(false);
    expect(await store.loadPending("approval-bound")).toMatchObject({ state: "pending", origin });

    await expect(broker.resolveConversationalApproval("approval-bound", false, origin)).resolves.toBe(true);
    await expect(request).resolves.toBe(false);
  });

  it("does not resolve conversational approvals when binding metadata is incomplete", async () => {
    tmpDir = makeTempDir();
    const store = new ApprovalStore(tmpDir);
    const broker = new ApprovalBroker({
      store,
      deliverConversationalApproval: async () => ({ delivered: true }),
      createId: () => "approval-incomplete-origin",
    });

    const request = broker.requestConversationalApproval("goal-1", {
      id: "task-incomplete-origin",
      description: "Restart daemon",
      action: "restart",
    }, {
      origin: {
        channel: "slack",
        conversation_id: "thread-1",
      },
    });
    await waitForFile(createRuntimeStorePaths(tmpDir).approvalPendingPath("approval-incomplete-origin"));

    await expect(broker.resolveConversationalApproval("approval-incomplete-origin", true, {
      channel: "slack",
      conversation_id: "thread-1",
      user_id: "user-1",
      session_id: "session-1",
      turn_id: "turn-1",
    })).resolves.toBe(false);
    expect(await store.loadPending("approval-incomplete-origin")).toMatchObject({
      state: "pending",
      origin: {
        channel: "slack",
        conversation_id: "thread-1",
      },
    });

    await expect(broker.resolveApproval("approval-incomplete-origin", false, "system")).resolves.toBe(false);
    await broker.stop();
    void request.catch(() => undefined);
  });

  it("does not let generic approval channels resolve origin-bound approvals", async () => {
    tmpDir = makeTempDir();
    const store = new ApprovalStore(tmpDir);
    const origin = {
      channel: "slack",
      conversation_id: "thread-1",
      user_id: "user-1",
      session_id: "session-1",
      turn_id: "turn-1",
    };
    const broker = new ApprovalBroker({
      store,
      deliverConversationalApproval: async () => ({ delivered: true }),
      createId: () => "approval-origin-only",
    });

    const request = broker.requestConversationalApproval("goal-1", {
      id: "task-origin-only",
      description: "Deploy production changes",
      action: "deploy",
    }, {
      origin,
    });
    await waitForFile(createRuntimeStorePaths(tmpDir).approvalPendingPath("approval-origin-only"));

    await expect(broker.resolveApproval("approval-origin-only", true, "http")).resolves.toBe(false);
    expect(await store.loadPending("approval-origin-only")).toMatchObject({ state: "pending", origin });

    await expect(broker.resolveConversationalApproval("approval-origin-only", false, origin)).resolves.toBe(true);
    await expect(request).resolves.toBe(false);
  });

  it("denies conversational approvals when the originating channel is unreachable", async () => {
    tmpDir = makeTempDir();
    const store = new ApprovalStore(tmpDir);
    const broker = new ApprovalBroker({
      store,
      deliverConversationalApproval: async () => ({
        delivered: false,
        reason: "channel_unreachable",
      }),
      createId: () => "approval-undelivered",
    });

    const request = broker.requestConversationalApproval("goal-1", {
      id: "task-undelivered",
      description: "Publish external report",
      action: "publish",
    }, {
      origin: {
        channel: "discord",
        conversation_id: "thread-1",
        user_id: "user-1",
      },
    });

    await expect(request).resolves.toBe(false);
    const resolved = await store.loadResolved("approval-undelivered");
    expect(resolved).toMatchObject({
      state: "denied",
      response_channel: "discord",
    });
  });

  it("denies conversational approvals when no delivery surface is configured", async () => {
    tmpDir = makeTempDir();
    const store = new ApprovalStore(tmpDir);
    const broker = new ApprovalBroker({
      store,
      createId: () => "approval-no-delivery",
    });

    const request = broker.requestConversationalApproval("goal-1", {
      id: "task-no-delivery",
      description: "Rotate production secret",
      action: "rotate_secret",
    }, {
      origin: {
        channel: "slack",
        conversation_id: "thread-1",
        user_id: "user-1",
        session_id: "session-1",
        turn_id: "turn-1",
      },
    });

    await expect(request).resolves.toBe(false);
    expect(await store.loadResolved("approval-no-delivery")).toMatchObject({
      state: "denied",
      response_channel: "slack",
    });
  });

  it("transitions the linked permission wait plan when approvals resolve", async () => {
    tmpDir = makeTempDir();
    const paths = createRuntimeStorePaths(tmpDir);
    const approvalStore = new ApprovalStore(paths);
    const waitPlanStore = new PermissionWaitPlanStore(paths);
    await waitPlanStore.createWaiting({
      wait_plan_id: "wait-linked",
      approval_id: "approval-linked",
      goal_id: "goal-1",
      canonical_plan: makeWaitPlan(),
    });
    const broker = new ApprovalBroker({
      store: approvalStore,
      permissionWaitPlanStore: waitPlanStore,
      createId: () => "approval-linked",
    });
    const origin = {
      channel: "chat",
      conversation_id: "conversation-1",
      user_id: "user-1",
      session_id: "session-1",
      turn_id: "turn-1",
    };

    const request = broker.requestConversationalApproval("goal-1", {
      id: "call-1",
      description: "Write a local file",
      action: "write-tool",
      kind: "permission",
      operation_summary: "Write a local file",
      risk_class: "medium",
      target: { session_id: "session-1", tool_id: "write-tool", tool_call_id: "call-1" },
      state_epoch: "epoch-1",
      wait_plan_id: "wait-linked",
    }, {
      origin,
      deliverConversationalApproval: async () => ({ delivered: true }),
    });
    await waitForFile(paths.approvalPendingPath("approval-linked"));

    await expect(broker.resolveConversationalApproval("approval-linked", true, origin)).resolves.toBe(true);
    await expect(request).resolves.toBe(true);

    expect(await waitPlanStore.load("wait-linked")).toMatchObject({
      state: "approved",
      audit_events: expect.arrayContaining([
        expect.objectContaining({ state: "approved" }),
      ]),
    });
  });
});
