import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod/v3";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import {
  isTextFileSizeLimitError,
  readJsonFileOrNull,
  readJsonFileWithSchema,
  readTextFileWithinLimit,
  readTextFileWithinLimitSync,
  writeJsonFileAtomic,
} from "../json-io.js";

describe("json-io", () => {
  it("supports concurrent atomic writes to the same file without temp collisions", async () => {
    const tmpDir = makeTempDir("pulseed-json-io-");
    try {
      const filePath = path.join(tmpDir, "state.json");

      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          writeJsonFileAtomic(filePath, { index })
        )
      );

      const result = await readJsonFileOrNull<{ index: number }>(filePath);
      expect(result).not.toBeNull();
      expect(typeof result!.index).toBe("number");
      expect(fs.readdirSync(tmpDir).filter((file) => file.endsWith(".tmp"))).toEqual([]);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("applies requested file and parent directory modes", async () => {
    const tmpDir = makeTempDir("pulseed-json-io-mode-");
    try {
      const privateDir = path.join(tmpDir, "private");
      const filePath = path.join(privateDir, "provider.json");

      await writeJsonFileAtomic(filePath, { api_key: "sk-test" }, {
        mode: 0o600,
        directoryMode: 0o700,
      });

      expect(fs.statSync(privateDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("returns null for absent or invalid JSON files", async () => {
    const tmpDir = makeTempDir("pulseed-json-io-null-");
    try {
      const missingPath = path.join(tmpDir, "missing.json");
      const invalidPath = path.join(tmpDir, "invalid.json");
      fs.writeFileSync(invalidPath, "{not-json", "utf-8");

      await expect(readJsonFileOrNull(missingPath)).resolves.toBeNull();
      await expect(readJsonFileOrNull(invalidPath)).resolves.toBeNull();
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("rethrows non-missing read errors instead of treating them as absent JSON", async () => {
    const tmpDir = makeTempDir("pulseed-json-io-eisdir-");
    try {
      const directoryPath = path.join(tmpDir, "state.json");
      fs.mkdirSync(directoryPath);

      await expect(readJsonFileOrNull(directoryPath)).rejects.toMatchObject({
        code: "EISDIR",
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("preserves schema validation null semantics while surfacing read failures", async () => {
    const tmpDir = makeTempDir("pulseed-json-io-schema-");
    try {
      const schema = z.object({ ok: z.boolean() });
      const invalidShapePath = path.join(tmpDir, "invalid-shape.json");
      const directoryPath = path.join(tmpDir, "directory.json");
      fs.writeFileSync(invalidShapePath, JSON.stringify({ ok: "yes" }), "utf-8");
      fs.mkdirSync(directoryPath);

      await expect(readJsonFileWithSchema(invalidShapePath, schema)).resolves.toBeNull();
      await expect(readJsonFileWithSchema(directoryPath, schema)).rejects.toMatchObject({
        code: "EISDIR",
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("reads text files up to the exact byte limit", async () => {
    const tmpDir = makeTempDir("pulseed-json-io-limit-exact-");
    try {
      const filePath = path.join(tmpDir, "payload.json");
      fs.writeFileSync(filePath, "abcde", "utf-8");

      await expect(readTextFileWithinLimit(filePath, { maxBytes: 5, chunkBytes: 2 })).resolves.toBe("abcde");
      expect(readTextFileWithinLimitSync(filePath, { maxBytes: 5, chunkBytes: 2 })).toBe("abcde");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("rejects oversized async reads after the byte cap", async () => {
    const tmpDir = makeTempDir("pulseed-json-io-limit-async-");
    try {
      const filePath = path.join(tmpDir, "payload.json");
      fs.writeFileSync(filePath, "abcdef", "utf-8");

      let caught: unknown;
      try {
        await readTextFileWithinLimit(filePath, { maxBytes: 5, chunkBytes: 2 });
      } catch (err) {
        caught = err;
      }

      expect(isTextFileSizeLimitError(caught)).toBe(true);
      expect(caught).toMatchObject({ filePath, maxBytes: 5 });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("rejects oversized sync reads after the byte cap", () => {
    const tmpDir = makeTempDir("pulseed-json-io-limit-sync-");
    try {
      const filePath = path.join(tmpDir, "payload.json");
      fs.writeFileSync(filePath, "abcdef", "utf-8");

      let caught: unknown;
      try {
        readTextFileWithinLimitSync(filePath, { maxBytes: 5, chunkBytes: 2 });
      } catch (err) {
        caught = err;
      }

      expect(isTextFileSizeLimitError(caught)).toBe(true);
      expect(caught).toMatchObject({ filePath, maxBytes: 5 });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });
});
