import type * as http from "node:http";

export const MAX_HTTP_BODY_SIZE = 1_048_576;
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

export function readBody(
  req: http.IncomingMessage,
  maxBodySize = MAX_HTTP_BODY_SIZE
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let bodyTooLarge = false;
    req.on("data", (chunk: Buffer | string) => {
      if (bodyTooLarge) {
        return;
      }
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += buffer.length;
      if (bytes > maxBodySize) {
        bodyTooLarge = true;
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (!bodyTooLarge) {
        resolve(Buffer.concat(chunks, bytes).toString("utf-8"));
      }
    });
    req.on("error", (error) => {
      if (!bodyTooLarge) {
        reject(error);
      }
    });
  });
}
