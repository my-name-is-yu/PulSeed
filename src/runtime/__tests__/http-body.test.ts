import type * as http from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { MAX_HTTP_BODY_SIZE, PayloadTooLargeError, readBody } from "../http-body.js";

describe("readBody", () => {
  it("decodes UTF-8 after joining request chunks", async () => {
    const req = new PassThrough();
    const body = JSON.stringify({ text: "\u3042" });
    const chunks = splitUtf8Body(body, "\u3042");
    const promise = readBody(req as unknown as http.IncomingMessage);

    req.write(chunks[0]);
    req.end(chunks[1]);

    await expect(promise).resolves.toBe(body);
  });

  it("rejects oversized bodies across chunks", async () => {
    const req = new PassThrough();
    const promise = readBody(req as unknown as http.IncomingMessage);

    req.write(Buffer.alloc(MAX_HTTP_BODY_SIZE));
    req.end(Buffer.from("x"));

    await expect(promise).rejects.toBeInstanceOf(PayloadTooLargeError);
  });
});

function splitUtf8Body(body: string, needle: string): [Buffer, Buffer] {
  const charIndex = body.indexOf(needle);
  if (charIndex === -1) {
    throw new Error("expected body to contain split marker");
  }
  const bytes = Buffer.from(body, "utf-8");
  const splitAt = Buffer.byteLength(body.slice(0, charIndex), "utf-8") + 1;
  return [bytes.subarray(0, splitAt), bytes.subarray(splitAt)];
}
