import * as fsp from "node:fs/promises";
import type { IndexedFile, RepoMapSlice } from "../contracts.js";

const IMPORT_RE = /^\s*import\s+(?:type\s+)?(?:[^"'`]+from\s+)?["'`]([^"'`]+)["'`]/gm;
const EXPORT_RE = /^\s*export\s+(?:\{([^}]+)\}|(?:default\s+)?(?:class|function|const|let|var|type|interface)\s+([A-Za-z_$][\w$]*))/gm;

export async function buildRepoMapIndex(files: IndexedFile[]): Promise<RepoMapSlice> {
  const result: RepoMapSlice = { files: [] };
  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file.path)) continue;
    try {
      const content = await fsp.readFile(file.absolutePath, "utf8");
      const imports = [...content.matchAll(IMPORT_RE)].map((match) => match[1]).slice(0, 40);
      const exports = [...content.matchAll(EXPORT_RE)]
        .flatMap((match) => match[1] ? match[1].split(",").map((item) => item.trim()) : [match[2]])
        .filter(Boolean)
        .slice(0, 40);
      if (imports.length || exports.length) {
        result.files.push({ file: file.path, imports, exports });
      }
    } catch {
      // skip unreadable files
    }
  }
  return result;
}
