import type { ConfigContext, IndexedFile } from "../contracts.js";
import { isConfigPath } from "../path-policy.js";

export function buildConfigIndex(files: IndexedFile[]): ConfigContext {
  return {
    files: files.filter((file) => isConfigPath(file.path)).map((file) => file.path),
  };
}
