import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import {
  writeSnapshot,
  loadLatestSnapshot,
  listSnapshots,
  deleteOldSnapshots,
} from "../state-snapshot.js";

describe("state-snapshot", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("snapshot-test-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("writeSnapshot + loadLatestSnapshot round-trip", async () => {
    const data = { value: 42, label: "test" };
    const filename = await writeSnapshot("goal-1", tmpDir, data);
    expect(filename).toMatch(/\.json$/);

    const result = await loadLatestSnapshot("goal-1", tmpDir);
    expect(result).not.toBeNull();
    expect(result!.data).toEqual(data);
    expect(result!.ts).toBeTruthy();
  });

  it("loadLatestSnapshot returns most recent when multiple exist", async () => {
    await writeSnapshot("goal-2", tmpDir, { version: 1 });
    await new Promise((r) => setTimeout(r, 10));
    await writeSnapshot("goal-2", tmpDir, { version: 2 });
    await new Promise((r) => setTimeout(r, 10));
    await writeSnapshot("goal-2", tmpDir, { version: 3 });

    const result = await loadLatestSnapshot("goal-2", tmpDir);
    expect(result).not.toBeNull();
    expect((result!.data as { version: number }).version).toBe(3);
  });

  it("skips malformed parsed snapshot records and returns the newest valid one", async () => {
    const dir = path.join(tmpDir, "goals", "goal-malformed", "snapshots");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "2026-01-01T00-00-00.000Z.json"),
      JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", data: { version: 1 } }),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(dir, "2026-01-01T00-00-01.000Z.json"),
      JSON.stringify({ ts: 123, data: { version: 2 } }),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(dir, "2026-01-01T00-00-02.000Z.json"),
      JSON.stringify({ ts: "2026-02-31T00:00:00.000Z", data: { version: 3 } }),
      "utf-8"
    );

    const result = await loadLatestSnapshot("goal-malformed", tmpDir);

    expect(result).not.toBeNull();
    expect(result!.ts).toBe("2026-01-01T00:00:00.000Z");
    expect(result!.data).toEqual({ version: 1 });
  });

  it("returns null when parsed snapshot records are all malformed", async () => {
    const dir = path.join(tmpDir, "goals", "goal-invalid-only", "snapshots");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "2026-01-01T00-00-00.000Z.json"), JSON.stringify([]), "utf-8");
    fs.writeFileSync(
      path.join(dir, "2026-01-01T00-00-01.000Z.json"),
      JSON.stringify({ ts: "not-a-date", data: { version: 2 } }),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(dir, "2026-01-01T00-00-02.000Z.json"),
      JSON.stringify({ ts: "2026-01-01T00:00:02.000Z" }),
      "utf-8"
    );

    await expect(loadLatestSnapshot("goal-invalid-only", tmpDir)).resolves.toBeNull();
  });

  it("listSnapshots returns sorted ascending list", async () => {
    await writeSnapshot("goal-3", tmpDir, { n: 1 });
    await new Promise((r) => setTimeout(r, 10));
    await writeSnapshot("goal-3", tmpDir, { n: 2 });
    await new Promise((r) => setTimeout(r, 10));
    await writeSnapshot("goal-3", tmpDir, { n: 3 });

    const list = await listSnapshots("goal-3", tmpDir);
    expect(list).toHaveLength(3);
    expect(list[0] < list[1]).toBe(true);
    expect(list[1] < list[2]).toBe(true);
  });

  it("deleteOldSnapshots keeps only the N most recent", async () => {
    for (let i = 0; i < 7; i++) {
      await writeSnapshot("goal-4", tmpDir, { i });
      await new Promise((r) => setTimeout(r, 5));
    }

    const deleted = await deleteOldSnapshots("goal-4", tmpDir, 3);
    expect(deleted).toBe(4);

    const remaining = await listSnapshots("goal-4", tmpDir);
    expect(remaining).toHaveLength(3);
  });

  it("loadLatestSnapshot returns null when dir does not exist", async () => {
    const result = await loadLatestSnapshot("nonexistent", tmpDir);
    expect(result).toBeNull();
  });

  it("listSnapshots returns [] when dir does not exist", async () => {
    const list = await listSnapshots("nonexistent", tmpDir);
    expect(list).toEqual([]);
  });

  it("deleteOldSnapshots returns 0 when no snapshots exist", async () => {
    const deleted = await deleteOldSnapshots("nonexistent", tmpDir, 5);
    expect(deleted).toBe(0);
  });

  it("snapshot data integrity: complex objects survive round-trip", async () => {
    const data = {
      nested: { a: [1, 2, 3], b: { c: true } },
      timestamp: "2026-01-01T00:00:00.000Z",
      count: 99,
    };
    await writeSnapshot("goal-5", tmpDir, data);
    const result = await loadLatestSnapshot("goal-5", tmpDir);
    expect(result!.data).toEqual(data);
  });
});
