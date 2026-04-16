import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../json-io.js";

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
});
