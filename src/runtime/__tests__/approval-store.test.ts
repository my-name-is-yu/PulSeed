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

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it("creates directories and stores pending approvals", async () => {
    await store.ensureReady();
    const record = makeApproval();
    const saved = await store.savePending(record);
    expect(saved.state).toBe("pending");
    expect(await store.load("approval-1")).not.toBeNull();
    expect(fs.existsSync(path.join(tmpDir, "approvals", "pending", "approval-1.json"))).toBe(true);
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

  it("listPending hides approvals that already have a resolved record", async () => {
    const pending = makeApproval({ approval_id: "approval-1" });
    await store.savePending(pending);
    await store.saveResolved({ ...pending, state: "approved", resolved_at: 10 });

    const pendingList = await store.listPending();
    expect(pendingList).toEqual([]);
    expect(await store.loadPending("approval-1")).not.toBeNull();
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

  it("keeps resolvePending authoritative when savePending races with it", async () => {
    const pending = makeApproval();
    const pendingPath = path.join(tmpDir, "approvals", "pending", "approval-1.json");
    const resolvedPath = path.join(tmpDir, "approvals", "resolved", "approval-1.json");
    const originalJournal = (store as any).journal;
    const originalSave = originalJournal.save.bind(originalJournal);

    await originalSave(pendingPath, ApprovalRecordSchema, pending);

    let releasePendingSave: (() => void) | undefined;
    let pendingSaveEntered = false;
    const pendingSaveGate = new Promise<void>((resolve) => {
      releasePendingSave = resolve;
    });

    originalJournal.save = async (filePath: string, schema: unknown, value: unknown) => {
      if (filePath === pendingPath) {
        pendingSaveEntered = true;
        await pendingSaveGate;
      }
      return originalSave(filePath, schema, value);
    };

    try {
      const savePromise = store.savePending(pending);

      for (let i = 0; i < 100; i += 1) {
        if (pendingSaveEntered) break;
        await sleep(1);
      }
      expect(pendingSaveEntered).toBe(true);

      const resolvePromise = store.resolvePending("approval-1", { state: "approved", resolved_at: 10 });

      await sleep(20);
      expect(await Promise.race([resolvePromise.then(() => true), sleep(1).then(() => false)])).toBe(false);

      releasePendingSave?.();

      const [, resolved] = await Promise.all([savePromise, resolvePromise]);
      expect(resolved?.state).toBe("approved");
      expect(await store.loadPending("approval-1")).toBeNull();
      expect(await store.loadResolved("approval-1")).toMatchObject({ state: "approved" });
      expect(fs.existsSync(pendingPath)).toBe(false);
      expect(fs.existsSync(resolvedPath)).toBe(true);
    } finally {
      originalJournal.save = originalSave;
      releasePendingSave?.();
    }
  });
});
