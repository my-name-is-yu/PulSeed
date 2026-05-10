import { TriggerMappingsConfigSchema } from "../base/types/trigger.js";
import type { TriggerMappingsConfig } from "../base/types/trigger.js";
import { readTextFileWithinLimit } from "../base/utils/json-io.js";
import { MAX_HTTP_BODY_SIZE } from "./http-body.js";

export const TRIGGER_MAPPINGS_MAX_BYTES = MAX_HTTP_BODY_SIZE;

export async function readTriggerMappingsConfig(filePath: string): Promise<TriggerMappingsConfig> {
  const content = await readTextFileWithinLimit(filePath, { maxBytes: TRIGGER_MAPPINGS_MAX_BYTES });
  const raw = JSON.parse(content) as unknown;
  return TriggerMappingsConfigSchema.parse(raw);
}
