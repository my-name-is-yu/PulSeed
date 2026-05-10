import type * as http from "node:http";
import {
  isPayloadTooLargeError,
  PayloadTooLargeError,
  readBody,
} from "../http-body.js";

export { isPayloadTooLargeError, PayloadTooLargeError, readBody };

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

export function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return readBody(req).then((body) => JSON.parse(body) as T);
}
