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
