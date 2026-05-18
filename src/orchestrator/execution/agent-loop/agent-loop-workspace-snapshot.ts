import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { execFileNoThrow } from "../../../base/utils/execFileNoThrow.js";

interface AgentLoopFilesystemSnapshotEntry {
  size: number;
  mtimeMs: number;
  hash?: string;
}

export type AgentLoopWorkspaceSnapshot =
  | { kind: "git"; paths: Set<string>; files?: Map<string, AgentLoopFilesystemSnapshotEntry> }
  | { kind: "filesystem"; files: Map<string, AgentLoopFilesystemSnapshotEntry> };

const FILESYSTEM_SNAPSHOT_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".codex",
  "dist",
  "build",
]);
const FILESYSTEM_SNAPSHOT_MAX_FILES = 5_000;
const FILESYSTEM_SNAPSHOT_HASH_MAX_BYTES = 1_000_000;

export async function captureAgentLoopWorkspaceSnapshot(cwd: string): Promise<AgentLoopWorkspaceSnapshot | null> {
  if (await shouldUseFilesystemWorkspaceSnapshot(cwd)) {
    return { kind: "filesystem", files: await captureFilesystemSnapshot(cwd) };
  }
  const result = await execFileNoThrow("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, timeoutMs: 10_000 });
  if ((result.exitCode ?? 1) === 0) {
    return {
      kind: "git",
      paths: new Set(parseGitStatusPaths(result.stdout)),
      ...(!await isGitRepoRootCwd(cwd) ? { files: await captureFilesystemSnapshot(cwd) } : {}),
    };
  }
  return { kind: "filesystem", files: await captureFilesystemSnapshot(cwd) };
}

export async function collectAgentLoopChangedFiles(
  cwd: string,
  before: AgentLoopWorkspaceSnapshot | null,
): Promise<string[]> {
  if (before?.kind === "filesystem") {
    return collectFilesystemChangedPaths(before.files, await captureFilesystemSnapshot(cwd));
  }
  const afterResult = await execFileNoThrow("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, timeoutMs: 10_000 });
  if ((afterResult.exitCode ?? 1) !== 0) {
    return [];
  }
  const after = new Set(parseGitStatusPaths(afterResult.stdout));
  const gitChanged = !before || before.kind !== "git"
    ? [...after]
    : [...after].filter((file) => !before.paths.has(file));
  if (before?.kind === "git" && before.files) {
    const filesystemChanged = collectFilesystemChangedPaths(before.files, await captureFilesystemSnapshot(cwd));
    return [...new Set([...gitChanged, ...filesystemChanged])].sort();
  }
  return gitChanged;
}

async function shouldUseFilesystemWorkspaceSnapshot(cwd: string): Promise<boolean> {
  const ignored = await execFileNoThrow("git", ["check-ignore", "-q", "--", "."], { cwd, timeoutMs: 10_000 });
  if ((ignored.exitCode ?? 1) === 0) return true;

  const tracked = await execFileNoThrow("git", ["ls-files", "--", "."], { cwd, timeoutMs: 10_000 });
  return (tracked.exitCode ?? 1) === 0 && tracked.stdout.trim().length === 0;
}

async function isGitRepoRootCwd(cwd: string): Promise<boolean> {
  const root = await execFileNoThrow("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 10_000 });
  if ((root.exitCode ?? 1) !== 0 || !root.stdout.trim()) return false;
  try {
    return await fsp.realpath(cwd) === await fsp.realpath(root.stdout.trim());
  } catch {
    return path.resolve(cwd) === path.resolve(root.stdout.trim());
  }
}

function parseGitStatusPaths(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length >= 4)
    .map((line) => line.slice(3).trim())
    .map((filePath) => filePath.includes(" -> ") ? filePath.split(" -> ").at(-1) ?? filePath : filePath);
}

async function captureFilesystemSnapshot(cwd: string): Promise<Map<string, AgentLoopFilesystemSnapshotEntry>> {
  const files = new Map<string, AgentLoopFilesystemSnapshotEntry>();
  const root = path.resolve(cwd);
  const visit = async (dir: string): Promise<void> => {
    if (files.size >= FILESYSTEM_SNAPSHOT_MAX_FILES) return;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.size >= FILESYSTEM_SNAPSHOT_MAX_FILES) return;
      if (entry.name.startsWith(".pulseed-")) continue;
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!FILESYSTEM_SNAPSHOT_EXCLUDED_DIRS.has(entry.name)) {
          await visit(absolutePath);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = path.relative(root, absolutePath).replace(/\\/g, "/");
      try {
        const stat = await fsp.stat(absolutePath);
        const snapshotEntry: AgentLoopFilesystemSnapshotEntry = {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };
        if (stat.size <= FILESYSTEM_SNAPSHOT_HASH_MAX_BYTES) {
          snapshotEntry.hash = createHash("sha256")
            .update(await fsp.readFile(absolutePath))
            .digest("hex");
        }
        files.set(relativePath, snapshotEntry);
      } catch {
        // File may have changed while scanning; skip and let the next scan observe it.
      }
    }
  };
  await visit(root);
  return files;
}

function collectFilesystemChangedPaths(
  before: Map<string, AgentLoopFilesystemSnapshotEntry>,
  after: Map<string, AgentLoopFilesystemSnapshotEntry>,
): string[] {
  const changed = new Set<string>();
  for (const [filePath, afterEntry] of after) {
    const beforeEntry = before.get(filePath);
    if (!beforeEntry || !sameFilesystemEntry(beforeEntry, afterEntry)) {
      changed.add(filePath);
    }
  }
  for (const filePath of before.keys()) {
    if (!after.has(filePath)) {
      changed.add(filePath);
    }
  }
  return [...changed].sort();
}

function sameFilesystemEntry(
  left: AgentLoopFilesystemSnapshotEntry,
  right: AgentLoopFilesystemSnapshotEntry,
): boolean {
  if (left.hash && right.hash) return left.hash === right.hash;
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}
