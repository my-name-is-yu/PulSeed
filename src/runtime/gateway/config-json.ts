import * as path from "node:path";
import { isTextFileSizeLimitError, readTextFileWithinLimitSync } from "../../base/utils/json-io.js";

export const GATEWAY_CONFIG_JSON_MAX_BYTES = 1024 * 1024;

export function loadGatewayConfigJson(pluginDir: string, channelName: string): Record<string, unknown> {
  const configPath = path.join(pluginDir, "config.json");
  const raw = readGatewayConfigText(configPath, channelName);
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${channelName}: config.json must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function readGatewayConfigText(filePath: string, channelName: string): string {
  try {
    return readTextFileWithinLimitSync(filePath, { maxBytes: GATEWAY_CONFIG_JSON_MAX_BYTES });
  } catch (err) {
    if (isTextFileSizeLimitError(err)) {
      throw oversizedGatewayConfigError(channelName);
    }
    throw err;
  }
}

function oversizedGatewayConfigError(channelName: string): Error {
  return new Error(`${channelName}: config.json exceeds ${GATEWAY_CONFIG_JSON_MAX_BYTES} bytes`);
}
