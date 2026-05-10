import * as fsp from "node:fs/promises";
import * as path from "node:path";

/**
 * Lists legacy archive directories that still contain a recoverable goal JSON.
 *
 * Normal archive ownership is database-first via GoalTaskStateStore. This
 * helper is intentionally limited to explicit migration/recovery inspection.
 */
export async function listRecoverableArchivedGoalIds(
  baseDir: string,
  pathExistsFn: (filePath: string) => Promise<boolean>
): Promise<string[]> {
  const archiveDir = path.join(baseDir, "archive");
  try {
    const entries = await fsp.readdir(archiveDir, { withFileTypes: true });
    const recoverable: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".staging") continue;
      if (await pathExistsFn(path.join(archiveDir, entry.name, "goal", "goal.json"))) {
        recoverable.push(entry.name);
      }
    }
    return recoverable;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}
