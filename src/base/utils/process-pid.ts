const PROCESS_PID_TOKEN = /^[0-9]+$/;

export function isProcessPidValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseProcessPid(raw: string): number | null {
  const normalized = raw.trim();
  if (!PROCESS_PID_TOKEN.test(normalized)) return null;
  const pid = Number(normalized);
  if (!isProcessPidValue(pid)) return null;
  return pid;
}

export type ProcessSignalResult =
  | { status: "sent"; pid: number }
  | { status: "unsafe_pid" }
  | { status: "missing_process"; pid: number };

export function signalProcessPid(pid: unknown, signal: NodeJS.Signals): ProcessSignalResult {
  if (!isProcessPidValue(pid)) {
    return { status: "unsafe_pid" };
  }

  try {
    process.kill(pid, signal);
    return { status: "sent", pid };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return { status: "missing_process", pid };
    }
    throw err;
  }
}
