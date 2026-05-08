const PROCESS_PID_TOKEN = /^[0-9]+$/;

export function parseProcessPid(raw: string): number | null {
  const normalized = raw.trim();
  if (!PROCESS_PID_TOKEN.test(normalized)) return null;
  const pid = Number(normalized);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return pid;
}
