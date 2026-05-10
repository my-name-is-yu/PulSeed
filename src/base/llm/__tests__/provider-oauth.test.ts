import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ProviderConfigModule from "../provider-config.js";

const CODEX_AUTH_TEXT_MAX_BYTES = 1024 * 1024;

const {
  getProviderRuntimeFingerprint,
  isJwtExpired,
  loadProviderConfig,
  readCodexOAuthToken,
} = await vi.importActual<typeof ProviderConfigModule>("../provider-config.js");

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("isJwtExpired", () => {
  it("returns false for a token with a future exp", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect(isJwtExpired(makeJwt({ exp: future }))).toBe(false);
  });

  it("returns true for a token with a past exp", () => {
    const past = Math.floor(Date.now() / 1000) - 1;
    expect(isJwtExpired(makeJwt({ exp: past }))).toBe(true);
  });

  it("returns true when exp is absent", () => {
    expect(isJwtExpired(makeJwt({ sub: "user" }))).toBe(true);
  });

  it("returns true for a malformed token", () => {
    expect(isJwtExpired("not-a-jwt")).toBe(true);
  });
});

describe("provider OAuth config fallback", () => {
  let tmpHome: string;
  let tmpPulseedHome: string;
  let originalHome: string | undefined;
  let originalPulseedHome: string | undefined;
  let originalOpenAiKey: string | undefined;

  beforeEach(async () => {
    originalHome = process.env["HOME"];
    originalPulseedHome = process.env["PULSEED_HOME"];
    originalOpenAiKey = process.env["OPENAI_API_KEY"];
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-provider-oauth-"));
    tmpPulseedHome = path.join(tmpHome, ".pulseed");
    process.env["HOME"] = tmpHome;
    process.env["PULSEED_HOME"] = tmpPulseedHome;
    delete process.env["OPENAI_API_KEY"];
  });

  afterEach(async () => {
    restoreEnv("HOME", originalHome);
    restoreEnv("PULSEED_HOME", originalPulseedHome);
    restoreEnv("OPENAI_API_KEY", originalOpenAiKey);
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("returns the access_token from a valid auth.json", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const token = makeJwt({ exp: future, sub: "user" });
    await writeCodexAuthJson({
      auth_mode: "chatgpt",
      tokens: { access_token: token, refresh_token: "rt_abc" },
      last_refresh: "2026-01-01T00:00:00Z",
    });

    const result = await readCodexOAuthToken();

    expect(result).toBe(token);
  });

  it("returns undefined when the file does not exist", async () => {
    await expect(readCodexOAuthToken()).resolves.toBeUndefined();
  });

  it("returns undefined when the token is expired", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    await writeCodexAuthJson({
      tokens: { access_token: makeJwt({ exp: past }) },
    });

    await expect(readCodexOAuthToken()).resolves.toBeUndefined();
  });

  it("returns undefined when tokens.access_token is missing", async () => {
    await writeCodexAuthJson({ auth_mode: "chatgpt", tokens: {} });

    await expect(readCodexOAuthToken()).resolves.toBeUndefined();
  });

  it("returns undefined when auth.json exceeds the bounded read limit", async () => {
    await fs.mkdir(path.dirname(codexAuthPath()), { recursive: true });
    await fs.writeFile(
      codexAuthPath(),
      JSON.stringify({ tokens: { access_token: "x".repeat(CODEX_AUTH_TEXT_MAX_BYTES) } }),
      "utf-8",
    );

    await expect(readCodexOAuthToken()).resolves.toBeUndefined();
  });

  it("loadProviderConfig uses OAuth token when no API key is configured", async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const validToken = makeJwt({ exp: futureExp });
    await writeProviderJson({
      provider: "openai",
      model: "gpt-5.4-mini",
      adapter: "openai_codex_cli",
    });
    await writeCodexAuthJson({ tokens: { access_token: validToken } });

    const config = await loadProviderConfig();

    expect(config.api_key).toBe(validToken);
  });

  it("changes fingerprint when the resolved OAuth token changes without exposing the raw token", async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const tokenA = makeJwt({ exp: futureExp, sub: "user-a" });
    const tokenB = makeJwt({ exp: futureExp, sub: "user-b" });
    await writeProviderJson({
      provider: "openai",
      model: "gpt-5.4-mini",
      adapter: "openai_codex_cli",
    });

    await writeCodexAuthJson({ tokens: { access_token: tokenA } });
    const fingerprintA = await getProviderRuntimeFingerprint();
    await writeCodexAuthJson({ tokens: { access_token: tokenB } });
    const fingerprintB = await getProviderRuntimeFingerprint();

    expect(fingerprintA).not.toContain(tokenA);
    expect(fingerprintB).not.toContain(tokenB);
    expect(fingerprintA).not.toBe(fingerprintB);
  });

  it("changes fingerprint when OpenAI reasoning effort changes", async () => {
    await writeProviderJson(providerConfig("low"));
    const fingerprintA = await getProviderRuntimeFingerprint();
    await writeProviderJson(providerConfig("high"));
    const fingerprintB = await getProviderRuntimeFingerprint();

    expect(fingerprintA).not.toBe(fingerprintB);
    expect(fingerprintA).toContain('"reasoning_effort":"low"');
    expect(fingerprintB).toContain('"reasoning_effort":"high"');
  });

  function providerConfig(reasoning_effort: string): Record<string, unknown> {
    return {
      provider: "openai",
      model: "gpt-5.5",
      reasoning_effort,
      adapter: "openai_codex_cli",
      api_key: "sk-test",
    };
  }

  async function writeProviderJson(value: Record<string, unknown>): Promise<void> {
    await fs.mkdir(tmpPulseedHome, { recursive: true });
    await fs.writeFile(path.join(tmpPulseedHome, "provider.json"), JSON.stringify(value), "utf-8");
  }

  async function writeCodexAuthJson(value: Record<string, unknown>): Promise<void> {
    await fs.mkdir(path.dirname(codexAuthPath()), { recursive: true });
    await fs.writeFile(codexAuthPath(), JSON.stringify(value), "utf-8");
  }

  function codexAuthPath(): string {
    return path.join(tmpHome, ".codex", "auth.json");
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
