import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  EVENT_SPOOL_MAX_FILE_BYTES,
  assertEventSpoolJsonFileName,
  listEventSpoolJsonFiles,
  moveEventSpoolFile,
  pruneEventSpoolDirectory,
  writeEventSpoolJson,
} from "../event-spool.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";

describe("event spool utilities", () => {
  it("accepts only bounded event spool JSON filenames", () => {
    expect(() => assertEventSpoolJsonFileName("event_1.json")).not.toThrow();
    expect(() => assertEventSpoolJsonFileName("daemon-token.json")).toThrow("Unsafe event spool filename");
    expect(() => assertEventSpoolJsonFileName("../event.json")).toThrow("Unsafe event spool filename");
    expect(() => assertEventSpoolJsonFileName("event.json.tmp")).toThrow("Unsafe event spool filename");
  });

  it("writes atomic bounded payloads and enforces pending file limits", async () => {
    const dir = makeTempDir();
    try {
      const first = await writeEventSpoolJson(dir, { ok: true }, { prefix: "test", maxPendingFiles: 2 });
      const second = await writeEventSpoolJson(dir, { ok: true }, { prefix: "test", maxPendingFiles: 2 });

      expect(first).toMatch(/^test_.*\.json$/);
      expect(second).toMatch(/^test_.*\.json$/);
      await expect(
        writeEventSpoolJson(dir, { ok: true }, { prefix: "test", maxPendingFiles: 2 })
      ).rejects.toThrow("pending file limit");
      expect(await listEventSpoolJsonFiles(dir)).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects oversized event payloads before writing", async () => {
    const dir = makeTempDir();
    try {
      await expect(
        writeEventSpoolJson(dir, { body: "x".repeat(EVENT_SPOOL_MAX_FILE_BYTES + 1) })
      ).rejects.toThrow("exceeds");
      expect(await listEventSpoolJsonFiles(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves explicit spool filenames for compatibility surfaces", async () => {
    const dir = makeTempDir();
    try {
      const fileName = await writeEventSpoolJson(dir, { ok: true }, { fileName: "explicit.json" });

      expect(fileName).toBe("explicit.json");
      expect(fs.existsSync(path.join(dir, "explicit.json"))).toBe(true);
      await expect(
        writeEventSpoolJson(dir, { ok: true }, { fileName: "../explicit.json" })
      ).rejects.toThrow("Unsafe event spool filename");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("moves event files without overwriting retained spool files", async () => {
    const dir = makeTempDir();
    try {
      const archiveDir = path.join(dir, "archive");
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(path.join(dir, "event.json"), "{}", "utf-8");
      fs.writeFileSync(path.join(archiveDir, "event.json"), "{\"old\":true}", "utf-8");

      const archivedName = await moveEventSpoolFile(dir, "event.json", archiveDir);

      expect(archivedName).not.toBe("event.json");
      expect(fs.readFileSync(path.join(archiveDir, "event.json"), "utf-8")).toBe("{\"old\":true}");
      expect(fs.existsSync(path.join(archiveDir, archivedName))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prunes retained event spool directories by age and count", async () => {
    const dir = makeTempDir();
    try {
      const oldTime = new Date(Date.now() - 10_000);
      for (const fileName of ["old.json", "new-a.json", "new-b.json"]) {
        fs.writeFileSync(path.join(dir, fileName), "{}", "utf-8");
      }
      fs.utimesSync(path.join(dir, "old.json"), oldTime, oldTime);

      const removed = await pruneEventSpoolDirectory(dir, {
        now: Date.now(),
        maxAgeMs: 1_000,
        maxFiles: 1,
      });

      expect(removed).toBe(2);
      expect(await listEventSpoolJsonFiles(dir)).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
