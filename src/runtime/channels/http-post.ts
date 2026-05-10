import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";

const DEFAULT_MAX_RESPONSE_BODY_BYTES = 64 * 1024;

export interface HttpPostOptions {
  maxResponseBodyBytes?: number;
}

/** Perform an HTTP/HTTPS POST with a JSON body. Returns the response status code. */
export function httpPost(
  urlStr: string,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
  options: HttpPostOptions = {}
): Promise<{ statusCode: number; body: string; bodyTruncated: boolean }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch {
      reject(new Error(`Invalid URL: ${urlStr}`));
      return;
    }

    const payload = JSON.stringify(body);
    const maxResponseBodyBytes = normalizeMaxResponseBodyBytes(options.maxResponseBodyBytes);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    const requestOptions: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port
        ? parseInt(parsed.port, 10)
        : isHttps
          ? 443
          : 80,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...extraHeaders,
      },
    };

    const req = lib.request(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      let storedBytes = 0;
      let bodyTruncated = false;
      res.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remainingBytes = maxResponseBodyBytes - storedBytes;
        if (remainingBytes <= 0) {
          bodyTruncated = true;
          return;
        }
        if (buffer.byteLength > remainingBytes) {
          chunks.push(buffer.subarray(0, remainingBytes));
          storedBytes += remainingBytes;
          bodyTruncated = true;
          return;
        }
        chunks.push(buffer);
        storedBytes += buffer.byteLength;
      });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          bodyTruncated,
        });
      });
    });

    req.on("error", (err: Error) => reject(err));
    req.setTimeout(10_000, () => {
      req.destroy(new Error("HTTP request timeout"));
    });

    req.write(payload);
    req.end();
  });
}

function normalizeMaxResponseBodyBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RESPONSE_BODY_BYTES;
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    return DEFAULT_MAX_RESPONSE_BODY_BYTES;
  }
  return value;
}
