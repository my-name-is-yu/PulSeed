import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { httpPost } from "../http-post.js";

const servers: http.Server[] = [];

function createResponseServer(statusCode: number, responseBody: string): Promise<{ url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(statusCode);
        res.end(responseBody);
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("unexpected server address");
      resolve({ url: `http://127.0.0.1:${address.port}/notify` });
    });
  });
}

function createOpenStreamingResponseServer(statusCode: number, responseBody: string): Promise<{ url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(statusCode);
        res.write(responseBody);
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("unexpected server address");
      resolve({ url: `http://127.0.0.1:${address.port}/notify` });
    });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("httpPost", () => {
  it("bounds stored response bodies while preserving status codes", async () => {
    const { url } = await createResponseServer(418, "abcdefghijklmnopqrstuvwxyz");

    const response = await httpPost(url, { ok: true }, undefined, { maxResponseBodyBytes: 8 });

    expect(response.statusCode).toBe(418);
    expect(response.body).toBe("abcdefgh");
    expect(response.bodyTruncated).toBe(true);
  });

  it("resolves once the response body cap is reached even when the server keeps streaming open", async () => {
    const { url } = await createOpenStreamingResponseServer(502, "abcdefghijklmnopqrstuvwxyz");

    const response = await withTimeout(
      httpPost(url, { ok: true }, undefined, { maxResponseBodyBytes: 8 }),
      500,
    );

    expect(response.statusCode).toBe(502);
    expect(response.body).toBe("abcdefgh");
    expect(response.bodyTruncated).toBe(true);
  });

  it("keeps complete response bodies below the cap", async () => {
    const { url } = await createResponseServer(200, "ok");

    const response = await httpPost(url, { ok: true }, undefined, { maxResponseBodyBytes: 8 });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("ok");
    expect(response.bodyTruncated).toBe(false);
  });
});
