import fs from "node:fs/promises";
import path from "node:path";
import { getPulseedDirPath } from "../../base/utils/paths.js";

export const KAGGLE_RUNS_DIR = "kaggle-runs";
export const KAGGLE_WORKSPACE_DIRS = ["data", "notebooks", "src", "experiments", "submissions"] as const;

export type KaggleWorkspaceDir = typeof KAGGLE_WORKSPACE_DIRS[number];

const COMPETITION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EXPERIMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validateKaggleCompetitionId(competition: string): string {
  if (!COMPETITION_ID_PATTERN.test(competition) || competition === "." || competition === "..") {
    throw new Error("competition must be a safe Kaggle competition id");
  }
  return competition;
}

export function validateKaggleExperimentId(experimentId: string): string {
  if (!EXPERIMENT_ID_PATTERN.test(experimentId) || experimentId === "." || experimentId === "..") {
    throw new Error("experiment_id must be a safe Kaggle experiment id");
  }
  return experimentId;
}

export function getKaggleRunsRoot(): string {
  return path.resolve(getPulseedDirPath(), KAGGLE_RUNS_DIR);
}

export function getKaggleWorkspaceRoot(competition: string): string {
  const safeCompetition = validateKaggleCompetitionId(competition);
  return path.resolve(getKaggleRunsRoot(), safeCompetition);
}

export function stateRelativePath(absolutePath: string): string {
  const stateRoot = path.resolve(getPulseedDirPath());
  const relativePath = path.relative(stateRoot, path.resolve(absolutePath));
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("path must stay within the PulSeed state root");
  }
  return relativePath.split(path.sep).join("/");
}

export function workspaceRelativePath(workspaceRoot: string, absolutePath: string): string {
  const relativePath = path.relative(path.resolve(workspaceRoot), path.resolve(absolutePath));
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("path must stay within the Kaggle workspace");
  }
  return relativePath.split(path.sep).join("/");
}

function assertWithin(parent: string, candidate: string, label: string): void {
  const relativePath = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))) {
    return;
  }
  throw new Error(`${label} must stay within ${parent}`);
}

export function resolveKaggleWorkspaceInput(workspace: string, competition: string): string {
  const expected = getKaggleWorkspaceRoot(competition);
  const runsRoot = getKaggleRunsRoot();
  const requested = workspace.trim();
  if (!requested) {
    throw new Error("workspace is required");
  }

  let resolved: string;
  if (path.isAbsolute(requested)) {
    resolved = path.resolve(requested);
    if (resolved === runsRoot) {
      resolved = expected;
    }
  } else if (requested === KAGGLE_RUNS_DIR) {
    resolved = expected;
  } else if (requested === competition) {
    resolved = expected;
  } else if (requested === path.join(KAGGLE_RUNS_DIR, competition)) {
    resolved = path.resolve(getPulseedDirPath(), requested);
  } else {
    resolved = path.resolve(runsRoot, requested);
  }

  if (resolved !== expected) {
    throw new Error(`workspace must resolve to ${stateRelativePath(expected)}`);
  }
  assertWithin(path.resolve(getPulseedDirPath()), resolved, "workspace");
  return resolved;
}

export function resolveWorkspaceRelativePath(workspaceRoot: string, candidate: string, label: string): string {
  const requested = candidate.trim();
  if (!requested) {
    throw new Error(`${label} is required`);
  }
  const resolved = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(workspaceRoot, requested);
  assertWithin(workspaceRoot, resolved, label);
  return resolved;
}

export function getKaggleExperimentDir(workspaceRoot: string, experimentId: string): string {
  return path.join(workspaceRoot, "experiments", validateKaggleExperimentId(experimentId));
}

async function realpathIfExists(candidate: string): Promise<string | null> {
  try {
    return await fs.realpath(candidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function ensureDirectoryWithinStateRoot(dirPath: string): Promise<void> {
  const stateRoot = path.resolve(getPulseedDirPath());
  await fs.mkdir(stateRoot, { recursive: true });
  const realStateRoot = await fs.realpath(stateRoot);
  assertWithin(stateRoot, dirPath, "directory");

  const relativeParts = path.relative(stateRoot, path.resolve(dirPath)).split(path.sep).filter(Boolean);
  let current = stateRoot;
  for (const part of relativeParts) {
    current = path.join(current, part);
    const existingRealPath = await realpathIfExists(current);
    if (existingRealPath) {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`workspace path component must not be a symlink: ${stateRelativePath(current)}`);
      }
      assertWithin(realStateRoot, existingRealPath, "directory realpath");
      if (!stat.isDirectory()) {
        throw new Error(`workspace path component is not a directory: ${stateRelativePath(current)}`);
      }
      continue;
    }
    await fs.mkdir(current);
    const createdRealPath = await fs.realpath(current);
    assertWithin(realStateRoot, createdRealPath, "created directory");
  }
}

export async function ensureKaggleWorkspaceDirectories(workspaceRoot: string): Promise<Record<KaggleWorkspaceDir, string>> {
  await ensureDirectoryWithinStateRoot(workspaceRoot);
  const directories = {} as Record<KaggleWorkspaceDir, string>;
  for (const dirname of KAGGLE_WORKSPACE_DIRS) {
    const fullPath = path.join(workspaceRoot, dirname);
    await ensureDirectoryWithinStateRoot(fullPath);
    directories[dirname] = fullPath;
  }
  return directories;
}
