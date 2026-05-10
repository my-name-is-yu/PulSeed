import { isTextFileSizeLimitError, readTextFileWithinLimitSync } from "../../base/utils/json-io.js";

export const DAEMON_CONFIG_JSON_MAX_BYTES = 1024 * 1024;

export function isRecoverableDaemonConfigJsonReadError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || error instanceof SyntaxError || isTextFileSizeLimitError(error);
}

export function readDaemonConfigJsonFileSync(filePath: string): unknown {
  const raw = readTextFileWithinLimitSync(filePath, {
    maxBytes: DAEMON_CONFIG_JSON_MAX_BYTES,
  });
  return JSON.parse(raw) as unknown;
}
