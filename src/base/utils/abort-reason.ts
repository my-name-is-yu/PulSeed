const DAEMON_SHUTDOWN_ABORT_CODE = "pulseed.daemon_shutdown";

export interface DaemonShutdownAbortReason {
  code: typeof DAEMON_SHUTDOWN_ABORT_CODE;
  message: string;
  requested_at: string;
}

export function createDaemonShutdownAbortReason(message = "daemon shutdown requested"): DaemonShutdownAbortReason {
  return {
    code: DAEMON_SHUTDOWN_ABORT_CODE,
    message,
    requested_at: new Date().toISOString(),
  };
}

export function isDaemonShutdownAbortReason(reason: unknown): reason is DaemonShutdownAbortReason {
  if (!reason || typeof reason !== "object") return false;
  return (reason as { code?: unknown }).code === DAEMON_SHUTDOWN_ABORT_CODE;
}

export function isDaemonShutdownAbortSignal(signal?: AbortSignal): boolean {
  return signal?.aborted === true && isDaemonShutdownAbortReason(signal.reason);
}
