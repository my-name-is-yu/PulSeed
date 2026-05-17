import { Logger } from "../../runtime/logger.js";
import { getLogsDir } from "../../base/utils/paths.js";

// Shared Logger instance for all CLI commands
// Logs to ~/.pulseed/logs/ (same dir used by daemon/run commands)
let _cliLogger: Logger | null = null;
let _cliLoggerDir: string | null = null;
let _cliLoggerFacade: Logger | null = null;

function getActiveCliLogger(): Logger {
  const dir = getLogsDir();
  if (!_cliLogger || _cliLoggerDir !== dir) {
    if (_cliLogger) {
      void _cliLogger.close().catch(() => {});
    }
    _cliLogger = new Logger({ dir, level: "warn", consoleOutput: true });
    _cliLoggerDir = dir;
  }
  return _cliLogger;
}

export function getCliLogger(): Logger {
  _cliLoggerFacade ??= {
    debug: (message: string, context?: Record<string, unknown>) => getActiveCliLogger().debug(message, context),
    info: (message: string, context?: Record<string, unknown>) => getActiveCliLogger().info(message, context),
    warn: (message: string, context?: Record<string, unknown>) => getActiveCliLogger().warn(message, context),
    error: (message: string, context?: Record<string, unknown>) => getActiveCliLogger().error(message, context),
    close: () => getActiveCliLogger().close(),
  } as Logger;
  return _cliLoggerFacade;
}
