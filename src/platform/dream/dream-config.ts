import * as path from "node:path";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../../base/utils/json-io.js";
import { getPulseedDirPath } from "../../base/utils/paths.js";
import { DreamLogConfigSchema, type DreamLogConfig } from "./dream-types.js";

export const DEFAULT_DREAM_CONFIG: DreamLogConfig = DreamLogConfigSchema.parse({});

export function getDreamConfigPath(baseDir: string = getPulseedDirPath()): string {
  return path.join(baseDir, "dream", "config.json");
}

export async function loadDreamConfig(baseDir?: string): Promise<DreamLogConfig> {
  const configPath = getDreamConfigPath(baseDir);
  const raw = await readJsonFileOrNull<unknown>(configPath);
  const parsed = DreamLogConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_DREAM_CONFIG;
}

export async function saveDreamConfig(
  config: Partial<DreamLogConfig>,
  baseDir?: string
): Promise<DreamLogConfig> {
  const resolved = DreamLogConfigSchema.parse({ ...config });
  await writeJsonFileAtomic(getDreamConfigPath(baseDir), resolved);
  return resolved;
}
