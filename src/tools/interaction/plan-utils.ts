import { homedir } from "node:os";
import path from "node:path";

export const PLAN_ID_RE = /^[a-zA-Z0-9-]+$/;

export function decisionsDir(): string {
  return path.join(homedir(), ".pulseed", "decisions");
}
