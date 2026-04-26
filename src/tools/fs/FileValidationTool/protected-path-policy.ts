import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const DEFAULT_PROTECTED_PATH_PATTERNS = [
  ".git",
  ".codex",
  ".agents",
  ".pulseed",
  "AGENTS.md",
  "AGENTS.override.md",
  ".env",
  ".env.local",
  ".env.production",
  "credentials",
  "secret",
  ".ssh",
  "id_rsa",
  "node_modules",
];

export interface ProtectedPathPolicyInput {
  cwd: string;
  workspaceRoot?: string;
  protectedPaths?: string[];
}

export interface ProtectedPathValidationResult {
  valid: boolean;
  resolved: string;
  error?: string;
}

export function validateProtectedPath(
  filePath: string,
  input: ProtectedPathPolicyInput,
): ProtectedPathValidationResult {
  const cwd = canonicalPath(input.cwd);
  const workspaceRoot = canonicalPath(input.workspaceRoot ?? input.cwd);
  const requestedPath = expandTildePath(filePath);
  const resolved = canonicalPath(isAbsolute(requestedPath) ? requestedPath : resolve(cwd, requestedPath));
  const pathFromWorkspace = relative(workspaceRoot, resolved);

  if (pathFromWorkspace.startsWith("..") || isAbsolute(pathFromWorkspace)) {
    return { valid: false, resolved, error: "Path traversal outside workspace root" };
  }

  const protectedPatterns = [
    ...DEFAULT_PROTECTED_PATH_PATTERNS,
    ...(input.protectedPaths ?? []),
  ];
  const normalized = normalizeForMatch(pathFromWorkspace === "" ? "." : pathFromWorkspace);
  for (const pattern of protectedPatterns) {
    const protectedPattern = normalizeForMatch(pattern);
    const isBroadToken = !protectedPattern.includes("/") && !protectedPattern.startsWith(".");
    if (
      normalized === protectedPattern
      || normalized.startsWith(`${protectedPattern}/`)
      || normalized.includes(`/${protectedPattern}/`)
      || (isBroadToken && normalized.includes(protectedPattern))
    ) {
      return {
        valid: false,
        resolved,
        error: `Blocked: path targets protected area "${pattern}"`,
      };
    }
  }

  return { valid: true, resolved };
}

export function expandTildePath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function canonicalPath(value: string): string {
  const expanded = expandTildePath(value);
  try {
    return realpathSync(expanded);
  } catch {
    return resolve(expanded);
  }
}

function normalizeForMatch(value: string): string {
  return value.split(sep).join("/").replace(/^\.\/+/, "").toLowerCase();
}
