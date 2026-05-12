import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { TraceArtifactTreeEntry } from "./types.js";

export async function exportArtifactTree(root: string): Promise<TraceArtifactTreeEntry[]> {
  const entries: TraceArtifactTreeEntry[] = [];
  await walk(root, "", entries);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function walk(root: string, relativePath: string, entries: TraceArtifactTreeEntry[]): Promise<void> {
  const absolutePath = path.join(root, relativePath);
  const stat = await fsp.stat(absolutePath);
  if (relativePath) {
    entries.push({
      path: normalize(relativePath),
      type: stat.isDirectory() ? "directory" : "file",
      size: stat.isFile() ? stat.size : undefined,
      sha256: stat.isFile() ? await hashFile(absolutePath) : undefined,
    });
  }
  if (!stat.isDirectory()) return;
  const children = await fsp.readdir(absolutePath);
  for (const child of children) {
    await walk(root, path.join(relativePath, child), entries);
  }
}

async function hashFile(filePath: string): Promise<string> {
  const content = await fsp.readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function normalize(filePath: string): string {
  return filePath.split(path.sep).join("/");
}
