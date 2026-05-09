import fs from "node:fs/promises";
import path from "node:path";
import { getPulseedDirPath } from "../../base/utils/paths.js";

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function resolveArtifactDirectory(runId?: string): Promise<string> {
  const safeId = validateSafeSegment(runId ?? `run-${compactTimestamp(new Date())}`, "run_id");
  const directory = path.join(getPulseedDirPath(), "runtime", "artifacts", safeId);
  await ensureDirectoryWithinStateRoot(directory);
  return directory;
}

export function resolveReadablePath(candidate: string, cwd: string): string {
  return path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(cwd, candidate);
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
        throw new Error(`state path component must not be a symlink: ${stateRelativePath(current)}`);
      }
      assertWithin(realStateRoot, existingRealPath, "directory realpath");
      if (!stat.isDirectory()) {
        throw new Error(`state path component is not a directory: ${stateRelativePath(current)}`);
      }
      continue;
    }
    await fs.mkdir(current);
  }
}

export function stateRelativePath(absolutePath: string): string {
  const stateRoot = path.resolve(getPulseedDirPath());
  const relativePath = path.relative(stateRoot, path.resolve(absolutePath));
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("path must stay within the PulSeed state root");
  }
  return relativePath.split(path.sep).join("/");
}

export function assertNotNestedImport(sourcePath: string, destination: string): void {
  const relativeDestination = path.relative(path.resolve(sourcePath), path.resolve(destination));
  if (relativeDestination === "" || (!relativeDestination.startsWith("..") && !path.isAbsolute(relativeDestination))) {
    throw new Error("workspace import destination must not be inside source_path");
  }
}

export function validateSafeSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT_PATTERN.test(value) || value === "." || value === "..") {
    throw new Error(`${label} must be a safe path segment`);
  }
  return value;
}

export function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

async function realpathIfExists(candidate: string): Promise<string | null> {
  try {
    return await fs.realpath(candidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function assertWithin(parent: string, candidate: string, label: string): void {
  const relativePath = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))) return;
  throw new Error(`${label} must stay within ${parent}`);
}
