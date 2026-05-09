import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import {
  assertNotNestedImport,
  compactTimestamp,
  ensureDirectoryWithinStateRoot,
  resolveArtifactDirectory,
  resolveReadablePath,
  stateRelativePath,
  validateSafeSegment,
} from "../long-running-runtime-paths.js";

describe("long-running runtime path helpers", () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env["PULSEED_HOME"];
    tmpHome = makeTempDir();
    process.env["PULSEED_HOME"] = tmpHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env["PULSEED_HOME"];
    } else {
      process.env["PULSEED_HOME"] = originalHome;
    }
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("resolves readable paths relative to the caller cwd", () => {
    expect(resolveReadablePath("result.json", "/tmp/work")).toBe(path.resolve("/tmp/work/result.json"));
    expect(resolveReadablePath("/tmp/result.json", "/tmp/work")).toBe(path.resolve("/tmp/result.json"));
  });

  it("creates artifact directories only for safe run ids inside the state root", async () => {
    expect(validateSafeSegment("run_1.2-3", "run_id")).toBe("run_1.2-3");
    expect(() => validateSafeSegment("../escape", "run_id")).toThrow("run_id must be a safe path segment");
    expect(() => validateSafeSegment(".", "run_id")).toThrow("run_id must be a safe path segment");

    const directory = await resolveArtifactDirectory("safe-run");
    expect(directory).toBe(path.join(tmpHome, "runtime", "artifacts", "safe-run"));
    expect((await fs.stat(directory)).isDirectory()).toBe(true);
  });

  it("rejects paths outside the PulSeed state root", () => {
    expect(stateRelativePath(path.join(tmpHome, "runtime", "artifacts", "run-1"))).toBe("runtime/artifacts/run-1");
    expect(() => stateRelativePath(path.dirname(tmpHome))).toThrow("path must stay within the PulSeed state root");
  });

  it("rejects state-root symlink components before creating nested artifact paths", async () => {
    const runtimeDir = path.join(tmpHome, "runtime");
    const outsideDir = path.join(tmpHome, "outside");
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.symlink(outsideDir, path.join(runtimeDir, "link"));

    await expect(ensureDirectoryWithinStateRoot(path.join(runtimeDir, "link", "child"))).rejects.toThrow(
      "state path component must not be a symlink"
    );
  });

  it("rejects workspace imports nested inside their source directory", () => {
    expect(() => assertNotNestedImport("/tmp/source", "/tmp/source/imported")).toThrow(
      "workspace import destination must not be inside source_path"
    );
    expect(() => assertNotNestedImport("/tmp/source", "/tmp/other/imported")).not.toThrow();
  });

  it("formats compact timestamps for default run directory names", () => {
    expect(compactTimestamp(new Date("2026-05-10T01:02:03.456Z"))).toBe("20260510010203");
  });
});
