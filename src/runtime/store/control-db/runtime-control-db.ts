import * as path from "node:path";
import type { RuntimeStorePaths } from "../runtime-paths.js";
import {
  openControlDatabase,
  openControlDatabaseSync,
  type ControlDatabase,
} from "./control-db.js";

export interface RuntimeControlDbStoreOptions {
  controlDb?: ControlDatabase;
  controlBaseDir?: string;
  controlDbPath?: string;
}

export function resolveRuntimeControlDbBaseDir(paths: Pick<RuntimeStorePaths, "rootDir">): string {
  const runtimeRoot = path.resolve(paths.rootDir);
  return path.basename(runtimeRoot) === "runtime"
    ? path.dirname(runtimeRoot)
    : runtimeRoot;
}

export async function openRuntimeControlDatabase(
  paths: Pick<RuntimeStorePaths, "rootDir">,
  options: RuntimeControlDbStoreOptions = {}
): Promise<ControlDatabase> {
  if (options.controlDb) {
    return options.controlDb;
  }
  return openControlDatabase({
    baseDir: options.controlBaseDir ?? resolveRuntimeControlDbBaseDir(paths),
    dbPath: options.controlDbPath,
  });
}

export function openRuntimeControlDatabaseSync(
  paths: Pick<RuntimeStorePaths, "rootDir">,
  options: RuntimeControlDbStoreOptions = {}
): ControlDatabase {
  if (options.controlDb) {
    return options.controlDb;
  }
  return openControlDatabaseSync({
    baseDir: options.controlBaseDir ?? resolveRuntimeControlDbBaseDir(paths),
    dbPath: options.controlDbPath,
  });
}
