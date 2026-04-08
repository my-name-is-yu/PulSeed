import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FALLBACK_VERSION = "0.0.0";
const MAX_PACKAGE_ROOT_ASCENT = 8;

export function findPackageRoot(importMetaUrl: string): string {
  let currentDir = path.dirname(fileURLToPath(importMetaUrl));

  for (let i = 0; i < MAX_PACKAGE_ROOT_ASCENT; i += 1) {
    if (fs.existsSync(path.join(currentDir, "package.json"))) {
      return currentDir;
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  throw new Error(`Could not locate package.json from ${importMetaUrl}`);
}

export function getPulseedVersion(importMetaUrl: string): string {
  try {
    const packageRoot = findPackageRoot(importMetaUrl);
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8")) as { version?: string };
    return pkg.version || DEFAULT_FALLBACK_VERSION;
  } catch {
    return DEFAULT_FALLBACK_VERSION;
  }
}

export function getCliRunnerBuildPath(importMetaUrl: string): string {
  return path.join(findPackageRoot(importMetaUrl), "dist", "interface", "cli", "cli-runner.js");
}
