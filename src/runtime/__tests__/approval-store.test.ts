import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ApprovalStore } from "../store/approval-store.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";
import { ApprovalRecordSchema } from "../store/runtime-schemas.js";

describe("ApprovalStore", () => {
  let tmpDir: string;
  let store: ApprovalStore;

  beforeEach(() => {
    tmpDir = makeTempDir();
    store = new ApprovalStore(tmpDir);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  function makeApproval(overrides: Record<string, unknown> = {}) {
    return ApprovalRecordSchema.parse({
      approval_id: "approval-1",
      goal_id: "goal-1",
      request_envelope_id: "msg-1",
      correlation_id: "corr-1",
      state: "pending",
      created_at: 1,
      expires_at: 2,
      payload: { prompt: "approve?" },
      ...overrides,
    });
  }

  it("initializes the control database and stores pending approvals", async () => {
    await store.ensureReady();
    const record = makeApproval();
    const saved = await store.savePending(record);
    expect(saved.state).toBe("pending");
    expect(await store.load("approval-1")).not.toBeNull();
    expect(fs.existsSync(path.join(tmpDir, "state", "pulseed-control.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "approvals", "pending", "approval-1.json"))).toBe(false);
  });

  it("rejects unsafe approval timestamps before persistence", async () => {
    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;

    expect(ApprovalRecordSchema.safeParse({
      approval_id: "approval-unsafe",
      request_envelope_id: "msg-1",
      correlation_id: "corr-1",
      state: "pending",
      created_at: unsafeInteger,
      expires_at: 2,
      payload: { prompt: "approve?" },
    }).success).toBe(false);

    await expect(store.savePending({
      ...makeApproval({ approval_id: "approval-unsafe" }),
      expires_at: unsafeInteger,
    })).rejects.toThrow();

    expect(fs.existsSync(path.join(tmpDir, "approvals", "pending", "approval-unsafe.json"))).toBe(false);
  });

  it("does not read legacy pending approval JSON on the normal store path", async () => {
    fs.mkdirSync(path.join(tmpDir, "approvals", "pending"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "approvals", "pending", "approval-legacy.json"),
      JSON.stringify(makeApproval({ approval_id: "approval-legacy" }), null, 2),
      "utf-8",
    );

    await expect(store.loadPending("approval-legacy")).resolves.toBeNull();
    await expect(store.listPending()).resolves.toEqual([]);
  });

  it("resolves a pending approval into the resolved directory", async () => {
    await store.savePending(makeApproval());
    const resolved = await store.resolvePending("approval-1", {
      state: "approved",
      resolved_at: 10,
      response_channel: "chat-1",
      payload: { decision: "yes" },
    });

    expect(resolved?.state).toBe("approved");
    expect(await store.loadPending("approval-1")).toBeNull();
    expect(await store.loadResolved("approval-1")).not.toBeNull();
    expect(await store.load("approval-1")).toMatchObject({ state: "approved" });
  });

  it("rejects unsafe approval resolution timestamps without removing the pending record", async () => {
    await store.savePending(makeApproval());

    await expect(store.resolvePending("approval-1", {
      state: "approved",
      resolved_at: Number.MAX_SAFE_INTEGER + 1,
    })).rejects.toThrow();

    await expect(store.loadPending("approval-1")).resolves.toMatchObject({
      approval_id: "approval-1",
      state: "pending",
    });
    await expect(store.loadResolved("approval-1")).resolves.toBeNull();
  });

  it("listPending hides approvals that already have a resolved record", async () => {
    const pending = makeApproval({ approval_id: "approval-1" });
    await store.savePending(pending);
    await store.saveResolved({ ...pending, state: "approved", resolved_at: 10 });

    const pendingList = await store.listPending();
    expect(pendingList).toEqual([]);
    expect(await store.loadPending("approval-1")).toBeNull();
    expect(await store.loadResolved("approval-1")).not.toBeNull();
  });

  it("keeps the resolved record authoritative after restart-like re-save", async () => {
    const pending = makeApproval();
    await store.savePending(pending);
    await store.resolvePending("approval-1", { state: "denied" });

    const reloaded = new ApprovalStore(tmpDir);
    const overwritten = await reloaded.savePending(pending);

    expect(overwritten.state).toBe("denied");
    expect(await reloaded.loadPending("approval-1")).toBeNull();
    expect(await reloaded.listResolved()).toHaveLength(1);
  });

  it("serializes concurrent resolvePending calls and avoids overwrite or throw", async () => {
    await store.savePending(makeApproval());

    const [first, second] = await Promise.all([
      store.resolvePending("approval-1", { state: "approved", resolved_at: 11 }),
      store.resolvePending("approval-1", { state: "denied", resolved_at: 12 }),
    ]);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.approval_id).toBe("approval-1");
    expect(second?.approval_id).toBe("approval-1");
    expect(await store.loadPending("approval-1")).toBeNull();
    expect(await store.listResolved()).toHaveLength(1);
    expect((await store.loadResolved("approval-1"))?.state).toMatch(/approved|denied/);
  });

  it("keeps resolved rows authoritative when pending saves replay after resolution", async () => {
    const pending = makeApproval();
    await store.savePending(pending);
    await store.resolvePending("approval-1", { state: "approved", resolved_at: 10 });

    const replayed = await store.savePending(pending);

    expect(replayed.state).toBe("approved");
    expect(await store.loadPending("approval-1")).toBeNull();
    expect(await store.loadResolved("approval-1")).toMatchObject({ state: "approved" });
    expect(fs.existsSync(path.join(tmpDir, "approvals", "pending", "approval-1.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "approvals", "resolved", "approval-1.json"))).toBe(false);
  });
});
