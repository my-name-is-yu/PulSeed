import { execFileSync } from 'node:child_process';
import * as net from 'node:net';
import { parseProcessPid } from '../base/utils/process-pid.js';

export const DEFAULT_PORT = 41700;
export const MAX_PORT_ATTEMPTS = 10;
const MIN_PORT = 1;
const MAX_PORT = 65_535;

function assertValidPort(port: number, label = 'Port'): void {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new RangeError(`${label} must be an integer between ${MIN_PORT} and ${MAX_PORT}`);
  }
}

export async function isPortAvailable(port: number): Promise<boolean> {
  assertValidPort(port);
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

export async function findAvailablePort(startPort: number = DEFAULT_PORT): Promise<number> {
  assertValidPort(startPort, 'startPort');
  const endPort = Math.min(MAX_PORT, startPort + MAX_PORT_ATTEMPTS - 1);
  for (let port = startPort; port <= endPort; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(
    `No available port found in range ${startPort}-${endPort}`
  );
}

export async function getProcessOnPort(port: number): Promise<string | null> {
  assertValidPort(port);
  try {
    // lsof works on macOS and Linux
    const output = execFileSync('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf-8' }).trim();
    if (!output) return null;
    const pid = parseProcessPid(output.split('\n')[0] ?? '');
    if (pid === null) return null;
    // Get process name from PID
    const name = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8' }).trim();
    return name || null;
  } catch {
    return null;
  }
}
