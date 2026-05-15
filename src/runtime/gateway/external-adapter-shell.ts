import { createHmac, timingSafeEqual, webcrypto } from "node:crypto";
import type * as http from "node:http";
import * as path from "node:path";
import { isTextFileSizeLimitError, readTextFileWithinLimitSync } from "../../base/utils/json-io.js";
import { isPayloadTooLargeError, readBody } from "../http-body.js";

export const DEFAULT_EXTERNAL_ADAPTER_BACKOFF_STEPS_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
export const DEFAULT_EXTERNAL_ADAPTER_CONFIG_JSON_MAX_BYTES = 1024 * 1024;

export interface ExternalAdapterConfigJsonOptions {
  maxBytes?: number;
  invalidObjectMessage?: string;
}

export function loadExternalAdapterConfigJson(
  pluginDir: string,
  adapterName: string,
  options: ExternalAdapterConfigJsonOptions = {}
): Record<string, unknown> {
  const configPath = path.join(pluginDir, "config.json");
  const maxBytes = options.maxBytes ?? DEFAULT_EXTERNAL_ADAPTER_CONFIG_JSON_MAX_BYTES;
  let raw: string;
  try {
    raw = readTextFileWithinLimitSync(configPath, { maxBytes });
  } catch (error) {
    if (isTextFileSizeLimitError(error)) {
      throw new Error(`${adapterName}: config.json exceeds ${maxBytes} bytes`);
    }
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`${adapterName}: failed to read config.json — ${msg}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`${adapterName}: failed to read config.json — ${msg}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(options.invalidObjectMessage ?? `${adapterName}: config must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function assertExternalAdapterNonEmptyString(value: unknown, message: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(message);
  }
}

export function assertExternalAdapterBoolean(value: unknown, message: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(message);
  }
}

export function assertExternalAdapterIntegerInRange(
  value: unknown,
  min: number,
  max: number,
  message: string
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(message);
  }
}

export function assertExternalAdapterStringArray(value: unknown, message: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error(message);
  }
}

export function assertExternalAdapterStringMap(value: unknown, message: string): asserts value is Record<string, string> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.values(value).every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new Error(message);
  }
}

export type ExternalAdapterHttpBodyResult =
  | { status: "ok"; body: string }
  | { status: "payload_too_large"; statusCode: 413; payload: { error: "payload_too_large" } }
  | { status: "invalid_body"; statusCode: 400; payload: { error: "invalid_body" } };

export async function readExternalAdapterHttpBody(
  req: http.IncomingMessage,
  maxBodySize?: number
): Promise<ExternalAdapterHttpBodyResult> {
  try {
    return { status: "ok", body: await readBody(req, maxBodySize) };
  } catch (error) {
    if (isPayloadTooLargeError(error)) {
      return { status: "payload_too_large", statusCode: 413, payload: { error: "payload_too_large" } };
    }
    return { status: "invalid_body", statusCode: 400, payload: { error: "invalid_body" } };
  }
}

export type ExternalAdapterJsonParseResult<T> =
  | { status: "ok"; value: T }
  | { status: "invalid_json"; statusCode: 400; payload: { error: "invalid_json" } };

export function parseExternalAdapterJson<T = unknown>(body: string): ExternalAdapterJsonParseResult<T> {
  try {
    return { status: "ok", value: JSON.parse(body) as T };
  } catch {
    return { status: "invalid_json", statusCode: 400, payload: { error: "invalid_json" } };
  }
}

export function respondExternalAdapterJson(
  res: http.ServerResponse,
  statusCode: number,
  payload: unknown
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

export function singleHeaderValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export interface ExternalAdapterHmacSha256SignatureInput {
  secret?: string;
  body: string;
  signatureHeader: string | string[] | undefined;
  prefix?: string;
}

export function verifyOptionalHmacSha256Signature(input: ExternalAdapterHmacSha256SignatureInput): boolean {
  if (input.secret === undefined || input.secret.length === 0) {
    return true;
  }

  const prefix = input.prefix ?? "sha256=";
  const header = singleHeaderValue(input.signatureHeader);
  if (header === undefined || !header.startsWith(prefix)) {
    return false;
  }

  const expectedHex = createHmac("sha256", input.secret).update(input.body).digest("hex");
  const actualHex = header.slice(prefix.length);
  if (actualHex.length !== expectedHex.length) {
    return false;
  }

  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(actualHex, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface ExternalAdapterEd25519SignatureInput {
  publicKeyHex?: string;
  signatureHeader: string | string[] | undefined;
  signedPayload: string;
}

export async function verifyOptionalEd25519Signature(input: ExternalAdapterEd25519SignatureInput): Promise<boolean> {
  if (input.publicKeyHex === undefined || input.publicKeyHex.length === 0) {
    return true;
  }

  const signature = singleHeaderValue(input.signatureHeader);
  if (signature === undefined) {
    return false;
  }

  try {
    const publicKeyBytes = Uint8Array.from(Buffer.from(input.publicKeyHex, "hex"));
    const key = await webcrypto.subtle.importKey("raw", publicKeyBytes, { name: "Ed25519" }, false, ["verify"]);
    return await webcrypto.subtle.verify(
      "Ed25519",
      key,
      Uint8Array.from(Buffer.from(signature, "hex")),
      new TextEncoder().encode(input.signedPayload)
    );
  } catch {
    return false;
  }
}

export async function readExternalAdapterHttpFailureBody(
  response: Pick<Response, "text">,
  fallback = "(unreadable)"
): Promise<string> {
  return response.text().catch(() => fallback);
}

export interface ExternalAdapterHttpFailureMessageInput {
  service: string;
  operation: string;
  statusVerb?: string;
}

export async function formatExternalAdapterHttpFailure(
  response: Pick<Response, "status" | "text">,
  input: ExternalAdapterHttpFailureMessageInput
): Promise<string> {
  const body = await readExternalAdapterHttpFailureBody(response);
  return `${input.service}: ${input.operation} ${input.statusVerb ?? "returned"} ${response.status}: ${body}`;
}

export interface ExternalAdapterIntervalPollerOptions {
  intervalMs: number;
  pollOnce: () => Promise<void>;
  onError?: (error: unknown) => void;
  runImmediately?: boolean;
}

export class ExternalAdapterIntervalPoller {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: ExternalAdapterIntervalPollerOptions) {}

  start(): void {
    if (this.timer !== null) {
      return;
    }

    if (this.options.runImmediately ?? true) {
      void this.runOnceGuarded();
    }
    this.timer = setInterval(() => {
      void this.runOnceGuarded();
    }, this.options.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pollOnce(): Promise<void> {
    await this.options.pollOnce();
  }

  get running(): boolean {
    return this.timer !== null;
  }

  private async runOnceGuarded(): Promise<void> {
    try {
      await this.options.pollOnce();
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}

export interface ExternalAdapterBackoffLoopOptions {
  shouldContinue: () => boolean;
  runOnce: () => Promise<void>;
  onError?: (error: unknown, delayMs: number) => void | Promise<void>;
  backoffStepsMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

export async function runExternalAdapterBackoffLoop(options: ExternalAdapterBackoffLoopOptions): Promise<void> {
  let backoffIndex = 0;

  while (options.shouldContinue()) {
    try {
      await options.runOnce();
      backoffIndex = 0;
    } catch (error) {
      if (!options.shouldContinue()) {
        break;
      }
      const delayMs = resolveExternalAdapterBackoffDelay(backoffIndex, options.backoffStepsMs);
      backoffIndex += 1;
      await options.onError?.(error, delayMs);
      await (options.sleep ?? sleepExternalAdapter)(delayMs);
    }
  }
}

export function resolveExternalAdapterBackoffDelay(
  attemptIndex: number,
  stepsMs: readonly number[] = DEFAULT_EXTERNAL_ADAPTER_BACKOFF_STEPS_MS
): number {
  if (stepsMs.length === 0) {
    return 0;
  }
  return stepsMs[Math.min(Math.max(0, attemptIndex), stepsMs.length - 1)]!;
}

export function sleepExternalAdapter(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
