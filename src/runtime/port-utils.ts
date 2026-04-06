import * as net from 'node:net';

export const DEFAULT_PORT = 41700;
export const MAX_PORT_ATTEMPTS = 10;

export async function isPortAvailable(port: number): Promise<boolean> {
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
  for (let port = startPort; port < startPort + MAX_PORT_ATTEMPTS; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(
    `No available port found in range ${startPort}-${startPort + MAX_PORT_ATTEMPTS - 1}`
  );
}
