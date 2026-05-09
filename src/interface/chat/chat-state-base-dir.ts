import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { StateManager } from "../../base/state/state-manager.js";

const fallbackBaseDirs = new WeakMap<object, string>();

export function resolveChatStateBaseDir(stateManager: StateManager): string {
  if (typeof stateManager.getBaseDir === "function") {
    return stateManager.getBaseDir();
  }
  const key = stateManager as unknown as object;
  const existing = fallbackBaseDirs.get(key);
  if (existing) return existing;
  const created = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-chat-db-state-"));
  fallbackBaseDirs.set(key, created);
  return created;
}
