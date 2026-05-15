import { loadExternalAdapterConfigJson } from "./external-adapter-shell.js";

export const GATEWAY_CONFIG_JSON_MAX_BYTES = 1024 * 1024;

export function loadGatewayConfigJson(pluginDir: string, channelName: string): Record<string, unknown> {
  return loadExternalAdapterConfigJson(pluginDir, channelName, {
    maxBytes: GATEWAY_CONFIG_JSON_MAX_BYTES,
    invalidObjectMessage: `${channelName}: config.json must contain a JSON object`,
  });
}
