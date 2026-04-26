import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateFilePath } from "../fs/FileValidationTool/FileValidationTool.js";
import type { ToolCallContext } from "../types.js";

export interface CodeSearchRootInput {
  path?: string;
}

export function isBroadCodeSearchRoot(root: string): boolean {
  const resolved = path.resolve(root);
  const homeDir = path.resolve(os.homedir());
  return resolved === path.parse(resolved).root || resolved === path.dirname(homeDir) || resolved === homeDir;
}

export function findCodeSearchProjectRoot(cwd: string): string | null {
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, ".git")) || fs.existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function resolveCodeSearchRoot(
  input: CodeSearchRootInput,
  context: ToolCallContext,
  toolName: string,
): string {
  if (input.path) {
    const resolvedPath = validateFilePath(input.path, context.cwd).resolved;
    if (isBroadCodeSearchRoot(resolvedPath)) {
      throw new Error(`${toolName} refused broad explicit path "${resolvedPath}".`);
    }
    return resolvedPath;
  }
  const projectRoot = findCodeSearchProjectRoot(context.cwd);
  if (projectRoot && !isBroadCodeSearchRoot(projectRoot)) {
    return projectRoot;
  }
  const resolvedCwd = path.resolve(context.cwd);
  if (isBroadCodeSearchRoot(resolvedCwd)) {
    throw new Error(`${toolName} requires a project working directory or an explicit path; refused broad root "${resolvedCwd}".`);
  }
  throw new Error(`${toolName} requires a project working directory or an explicit path; no project root found from "${resolvedCwd}".`);
}
