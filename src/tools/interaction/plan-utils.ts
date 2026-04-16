import path from "node:path";
import { getPulseedDirPath } from "../../base/utils/paths.js";

export const PLAN_ID_RE = /^[a-zA-Z0-9-]+$/;

export function decisionsDir(): string {
  return path.join(getPulseedDirPath(), "decisions");
}
