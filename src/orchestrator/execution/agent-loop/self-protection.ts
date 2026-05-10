import { existsSync, realpathSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePackageMetadata } from "../../../base/utils/package-metadata.js";

export type PulSeedExecutionProfile = "consumer" | "dev";

export function resolvePulSeedExecutionProfile(env: NodeJS.ProcessEnv = process.env): PulSeedExecutionProfile {
  return env["PULSEED_DEV"] === "1" ? "dev" : "consumer";
}

export function resolvePulSeedProtectedRoots(input: {
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv;
  packageRoot?: string;
}): string[] {
  const env = input.env ?? process.env;
  if (resolvePulSeedExecutionProfile(env) === "dev") return [];

  const roots = new Set<string>();
  const packageRoot = input.packageRoot ?? findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  if (packageRoot) roots.add(canonicalPath(packageRoot));

  const workspaceRoot = canonicalPath(input.workspaceRoot);
  if (isPulSeedPackageRoot(workspaceRoot)) roots.add(workspaceRoot);

  for (const rawRoot of splitEnvRoots(env["PULSEED_SELF_PROTECTION_ROOTS"])) {
    roots.add(canonicalPath(rawRoot));
  }

  return [...roots];
}

export function isPathInsideProtectedRoots(pathname: string, protectedRoots: readonly string[]): boolean {
  const target = canonicalPath(pathname);
  return protectedRoots.some((root) => {
    const protectedRoot = canonicalPath(root);
    return target === protectedRoot || target.startsWith(`${protectedRoot}/`);
  });
}

function findPackageRoot(startDir: string): string | null {
  let current = canonicalPath(startDir);
  while (true) {
    if (isPulSeedPackageRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isPulSeedPackageRoot(root: string): boolean {
  const packageJsonPath = join(root, "package.json");
  if (!existsSync(packageJsonPath)) return false;
  try {
    return parsePackageMetadata(readFileSync(packageJsonPath, "utf-8"))?.name === "pulseed";
  } catch {
    return false;
  }
}

function splitEnvRoots(value: string | undefined): string[] {
  return value?.split(":").map((part) => part.trim()).filter(Boolean) ?? [];
}

function canonicalPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    const resolved = resolve(value);
    let current = resolved;
    const missingParts: string[] = [];
    while (!existsSync(current)) {
      const parent = dirname(current);
      if (parent === current) return resolved;
      missingParts.unshift(relative(parent, current));
      current = parent;
    }
    return resolve(realpathSync(current), ...missingParts);
  }
}
