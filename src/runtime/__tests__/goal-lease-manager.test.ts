import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";
import { GoalLeaseManager } from "../goal-lease-manager.js";

describe("GoalLeaseManager", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
  });

  it("acquire writes a goal lease record and read returns it", async () => {
    tmpDir = makeTempDir();
    const manager = new GoalLeaseManager(tmpDir, 1_000);

    const record = await manager.acquire("goal-1", {
      workerId: "worker-a",
      ownerToken: "owner-a",
      attemptId: "attempt-a",
      now: 1000,
    });

    expect(record).not.toBeNull();
    expect(record!.goal_id).toBe("goal-1");
    expect(record!.lease_until).toBe(2000);
    expect(await manager.read("goal-1")).toEqual(record);
  });

  it("blocks a second active acquire for the same goal", async () => {
    tmpDir = makeTempDir();
    const manager = new GoalLeaseManager(tmpDir, 1_000);

    const first = await manager.acquire("goal-1", {
      workerId: "worker-a",
      ownerToken: "owner-a",
      attemptId: "attempt-a",
      now: 1000,
    });

    const second = await manager.acquire("goal-1", {
      workerId: "worker-b",
      ownerToken: "owner-b",
      attemptId: "attempt-b",
      now: 1500,
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("renew extends the lease only for the matching owner", async () => {
    tmpDir = makeTempDir();
    const manager = new GoalLeaseManager(tmpDir, 1_000);

    const acquired = await manager.acquire("goal-1", {
      workerId: "worker-a",
      ownerToken: "owner-a",
      attemptId: "attempt-a",
      now: 1000,
    });

    const renewed = await manager.renew("goal-1", "owner-a", { now: 1500, leaseMs: 2_000 });
    expect(renewed).not.toBeNull();
    expect(renewed!.lease_until).toBe(3500);
    expect(renewed!.attempt_id).toBe(acquired!.attempt_id);
    expect(await manager.renew("goal-1", "wrong-owner", { now: 1600 })).toBeNull();
  });

  it("release removes the lease only for the matching owner", async () => {
    tmpDir = makeTempDir();
    const manager = new GoalLeaseManager(tmpDir, 1_000);

    const acquired = await manager.acquire("goal-1", {
      workerId: "worker-a",
      ownerToken: "owner-a",
      attemptId: "attempt-a",
      now: 1000,
    });

    expect(await manager.release("goal-1", "wrong-owner")).toBe(false);
    expect(await manager.read("goal-1")).not.toBeNull();

    expect(await manager.release("goal-1", acquired!.owner_token)).toBe(true);
    expect(await manager.read("goal-1")).toBeNull();
  });

  it("acquire reclaims an expired lease", async () => {
    tmpDir = makeTempDir();
    const manager = new GoalLeaseManager(tmpDir, 1_000);

    await manager.acquire("goal-1", {
      workerId: "worker-a",
      ownerToken: "owner-a",
      attemptId: "attempt-a",
      now: 1000,
    });

    const reclaimed = await manager.acquire("goal-1", {
      workerId: "worker-b",
      ownerToken: "owner-b",
      attemptId: "attempt-b",
      now: 2500,
    });

    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.owner_token).toBe("owner-b");
  });

  it("reapStale removes only expired goal leases", async () => {
    tmpDir = makeTempDir();
    const manager = new GoalLeaseManager(tmpDir, 1_000);

    await manager.acquire("goal-live", {
      workerId: "worker-a",
      ownerToken: "owner-a",
      attemptId: "attempt-a",
      leaseMs: 5_000,
      now: 1000,
    });
    await manager.acquire("goal-dead", {
      workerId: "worker-b",
      ownerToken: "owner-b",
      attemptId: "attempt-b",
      now: 1000,
    });

    const removed = await manager.reapStale(2500);
    expect(removed.map((record) => record.goal_id)).toEqual(["goal-dead"]);
    expect(await manager.read("goal-live")).not.toBeNull();
    expect(await manager.read("goal-dead")).toBeNull();
  });

  it("does not leave tmp files after writes", async () => {
    tmpDir = makeTempDir();
    const manager = new GoalLeaseManager(tmpDir, 1_000);

    await manager.acquire("goal-1", {
      workerId: "worker-a",
      ownerToken: "owner-a",
      attemptId: "attempt-a",
      now: 1000,
    });
    await manager.renew("goal-1", "owner-a", { now: 1100 });

    const goalDir = path.join(tmpDir, "leases", "goal");
    const files = fs.readdirSync(goalDir);
    expect(files.some((file) => file.includes(".tmp"))).toBe(false);
  });

  it("resolves a relative runtime root to an absolute path", async () => {
    tmpDir = makeTempDir();
    const relativeRoot = path.relative(process.cwd(), tmpDir);
    const manager = new GoalLeaseManager(relativeRoot, 1_000);

    await manager.acquire("goal-1", {
      workerId: "worker-a",
      ownerToken: "owner-a",
      attemptId: "attempt-a",
      now: 1000,
    });

    expect(fs.existsSync(path.join(tmpDir, "leases", "goal", "goal-1.json"))).toBe(true);
  });
});
