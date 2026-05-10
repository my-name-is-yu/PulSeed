import * as fs from "node:fs";
import * as path from "node:path";

export const GATEWAY_CONFIG_JSON_MAX_BYTES = 1024 * 1024;
const GATEWAY_CONFIG_JSON_READ_CHUNK_BYTES = 64 * 1024;

export function loadGatewayConfigJson(pluginDir: string, channelName: string): Record<string, unknown> {
  const configPath = path.join(pluginDir, "config.json");
  const raw = readTextFileWithinLimit(configPath, GATEWAY_CONFIG_JSON_MAX_BYTES, channelName);
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${channelName}: config.json must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function readTextFileWithinLimit(filePath: string, maxBytes: number, channelName: string): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(Math.min(GATEWAY_CONFIG_JSON_READ_CHUNK_BYTES, maxBytes + 1));
    let totalBytes = 0;

    while (true) {
      const remainingBytes = maxBytes + 1 - totalBytes;
      if (remainingBytes <= 0) {
        throw oversizedGatewayConfigError(channelName, maxBytes);
      }

      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.byteLength, remainingBytes), null);
      if (bytesRead === 0) break;

      totalBytes += bytesRead;
      if (totalBytes > maxBytes) {
        throw oversizedGatewayConfigError(channelName, maxBytes);
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }

    return Buffer.concat(chunks, totalBytes).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

function oversizedGatewayConfigError(channelName: string, maxBytes: number): Error {
  return new Error(`${channelName}: config.json exceeds ${maxBytes} bytes`);
}
