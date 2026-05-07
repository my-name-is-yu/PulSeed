import type { VerificationFileDiff } from "../../../base/types/task.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export type ExecFileSyncFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; encoding: "utf-8"; stdio?: "pipe" }
) => string;

export interface ExecutionDiffArtifacts {
  available: boolean;
  evidenceSource: "git" | "filesystem_artifact" | "unavailable";
  changedPaths: string[];
  fileDiffs: VerificationFileDiff[];
}

export interface ExecutionDiffBaseline {
  available: boolean;
  cwd: string;
  changedPaths: string[];
  pathFingerprints: Record<string, string>;
  filesystemFingerprints?: Record<string, string>;
}

export interface CaptureExecutionDiffOptions {
  fallbackChangedPaths?: string[];
  maxFallbackDiffBytes?: number;
  baseline?: ExecutionDiffBaseline;
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function readStdoutFromExecError(error: unknown): string | null {
  if (
    error &&
    typeof error === "object" &&
    "stdout" in error &&
    typeof (error as { stdout?: unknown }).stdout === "string"
  ) {
    const stdout = (error as { stdout: string }).stdout;
    return stdout.length > 0 ? stdout : null;
  }

  if (
    error &&
    typeof error === "object" &&
    "stdout" in error &&
    Buffer.isBuffer((error as { stdout?: unknown }).stdout)
  ) {
    const stdout = ((error as { stdout: Buffer }).stdout).toString("utf-8");
    return stdout.length > 0 ? stdout : null;
  }

  return null;
}

function runGitRead(
  execFileSyncFn: ExecFileSyncFn,
  cwd: string,
  args: string[],
): string | null {
  try {
    return execFileSyncFn("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });
  } catch (error) {
    return readStdoutFromExecError(error);
  }
}

function normalizeCwd(cwd: string): string {
  try {
    return fs.realpathSync(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

function captureGitChangedPaths(
  execFileSyncFn: ExecFileSyncFn,
  cwd: string,
): {
  available: boolean;
  trackedPaths: string[];
  stagedPaths: string[];
  untrackedPaths: string[];
  changedPaths: string[];
} {
  const trackedOutput = runGitRead(execFileSyncFn, cwd, ["diff", "--name-only"]);
  const stagedOutput = runGitRead(execFileSyncFn, cwd, ["diff", "--cached", "--name-only"]);
  const untrackedOutput = runGitRead(execFileSyncFn, cwd, ["ls-files", "--others", "--exclude-standard"]);
  const available = trackedOutput !== null || stagedOutput !== null || untrackedOutput !== null;
  if (!available) {
    return {
      available: false,
      trackedPaths: [],
      stagedPaths: [],
      untrackedPaths: [],
      changedPaths: [],
    };
  }

  const trackedPaths = (trackedOutput ?? "").split("\n");
  const stagedPaths = (stagedOutput ?? "").split("\n");
  const untrackedPaths = (untrackedOutput ?? "").split("\n");
  const changedPaths = uniqueNonEmpty([...trackedPaths, ...stagedPaths, ...untrackedPaths])
    .filter((filePath) => isSafeRelativePath(cwd, filePath));
  return {
    available: true,
    trackedPaths,
    stagedPaths,
    untrackedPaths,
    changedPaths,
  };
}

export function captureExecutionDiffBaseline(
  execFileSyncFn: ExecFileSyncFn,
  cwd: string,
): ExecutionDiffBaseline {
  const normalizedCwd = normalizeCwd(cwd);
  if (!hasGitMetadata(cwd)) {
    return {
      available: true,
      cwd: normalizedCwd,
      changedPaths: [],
      pathFingerprints: {},
      filesystemFingerprints: captureFilesystemFingerprints(cwd),
    };
  }
  if (shouldUseFilesystemDiff(execFileSyncFn, cwd)) {
    return {
      available: true,
      cwd: normalizedCwd,
      changedPaths: [],
      pathFingerprints: {},
      filesystemFingerprints: captureFilesystemFingerprints(cwd),
    };
  }

  const snapshot = captureGitChangedPaths(execFileSyncFn, cwd);
  const untrackedSet = new Set(uniqueNonEmpty(snapshot.untrackedPaths));
  const patchMap = readGitPathPatches(execFileSyncFn, cwd, snapshot);
  return {
    available: snapshot.available,
    cwd: normalizedCwd,
    changedPaths: snapshot.changedPaths,
    pathFingerprints: Object.fromEntries(
      snapshot.changedPaths.map((filePath) => [
        filePath,
        patchMap.get(filePath) ?? (untrackedSet.has(filePath)
          ? renderCurrentFileDiff(cwd, filePath, 200_000)[0]?.patch.trim() ?? ""
          : ""),
      ]),
    ),
  };
}

function baselineChangedPathSetForCwd(
  baseline: ExecutionDiffBaseline | undefined,
  cwd: string,
): Set<string> | undefined {
  if (!baseline?.available) return undefined;
  if (baseline.cwd !== normalizeCwd(cwd)) return undefined;
  return new Set(baseline.changedPaths);
}

function baselinePathFingerprintsForCwd(
  baseline: ExecutionDiffBaseline | undefined,
  cwd: string,
): Map<string, string> | undefined {
  if (!baseline?.available) return undefined;
  if (baseline.cwd !== normalizeCwd(cwd)) return undefined;
  return new Map(Object.entries(baseline.pathFingerprints));
}

function readGitPathPatches(
  execFileSyncFn: ExecFileSyncFn,
  cwd: string,
  snapshot: ReturnType<typeof captureGitChangedPaths>,
): Map<string, string> {
  const patches = new Map<string, string>();
  const appendPatch = (filePath: string, patch: string): void => {
    const trimmed = patch.trim();
    if (trimmed.length === 0) return;
    const existing = patches.get(filePath);
    patches.set(filePath, existing ? `${existing}\n${trimmed}` : trimmed);
  };

  const trackedPaths = uniqueNonEmpty(snapshot.trackedPaths)
    .filter((filePath) => isSafeRelativePath(cwd, filePath));
  const stagedPaths = uniqueNonEmpty(snapshot.stagedPaths)
    .filter((filePath) => isSafeRelativePath(cwd, filePath));

  for (const [filePath, patch] of parseGitDiffByPath(
    trackedPaths.length > 0
      ? runGitRead(execFileSyncFn, cwd, ["diff", "--", ...trackedPaths]) ?? ""
      : "",
    trackedPaths,
  )) {
    appendPatch(filePath, patch);
  }

  for (const [filePath, patch] of parseGitDiffByPath(
    stagedPaths.length > 0
      ? runGitRead(execFileSyncFn, cwd, ["diff", "--cached", "--", ...stagedPaths]) ?? ""
      : "",
    stagedPaths,
  )) {
    appendPatch(filePath, patch);
  }

  return patches;
}

export function captureExecutionDiffArtifacts(
  execFileSyncFn: ExecFileSyncFn,
  cwd: string,
  options: CaptureExecutionDiffOptions = {},
): ExecutionDiffArtifacts {
  const baselineChangedPaths = baselineChangedPathSetForCwd(options.baseline, cwd);
  const baselinePathFingerprints = baselinePathFingerprintsForCwd(options.baseline, cwd);
  const baselineFilesystemFingerprints = baselineFilesystemFingerprintsForCwd(options.baseline, cwd);
  const fallbackPaths = uniqueNonEmpty(options.fallbackChangedPaths ?? [])
    .filter((filePath) => isSafeRelativePath(cwd, filePath));
  if (!hasGitMetadata(cwd) || shouldUseFilesystemDiff(execFileSyncFn, cwd)) {
    const filesystemChangedPaths = baselineFilesystemFingerprints
      ? collectFilesystemChangedPaths(baselineFilesystemFingerprints, cwd)
      : [];
    return renderFallbackDiffArtifacts(
      cwd,
      uniqueNonEmpty([...fallbackPaths, ...filesystemChangedPaths]),
      options.maxFallbackDiffBytes,
      baselineChangedPaths,
      "filesystem_artifact",
    );
  }

  const snapshot = captureGitChangedPaths(execFileSyncFn, cwd);
  if (!snapshot.available) {
    return renderFallbackDiffArtifacts(
      cwd,
      fallbackPaths,
      options.maxFallbackDiffBytes,
      baselineChangedPaths,
      "unavailable",
    );
  }

  const untrackedSet = new Set(uniqueNonEmpty(snapshot.untrackedPaths));
  const patchMap = readGitPathPatches(execFileSyncFn, cwd, snapshot);
  const changedPaths: string[] = [];
  const fileDiffs: VerificationFileDiff[] = [];

  for (const filePath of snapshot.changedPaths) {
    const patch = patchMap.get(filePath)
      ?? (untrackedSet.has(filePath)
        ? renderCurrentFileDiff(cwd, filePath, options.maxFallbackDiffBytes ?? 200_000)[0]?.patch.trim() ?? ""
        : "");
    const baselinePatch = baselinePathFingerprints?.get(filePath);
    if (baselinePatch !== undefined && patch === baselinePatch) {
      continue;
    }

    changedPaths.push(filePath);
    if (patch.length > 0) {
      fileDiffs.push({
        path: filePath,
        patch,
        ...(baselinePatch !== undefined ? { safe_to_revert: false } : {}),
      });
    }
  }

  return { available: true, evidenceSource: "git", changedPaths, fileDiffs };
}

function baselineFilesystemFingerprintsForCwd(
  baseline: ExecutionDiffBaseline | undefined,
  cwd: string,
): Map<string, string> | undefined {
  if (!baseline?.available || !baseline.filesystemFingerprints) return undefined;
  if (baseline.cwd !== normalizeCwd(cwd)) return undefined;
  return new Map(Object.entries(baseline.filesystemFingerprints));
}

function shouldUseFilesystemDiff(execFileSyncFn: ExecFileSyncFn, cwd: string): boolean {
  const ignored = runGitRead(execFileSyncFn, cwd, ["check-ignore", "--", "."]);
  return ignored !== null && ignored.trim().length > 0;
}

function captureFilesystemFingerprints(cwd: string): Record<string, string> {
  const root = path.resolve(cwd);
  const files = new Map<string, string>();
  const visit = (dir: string): void => {
    if (files.size >= 5_000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.size >= 5_000) return;
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".venv" || entry.name === "venv") {
        continue;
      }
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = path.relative(root, absolutePath).replace(/\\/g, "/");
      try {
        const stat = fs.statSync(absolutePath);
        let fingerprint = `${stat.size}:${stat.mtimeMs}`;
        if (stat.size <= 1_000_000) {
          fingerprint = createHash("sha256")
            .update(fs.readFileSync(absolutePath))
            .digest("hex");
        }
        files.set(relativePath, fingerprint);
      } catch {
        // Ignore files that changed during the scan; the next scan can observe them.
      }
    }
  };
  visit(root);
  return Object.fromEntries(files);
}

function collectFilesystemChangedPaths(baseline: Map<string, string>, cwd: string): string[] {
  const after = new Map(Object.entries(captureFilesystemFingerprints(cwd)));
  const changed = new Set<string>();
  for (const [filePath, fingerprint] of after) {
    if (baseline.get(filePath) !== fingerprint) changed.add(filePath);
  }
  for (const filePath of baseline.keys()) {
    if (!after.has(filePath)) changed.add(filePath);
  }
  return [...changed].sort();
}

function parseGitDiffByPath(output: string, expectedPaths: string[]): Map<string, string> {
  const patches = new Map<string, string>();
  if (output.trim().length === 0) return patches;

  const expectedByLength = [...expectedPaths].sort((left, right) => right.length - left.length);
  const sections = output.split(/^diff --git /m).filter((section) => section.trim().length > 0);
  for (const section of sections) {
    const patch = `diff --git ${section}`.trim();
    const header = patch.split("\n", 1)[0] ?? "";
    const filePath = expectedByLength.find((candidate) =>
      header === `diff --git a/${candidate} b/${candidate}` ||
      header.endsWith(` b/${candidate}`)
    );
    if (filePath) {
      patches.set(filePath, patch);
    }
  }
  return patches;
}

function renderFallbackDiffArtifacts(
  cwd: string,
  fallbackPaths: string[],
  maxFallbackDiffBytes = 200_000,
  baselineChangedPaths?: Set<string>,
  evidenceSource: ExecutionDiffArtifacts["evidenceSource"] = "unavailable",
): ExecutionDiffArtifacts {
  const available = evidenceSource === "filesystem_artifact" || fallbackPaths.length > 0;
  return {
    available,
    evidenceSource,
    changedPaths: fallbackPaths,
    fileDiffs: fallbackPaths.flatMap((filePath) =>
      renderCurrentFileDiff(cwd, filePath, maxFallbackDiffBytes)
        .map((diff) => ({
          ...diff,
          ...(evidenceSource === "filesystem_artifact" || baselineChangedPaths?.has(filePath)
            ? { safe_to_revert: false }
            : {}),
        }))
    ),
  };
}

function hasGitMetadata(cwd: string): boolean {
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function isSafeRelativePath(cwd: string, filePath: string): boolean {
  if (!filePath || filePath.includes("\0") || path.isAbsolute(filePath)) return false;
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, filePath);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function isWithinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function renderCurrentFileDiff(cwd: string, filePath: string, maxBytes: number): VerificationFileDiff[] {
  const resolved = path.resolve(cwd, filePath);
  try {
    const root = fs.realpathSync(cwd);
    const realResolved = fs.realpathSync(resolved);
    if (!isWithinRoot(root, realResolved)) {
      return [{
        path: filePath,
        patch: [
          `diff --git a/${filePath} b/${filePath}`,
          `--- a/${filePath}`,
          `+++ b/${filePath}`,
          "@@ -0,0 +1 @@",
          "+[non-git evidence] path resolves outside the workspace; content omitted",
          "",
        ].join("\n"),
      }];
    }
    const stat = fs.statSync(realResolved);
    if (!stat.isFile()) {
      return [{
        path: filePath,
        patch: [
          `diff --git a/${filePath} b/${filePath}`,
          `--- a/${filePath}`,
          `+++ b/${filePath}`,
          "@@ -0,0 +1 @@",
          `+[non-git evidence] path exists but is not a regular file (${stat.isDirectory() ? "directory" : "special file"})`,
          "",
        ].join("\n"),
      }];
    }
    if (stat.size > maxBytes) {
      return [{
        path: filePath,
        patch: [
          `diff --git a/${filePath} b/${filePath}`,
          `--- a/${filePath}`,
          `+++ b/${filePath}`,
          "@@ -0,0 +1 @@",
          `+[non-git evidence] file exists; diff omitted because size ${stat.size} exceeds ${maxBytes} bytes`,
          "",
        ].join("\n"),
      }];
    }
    const content = fs.readFileSync(realResolved, "utf-8");
    if (content.includes("\0")) {
      return [{
        path: filePath,
        patch: [
          `diff --git a/${filePath} b/${filePath}`,
          "new file mode 100644",
          "--- /dev/null",
          `+++ b/${filePath}`,
          "@@ -0,0 +1 @@",
          `+[non-git evidence] binary file exists; size ${stat.size} bytes`,
          "",
        ].join("\n"),
      }];
    }
    const lines = content.length === 0
      ? []
      : content.replace(/\n$/, "").split("\n");
    return [{
      path: filePath,
      patch: [
        `diff --git a/${filePath} b/${filePath}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${filePath}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`),
        "",
      ].join("\n"),
    }];
  } catch {
    return [{
      path: filePath,
      patch: [
        `diff --git a/${filePath} b/${filePath}`,
        `--- a/${filePath}`,
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-[non-git evidence] path was reported changed but is absent after execution",
        "",
      ].join("\n"),
    }];
  }
}
