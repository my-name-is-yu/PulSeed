import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiscordGatewayAdapter } from "../gateway/discord-gateway-adapter.js";
import { GATEWAY_CONFIG_JSON_MAX_BYTES } from "../gateway/config-json.js";
import { SignalGatewayAdapter } from "../gateway/signal-gateway-adapter.js";
import { TelegramGatewayAdapter } from "../gateway/telegram-gateway-adapter.js";
import { WhatsAppGatewayAdapter } from "../gateway/whatsapp-gateway-adapter.js";
import { cleanupTempDir, makeTempDir } from "../../../tests/helpers/temp-dir.js";

function writeConfig(dir: string, config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config, null, 2), "utf-8");
}

function writeOversizedConfig(dir: string, config: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ ...config, padding: "x".repeat(GATEWAY_CONFIG_JSON_MAX_BYTES) }),
    "utf-8",
  );
}

describe("gateway channel config boundaries", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      cleanupTempDir(tmpDir);
      tmpDir = null;
    }
  });

  it("rejects unsafe Telegram numeric IDs on the config loader path", () => {
    tmpDir = makeTempDir();
    writeConfig(tmpDir, {
      bot_token: "telegram-token",
      allowed_user_ids: [Number.MAX_SAFE_INTEGER + 1],
    });

    expect(() => TelegramGatewayAdapter.fromConfigDir(tmpDir!)).toThrow(
      "telegram-bot: allowed_user_ids must be an array of safe integers",
    );
  });

  it("rejects out-of-range Telegram polling timeouts on the config loader path", () => {
    tmpDir = makeTempDir();
    writeConfig(tmpDir, {
      bot_token: "telegram-token",
      polling_timeout: Number.MAX_SAFE_INTEGER,
    });

    expect(() => TelegramGatewayAdapter.fromConfigDir(tmpDir!)).toThrow(
      "telegram-bot: polling_timeout must be a safe integer between 1 and 60",
    );
  });

  it("rejects unsafe Discord HTTP ports on the config loader path", () => {
    tmpDir = makeTempDir();
    writeConfig(tmpDir, {
      application_id: "app-1",
      bot_token: "discord-token",
      channel_id: "channel-1",
      identity_key: "main",
      port: Number.MAX_SAFE_INTEGER + 1,
    });

    expect(() => DiscordGatewayAdapter.fromConfigDir(tmpDir!)).toThrow(
      "discord-bot: port must be a safe integer between 1 and 65535",
    );
  });

  it("rejects out-of-range WhatsApp HTTP ports on the config loader path", () => {
    tmpDir = makeTempDir();
    writeConfig(tmpDir, {
      phone_number_id: "phone-1",
      access_token: "whatsapp-token",
      verify_token: "verify-token",
      recipient_id: "recipient-1",
      identity_key: "main",
      port: 65_536,
    });

    expect(() => WhatsAppGatewayAdapter.fromConfigDir(tmpDir!)).toThrow(
      "whatsapp-webhook: port must be a safe integer between 1 and 65535",
    );
  });

  it("rejects timer-overflow Signal polling controls on the config loader path", () => {
    tmpDir = makeTempDir();
    writeConfig(tmpDir, {
      bridge_url: "http://127.0.0.1:8080",
      account: "+15555550100",
      recipient_id: "+15555550101",
      identity_key: "main",
      poll_interval_ms: Number.MAX_SAFE_INTEGER,
    });

    expect(() => SignalGatewayAdapter.fromConfigDir(tmpDir!)).toThrow(
      "signal-bridge: poll_interval_ms must be a safe integer between 1000 and 60000",
    );
  });

  it.each([
    [
      "telegram-bot",
      () => TelegramGatewayAdapter.fromConfigDir(tmpDir!),
      { bot_token: "telegram-token" },
    ],
    [
      "discord-bot",
      () => DiscordGatewayAdapter.fromConfigDir(tmpDir!),
      {
        application_id: "app-1",
        bot_token: "discord-token",
        channel_id: "channel-1",
        identity_key: "main",
      },
    ],
    [
      "whatsapp-webhook",
      () => WhatsAppGatewayAdapter.fromConfigDir(tmpDir!),
      {
        phone_number_id: "phone-1",
        access_token: "whatsapp-token",
        verify_token: "verify-token",
        recipient_id: "recipient-1",
        identity_key: "main",
      },
    ],
    [
      "signal-bridge",
      () => SignalGatewayAdapter.fromConfigDir(tmpDir!),
      {
        bridge_url: "http://127.0.0.1:8080",
        account: "+15555550100",
        recipient_id: "+15555550101",
        identity_key: "main",
      },
    ],
  ])("rejects oversized %s config before adapter-specific validation", (channelName, loadConfig, config) => {
    tmpDir = makeTempDir();
    writeOversizedConfig(tmpDir, config);

    expect(loadConfig).toThrow(`${channelName}: config.json exceeds ${GATEWAY_CONFIG_JSON_MAX_BYTES} bytes`);
  });
});
