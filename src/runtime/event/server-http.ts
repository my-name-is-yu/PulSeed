import type * as http from "node:http";

const MAX_BODY_SIZE = 1_048_576;
const PAYLOAD_TOO_LARGE_MESSAGE = "Payload too large";

export class PayloadTooLargeError extends Error {
  constructor() {
    super(PAYLOAD_TOO_LARGE_MESSAGE);
    this.name = "PayloadTooLargeError";
  }
}

export function isPayloadTooLargeError(error: unknown): boolean {
  return error instanceof PayloadTooLargeError
    || (error instanceof Error && error.message === PAYLOAD_TOO_LARGE_MESSAGE);
}

export function writeJson(
  res: http.ServerResponse,
  status: number,
  body: unknown
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function writeJsonError(
  res: http.ServerResponse,
  status: number,
  error: string,
  details?: unknown
): void {
  writeJson(res, status, details === undefined ? { error } : { error, details: String(details) });
}

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let bodyTooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (bodyTooLarge) {
        return;
      }
      bytes += chunk.length;
      if (bytes > MAX_BODY_SIZE) {
        bodyTooLarge = true;
        reject(new PayloadTooLargeError());
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (!bodyTooLarge) {
        resolve(body);
      }
    });
    req.on("error", (error) => {
      if (!bodyTooLarge) {
        reject(error);
      }
    });
  });
}

export function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return readBody(req).then((body) => JSON.parse(body) as T);
}
