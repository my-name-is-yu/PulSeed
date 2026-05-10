import path from "node:path";
import { getPulseedDirPath } from "../../base/utils/paths.js";

export const PLAN_ID_RE = /^[a-zA-Z0-9-]+$/;
export const PLAN_TITLE_MAX_CHARS = 200;
export const PLAN_CONTENT_MAX_CHARS = 128_000;
export const PLAN_FILE_MAX_BYTES = 1024 * 1024;

export function decisionsDir(): string {
  return path.join(getPulseedDirPath(), "decisions");
}
