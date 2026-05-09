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

export type ProcessSignal = NodeJS.Signals | 0;

export function signalProcessPid(pid: unknown, signal: ProcessSignal): ProcessSignalResult {
  if (!isProcessPidValue(pid)) {
    return { status: "unsafe_pid" };
  }

  try {
    process.kill(pid, signal);
    return { status: "sent", pid };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return { status: "missing_process", pid };
    }
    if (signal === 0 && code === "EPERM") {
      return { status: "sent", pid };
    }
    throw err;
  }
}
