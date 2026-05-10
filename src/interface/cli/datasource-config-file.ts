import { readTextFileWithinLimit } from "../../base/utils/json-io.js";
import {
  DataSourceConfigSchema,
  type DataSourceConfig,
} from "../../platform/observation/types/data-source.js";

export const DATASOURCE_CONFIG_FILE_MAX_BYTES = 256 * 1024;

export async function readDatasourceJsonFile(filePath: string): Promise<unknown> {
  const raw = await readTextFileWithinLimit(filePath, {
    maxBytes: DATASOURCE_CONFIG_FILE_MAX_BYTES,
  });
  return JSON.parse(raw) as unknown;
}

export async function readDatasourceConfigFile(filePath: string): Promise<DataSourceConfig | null> {
  const parsed = DataSourceConfigSchema.safeParse(await readDatasourceJsonFile(filePath));
  return parsed.success ? parsed.data : null;
}
