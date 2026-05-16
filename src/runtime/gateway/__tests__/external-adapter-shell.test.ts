import { createHmac, webcrypto } from "node:crypto";
import type * as http from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExternalAdapterIntervalPoller,
  formatExternalAdapterHttpFailure,
  parseExternalAdapterJson,
  readExternalAdapterHttpBody,
  resolveExternalAdapterBackoffDelay,
  respondExternalAdapterJson,
  runExternalAdapterBackoffLoop,
  verifyOptionalEd25519Signature,
  verifyOptionalHmacSha256Signature,
} from "../external-adapter-shell.js";

describe("external adapter shell", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads bounded HTTP bodies and maps oversized bodies to a shared response payload", async () => {
    const ok = await readExternalAdapterHttpBody(createRequest("hello"), 10);
    expect(ok).toEqual({ status: "ok", body: "hello" });

    const tooLarge = await readExternalAdapterHttpBody(createRequest("hello"), 3);
    expect(tooLarge).toEqual({
      status: "payload_too_large",
      statusCode: 413,
      payload: { error: "payload_too_large" },
    });
  });

  it("parses JSON and renders JSON responses through the shared envelope", () => {
    expect(parseExternalAdapterJson<{ ok: boolean }>("{\"ok\":true}")).toEqual({
      status: "ok",
      value: { ok: true },
    });
    expect(parseExternalAdapterJson("{")).toEqual({
      status: "invalid_json",
      statusCode: 400,
      payload: { error: "invalid_json" },
    });

    const response = createResponse();
    respondExternalAdapterJson(response.res, 202, { accepted: true });
    expect(response.res.statusCode).toBe(202);
    expect(response.headers).toEqual({ "Content-Type": "application/json" });
    expect(response.body()).toBe("{\"accepted\":true}");
  });

  it("verifies optional HMAC signatures over raw non-ASCII bodies", () => {
    const body = "hello \u3042";
    const signature = createHmac("sha256", "secret").update(body).digest("hex");

    expect(verifyOptionalHmacSha256Signature({
      secret: "secret",
      body,
      signatureHeader: `sha256=${signature}`,
    })).toBe(true);
    expect(verifyOptionalHmacSha256Signature({
      secret: "secret",
      body,
      signatureHeader: `sha256=${signature.slice(2)}`,
    })).toBe(false);
    expect(verifyOptionalHmacSha256Signature({
      body,
      signatureHeader: undefined,
    })).toBe(true);
  });

  it("verifies optional Ed25519 signatures through the same fail-closed contract", async () => {
    type Ed25519KeyPair = {
      publicKey: Parameters<typeof webcrypto.subtle.exportKey>[1];
      privateKey: Parameters<typeof webcrypto.subtle.sign>[1];
    };
    const payload = "1710000000{\"locale\":\"\u3042\"}";
    const keyPair = await webcrypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"]
    ) as Ed25519KeyPair;
    const publicKeyHex = Buffer.from(await webcrypto.subtle.exportKey("raw", keyPair.publicKey)).toString("hex");
    const signatureHex = Buffer.from(
      await webcrypto.subtle.sign("Ed25519", keyPair.privateKey, new TextEncoder().encode(payload))
    ).toString("hex");

    await expect(verifyOptionalEd25519Signature({
      publicKeyHex,
      signatureHeader: signatureHex,
      signedPayload: payload,
    })).resolves.toBe(true);
    await expect(verifyOptionalEd25519Signature({
      publicKeyHex,
      signatureHeader: signatureHex,
      signedPayload: `${payload} stale`,
    })).resolves.toBe(false);
    await expect(verifyOptionalEd25519Signature({
      signatureHeader: undefined,
      signedPayload: payload,
    })).resolves.toBe(true);
  });

  it("formats HTTP failure messages after reading the provider response body once", async () => {
    const message = await formatExternalAdapterHttpFailure(
      responseLike(503, "upstream unavailable"),
      { service: "discord-bot", operation: "follow-up send failed", statusVerb: "with" }
    );

    expect(message).toBe("discord-bot: follow-up send failed with 503: upstream unavailable");
  });

  it("runs interval pollers without leaking provider-specific timer code into callers", async () => {
    vi.useFakeTimers();
    const pollOnce = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("bridge down"));
    const onError = vi.fn();
    const poller = new ExternalAdapterIntervalPoller({
      intervalMs: 1000,
      pollOnce,
      onError,
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);

    expect(pollOnce).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));

    poller.stop();
    expect(poller.running).toBe(false);
  });

  it("shares bounded backoff progression for long-polling adapters", async () => {
    const delays: number[] = [];
    let attempts = 0;

    await runExternalAdapterBackoffLoop({
      shouldContinue: () => attempts < 3,
      runOnce: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error(`attempt ${attempts}`);
        }
      },
      backoffStepsMs: [10, 20],
      onError: (_error, delayMs) => {
        delays.push(delayMs);
      },
      sleep: async () => undefined,
    });

    expect(delays).toEqual([10, 20]);
    expect(resolveExternalAdapterBackoffDelay(4, [10, 20])).toBe(20);
  });

  it("re-checks the stop condition after async error handling before sleeping", async () => {
    let running = true;
    const sleep = vi.fn(async () => undefined);

    await runExternalAdapterBackoffLoop({
      shouldContinue: () => running,
      runOnce: async () => {
        throw new Error("poll failed");
      },
      backoffStepsMs: [60_000],
      onError: async () => {
        await Promise.resolve();
        running = false;
      },
      sleep,
    });

    expect(sleep).not.toHaveBeenCalled();
  });
});

function createRequest(body: string): http.IncomingMessage {
  const req = new PassThrough() as unknown as http.IncomingMessage;
  (req as unknown as PassThrough).end(body);
  return req;
}

function createResponse(): {
  res: http.ServerResponse;
  headers: Record<string, string>;
  body: () => string;
} {
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader: (key: string, value: string) => {
      headers[key] = value;
    },
    end: (chunk?: unknown) => {
      if (chunk !== undefined) {
        chunks.push(String(chunk));
      }
    },
  } as unknown as http.ServerResponse;
  return { res, headers, body: () => chunks.join("") };
}

function responseLike(status: number, body: string): Pick<Response, "status" | "text"> {
  return {
    status,
    text: async () => body,
  };
}
