import * as path from "node:path";
import { classifyGeneratedPath } from "./generated-detector.js";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yaml",
  ".yml",
  ".toml",
  ".css",
  ".scss",
]);

const CONFIG_FILE_NAMES = new Set([
  "package.json",
  "tsconfig.json",
  "pnpm-workspace.yaml",
  "eslint.config.mjs",
  "vite.config.ts",
  "vitest.config.ts",
]);

export function toRepoRelative(root: string, filePath: string): string {
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
  return path.relative(root, absolute).split(path.sep).join("/");
}

export function isPathInside(root: string, filePath: string): boolean {
  const relative = path.relative(root, path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isSearchablePath(filePath: string): boolean {
  const normalized = filePath.split(path.sep).join("/");
  const basename = path.basename(normalized);
  const ext = path.extname(normalized);
  if (basename.startsWith(".") && !CONFIG_FILE_NAMES.has(basename)) return false;
  if (!SOURCE_EXTENSIONS.has(ext) && !CONFIG_FILE_NAMES.has(basename)) return false;
  const classification = classifyGeneratedPath(normalized);
  return !classification.vendor && !classification.buildArtifact;
}

export function isConfigPath(filePath: string): boolean {
  const basename = path.basename(filePath);
  return CONFIG_FILE_NAMES.has(basename)
    || /^tsconfig.*\.json$/.test(basename)
    || /^vitest.*\.config\./.test(basename)
    || /^eslint\.config\./.test(basename)
    || basename.includes("workspace")
    || basename.includes("docker")
    || basename.includes("Dockerfile");
}

export function isTestPath(filePath: string): boolean {
  return /(?:^|[./_-])(?:test|spec)\.[cm]?[jt]sx?$/.test(filePath)
    || filePath.includes("__tests__")
    || filePath.includes("/tests/");
}
