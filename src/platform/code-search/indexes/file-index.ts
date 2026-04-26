import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { IndexedFile } from "../contracts.js";
import { classifyGeneratedPath } from "../generated-detector.js";
import { isSearchablePath, toRepoRelative } from "../path-policy.js";

const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".jj",
  ".sl",
  ".claude",
  ".claire",
  ".cache",
  ".dist-delete",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "archive",
  "tmp",
  "vendor",
  "worktree",
  "worktrees",
]);

const HIDDEN_DIR_ALLOWLIST = new Set([".github"]);
const IGNORED_DIR_PREFIXES = ["dist-", "build-", "out-", "target-", "coverage-", ".dist-delete"];

function languageFor(filePath: string): string {
  const ext = path.extname(filePath).slice(1);
  if (ext) return ext;
  return path.basename(filePath);
}

export function hashContent(content: string | Buffer): string {
  return crypto.createHash("sha1").update(content).digest("hex");
}

async function walk(root: string, dir: string, result: string[], maxFiles: number): Promise<void> {
  if (result.length >= maxFiles) return;
  let entries: import("node:fs").Dirent<string>[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (result.length >= maxFiles) return;
    if (entry.isDirectory()) {
      if (
        IGNORED_DIRS.has(entry.name)
        || IGNORED_DIR_PREFIXES.some((prefix) => entry.name.startsWith(prefix))
        || (entry.name.startsWith(".") && !HIDDEN_DIR_ALLOWLIST.has(entry.name))
      ) continue;
      await walk(root, path.join(dir, entry.name), result, maxFiles);
      continue;
    }
    if (!entry.isFile()) continue;
    const absolute = path.join(dir, entry.name);
    const relative = toRepoRelative(root, absolute);
    if (isSearchablePath(relative)) result.push(absolute);
  }
}

export async function buildFileIndex(root: string, maxFiles = 1_500): Promise<IndexedFile[]> {
  const absoluteRoot = path.resolve(root);
  const files: string[] = [];
  await walk(absoluteRoot, absoluteRoot, files, maxFiles);

  const indexed: IndexedFile[] = [];
  for (const absolutePath of files) {
    try {
      const stat = await fsp.stat(absolutePath);
      if (!stat.isFile()) continue;
      const content = await fsp.readFile(absolutePath);
      const rel = toRepoRelative(absoluteRoot, absolutePath);
      const classification = classifyGeneratedPath(rel);
      indexed.push({
        path: rel,
        absolutePath,
        hash: hashContent(content),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        language: languageFor(rel),
        generated: classification.generated,
        vendor: classification.vendor,
        buildArtifact: classification.buildArtifact,
        editable: classification.editable,
      });
    } catch {
      // Ignore files that disappear during indexing.
    }
  }
  return indexed;
}

export async function hashFileOrNull(filePath: string): Promise<string | null> {
  try {
    return hashContent(await fsp.readFile(filePath));
  } catch {
    return null;
  }
}
